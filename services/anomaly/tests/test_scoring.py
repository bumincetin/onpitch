"""Tests for the anomaly sidecar.

Run from ``services/anomaly``::

    pip install -r requirements.txt "pytest>=8.2,<9" "httpx>=0.27,<0.29"
    pytest -q

Everything here runs against the **rule-engine fallback**; no artefact is
written to disk. The cold-start path is what ships on day one and what the
service falls back to whenever a model file is missing or corrupt, so it is the
path that most needs a regression net. The properties that matter for a trained
forest (that ``c(n)`` is right, that a short path scores high) are exercised
directly against the math instead of against a fitted model, which keeps the
suite fast and free of a checked-in binary.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import time
from pathlib import Path

import pytest

from app import model as model_module
from app.model import (
    DEFAULT_THRESHOLD,
    FALLBACK_MODEL_VERSION,
    FEATURE_ORDER,
    AnomalyDetector,
    anomaly_score_from_path_length,
    empirical_percentile,
    expected_path_length,
    percentile_severity,
    quantile_key,
    rule_based_score,
)
from app.security import (
    ADMIN_TOKEN_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    InvalidSignature,
    MalformedSignature,
    MissingSignature,
    RateLimiter,
    SecretNotConfigured,
    StaleTimestamp,
    sign_payload,
    verify_signature,
)

SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ADMIN_TOKEN = "admin-token-for-tests-0123456789"
MATCH_ID = "6f1b0b16-4d1b-4a9e-9f31-1f0a2b3c4d5e"


# --------------------------------------------------------------------------- #
# Fixtures                                                                     #
# --------------------------------------------------------------------------- #


def normal_vector(**overrides: float) -> dict[str, float]:
    """A Tuesday-night seven-a-side that nobody would look at twice.

    Both captains filed the same scoreline 15 minutes after the whistle, the
    accounts are old, the venue is busy, the sides have played all over the
    city.
    """
    vector: dict[str, float] = {
        "matchId": MATCH_ID,
        "scoreVariance": 0.0,
        "reportingDelaySeconds": 900.0,
        "reporterCount": 4,
        "opposingReportAgreement": 1.0,
        "participantOverlapRatio": 0.12,
        "historicalReportDeviation": 0.2,
        "goalDiff": 2,
        "kickoffHour": 20,
        "venueBookingsLast7d": 41,
        "reporterAccountAgeDays": 430.0,
    }
    vector.update(overrides)
    return vector


def anomalous_vector(**overrides: float) -> dict[str, float]:
    """The vector from ``docs/API.md``: the two camps contradict each other,
    the same two groups only ever play each other, and the reporter's account
    is two days old."""
    vector: dict[str, float] = {
        "matchId": MATCH_ID,
        "scoreVariance": 4.0,
        "reportingDelaySeconds": 120.0,
        "reporterCount": 2,
        "opposingReportAgreement": 0.0,
        "participantOverlapRatio": 0.9,
        "historicalReportDeviation": 2.1,
        "goalDiff": 9,
        "kickoffHour": 23,
        "venueBookingsLast7d": 1,
        "reporterAccountAgeDays": 2.0,
    }
    vector.update(overrides)
    return vector


def to_features(wire: dict[str, float]) -> dict[str, float]:
    """Wire payload -> the 10 model inputs, via the real pydantic model."""
    from app.schemas import AnomalyFeatureVector

    return AnomalyFeatureVector.model_validate(wire).features()


@pytest.fixture()
def cold_detector(tmp_path: Path) -> AnomalyDetector:
    """A detector pointed at an empty directory: no artefact, rules engaged."""
    detector = AnomalyDetector(model_dir=tmp_path / "artifacts", threshold=DEFAULT_THRESHOLD)
    detector.load()
    return detector


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A ``TestClient`` over a freshly configured app.

    ``app.config`` caches settings for the process, and ``app.main`` builds its
    CORS middleware at import time, so both are reloaded after the environment
    is patched rather than reusing whatever an earlier test left behind.
    """
    from fastapi.testclient import TestClient

    monkeypatch.setenv("ANOMALY_SERVICE_SECRET", SECRET)
    monkeypatch.setenv("ANOMALY_ADMIN_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("ANOMALY_MODEL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("ANOMALY_ENV", "test")
    monkeypatch.setenv("ANOMALY_LOG_LEVEL", "WARNING")
    monkeypatch.setenv("ANOMALY_RATE_LIMIT", "1000")
    monkeypatch.delenv("ANOMALY_ALLOW_UNSIGNED", raising=False)
    monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)

    from app import config as config_module

    config_module.reset_settings_cache()
    main_module = importlib.reload(importlib.import_module("app.main"))

    with TestClient(main_module.app) as test_client:
        yield test_client

    config_module.reset_settings_cache()


