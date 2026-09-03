"""FastAPI surface for the OnPitch anomaly sidecar.

Endpoints
---------
``POST /score``         one feature vector  -> one verdict          (signed)
``POST /score/batch``   many vectors        -> many verdicts        (signed)
``GET  /healthz``       liveness + which scorer is active           (open)
``GET  /model/info``    model + training metadata                   (signed)
``POST /model/reload``  re-read the artefact directory              (admin token)

Design notes
------------
**The body is authenticated before it is parsed.** The scoring handlers take a
raw :class:`~starlette.requests.Request` and verify the HMAC over the exact
bytes received, then parse. Letting FastAPI bind a pydantic body parameter
would run the JSON parser -- and return a 422 that distinguishes well-formed
from malformed payloads -- before anyone proved they were allowed to talk to
us.

**This service is advisory and must never be load-bearing.** The Next.js route
gives it 2.5 seconds and falls back to the in-database rule engine on any
non-2xx or timeout. That means no unbounded work, no blocking I/O, no startup
that can fail because a model file is missing, and a rule-based answer whenever
the forest cannot answer.

**Every failure has one shape:** ``{"error": {"code", "message"}, "requestId"}``,
so the caller can branch on a slug rather than on prose.
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any, AsyncIterator, Callable

from fastapi import Depends, FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .config import SERVICE_NAME, SERVICE_VERSION, ConfigError, Settings, get_settings
from .model import AnomalyDetector
from .schemas import (
    AnomalyBatchRequest,
    AnomalyBatchResponse,
    AnomalyFeatureVector,
    AnomalyVerdict,
    ErrorBody,
    ErrorResponse,
    HealthResponse,
    ModelInfoResponse,
    ModelReloadResponse,
    json_schema_of,
)
from .security import (
    ADMIN_TOKEN_HEADER,
    REQUEST_ID_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    RateLimiter,
    SignatureError,
    verify_admin_token,
    verify_signature,
)

# --------------------------------------------------------------------------- #
# Structured logging                                                           #
# --------------------------------------------------------------------------- #

_request_id: ContextVar[str] = ContextVar("request_id", default="-")

_LOG_RECORD_BUILTINS = frozenset(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys()
) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    """One JSON object per line, on stdout.

    Container log collectors parse lines, not tracebacks, so the exception text
    is folded into the object rather than trailing after it.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "requestId": _request_id.get(),
        }
        for key, value in record.__dict__.items():
            if key not in _LOG_RECORD_BUILTINS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, ensure_ascii=False)


def configure_logging(level: str) -> None:
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # uvicorn installs its own handlers; route them through ours so the log is
    # one machine-readable stream rather than two interleaved formats.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = [handler]
        uvicorn_logger.propagate = False


logger = logging.getLogger("onpitch.anomaly")


# --------------------------------------------------------------------------- #
# Errors                                                                       #
# --------------------------------------------------------------------------- #


class ServiceError(Exception):
    """An error we chose to return. Carries its own status code and slug."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorBody(code=code, message=message), request_id=_request_id.get()
    )
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(by_alias=True),
        headers={REQUEST_ID_HEADER: _request_id.get()},
    )


# --------------------------------------------------------------------------- #
# Application state                                                            #
# --------------------------------------------------------------------------- #


class ServiceState:
    """Everything the handlers need, built once at startup."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.started_at = time.monotonic()
        self.detector = AnomalyDetector(
            model_dir=settings.model_dir,
            threshold=settings.threshold,
            n_estimators=settings.n_estimators,
            contamination=settings.contamination,
            random_state=settings.random_state,
        )
        self.rate_limiter = RateLimiter(
            limit=settings.rate_limit_requests,
            window_seconds=settings.rate_limit_window_seconds,
        )

    @property
    def uptime_seconds(self) -> float:
        return time.monotonic() - self.started_at


