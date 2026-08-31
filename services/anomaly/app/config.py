"""Environment-driven configuration for the anomaly sidecar.

Standard library only: nothing here should force a pydantic import, so that
``app.model`` and ``app.security`` stay usable (and testable) on their own.

Every knob has a default except the signing secret. The service refuses to
start without it unless ``ANOMALY_ALLOW_UNSIGNED=true`` is set, which is meant
for local development and is itself refused when ``ANOMALY_ENV=production``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .model import (
    DEFAULT_CONTAMINATION,
    DEFAULT_N_ESTIMATORS,
    DEFAULT_RANDOM_STATE,
    DEFAULT_THRESHOLD,
)
from .security import DEFAULT_MAX_SKEW_SECONDS

SERVICE_NAME = "halisaha-anomaly"

#: Bumped by hand when the HTTP surface changes. Tracked separately from
#: MODEL_VERSION so that a retrain does not read as a deploy.
SERVICE_VERSION = "1.0.0"

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}


class ConfigError(RuntimeError):
    """Raised at startup for a configuration the service refuses to run with."""


def _env(name: str, default: str | None = None) -> str | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    return raw if raw else default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    lowered = raw.lower()
    if lowered in _TRUTHY:
        return True
    if lowered in _FALSY:
        return False
    raise ConfigError(f"{name} must be one of {sorted(_TRUTHY | _FALSY)}, got {raw!r}")


def _env_int(name: str, default: int, *, minimum: int | None = None) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from None
    if minimum is not None and value < minimum:
        raise ConfigError(f"{name} must be >= {minimum}, got {value}")
    return value


def _env_float(name: str, default: float, *, minimum: float | None = None,
               maximum: float | None = None) -> float:
    raw = _env(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from None
    if minimum is not None and value < minimum:
        raise ConfigError(f"{name} must be >= {minimum}, got {value}")
    if maximum is not None and value > maximum:
        raise ConfigError(f"{name} must be <= {maximum}, got {value}")
    return value


def _env_contamination(name: str, default: float | str) -> float | str:
    """``auto`` or a float in ``(0, 0.5]``, the range sklearn accepts."""
    raw = _env(name)
    if raw is None:
        return default
    if raw.lower() == "auto":
        return "auto"
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be 'auto' or a float, got {raw!r}") from None
    if not 0.0 < value <= 0.5:
        raise ConfigError(f"{name} must be in (0, 0.5], got {value}")
    return value


def _env_origins(name: str, default: str) -> tuple[str, ...]:
    raw = _env(name, default) or ""
    return tuple(origin.strip() for origin in raw.split(",") if origin.strip())


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of the process environment."""

    environment: str = "development"
    log_level: str = "INFO"

    # --- authentication ---------------------------------------------------- #
    signing_secret: str | None = None
    allow_unsigned: bool = False
    max_clock_skew_seconds: int = DEFAULT_MAX_SKEW_SECONDS
    admin_token: str | None = None

    # --- model ------------------------------------------------------------- #
    model_dir: Path = field(default_factory=lambda: Path("artifacts"))
    threshold: float = DEFAULT_THRESHOLD
    n_estimators: int = DEFAULT_N_ESTIMATORS
    contamination: float | str = DEFAULT_CONTAMINATION
    random_state: int = DEFAULT_RANDOM_STATE

    # --- transport --------------------------------------------------------- #
    allowed_origins: tuple[str, ...] = ("http://localhost:3000",)
    rate_limit_requests: int = 120
    rate_limit_window_seconds: float = 60.0
    max_batch_size: int = 200
    max_body_bytes: int = 1_048_576  # 1 MiB; a 200-row batch is ~60 KB

    @property
    def signing_required(self) -> bool:
        return not self.allow_unsigned

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}

    def redacted(self) -> dict[str, object]:
        """Loggable view. Secrets are reported as booleans, not as prefixes."""
        return {
            "environment": self.environment,
            "logLevel": self.log_level,
            "signingRequired": self.signing_required,
            "hasSigningSecret": bool(self.signing_secret),
            "hasAdminToken": bool(self.admin_token),
            "maxClockSkewSeconds": self.max_clock_skew_seconds,
            "modelDir": str(self.model_dir),
            "threshold": self.threshold,
            "allowedOrigins": list(self.allowed_origins),
            "rateLimitRequests": self.rate_limit_requests,
            "rateLimitWindowSeconds": self.rate_limit_window_seconds,
            "maxBatchSize": self.max_batch_size,
        }


def load_settings() -> Settings:
    """Read the environment, validating as we go.

    Raises :class:`ConfigError` instead of starting up in a state an operator
    would only discover from a 500 later.
    """
    allow_unsigned = _env_bool("ANOMALY_ALLOW_UNSIGNED", False)
    secret = _env("ANOMALY_SERVICE_SECRET")
    environment = _env("ANOMALY_ENV", "development") or "development"

    if not secret and not allow_unsigned:
        raise ConfigError(
            "ANOMALY_SERVICE_SECRET is not set. It must match the value the Next.js app "
            "signs with. For local development only, set ANOMALY_ALLOW_UNSIGNED=true."
        )
    if allow_unsigned and environment.lower() in {"production", "prod"}:
        raise ConfigError(
            "ANOMALY_ALLOW_UNSIGNED=true is refused when ANOMALY_ENV=production. "
            "The scoring endpoint would accept any caller that can reach the port."
        )
    if secret and len(secret) < 32 and not allow_unsigned:
        raise ConfigError(
            "ANOMALY_SERVICE_SECRET must be at least 32 characters. Generate one with "
            "`openssl rand -hex 32`."
        )

    return Settings(
        environment=environment,
        log_level=(_env("ANOMALY_LOG_LEVEL", "INFO") or "INFO").upper(),
        signing_secret=secret,
        allow_unsigned=allow_unsigned,
        max_clock_skew_seconds=_env_int(
            "ANOMALY_MAX_CLOCK_SKEW_SECONDS", DEFAULT_MAX_SKEW_SECONDS, minimum=1
        ),
        # Falls back to the token that already guards /api/internal/* so a
        # single-secret deployment stays possible without inventing a new one.
        admin_token=_env("ANOMALY_ADMIN_TOKEN") or _env("INTERNAL_API_TOKEN"),
        model_dir=Path(_env("ANOMALY_MODEL_DIR", "artifacts") or "artifacts"),
        threshold=_env_float("ANOMALY_THRESHOLD", DEFAULT_THRESHOLD, minimum=0.0, maximum=1.0),
        n_estimators=_env_int("ANOMALY_N_ESTIMATORS", DEFAULT_N_ESTIMATORS, minimum=1),
        contamination=_env_contamination("ANOMALY_CONTAMINATION", DEFAULT_CONTAMINATION),
        random_state=_env_int("ANOMALY_RANDOM_STATE", DEFAULT_RANDOM_STATE),
        allowed_origins=_env_origins("ANOMALY_ALLOWED_ORIGINS", "http://localhost:3000"),
        rate_limit_requests=_env_int("ANOMALY_RATE_LIMIT", 120, minimum=1),
        rate_limit_window_seconds=_env_float(
            "ANOMALY_RATE_LIMIT_WINDOW_SECONDS", 60.0, minimum=0.1
        ),
        max_batch_size=_env_int("ANOMALY_MAX_BATCH_SIZE", 200, minimum=1),
        max_body_bytes=_env_int("ANOMALY_MAX_BODY_BYTES", 1_048_576, minimum=1024),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, read once."""
    return load_settings()


def reset_settings_cache() -> None:
    """Forget the cached settings. For tests that patch the environment."""
    get_settings.cache_clear()