def signed(payload: dict | None, *, secret: str = SECRET, skew: int = 0) -> tuple[bytes, dict]:
    """Serialise once, sign those exact bytes, return both.

    The bytes that are signed are the bytes that are sent; a test that
    re-serialised would pass while production failed on key order.
    """
    raw = b"" if payload is None else json.dumps(payload).encode("utf-8")
    timestamp = str(int(time.time()) + skew)
    return raw, {
        TIMESTAMP_HEADER: timestamp,
        SIGNATURE_HEADER: sign_payload(secret, timestamp, raw),
        "Content-Type": "application/json",
    }


# --------------------------------------------------------------------------- #
# (a) An obviously anomalous vector scores above the threshold                 #
# --------------------------------------------------------------------------- #


def test_anomalous_vector_scores_above_threshold(cold_detector: AnomalyDetector) -> None:
    result = cold_detector.score_one(MATCH_ID, to_features(anomalous_vector()))

    assert result.anomaly_score > DEFAULT_THRESHOLD
    assert result.is_anomalous is True
    assert result.threshold == DEFAULT_THRESHOLD
    assert result.reasons, "a flagged match must come with an explanation"
    assert len(result.reasons) <= model_module.MAX_REASONS
    assert all(len(reason) <= model_module.MAX_REASON_CHARS for reason in result.reasons)


def test_contradicting_sides_alone_are_enough_to_flag(cold_detector: AnomalyDetector) -> None:
    """A flat contradiction between the two camps trips the two strongest rules
    in the engine, and must clear the threshold with no other signal present."""
    vector = normal_vector(scoreVariance=4.0, opposingReportAgreement=0.0)
    result = cold_detector.score_one(MATCH_ID, to_features(vector))

    assert result.is_anomalous is True
    assert any("disagree" in reason or "different stories" in reason for reason in result.reasons)


def test_result_filed_before_the_final_whistle_is_flagged(
    cold_detector: AnomalyDetector,
) -> None:
    vector = normal_vector(reportingDelaySeconds=-2400.0, reporterCount=1, kickoffHour=3)
    result = cold_detector.score_one(MATCH_ID, to_features(vector))

    assert result.is_anomalous is True
    assert any("BEFORE the final whistle" in reason for reason in result.reasons)


@pytest.mark.parametrize(
    "field,value",
    [
        ("scoreVariance", 9.0),
        ("participantOverlapRatio", 1.0),
        ("reporterAccountAgeDays", 0.0),
        ("goalDiff", 22),
    ],
)
def test_each_signal_moves_the_score_up(
    cold_detector: AnomalyDetector, field: str, value: float
) -> None:
    """Monotonicity: pushing any single feature into its suspicious tail must
    raise the score, never lower it."""
    baseline = cold_detector.score_one(MATCH_ID, to_features(normal_vector()))
    worse = cold_detector.score_one(MATCH_ID, to_features(normal_vector(**{field: value})))

    assert worse.anomaly_score > baseline.anomaly_score


# --------------------------------------------------------------------------- #
# (b) A normal vector scores below the threshold                               #
# --------------------------------------------------------------------------- #