def get_state(request: Request) -> ServiceState:
    state: ServiceState | None = getattr(request.app.state, "service", None)
    if state is None:  # pragma: no cover - only reachable if lifespan was skipped
        raise ServiceError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "not_ready", "the service is still starting"
        )
    return state


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    state = ServiceState(settings)
    # Loading is best-effort: a missing artefact leaves the rule engine in
    # charge and the service keeps answering.
    report = state.detector.load()
    app.state.service = state
    logger.info(
        "service.started",
        extra={
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "modelVersion": report.model_version,
            "modelLoaded": report.loaded,
            "config": settings.redacted(),
        },
    )
    try:
        yield
    finally:
        logger.info("service.stopping", extra={"uptimeSeconds": round(state.uptime_seconds, 3)})


# --------------------------------------------------------------------------- #
# Dependencies                                                                 #
# --------------------------------------------------------------------------- #


def _client_key(request: Request) -> str:
    client = request.client
    return client.host if client and client.host else "unknown"


async def enforce_rate_limit(request: Request) -> None:
    """Cheap gate, run before the HMAC so a flood costs no crypto.

    Deliberately keyed on the peer address rather than on anything in the
    request: the point is to cap a single misbehaving caller, and nothing in an
    unauthenticated request can be trusted as an identity.
    """
    state = get_state(request)
    decision = state.rate_limiter.check(_client_key(request))
    if not decision.allowed:
        raise ServiceError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "rate_limited",
            f"more than {decision.limit} requests in "
            f"{state.settings.rate_limit_window_seconds:g}s; retry in "
            f"{decision.retry_after}s",
        )


async def require_signed_request(request: Request) -> bytes:
    """Verify the HMAC and hand back the raw body.

    Returning the bytes (rather than re-reading them in the handler) makes it
    structurally impossible for a handler to parse something other than what
    was signed.
    """
    state = get_state(request)
    settings = state.settings

    # Check the declared length before buffering, so an oversized payload costs
    # us a header parse rather than a megabyte of memory. The post-read check
    # below still stands, because Content-Length is the client's claim and a
    # chunked request has none at all.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > settings.max_body_bytes:
        raise ServiceError(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "body_too_large",
            f"request body exceeds {settings.max_body_bytes} bytes",
        )

    raw = await request.body()
    if len(raw) > settings.max_body_bytes:
        raise ServiceError(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "body_too_large",
            f"request body exceeds {settings.max_body_bytes} bytes",
        )

    if not settings.signing_required:
        logger.warning("auth.unsigned_request_allowed", extra={"path": request.url.path})
        return raw

    try:
        verify_signature(
            secret=settings.signing_secret,
            signature_header=request.headers.get(SIGNATURE_HEADER),
            timestamp_header=request.headers.get(TIMESTAMP_HEADER),
            raw_body=raw,
            max_skew_seconds=settings.max_clock_skew_seconds,
        )
    except SignatureError as exc:
        logger.warning(
            "auth.rejected",
            extra={"reason": exc.code, "path": request.url.path, "peer": _client_key(request)},
        )
        raise ServiceError(status.HTTP_401_UNAUTHORIZED, exc.code, exc.message) from exc
    return raw


async def require_admin(request: Request) -> None:
    state = get_state(request)
    try:
        verify_admin_token(
            state.settings.admin_token, request.headers.get(ADMIN_TOKEN_HEADER)
        )
    except SignatureError as exc:
        logger.warning("auth.admin_rejected", extra={"reason": exc.code})
        raise ServiceError(status.HTTP_401_UNAUTHORIZED, exc.code, exc.message) from exc


def _parse_json(raw: bytes, model: type[Any]) -> Any:
    if not raw:
        raise ServiceError(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "empty_body", "a JSON body is required"
        )
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        errors = exc.errors()
        # Pydantic reports "the bytes were not JSON" and "the JSON did not fit
        # the schema" through the same exception. They are different bugs on
        # the caller's side and get different codes.
        if any(err.get("type") == "json_invalid" for err in errors):
            raise ServiceError(
                status.HTTP_400_BAD_REQUEST, "malformed_json", "request body is not valid JSON"
            ) from exc
        # The error list names the offending fields, which is what a caller
        # debugging contract drift needs, and contains nothing they did not
        # already send us.
        detail = "; ".join(
            f"{'.'.join(str(part) for part in err['loc'])}: {err['msg']}" for err in errors[:6]
        )
        raise ServiceError(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_feature_vector", detail
        ) from exc


