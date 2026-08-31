"""Request authentication for the anomaly sidecar.

Standard library only, and deliberately free of any FastAPI import: the
signing scheme is the contract with the Next.js caller and must be readable,
portable and unit-testable on its own. ``app.main`` is the only place that
turns these exceptions into HTTP responses.

------------------------------------------------------------------------------
THE SIGNING SCHEME
------------------------------------------------------------------------------
Every authenticated request carries two headers::

    X-Halisaha-Timestamp: 1756500000                 # Unix seconds, integer
    X-Halisaha-Signature: 3f2a...c91                 # lowercase hex, 64 chars

with::

    signature = hex( HMAC_SHA256( secret, f"{timestamp}.{raw_body}" ) )

``raw_body`` is the **exact bytes** on the wire, not a re-serialised object.
Signing a re-encode gives a check that passes in tests and fails in production
the moment key order or whitespace differs. For a body-less request
(``GET /model/info``) the signed string is ``f"{timestamp}."``; the separator
stays.

The Node.js side is one call::

    const ts = Math.floor(Date.now() / 1000).toString()
    const body = JSON.stringify(featureVector)
    const sig = crypto.createHmac("sha256", process.env.ANOMALY_SERVICE_SECRET!)
      .update(`${ts}.${body}`).digest("hex")

The scheme rests on three properties:

* **Timestamp in the MAC.** The timestamp is inside the signed string, so an
  attacker cannot replay a captured body with a fresh timestamp.
* **Skew window.** Requests more than ``max_skew_seconds`` (default 300) away
  from now are rejected in *both* directions. A far-future timestamp is just as
  suspicious as a stale one, and clock drift cuts both ways.
* **Constant-time compare.** ``hmac.compare_digest`` throughout, so a byte-wise
  early exit cannot leak the expected signature one character at a time.

The window narrows replay rather than preventing it: a replay inside 300
seconds still verifies. That is an accepted trade, because the endpoint is
idempotent (scoring the same vector twice yields the same verdict), advisory,
rate-limited, and never meant to be reachable from the public internet. A nonce
cache is the fix if that changes.
"""

from __future__ import annotations

import hashlib
import hmac
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Deque

SIGNATURE_HEADER = "X-Halisaha-Signature"
TIMESTAMP_HEADER = "X-Halisaha-Timestamp"
ADMIN_TOKEN_HEADER = "X-Halisaha-Admin-Token"
REQUEST_ID_HEADER = "X-Request-Id"

DEFAULT_MAX_SKEW_SECONDS = 300

#: Hex-encoded SHA-256 is always exactly 64 characters.
_SIGNATURE_HEX_LENGTH = 64


class SignatureError(Exception):
    """Base class for every rejection reason.

    ``code`` is a stable machine-readable slug; ``message`` is safe to return
    to the caller (it never echoes the expected signature or the secret).
    """

    code = "unauthorized"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class MissingSignature(SignatureError):
    code = "signature_missing"


class MalformedSignature(SignatureError):
    code = "signature_malformed"


class StaleTimestamp(SignatureError):
    code = "timestamp_out_of_window"


class InvalidSignature(SignatureError):
    code = "signature_invalid"


class SecretNotConfigured(SignatureError):
    code = "signing_not_configured"


def build_signing_string(timestamp: str, raw_body: bytes) -> bytes:
    """``f"{timestamp}.".encode() + raw_body`` -- the exact bytes that are MACed.

    Concatenating bytes rather than decoding the body keeps this correct for
    any payload encoding and avoids a decode error becoming an auth bypass.
    """
    return timestamp.encode("utf-8") + b"." + raw_body


def sign_payload(secret: str, timestamp: str, raw_body: bytes) -> str:
    """Produce the lowercase hex signature for a payload.

    Exported so tests, ``curl`` recipes in the README and any future Python
    caller all use the one implementation the verifier checks against.
    """
    return hmac.new(
        secret.encode("utf-8"),
        build_signing_string(timestamp, raw_body),
        hashlib.sha256,
    ).hexdigest()