def test_normal_vector_scores_below_threshold(cold_detector: AnomalyDetector) -> None:
    result = cold_detector.score_one(MATCH_ID, to_features(normal_vector()))

    assert result.anomaly_score < DEFAULT_THRESHOLD
    assert result.is_anomalous is False
    assert result.reasons == []


def test_mildly_odd_match_is_not_flagged(cold_detector: AnomalyDetector) -> None:
    """A late report and a half-agreeing pair of reports is a normal messy
    Sunday. Flagging it would send real players into a consensus round for
    nothing."""
    vector = normal_vector(
        scoreVariance=1.0,
        opposingReportAgreement=0.5,
        reportingDelaySeconds=21_600.0,
        reporterCount=2,
    )
    result = cold_detector.score_one(MATCH_ID, to_features(vector))

    assert result.is_anomalous is False


def test_scores_are_bounded_and_deterministic(cold_detector: AnomalyDetector) -> None:
    for wire in (normal_vector(), anomalous_vector()):
        features = to_features(wire)
        first = cold_detector.score_one(MATCH_ID, features)
        second = cold_detector.score_one(MATCH_ID, features)
        assert first == second, "the rule engine must be deterministic"
        assert 0.0 <= first.anomaly_score <= 1.0


# --------------------------------------------------------------------------- #
# (c) Signature verification                                                   #
# --------------------------------------------------------------------------- #


def test_signature_round_trip() -> None:
    raw = b'{"matchId":"x"}'
    timestamp = str(int(time.time()))
    verify_signature(
        secret=SECRET,
        signature_header=sign_payload(SECRET, timestamp, raw),
        timestamp_header=timestamp,
        raw_body=raw,
    )


def test_signature_matches_the_nodejs_construction() -> None:
    """Pin the exact bytes that are MACed: ``timestamp + "." + body``.

    Computed here from primitives rather than by calling ``sign_payload``, so
    this test fails if the signing string is ever quietly redefined.
    """
    timestamp = "1700000000"
    raw = b'{"matchId":"abc"}'
    expected = hmac.new(
        SECRET.encode(), timestamp.encode() + b"." + raw, hashlib.sha256
    ).hexdigest()

    assert sign_payload(SECRET, timestamp, raw) == expected


def test_bad_signature_is_rejected() -> None:
    raw = b'{"matchId":"x"}'
    timestamp = str(int(time.time()))

    with pytest.raises(InvalidSignature):
        verify_signature(
            secret=SECRET,
            signature_header="a" * 64,
            timestamp_header=timestamp,
            raw_body=raw,
        )


def test_signature_over_a_different_body_is_rejected() -> None:
    """The signature covers the body, so a swapped payload must not verify."""
    timestamp = str(int(time.time()))
    signature = sign_payload(SECRET, timestamp, b'{"matchId":"a"}')

    with pytest.raises(InvalidSignature):
        verify_signature(
            secret=SECRET,
            signature_header=signature,
            timestamp_header=timestamp,
            raw_body=b'{"matchId":"b"}',
        )


def test_stale_timestamp_is_rejected() -> None:
    """A correctly signed request from outside the window still fails. The
    signature itself is valid, which is what a replay looks like; the timestamp
    is inside the MAC, so it cannot be refreshed without the secret."""
    raw = b'{"matchId":"x"}'
    stale = str(int(time.time()) - 3600)

    with pytest.raises(StaleTimestamp):
        verify_signature(
            secret=SECRET,
            signature_header=sign_payload(SECRET, stale, raw),
            timestamp_header=stale,
            raw_body=raw,
            max_skew_seconds=300,
        )


def test_future_timestamp_is_rejected() -> None:
    """The window is symmetric -- a far-future clock is as suspicious as a
    stale one, and drift goes both ways."""
    raw = b'{"matchId":"x"}'
    ahead = str(int(time.time()) + 3600)

    with pytest.raises(StaleTimestamp):
        verify_signature(
            secret=SECRET,
            signature_header=sign_payload(SECRET, ahead, raw),
            timestamp_header=ahead,
            raw_body=raw,
            max_skew_seconds=300,
        )


