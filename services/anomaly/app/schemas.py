"""Wire models for the anomaly sidecar (pydantic v2).

THE CONTRACT
------------
:class:`AnomalyFeatureVector` is field-for-field the TypeScript
``AnomalyFeatureVector`` in ``types/domain.ts`` and the SQL composite type
``public.match_anomaly_feature_row``. All three change together; a mismatch
degrades detection without raising anything.

:class:`AnomalyVerdict` is field-for-field what ``anomalyVerdictResponseSchema``
(Zod, ``types/domain.ts``) parses back. A non-strict Zod object drops unknown
keys, so any extra key this service invented would be dropped before the caller
saw it. It invents none.

NAMING
------
Python fields are ``snake_case``; the wire is ``camelCase``.

*Requests* declare a ``validation_alias`` of :class:`~pydantic.AliasChoices`, so
they accept both spellings. Both are needed: the Postgres RPC
``public.anomaly_features(match_id)`` returns ``to_jsonb`` of a composite type
whose keys are ``snake_case``, while the Next.js route sends ``camelCase``.
Accepting both means either producer can be wired straight through with no
translation layer in between. ``venue_bookings_last_7d`` is the one name the
two conventions do not mechanically agree on (``venueBookingsLast7d`` vs the
SQL column ``venue_bookings_last_7d``), so it lists both plus the naive
``venue_bookings_last7d``.

*Responses* use a plain ``alias``, which covers validation **and**
serialization. FastAPI serialises a response model with ``by_alias=True`` and
then re-validates the resulting dict against the same model; a field carrying
only a ``serialization_alias`` fails that round-trip, because the dump emits
``matchId`` and the re-validation looks for ``match_id``. With
``populate_by_name=True`` we still construct them in Python using field names.

VALIDATION POSTURE
------------------
Bounds are set only where the SQL guarantees them (``coalesce``, ``abs``,
``greatest``, ratios). Everything else is deliberately open: rejecting a
feature vector for being *weird* would throw away exactly the rows this service
exists to score. ``reporting_delay_seconds`` in particular is unbounded below,
because it goes negative when a scoreline is filed before the final whistle,
which is a signal for the model to score rather than a row to reject.

``allow_inf_nan=False`` rejects ``Infinity``/``NaN``: neither is representable
in ``numeric(8,6)`` on the way back into Postgres, and both turn the forest's
arithmetic into silent nonsense.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from .model import FEATURE_ORDER, ScoringResult

# --------------------------------------------------------------------------- #
# Shared base                                                                  #
# --------------------------------------------------------------------------- #


class WireModel(BaseModel):
    """Base for every model that crosses the network boundary."""

    model_config = ConfigDict(
        populate_by_name=True,
        extra="ignore",
        allow_inf_nan=False,
        str_strip_whitespace=True,
        # `model_` is a pydantic-protected namespace, but `modelVersion` is this
        # platform's vocabulary: it appears in the SQL contract
        # (`match_anomaly_flags.model_version`) and in the Zod parser. The
        # guard is switched off rather than renaming the wire fields around it.
        protected_namespaces=(),
    )


def _aliases(*names: str) -> AliasChoices:
    return AliasChoices(*names)


def json_schema_of(model: type[BaseModel]) -> dict[str, Any]:
    """Serialization-mode JSON schema, for hand-written ``openapi_extra``.

    Serialization mode because it resolves to a single ``camelCase`` name per
    field, which is the shape callers actually send. Wrapped because a docs
    convenience must never be able to break the import of the service.
    """
    try:
        return model.model_json_schema(by_alias=True, mode="serialization")
    except Exception:  # noqa: BLE001 - documentation is not worth an outage
        return {"type": "object", "title": model.__name__}


# --------------------------------------------------------------------------- #
# Request                                                                      #
# --------------------------------------------------------------------------- #


class AnomalyFeatureVector(WireModel):
    """One match's integrity feature vector.

    ``public.anomaly_features()`` also nests a ``collusion`` object alongside
    these keys. It is accepted and ignored (``extra="ignore"``): the forest was
    never trained on it, and quietly folding an unmodelled signal into the
    score would make the verdict unreproducible.
    """

    match_id: str = Field(
        validation_alias=_aliases("matchId", "match_id"),
        serialization_alias="matchId",
        description="UUID of the match being scored.",
    )
    score_variance: float = Field(
        ge=0.0,
        validation_alias=_aliases("scoreVariance", "score_variance"),
        serialization_alias="scoreVariance",
        description="Variance of reported scorelines across all score_reports for the match.",
    )
    reporting_delay_seconds: float = Field(
        validation_alias=_aliases("reportingDelaySeconds", "reporting_delay_seconds"),
        serialization_alias="reportingDelaySeconds",
        description=(
            "Seconds between kickoff+duration and the first report. Negative when the result "
            "was filed before the final whistle."
        ),
    )
    reporter_count: int = Field(
        ge=0,
        validation_alias=_aliases("reporterCount", "reporter_count"),
        serialization_alias="reporterCount",
        description="How many distinct participants filed a report.",
    )
    opposing_report_agreement: float = Field(
        ge=0.0,
        le=1.0,
        validation_alias=_aliases("opposingReportAgreement", "opposing_report_agreement"),
        serialization_alias="opposingReportAgreement",
        description="Agreement in [0,1] between the home-side and away-side reports.",
    )
    participant_overlap_ratio: float = Field(
        ge=0.0,
        le=1.0,
        validation_alias=_aliases("participantOverlapRatio", "participant_overlap_ratio"),
        serialization_alias="participantOverlapRatio",
        description="Roster overlap in [0,1] with the previous meeting of these two line-ups.",
    )
    historical_report_deviation: float = Field(
        ge=0.0,
        validation_alias=_aliases("historicalReportDeviation", "historical_report_deviation"),
        serialization_alias="historicalReportDeviation",
        description="Deviation of this report from the reporters' historical pattern, in goals.",
    )
    goal_diff: int = Field(
        ge=0,
        validation_alias=_aliases("goalDiff", "goal_diff"),
        serialization_alias="goalDiff",
        description="abs(homeScore - awayScore) of the agreed or first-reported scoreline.",
    )
    kickoff_hour: int = Field(
        ge=0,
        le=23,
        validation_alias=_aliases("kickoffHour", "kickoff_hour"),
        serialization_alias="kickoffHour",
        description="Kickoff hour 0..23 in the venue timezone.",
    )
    venue_bookings_last_7d: int = Field(
        ge=0,
        validation_alias=_aliases(
            "venueBookingsLast7d", "venue_bookings_last_7d", "venue_bookings_last7d"
        ),
        serialization_alias="venueBookingsLast7d",
        description="Bookings at the venue in the trailing 7 days before kickoff.",
    )
    reporter_account_age_days: float = Field(
        ge=0.0,
        validation_alias=_aliases("reporterAccountAgeDays", "reporter_account_age_days"),
        serialization_alias="reporterAccountAgeDays",
        description="Age in days of the first reporter's account, measured at kickoff.",
    )

    @field_validator("match_id", mode="before")
    @classmethod
    def _canonicalise_uuid(cls, value: Any) -> str:
        """Accept any UUID spelling; store the canonical lowercase hyphenated form.

        The id is echoed straight back and handed to ``record_anomaly_verdict``,
        so one that round-tripped in a different case would look like a
        different match to a naive comparison on the caller's side.
        """
        if isinstance(value, UUID):
            return str(value)
        if not isinstance(value, str):
            raise ValueError("matchId must be a UUID string")
        try:
            return str(UUID(value.strip()))
        except (ValueError, AttributeError):
            raise ValueError("matchId must be a valid UUID") from None

    def features(self) -> dict[str, float]:
        """The 10 model inputs, keyed by canonical feature name.

        Built by walking :data:`app.model.FEATURE_ORDER` rather than by hand, so
        adding a feature to the model without adding it here raises an
        ``AttributeError`` immediately instead of quietly feeding a zero.
        """
        return {name: float(getattr(self, name)) for name in FEATURE_ORDER}


class AnomalyBatchRequest(WireModel):
    """Body of ``POST /score/batch``.

    A list rather than a map keyed by id: ``matchId`` is not guaranteed unique
    in the caller's payload -- a re-scoring sweep may legitimately send the same
    match twice -- and a map would silently collapse those.
    """

    matches: list[AnomalyFeatureVector] = Field(
        default_factory=list,
        validation_alias=_aliases("matches", "vectors", "items"),
        serialization_alias="matches",
        description="Feature vectors to score. Capped by ANOMALY_MAX_BATCH_SIZE.",
    )


# --------------------------------------------------------------------------- #
# Response                                                                     #
# --------------------------------------------------------------------------- #


class AnomalyVerdict(WireModel):
    """What the sidecar answers, and what ``record_anomaly_verdict`` persists.

    ``leafDepth`` and ``averagePathLength`` are ``null`` under the rule-engine
    fallback, because there is no tree and therefore no path to measure.
    ``modelVersion`` says which scorer answered: ``if-v1`` (trained Isolation
    Forest) or ``rules-fallback-v1`` (deterministic cold-start rules).
    """

    match_id: str = Field(alias="matchId")
    anomaly_score: float = Field(
        ge=0.0,
        le=1.0,
        alias="anomalyScore",
        description=(
            "2 ** (-E[h(x)] / c(n)). Higher is more anomalous, because a SHORT path means the "
            "vector was isolated near the root."
        ),
    )
    is_anomalous: bool = Field(alias="isAnomalous", description="anomalyScore >= threshold.")
    leaf_depth: int | None = Field(
        default=None,
        alias="leafDepth",
        description="Mean raw leaf depth across the ensemble. null under the rules fallback.",
    )
    average_path_length: float | None = Field(
        default=None,
        alias="averagePathLength",
        description="E[h(x)], truncated-leaf corrected. null under the rules fallback.",
    )
    model_version: str = Field(max_length=64, alias="modelVersion")
    threshold: float = Field(
        ge=0.0,
        le=1.0,
        description="Score at or above which the match is flagged for peer consensus.",
    )
    reasons: list[Annotated[str, Field(max_length=280)]] = Field(
        default_factory=list,
        description="Human-readable, heuristic explanations. Not SHAP -- see app/model.py.",
    )

    @classmethod
    def from_result(cls, result: ScoringResult) -> "AnomalyVerdict":
        return cls(
            match_id=result.match_id,
            anomaly_score=result.anomaly_score,
            is_anomalous=result.is_anomalous,
            leaf_depth=result.leaf_depth,
            average_path_length=result.average_path_length,
            model_version=result.model_version,
            threshold=result.threshold,
            reasons=list(result.reasons),
        )


class AnomalyBatchResponse(WireModel):
    """Body of ``POST /score/batch``.

    ``results`` preserves request order one-for-one, so the caller can zip it
    against what it sent instead of matching on id (which is not unique).
    """

    results: list[AnomalyVerdict] = Field(default_factory=list)
    count: int = Field(description="len(results); echoed so a truncated read is obvious.")
    model_version: str = Field(alias="modelVersion")
    threshold: float
    scored_at: str = Field(alias="scoredAt")
    flagged_count: int = Field(
        alias="flaggedCount", description="How many results crossed the threshold."
    )

    @classmethod
    def from_results(
        cls, results: list[AnomalyVerdict], model_version: str, threshold: float
    ) -> "AnomalyBatchResponse":
        return cls(
            results=results,
            count=len(results),
            model_version=model_version,
            threshold=threshold,
            scored_at=datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            flagged_count=sum(1 for verdict in results if verdict.is_anomalous),
        )


# --------------------------------------------------------------------------- #
# Operational endpoints                                                        #
# --------------------------------------------------------------------------- #


class HealthResponse(WireModel):
    """``GET /healthz``. Unauthenticated so an orchestrator can poll it.

    Reveals liveness and which scorer is active, and nothing else: no
    thresholds, no paths, no configuration.
    """

    status: str
    service: str
    version: str
    model_loaded: bool = Field(alias="modelLoaded")
    model_version: str = Field(alias="modelVersion")
    uptime_seconds: float = Field(alias="uptimeSeconds")


class ModelInfoResponse(WireModel):
    """``GET /model/info``. Authenticated -- it describes the training corpus.

    ``extra="allow"`` on purpose: :meth:`app.model.AnomalyDetector.info` grows
    diagnostic keys over time (``cNorm``, ``suggestedThreshold``,
    ``sklearnVersion``, ...) and they should reach an operator without a schema
    edit here. The fields named below are the ones callers may rely on.
    """

    model_config = ConfigDict(
        populate_by_name=True,
        extra="allow",
        allow_inf_nan=False,
        protected_namespaces=(),
    )

    service: str
    version: str
    model_version: str = Field(alias="modelVersion")
    is_trained: bool = Field(alias="isTrained")
    threshold: float
    feature_order: list[str] = Field(alias="featureOrder")


class ModelReloadResponse(WireModel):
    """``POST /model/reload``."""

    model_config = ConfigDict(
        populate_by_name=True,
        extra="allow",
        allow_inf_nan=False,
        protected_namespaces=(),
    )

    reloaded: bool
    model_version: str = Field(alias="modelVersion")
    detail: str


class ErrorBody(WireModel):
    code: str
    message: str


class ErrorResponse(WireModel):
    """Every non-2xx body. One shape, so callers branch on ``error.code``."""

    error: ErrorBody
    request_id: str | None = Field(default=None, alias="requestId")