# --------------------------------------------------------------------------- #
# Application                                                                  #
# --------------------------------------------------------------------------- #

app = FastAPI(
    title="OnPitch anomaly service",
    version=SERVICE_VERSION,
    description=(
        "Isolation Forest scoring for match-integrity signals. Advisory only: the platform "
        "finalises matches whether or not this service answers."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
)

_settings_for_cors = None
try:
    _settings_for_cors = get_settings()
except ConfigError:
    # Startup will raise this again with a proper log line; here we only need
    # something to hand the CORS middleware.
    pass

app.add_middleware(
    CORSMiddleware,
    # Locked to the app origin. Browsers never call this service; the caller is
    # a Next.js route handler, server to server. The allow-list only guards
    # against a misconfigured ingress publishing the port, and nothing depends
    # on it.
    allow_origins=list(_settings_for_cors.allowed_origins) if _settings_for_cors else [],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        SIGNATURE_HEADER,
        TIMESTAMP_HEADER,
        ADMIN_TOKEN_HEADER,
        REQUEST_ID_HEADER,
    ],
    max_age=600,
)


@app.middleware("http")
async def request_context(request: Request, call_next: Callable) -> Response:
    """Assign a request id, time the request, emit exactly one access line.

    The id is set on a ContextVar *before* ``call_next``, which is what makes
    it visible to every log record the handler emits: Starlette runs the
    downstream app in a child task, and a child task inherits a copy of the
    context as it stands at spawn time.
    """
    incoming = request.headers.get(REQUEST_ID_HEADER, "").strip()
    request_id = incoming[:64] if incoming else uuid.uuid4().hex
    token = _request_id.set(request_id)
    started = time.perf_counter()
    try:
        try:
            response = await call_next(request)
        except ServiceError as exc:
            response = _error_response(exc.status_code, exc.code, exc.message)
        except Exception:  # noqa: BLE001 - never leak a stack trace to the caller
            logger.exception("request.unhandled", extra={"path": request.url.path})
            response = _error_response(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "internal_error",
                "unexpected server error",
            )
        response.headers[REQUEST_ID_HEADER] = request_id
        logger.info(
            "request.completed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
            },
        )
        return response
    finally:
        # Reset last, so the access line above still carries the id.
        _request_id.reset(token)


@app.exception_handler(ServiceError)
async def service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
    return _error_response(exc.status_code, exc.code, exc.message)


# The OpenAPI request bodies. The scoring handlers read raw bytes so they can
# authenticate before parsing, which means FastAPI cannot infer the schema.
_SCORE_BODY = {
    "requestBody": {
        "required": True,
        "content": {"application/json": {"schema": json_schema_of(AnomalyFeatureVector)}},
    }
}
_BATCH_BODY = {
    "requestBody": {
        "required": True,
        "content": {"application/json": {"schema": json_schema_of(AnomalyBatchRequest)}},
    }
}


# --------------------------------------------------------------------------- #
# Routes                                                                       #
# --------------------------------------------------------------------------- #


@app.get(
    "/healthz",
    response_model=HealthResponse,
    tags=["ops"],
    summary="Liveness probe",
)
async def healthz(request: Request) -> HealthResponse:
    """Unauthenticated, because orchestrators cannot sign requests.

    It exposes liveness and which scorer is active, which an attacker who can
    already reach the port learns from a single failed request anyway.
    """
    state = get_state(request)
    return HealthResponse(
        status="ok",
        service=SERVICE_NAME,
        version=SERVICE_VERSION,
        model_loaded=state.detector.is_trained,
        model_version=state.detector.model_version,
        uptime_seconds=round(state.uptime_seconds, 3),
    )