@pytest.mark.parametrize(
    "signature,timestamp,expected",
    [
        (None, "1700000000", MissingSignature),
        ("a" * 64, None, MissingSignature),
        ("too-short", "1700000000", MalformedSignature),
        ("z" * 64, "1700000000", MalformedSignature),
        ("a" * 64, "not-a-number", MalformedSignature),
    ],
)
def test_malformed_headers_are_rejected(signature, timestamp, expected) -> None:
    with pytest.raises(expected):
        verify_signature(
            secret=SECRET,
            signature_header=signature,
            timestamp_header=timestamp,
            raw_body=b"{}",
        )


def test_missing_secret_fails_closed() -> None:
    """With no configured secret, verification rejects every request."""
    timestamp = str(int(time.time()))

    with pytest.raises(SecretNotConfigured):
        verify_signature(
            secret=None,
            signature_header="a" * 64,
            timestamp_header=timestamp,
            raw_body=b"{}",
        )


def test_http_score_rejects_a_bad_signature(client) -> None:
    raw, headers = signed(anomalous_vector())
    headers[SIGNATURE_HEADER] = "b" * 64

    response = client.post("/score", content=raw, headers=headers)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "signature_invalid"


def test_http_score_rejects_a_stale_timestamp(client) -> None:
    raw, headers = signed(anomalous_vector(), skew=-3600)

    response = client.post("/score", content=raw, headers=headers)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "timestamp_out_of_window"


def test_http_score_rejects_an_unsigned_request(client) -> None:
    response = client.post("/score", json=anomalous_vector())

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "signature_missing"


def test_http_malformed_body_is_not_parsed_before_auth(client) -> None:
    """Authentication precedes parsing. Garbage with no signature must come
    back 401, not a 422 that tells an unauthenticated caller how our schema is
    shaped."""
    response = client.post(
        "/score", content=b"{not json", headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 401


def test_rate_limiter_window() -> None:
    limiter = RateLimiter(limit=3, window_seconds=10.0)

    assert [limiter.check("peer", now=t).allowed for t in (0.0, 1.0, 2.0)] == [True] * 3
    blocked = limiter.check("peer", now=3.0)
    assert blocked.allowed is False
    assert blocked.retry_after > 0
    # A different caller has its own bucket.
    assert limiter.check("other", now=3.0).allowed is True
    # And the window slides.
    assert limiter.check("peer", now=11.0).allowed is True


# --------------------------------------------------------------------------- #
# (d) The rules fallback activates when there is no model file                 #
# --------------------------------------------------------------------------- #


def test_fallback_activates_with_no_model_file(tmp_path: Path) -> None:
    detector = AnomalyDetector(model_dir=tmp_path / "nothing-here")
    report = detector.load()

    assert report.loaded is False
    assert detector.is_trained is False
    assert detector.model_version == FALLBACK_MODEL_VERSION
    assert "rule" in report.detail

    result = detector.score_one(MATCH_ID, to_features(anomalous_vector()))
    assert result.model_version == FALLBACK_MODEL_VERSION
    # No tree, so no path to measure. A number here would be
    # indistinguishable from a measured one.
    assert result.leaf_depth is None
    assert result.average_path_length is None
    assert detector.average_path_length(to_features(normal_vector())) is None
    assert detector.leaf_depth_statistics(to_features(normal_vector())) is None


def test_corrupt_artefact_degrades_to_the_fallback(tmp_path: Path) -> None:
    """A broken model file must not take the service down; the detector falls
    back to the rule engine and keeps scoring."""
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "model.joblib").write_bytes(b"this is not a joblib payload")

    detector = AnomalyDetector(model_dir=artifacts)
    report = detector.load()

    assert report.loaded is False
    assert detector.model_version == FALLBACK_MODEL_VERSION
    result = detector.score_one(MATCH_ID, to_features(normal_vector()))
    assert result.model_version == FALLBACK_MODEL_VERSION