def verify_signature(
    *,
    secret: str | None,
    signature_header: str | None,
    timestamp_header: str | None,
    raw_body: bytes,
    max_skew_seconds: int = DEFAULT_MAX_SKEW_SECONDS,
    now: float | None = None,
) -> None:
    """Verify a signed request, raising :class:`SignatureError` on any failure.

    Returns ``None`` on success. Checks run in the cheap-to-expensive order:
    configuration, presence, shape, freshness, then the HMAC itself.
    """
    if not secret:
        raise SecretNotConfigured(
            "the service has no signing secret configured; set ANOMALY_SERVICE_SECRET"
        )
    if not signature_header or not timestamp_header:
        raise MissingSignature(
            f"both {SIGNATURE_HEADER} and {TIMESTAMP_HEADER} are required"
        )

    timestamp = timestamp_header.strip()
    try:
        sent_at = int(timestamp)
    except ValueError:
        raise MalformedSignature(
            f"{TIMESTAMP_HEADER} must be integer Unix seconds"
        ) from None

    candidate = signature_header.strip().lower()
    # Tolerate a "sha256=" prefix so the header survives a proxy or a caller
    # that follows the Stripe/GitHub convention.
    if candidate.startswith("sha256="):
        candidate = candidate[len("sha256=") :]
    if len(candidate) != _SIGNATURE_HEX_LENGTH:
        raise MalformedSignature(f"{SIGNATURE_HEADER} must be 64 hex characters")
    try:
        bytes.fromhex(candidate)
    except ValueError:
        raise MalformedSignature(f"{SIGNATURE_HEADER} must be hex-encoded") from None

    current = time.time() if now is None else now
    skew = abs(current - sent_at)
    if skew > max_skew_seconds:
        raise StaleTimestamp(
            f"{TIMESTAMP_HEADER} is {int(skew)}s away from server time; the window is "
            f"{max_skew_seconds}s"
        )

    expected = sign_payload(secret, timestamp, raw_body)
    if not hmac.compare_digest(expected, candidate):
        raise InvalidSignature("signature does not match the request body")


def verify_admin_token(configured: str | None, presented: str | None) -> None:
    """Guard for ``POST /model/reload``.

    With no token configured this rejects every call, so an operator who never
    set ``ANOMALY_ADMIN_TOKEN`` gets an endpoint nobody can reach rather than
    one anybody can.
    """
    if not configured:
        raise SecretNotConfigured(
            "no admin token configured; set ANOMALY_ADMIN_TOKEN to enable this endpoint"
        )
    if not presented:
        raise MissingSignature(f"{ADMIN_TOKEN_HEADER} is required")
    if not hmac.compare_digest(configured, presented):
        raise InvalidSignature("admin token rejected")


# --------------------------------------------------------------------------- #
# Rate limiting                                                                #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    limit: int
    remaining: int
    retry_after: int


class RateLimiter:
    """In-process sliding-window limiter.

    Deliberately simple and deliberately local. Two consequences an operator
    must know:

    * State lives in **this process**. Run N uvicorn workers and the effective
      limit is N x ``limit``. Run several replicas and it is replicas x N x
      ``limit``. For a global limit, enforce it at the ingress or in Redis;
      this caps the blast radius on a private-network service and is not a
      billing control.
    * State is lost on restart, which is fine for a window measured in seconds.

    Keys are bounded by ``max_keys`` with least-recently-used eviction, so a
    caller cycling source addresses cannot grow the table without limit.
    """

    def __init__(self, limit: int, window_seconds: float, max_keys: int = 4096) -> None:
        self.limit = max(1, int(limit))
        self.window_seconds = float(window_seconds)
        self.max_keys = max(1, int(max_keys))
        self._buckets: OrderedDict[str, Deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def check(self, key: str, now: float | None = None) -> RateLimitDecision:
        """Record a hit for ``key`` and say whether it is allowed.

        Uses a monotonic clock so an NTP step cannot open or close the window.
        """
        current = time.monotonic() if now is None else now
        cutoff = current - self.window_seconds

        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = deque()
                self._buckets[key] = bucket
            self._buckets.move_to_end(key)

            while bucket and bucket[0] <= cutoff:
                bucket.popleft()

            if len(bucket) >= self.limit:
                retry_after = max(1, int(round(bucket[0] + self.window_seconds - current)))
                return RateLimitDecision(
                    allowed=False, limit=self.limit, remaining=0, retry_after=retry_after
                )

            bucket.append(current)
            remaining = self.limit - len(bucket)

            while len(self._buckets) > self.max_keys:
                self._buckets.popitem(last=False)

        return RateLimitDecision(
            allowed=True, limit=self.limit, remaining=remaining, retry_after=0
        )

    def reset(self) -> None:
        """Drop all state. Used by tests; harmless in production."""
        with self._lock:
            self._buckets.clear()