@app.post(
    "/score",
    response_model=AnomalyVerdict,
    responses={401: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
    dependencies=[Depends(enforce_rate_limit)],
    openapi_extra=_SCORE_BODY,
    tags=["scoring"],
    summary="Score one match feature vector",
)
async def score(
    request: Request, raw: bytes = Depends(require_signed_request)
) -> AnomalyVerdict:
    state = get_state(request)
    vector: AnomalyFeatureVector = _parse_json(raw, AnomalyFeatureVector)
    result = state.detector.score_one(vector.match_id, vector.features())
    logger.info(
        "score.completed",
        extra={
            "matchId": result.match_id,
            "anomalyScore": result.anomaly_score,
            "isAnomalous": result.is_anomalous,
            "modelVersion": result.model_version,
            "leafDepth": result.leaf_depth,
        },
    )
    return AnomalyVerdict.from_result(result)


@app.post(
    "/score/batch",
    response_model=AnomalyBatchResponse,
    responses={401: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
    dependencies=[Depends(enforce_rate_limit)],
    openapi_extra=_BATCH_BODY,
    tags=["scoring"],
    summary="Score many match feature vectors",
)
async def score_batch(
    request: Request, raw: bytes = Depends(require_signed_request)
) -> AnomalyBatchResponse:
    """Used by the ``anomaly-sweep`` Edge Function to drain
    ``matches_pending_anomaly_check()``.

    The batch is capped rather than streamed: this endpoint runs on the event
    loop, and an unbounded batch would block it for every other caller.
    """
    state = get_state(request)
    payload: AnomalyBatchRequest = _parse_json(raw, AnomalyBatchRequest)

    if not payload.matches:
        raise ServiceError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "empty_batch",
            "`matches` must contain at least one feature vector",
        )
    if len(payload.matches) > state.settings.max_batch_size:
        raise ServiceError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "batch_too_large",
            f"batch of {len(payload.matches)} exceeds the limit of "
            f"{state.settings.max_batch_size}; page the sweep",
        )

    results = state.detector.score_many(
        [(vector.match_id, vector.features()) for vector in payload.matches]
    )
    verdicts = [AnomalyVerdict.from_result(result) for result in results]
    response = AnomalyBatchResponse.from_results(
        verdicts, state.detector.model_version, state.settings.threshold
    )
    logger.info(
        "score.batch_completed",
        extra={
            "count": response.count,
            "flaggedCount": response.flagged_count,
            "modelVersion": response.model_version,
        },
    )
    return response


@app.get(
    "/model/info",
    response_model=ModelInfoResponse,
    responses={401: {"model": ErrorResponse}},
    dependencies=[Depends(enforce_rate_limit)],
    tags=["ops"],
    summary="Model and training metadata",
)
async def model_info(
    request: Request, raw: bytes = Depends(require_signed_request)
) -> ModelInfoResponse:
    """Signed like the scoring endpoints -- it describes the training corpus.

    A GET has no body, so the signed string is ``f"{timestamp}."`` with an
    empty payload. See ``app/security.py`` and the README for a curl recipe.
    """
    del raw
    state = get_state(request)
    return ModelInfoResponse(
        service=SERVICE_NAME,
        version=SERVICE_VERSION,
        **state.detector.info(),
    )


@app.post(
    "/model/reload",
    response_model=ModelReloadResponse,
    responses={401: {"model": ErrorResponse}},
    dependencies=[Depends(enforce_rate_limit), Depends(require_admin)],
    tags=["ops"],
    summary="Re-read the model artefacts from disk",
)
async def model_reload(request: Request) -> ModelReloadResponse:
    """The replacement snapshot is built before the swap, so scoring never sees
    a window with no model. A reload that fails leaves the previous scorer in
    place and reports why.

    This is how a retrain goes live without a restart: write the new
    ``model.joblib`` + ``metadata.json`` into the artefact directory, then POST
    here with the admin token.
    """
    state = get_state(request)
    report = state.detector.reload()
    logger.info(
        "model.reload_requested",
        extra={"loaded": report.loaded, "modelVersion": report.model_version},
    )
    return ModelReloadResponse(
        reloaded=report.loaded,
        model_version=report.model_version,
        detail=report.detail,
        trainedAt=report.trained_at,
        nTrainingSamples=report.n_training_samples,
    )