def test_http_score_uses_the_fallback_and_says_so(client) -> None:
    raw, headers = signed(anomalous_vector())

    response = client.post("/score", content=raw, headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["matchId"] == MATCH_ID
    assert body["modelVersion"] == FALLBACK_MODEL_VERSION
    assert body["isAnomalous"] is True
    assert body["anomalyScore"] > body["threshold"]
    assert body["leafDepth"] is None
    assert body["averagePathLength"] is None
    assert body["reasons"]
    # Exactly the keys the Zod parser on the Next.js side expects.
    assert set(body) == {
        "matchId",
        "anomalyScore",
        "isAnomalous",
        "leafDepth",
        "averagePathLength",
        "modelVersion",
        "threshold",
        "reasons",
    }


def test_http_healthz_is_open_and_reports_the_fallback(client) -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["modelLoaded"] is False
    assert body["modelVersion"] == FALLBACK_MODEL_VERSION


def test_http_batch_scores_in_request_order(client) -> None:
    other_id = "11111111-2222-3333-4444-555555555555"
    payload = {
        "matches": [normal_vector(), anomalous_vector(matchId=other_id)],
    }
    raw, headers = signed(payload)

    response = client.post("/score/batch", content=raw, headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 2
    assert body["flaggedCount"] == 1
    assert [r["matchId"] for r in body["results"]] == [MATCH_ID, other_id]
    assert body["results"][0]["isAnomalous"] is False
    assert body["results"][1]["isAnomalous"] is True


def test_http_batch_rejects_an_empty_list(client) -> None:
    raw, headers = signed({"matches": []})

    response = client.post("/score/batch", content=raw, headers=headers)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "empty_batch"


def test_http_model_info_requires_a_signature(client) -> None:
    assert client.get("/model/info").status_code == 401

    _raw, headers = signed(None)
    response = client.get("/model/info", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["isTrained"] is False
    assert body["featureOrder"] == list(FEATURE_ORDER)
    assert body["threshold"] == DEFAULT_THRESHOLD


def test_http_model_reload_requires_the_admin_token(client) -> None:
    assert client.post("/model/reload").status_code == 401
    assert (
        client.post("/model/reload", headers={ADMIN_TOKEN_HEADER: "wrong"}).status_code == 401
    )

    response = client.post("/model/reload", headers={ADMIN_TOKEN_HEADER: ADMIN_TOKEN})

    assert response.status_code == 200
    body = response.json()
    assert body["reloaded"] is False
    assert body["modelVersion"] == FALLBACK_MODEL_VERSION


def test_http_rejects_a_vector_missing_a_feature(client) -> None:
    broken = anomalous_vector()
    del broken["goalDiff"]
    raw, headers = signed(broken)

    response = client.post("/score", content=raw, headers=headers)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_feature_vector"


def test_snake_case_payloads_are_accepted(client) -> None:
    """``public.anomaly_features()`` emits snake_case, and its nested
    ``collusion`` object rides along. Both must pass straight through."""
    payload = {
        "match_id": MATCH_ID,
        "score_variance": 0.0,
        "reporting_delay_seconds": 900.0,
        "reporter_count": 4,
        "opposing_report_agreement": 1.0,
        "participant_overlap_ratio": 0.12,
        "historical_report_deviation": 0.2,
        "goal_diff": 2,
        "kickoff_hour": 20,
        "venue_bookings_last_7d": 41,
        "reporter_account_age_days": 430.0,
        "collusion": {"repeat_pairings": 1, "is_suspicious": False},
    }
    raw, headers = signed(payload)

    response = client.post("/score", content=raw, headers=headers)

    assert response.status_code == 200
    assert response.json()["isAnomalous"] is False


# --------------------------------------------------------------------------- #
# Isolation Forest math                                                        #
# --------------------------------------------------------------------------- #


def test_c_of_n_matches_the_closed_form() -> None:
    """c(n) = 2*H(n-1) - 2*(n-1)/n, with the documented small-n special cases."""
    import math

    assert expected_path_length(0) == 0.0
    assert expected_path_length(1) == 0.0
    assert expected_path_length(2) == 1.0

    n = 256.0
    expected = 2.0 * (math.log(n - 1.0) + 0.5772156649015329) - 2.0 * (n - 1.0) / n
    assert expected_path_length(n) == pytest.approx(expected)
    assert expected_path_length(256) == pytest.approx(10.2447709, abs=1e-5)


def test_short_paths_are_the_anomalous_direction() -> None:
    """Pin the sign convention.

    A leaf near the ROOT means the point was isolated immediately, which means
    ANOMALOUS, which means a HIGH score.
    """
    n = 256
    near_root = anomaly_score_from_path_length(1.0, n)
    average = anomaly_score_from_path_length(expected_path_length(n), n)
    deep = anomaly_score_from_path_length(30.0, n)

    assert near_root > average > deep
    assert average == pytest.approx(0.5)
    assert anomaly_score_from_path_length(0.0, n) == pytest.approx(1.0)
    assert 0.0 <= deep <= 1.0


def test_degenerate_forest_returns_no_signal() -> None:
    """c(n) = 0 would divide by zero; 0.5 is the "no information" point."""
    assert anomaly_score_from_path_length(3.0, 1) == 0.5


def test_percentile_interpolation_and_plateaus() -> None:
    grid = {
        quantile_key(level): value
        for level, value in zip(
            (0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99),
            (0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 2.1, 6.0),
        )
    }

    # The modal value sits on a plateau and must not read as an extreme.
    plateau = empirical_percentile(0.0, grid)
    assert 0.1 < plateau < 0.35
    assert percentile_severity(plateau, "high") == 0.0

    # A value past the top knot clamps to the top level, not beyond it.
    assert empirical_percentile(999.0, grid) == 0.99
    assert percentile_severity(0.99, "high") == pytest.approx(0.98)

    # And interpolation is monotone in between.
    assert empirical_percentile(0.6, grid) < empirical_percentile(1.5, grid)

    # Too few knots to say anything.
    assert empirical_percentile(1.0, {"p50": 0.0}) is None


def test_percentile_severity_honours_direction() -> None:
    # A low reporter count is the suspicious tail; a high one is not.
    assert percentile_severity(0.02, "low") == pytest.approx(0.96)
    assert percentile_severity(0.98, "low") == 0.0
    assert percentile_severity(0.98, "high") == pytest.approx(0.96)
    # Either tail counts for a two-sided feature such as kickoff hour.
    assert percentile_severity(0.02, "two_sided") == pytest.approx(0.96)
    assert percentile_severity(0.98, "two_sided") == pytest.approx(0.96)


def test_rule_scores_are_ordered_as_expected() -> None:
    normal, _ = rule_based_score(to_features(normal_vector()))
    anomalous, hits = rule_based_score(to_features(anomalous_vector()))

    assert normal < DEFAULT_THRESHOLD < anomalous
    assert hits, "the anomalous vector must trip at least one rule"
    # Rules are returned strongest-first, which is what the reason ordering
    # depends on.
    contributions = [hit.contribution for hit in hits]
    assert contributions == sorted(contributions, reverse=True)


def test_feature_order_matches_the_wire_model() -> None:
    """The service, the TypeScript type and the SQL composite type all carry
    the same ten features. This catches the Python half drifting."""
    from app.schemas import AnomalyFeatureVector

    assert set(FEATURE_ORDER) <= set(AnomalyFeatureVector.model_fields)
    assert len(FEATURE_ORDER) == 10
    assert set(to_features(normal_vector())) == set(FEATURE_ORDER)
