"""Isolation Forest scoring for OnPitch match-integrity signals.

This module is deliberately dependency-light at import time: only the standard
library is imported at module scope. ``numpy``, ``scikit-learn`` and ``joblib``
are imported lazily inside the code paths that actually need a trained forest,
so the rule-based cold-start scorer keeps working, and stays testable, in an
environment where they are not installed.

------------------------------------------------------------------------------
THE MATH
------------------------------------------------------------------------------
An Isolation Forest builds ``n_estimators`` random binary trees. Each tree
repeatedly picks a random feature and a random split value until every point
sits alone in its own leaf. The quantity of interest is ``h(x)``: the number of
splits it took to isolate ``x``.

A point that is *unlike* the rest of the data gets carved off after very few
splits, so its leaf sits **close to the root** and ``h(x)`` is **small**.
A point buried in the bulk of the distribution needs many splits, so its leaf
sits **deep** and ``h(x)`` is **large**.

    SHORT path  ->  leaf near the ROOT  ->  easily isolated  ->  ANOMALOUS  ->  HIGH score
    LONG  path  ->  leaf deep in tree   ->  hard to isolate  ->  NORMAL     ->  LOW  score

To turn a raw path length into a bounded score you normalise by the average
path length of an unsuccessful search in a Binary Search Tree over ``n``
points, which has the closed form

    c(n) = 2 * H(n - 1) - 2 * (n - 1) / n            for n > 2
    c(2) = 1
    c(n) = 0                                          for n <= 1

    H(i) = ln(i) + gamma          (gamma = 0.5772156649015329, Euler-Mascheroni)

and the score is

    s(x, n) = 2 ** ( -E[h(x)] / c(n) )

which lives in ``(0, 1]``:

    E[h(x)] -> 0     =>  s -> 1     (isolated immediately: maximally anomalous)
    E[h(x)] = c(n)   =>  s = 0.5    (exactly average: no signal either way)
    E[h(x)] -> inf   =>  s -> 0     (deeply buried: maximally normal)

``E[h(x)]`` is averaged over every tree, and because each tree is built on a
sub-sample of at most ``max_samples`` points, its leaves are truncated: a leaf
still holding ``m > 1`` training points stands in for a subtree that was never
grown, so the standard correction adds ``c(m)`` to the measured node depth.
That is why :meth:`AnomalyDetector.average_path_length` (the *corrected* path
length) is a float and slightly larger than the reported ``leaf_depth`` (the
raw node depth, an integer).

This reproduces scikit-learn's own ``-IsolationForest.score_samples(X)``; we
compute it ourselves because the platform contract needs the intermediate
quantities (``leafDepth``, ``averagePathLength``) that sklearn does not expose.

------------------------------------------------------------------------------
EXPLAINABILITY
------------------------------------------------------------------------------
Isolation Forests do not hand you per-feature attributions. The ``reasons``
this module returns come from a documented heuristic. They are not SHAP
values, not a game-theoretic attribution, and not a causal claim. Two sources
feed it:

1. *Trained model:* each feature is placed on the empirical quantile grid
   captured at training time (written into ``metadata.json`` by ``train.py``).
   A feature whose value sits far into its suspicious tail gets a severity in
   ``[0, 1]``; the strongest few are rendered as sentences. This describes
   what is unusual about the vector, not what the forest split on.
2. *Rule engine:* the same deterministic rules that power the cold-start
   fallback, used to top up (or replace) the quantile reasons.

------------------------------------------------------------------------------
COLD START
------------------------------------------------------------------------------
With no artefact on disk the detector answers from :data:`RULES` -- a fixed,
hand-tuned, deterministic rule set combined with a noisy-OR. It says so on the
wire: ``model_version`` comes back as ``rules-fallback-v1``, and both
``leaf_depth`` and ``average_path_length`` come back as ``None``, because there
is no tree and therefore no path to measure. A fabricated depth would be
indistinguishable from a measured one to the caller. This is the one intentional
stub boundary in the service, and it lets the endpoint answer before any model
has been trained.
"""

from __future__ import annotations

import json
import logging
import math
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Constants                                                                    #
# --------------------------------------------------------------------------- #

#: Version stamped on verdicts produced by a trained forest.
MODEL_VERSION = "if-v1"

#: Version stamped on verdicts produced by the cold-start rule engine.
FALLBACK_MODEL_VERSION = "rules-fallback-v1"

#: Default cut-off. Mirrors ``public.anomaly_score_threshold()`` in
#: ``supabase/migrations/0005_integrity_consensus.sql``. Change both together.
DEFAULT_THRESHOLD = 0.62

DEFAULT_N_ESTIMATORS = 200
DEFAULT_MAX_SAMPLES = "auto"
DEFAULT_CONTAMINATION = "auto"

#: Fixed so that rebuilding from the same rows produces the same trees.
DEFAULT_RANDOM_STATE = 1712

EULER_GAMMA = 0.5772156649015329

MODEL_FILENAME = "model.joblib"
METADATA_FILENAME = "metadata.json"

#: Canonical feature order. Must stay in lock-step with
#: ``public.match_anomaly_feature_row`` (SQL), ``AnomalyFeatureVector``
#: (types/domain.ts) and ``app.schemas.AnomalyFeatureVector`` (this service).
FEATURE_ORDER: tuple[str, ...] = (
    "score_variance",
    "reporting_delay_seconds",
    "reporter_count",
    "opposing_report_agreement",
    "participant_overlap_ratio",
    "historical_report_deviation",
    "goal_diff",
    "kickoff_hour",
    "venue_bookings_last_7d",
    "reporter_account_age_days",
)

#: Which tail of each feature is the suspicious one.
#:   ``high``       -- large values are suspicious
#:   ``low``        -- small values are suspicious
#:   ``two_sided``  -- either tail is suspicious
FEATURE_DIRECTION: dict[str, str] = {
    "score_variance": "high",
    "reporting_delay_seconds": "two_sided",
    "reporter_count": "low",
    "opposing_report_agreement": "low",
    "participant_overlap_ratio": "high",
    "historical_report_deviation": "high",
    "goal_diff": "high",
    "kickoff_hour": "two_sided",
    "venue_bookings_last_7d": "low",
    "reporter_account_age_days": "low",
}

FEATURE_LABELS: dict[str, str] = {
    "score_variance": "score-report variance",
    "reporting_delay_seconds": "reporting delay",
    "reporter_count": "number of reporters",
    "opposing_report_agreement": "home/away report agreement",
    "participant_overlap_ratio": "opponent-overlap ratio",
    "historical_report_deviation": "reporters' historical deviation",
    "goal_diff": "goal difference",
    "kickoff_hour": "kickoff hour",
    "venue_bookings_last_7d": "venue bookings in the last 7 days",
    "reporter_account_age_days": "first reporter's account age",
}

#: Probability levels captured by ``train.py`` and consumed by the explainer.
QUANTILE_LEVELS: tuple[float, ...] = (0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99)

#: A quantile reason is only rendered once its severity clears this bar
#: (0.60 corresponds to a value outside the central 60% of the training data).
REASON_SEVERITY_CUT = 0.60

#: Hard ceiling on rendered reasons. ``match_anomaly_flags.reasons`` is jsonb
#: and the Zod parser on the Next.js side caps each string at 280 characters.
MAX_REASONS = 5
MAX_REASON_CHARS = 280


class ModelLoadError(RuntimeError):
    """Raised when an artefact exists on disk but cannot be used."""


# --------------------------------------------------------------------------- #
# Path-length math                                                             #
# --------------------------------------------------------------------------- #


def harmonic_number(i: float) -> float:
    """``H(i) = ln(i) + gamma``, the standard asymptotic harmonic number.

    Accurate enough for an Isolation Forest: the error is O(1/2i) and the
    result is only ever used inside a ratio.
    """
    if i <= 0.0:
        return 0.0
    return math.log(i) + EULER_GAMMA


def expected_path_length(n: float) -> float:
    """``c(n) = 2*H(n-1) - 2*(n-1)/n`` -- the normalising constant.

    This is the average path length of an unsuccessful search in a Binary
    Search Tree over ``n`` points, i.e. the path length a perfectly ordinary
    point should expect. Dividing ``E[h(x)]`` by it makes the score comparable
    across sub-sample sizes.

    It doubles as the truncated-leaf correction: a leaf that still holds ``m``
    training points stands in for an ungrown subtree worth ``c(m)`` splits.
    """
    if n <= 1.0:
        return 0.0
    if n == 2.0:
        return 1.0
    n = float(n)
    return 2.0 * harmonic_number(n - 1.0) - 2.0 * (n - 1.0) / n


#: sklearn calls this ``_average_path_length``. Alias kept so readers arriving
#: from the sklearn source find a familiar name.
c_factor = expected_path_length


def anomaly_score_from_path_length(mean_path_length: float, n_samples: float) -> float:
    """``s = 2 ** (-E[h(x)] / c(n))``, clamped into ``[0, 1]``.

    Note the direction: a SHORT ``mean_path_length`` yields a score near 1,
    which means ANOMALOUS.
    """
    c = expected_path_length(n_samples)
    if c <= 0.0:
        # Degenerate forest (fewer than two training samples). 0.5 is the
        # "no information" point of the scale.
        return 0.5
    score = 2.0 ** (-float(mean_path_length) / c)
    if score < 0.0:
        return 0.0
    if score > 1.0:
        return 1.0
    return score


# --------------------------------------------------------------------------- #
# Rule engine (cold start, and the explainer's fallback)                       #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Rule:
    """One deterministic integrity heuristic.

    ``severity`` maps the feature vector onto ``[0, 1]``: 0 means "nothing to
    see", 1 means "as bad as this rule can describe". ``strength`` caps the
    probability mass the rule may contribute under the noisy-OR, so no single
    heuristic can reach 1.0 on its own.
    """

    id: str
    feature: str
    strength: float
    severity: Callable[[Mapping[str, float]], float]
    message: Callable[[Mapping[str, float]], str]


def _clamp01(x: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    return float(x)


def _ramp(value: float, start: float, full: float) -> float:
    """0 at ``start``, 1 at ``full``, linear in between, clamped outside."""
    if full == start:
        return 1.0 if value >= full else 0.0
    return _clamp01((value - start) / (full - start))


def _sev_disagreement(f: Mapping[str, float]) -> float:
    # Variance across reported scorelines. Corroborated reports agree exactly,
    # so anything above zero is already evidence; saturate at a 2-goal spread.
    return _ramp(f["score_variance"], 0.0, 4.0)


def _sev_opposing_disagreement(f: Mapping[str, float]) -> float:
    # Only meaningful once both camps have filed something. With a single
    # reporter the agreement ratio is 0 by construction, which is the
    # single-reporter rule's job to flag, not this one's.
    if f["reporter_count"] < 2:
        return 0.0
    return _clamp01(1.0 - f["opposing_report_agreement"])


def _sev_single_reporter(f: Mapping[str, float]) -> float:
    return 1.0 if f["reporter_count"] <= 1 else 0.0


def _sev_late_report(f: Mapping[str, float]) -> float:
    # One hour of grace, saturating at 48 hours.
    return _ramp(f["reporting_delay_seconds"], 3600.0, 172800.0)


def _sev_premature_report(f: Mapping[str, float]) -> float:
    # Negative delay: the scoreline was filed before the final whistle.
    delay = f["reporting_delay_seconds"]
    if delay >= 0.0:
        return 0.0
    return _ramp(-delay, 0.0, 3600.0)


def _sev_closed_circuit(f: Mapping[str, float]) -> float:
    # These two groups mostly play only each other -- the shape of a rating farm.
    return _ramp(f["participant_overlap_ratio"], 0.60, 1.0)


def _sev_unreliable_reporter(f: Mapping[str, float]) -> float:
    return _ramp(f["historical_report_deviation"], 0.5, 4.0)


def _sev_implausible_margin(f: Mapping[str, float]) -> float:
    # Amateur blowouts are real; only start worrying past eight goals.
    return _ramp(f["goal_diff"], 8.0, 20.0)


def _sev_odd_hour(f: Mapping[str, float]) -> float:
    hour = int(f["kickoff_hour"])
    if 7 <= hour <= 23:
        return 0.0
    # Distance below the 07:00 edge; 02:00 and earlier is fully suspicious.
    return _ramp(7 - hour, 0.0, 5.0)


def _sev_quiet_venue(f: Mapping[str, float]) -> float:
    bookings = int(f["venue_bookings_last_7d"])
    if bookings >= 3:
        return 0.0
    return {0: 1.0, 1: 0.6, 2: 0.3}[max(0, bookings)]


def _sev_fresh_reporter(f: Mapping[str, float]) -> float:
    return _ramp(14.0 - f["reporter_account_age_days"], 0.0, 14.0)


RULES: tuple[Rule, ...] = (
    Rule(
        id="report_disagreement",
        feature="score_variance",
        strength=0.733,
        severity=_sev_disagreement,
        message=lambda f: (
            f"reported scorelines disagree - variance {f['score_variance']:.2f} "
            f"(corroborated reports sit at 0.00)"
        ),
    ),
    Rule(
        id="opposing_sides_disagree",
        feature="opposing_report_agreement",
        strength=0.600,
        severity=_sev_opposing_disagreement,
        message=lambda f: (
            f"the two sides told different stories - home/away report agreement "
            f"{f['opposing_report_agreement'] * 100:.0f}%"
        ),
    ),
    Rule(
        id="single_reporter",
        feature="reporter_count",
        strength=0.400,
        severity=_sev_single_reporter,
        message=lambda f: "only one participant filed a score report, so nothing corroborates it",
    ),
    Rule(
        id="late_report",
        feature="reporting_delay_seconds",
        strength=0.333,
        severity=_sev_late_report,
        message=lambda f: (
            f"the result was filed {f['reporting_delay_seconds'] / 3600.0:.1f}h "
            f"after the final whistle"
        ),
    ),
    Rule(
        id="premature_report",
        feature="reporting_delay_seconds",
        # Higher than the other soft signals: a scoreline filed before the
        # final whistle is not "unusual", it is logically impossible for an
        # honestly observed result.
        strength=0.600,
        severity=_sev_premature_report,
        message=lambda f: (
            f"the result was filed {abs(f['reporting_delay_seconds']) / 60.0:.0f} min "
            f"BEFORE the final whistle"
        ),
    ),
    Rule(
        id="closed_circuit",
        feature="participant_overlap_ratio",
        strength=0.500,
        severity=_sev_closed_circuit,
        message=lambda f: (
            f"closed circuit - {f['participant_overlap_ratio'] * 100:.0f}% of these players' "
            f"earlier matches were against this same opposing group"
        ),
    ),
    Rule(
        id="unreliable_reporter",
        feature="historical_report_deviation",
        strength=0.400,
        severity=_sev_unreliable_reporter,
        message=lambda f: (
            f"the reporters are historically {f['historical_report_deviation']:.1f} goals off "
            f"the confirmed scoreline"
        ),
    ),
    Rule(
        id="implausible_margin",
        feature="goal_diff",
        strength=0.367,
        severity=_sev_implausible_margin,
        message=lambda f: f"implausible margin - {int(f['goal_diff'])} goal difference",
    ),
    Rule(
        id="odd_kickoff_hour",
        feature="kickoff_hour",
        strength=0.267,
        severity=_sev_odd_hour,
        message=lambda f: (
            f"kickoff at {int(f['kickoff_hour']):02d}:00 venue-local, outside normal "
            f"playing hours (07:00-23:59)"
        ),
    ),
    Rule(
        id="quiet_venue",
        feature="venue_bookings_last_7d",
        strength=0.233,
        severity=_sev_quiet_venue,
        message=lambda f: (
            f"the venue took {int(f['venue_bookings_last_7d'])} other booking(s) in the "
            f"7 days before kickoff"
        ),
    ),
    Rule(
        id="fresh_reporter",
        feature="reporter_account_age_days",
        strength=0.433,
        severity=_sev_fresh_reporter,
        message=lambda f: (
            f"the first reporter's account is {f['reporter_account_age_days']:.1f} day(s) old"
        ),
    ),
)

#: Applied to the noisy-OR output. A noisy-OR saturates quickly once three or
#: four rules fire; an exponent above 1 pulls the middle of the range down so
#: that "a couple of soft signals" lands below the 0.62 cut while "a flat
#: contradiction between the two camps" stays comfortably above it. Tuned by
#: hand against the vectors in ``tests/test_scoring.py`` -- retune there.
RULE_CALIBRATION_EXPONENT = 1.35

#: Rules softer than this are not worth a sentence.
RULE_REASON_SEVERITY_CUT = 0.20


@dataclass(frozen=True)
class RuleHit:
    rule_id: str
    feature: str
    severity: float
    contribution: float
    message: str


def evaluate_rules(features: Mapping[str, float]) -> list[RuleHit]:
    """Run every rule, returning the ones that fired, strongest first."""
    hits: list[RuleHit] = []
    for rule in RULES:
        severity = _clamp01(rule.severity(features))
        if severity <= 0.0:
            continue
        hits.append(
            RuleHit(
                rule_id=rule.id,
                feature=rule.feature,
                severity=severity,
                contribution=severity * rule.strength,
                message=rule.message(features)[:MAX_REASON_CHARS],
            )
        )
    hits.sort(key=lambda h: h.contribution, reverse=True)
    return hits


def rule_based_score(features: Mapping[str, float]) -> tuple[float, list[RuleHit]]:
    """The documented cold-start scorer.

    Rules are combined with a **noisy-OR**::

        p     = 1 - PROD_i (1 - severity_i * strength_i)
        score = p ** RULE_CALIBRATION_EXPONENT

    Noisy-OR fits heuristics that are near-independent pieces of evidence
    pointing the same way: any one of them raises suspicion, several together
    raise it more, and none of them reaches 1.0 alone. The result is on the same
    ``[0, 1]`` scale as the Isolation Forest score, so the same 0.62 threshold
    applies to both. The two numbers are not interchangeable, and
    ``model_version`` records which one produced the verdict.
    """
    hits = evaluate_rules(features)
    survival = 1.0
    for hit in hits:
        survival *= 1.0 - _clamp01(hit.contribution)
    noisy_or = _clamp01(1.0 - survival)
    return _clamp01(noisy_or**RULE_CALIBRATION_EXPONENT), hits


# --------------------------------------------------------------------------- #
# Quantile-based explainer                                                     #
# --------------------------------------------------------------------------- #


def quantile_key(level: float) -> str:
    """``0.95 -> "p95"``. Metadata JSON object keys must be strings."""
    return f"p{int(round(level * 100)):02d}"


def empirical_percentile(value: float, quantiles: Mapping[str, float]) -> float | None:
    """Where ``value`` sits in a distribution described by a quantile grid.

    Returns a probability inside ``[QUANTILE_LEVELS[0], QUANTILE_LEVELS[-1]]``,
    or ``None`` when the grid is unusable. Linear interpolation between knots;
    values outside the grid clamp to its ends; a value landing exactly on a
    plateau (several knots sharing one value, common for count features) gets
    the midpoint of that plateau rather than an arbitrary edge.
    """
    knots: list[tuple[float, float]] = []
    for level in QUANTILE_LEVELS:
        raw = quantiles.get(quantile_key(level))
        if raw is None:
            continue
        try:
            knots.append((level, float(raw)))
        except (TypeError, ValueError):
            continue
    if len(knots) < 2:
        return None
    knots.sort(key=lambda kv: kv[1])

    plateau = [level for level, knot_value in knots if knot_value == value]
    if plateau:
        return sum(plateau) / len(plateau)

    if value <= knots[0][1]:
        return knots[0][0]
    if value >= knots[-1][1]:
        return knots[-1][0]

    for (p_lo, v_lo), (p_hi, v_hi) in zip(knots, knots[1:]):
        if v_lo <= value <= v_hi:
            if v_hi == v_lo:
                return (p_lo + p_hi) / 2.0
            frac = (value - v_lo) / (v_hi - v_lo)
            return p_lo + frac * (p_hi - p_lo)
    return knots[-1][0]


def percentile_severity(percentile: float, direction: str) -> float:
    """Turn a percentile into a ``[0, 1]`` suspicion, honouring the tail."""
    if direction == "high":
        return _clamp01((percentile - 0.5) / 0.5)
    if direction == "low":
        return _clamp01((0.5 - percentile) / 0.5)
    return _clamp01(abs(percentile - 0.5) / 0.5)


def _ordinal(percentile: float) -> str:
    pct = int(round(percentile * 100))
    pct = max(1, min(99, pct))
    if 11 <= pct % 100 <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(pct % 10, "th")
    return f"{pct}{suffix}"


def _format_value(feature: str, value: float) -> str:
    if feature in ("reporter_count", "goal_diff", "kickoff_hour", "venue_bookings_last_7d"):
        return f"{int(round(value))}"
    if feature == "reporting_delay_seconds":
        return f"{value / 3600.0:.1f}h"
    return f"{value:.2f}"


def quantile_reasons(
    features: Mapping[str, float],
    quantiles: Mapping[str, Mapping[str, float]],
) -> list[tuple[str, float, str]]:
    """Rank features by how far into their suspicious tail they sit.

    Returns ``(feature, severity, sentence)`` triples, strongest first. The
    ranking is a heuristic over the *training distribution* rather than an
    attribution over the *model*: it says "this value is unusual", never "the
    forest split on this". See the module docstring.
    """
    scored: list[tuple[str, float, str]] = []
    for feature in FEATURE_ORDER:
        grid = quantiles.get(feature)
        if not grid:
            continue
        value = features.get(feature)
        if value is None:
            continue
        percentile = empirical_percentile(float(value), grid)
        if percentile is None:
            continue
        direction = FEATURE_DIRECTION.get(feature, "high")
        severity = percentile_severity(percentile, direction)
        if severity < REASON_SEVERITY_CUT:
            continue
        label = FEATURE_LABELS.get(feature, feature)
        reference_level = 0.05 if direction == "low" else 0.95
        reference = grid.get(quantile_key(reference_level))
        tail = ""
        if reference is not None:
            tail = (
                f", training {quantile_key(reference_level)}="
                f"{_format_value(feature, float(reference))}"
            )
        sentence = (
            f"{label} {_format_value(feature, float(value))} sits around the "
            f"{_ordinal(percentile)} percentile of training data{tail}"
        )
        scored.append((feature, severity, sentence[:MAX_REASON_CHARS]))
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored


# --------------------------------------------------------------------------- #
# Results                                                                      #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ScoringResult:
    """Plain-data verdict. ``app.schemas`` turns this into the wire model."""

    match_id: str
    anomaly_score: float
    is_anomalous: bool
    leaf_depth: int | None
    average_path_length: float | None
    model_version: str
    threshold: float
    reasons: list[str]


@dataclass(frozen=True)
class LoadReport:
    """Outcome of a load/reload attempt. A missing artefact reports, never raises."""

    loaded: bool
    model_version: str
    model_dir: str
    detail: str
    trained_at: str | None = None
    n_training_samples: int | None = None


@dataclass(frozen=True)
class _LoadedModel:
    """Immutable snapshot, swapped in atomically on reload."""

    forest: Any
    metadata: dict[str, Any]
    feature_order: tuple[str, ...]
    quantiles: dict[str, dict[str, float]]
    node_depths: list[Any]  # one int32 numpy array per estimator
    leaf_corrections: list[Any]  # one float64 numpy array per estimator
    max_samples: int
    c_norm: float
    model_version: str


# --------------------------------------------------------------------------- #
# Detector                                                                     #
# --------------------------------------------------------------------------- #


class AnomalyDetector:
    """Scores match feature vectors, with or without a trained forest.

    Thread-safe: the loaded artefact is an immutable snapshot swapped under a
    lock, and scoring only ever reads the current reference. Safe to call from
    an asyncio event loop -- scoring one vector is pure CPU work in the tens of
    microseconds, well inside the caller's 2.5s budget.
    """

    def __init__(
        self,
        model_dir: str | Path = "artifacts",
        threshold: float = DEFAULT_THRESHOLD,
        *,
        n_estimators: int = DEFAULT_N_ESTIMATORS,
        contamination: float | str = DEFAULT_CONTAMINATION,
        random_state: int = DEFAULT_RANDOM_STATE,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.threshold = float(threshold)
        self.n_estimators = int(n_estimators)
        self.contamination = contamination
        self.random_state = int(random_state)
        self._lock = threading.Lock()
        self._loaded: _LoadedModel | None = None
        self._last_report: LoadReport = LoadReport(
            loaded=False,
            model_version=FALLBACK_MODEL_VERSION,
            model_dir=str(self.model_dir),
            detail="not loaded yet",
        )

    # -- lifecycle ---------------------------------------------------------- #

    @property
    def is_trained(self) -> bool:
        return self._loaded is not None

    @property
    def model_version(self) -> str:
        loaded = self._loaded
        return loaded.model_version if loaded is not None else FALLBACK_MODEL_VERSION

    @property
    def last_load_report(self) -> LoadReport:
        return self._last_report

    def load(self) -> LoadReport:
        """Load ``model.joblib`` + ``metadata.json`` from :attr:`model_dir`.

        A missing artefact is the documented cold-start path: it leaves the
        detector on the rule engine and comes back as a report. A corrupt
        artefact is logged and also falls back to the rule engine rather than
        refusing to start, so a bad file on disk cannot stop a match being
        finalised.
        """
        model_path = self.model_dir / MODEL_FILENAME
        meta_path = self.model_dir / METADATA_FILENAME

        if not model_path.is_file():
            report = LoadReport(
                loaded=False,
                model_version=FALLBACK_MODEL_VERSION,
                model_dir=str(self.model_dir),
                detail=(
                    f"no artefact at {model_path}; serving the deterministic rule "
                    f"engine ({FALLBACK_MODEL_VERSION})"
                ),
            )
            with self._lock:
                self._loaded = None
                self._last_report = report
            logger.warning("model.cold_start | %s", report.detail)
            return report

        try:
            snapshot = self._build_snapshot(model_path, meta_path)
        except Exception as exc:  # noqa: BLE001 - degrade, never crash
            report = LoadReport(
                loaded=False,
                model_version=FALLBACK_MODEL_VERSION,
                model_dir=str(self.model_dir),
                detail=f"artefact at {model_path} is unusable ({exc}); staying on the rule engine",
            )
            with self._lock:
                self._loaded = None
                self._last_report = report
            logger.exception("model.load_failed | %s", report.detail)
            return report

        report = LoadReport(
            loaded=True,
            model_version=snapshot.model_version,
            model_dir=str(self.model_dir),
            detail=f"loaded {snapshot.model_version} from {model_path}",
            trained_at=snapshot.metadata.get("trainedAt"),
            n_training_samples=snapshot.metadata.get("nSamples"),
        )
        with self._lock:
            self._loaded = snapshot
            self._last_report = report
        logger.info("model.loaded | %s", report.detail)
        return report

    def reload(self) -> LoadReport:
        """Re-read the artefact directory.

        The new snapshot is built entirely before the swap, so a reload either
        succeeds atomically or leaves the service on the scorer it already had.
        No request is refused while it runs.
        """
        return self.load()

    def _build_snapshot(self, model_path: Path, meta_path: Path) -> _LoadedModel:
        import joblib  # local import: only needed when an artefact exists
        import numpy as np

        forest = joblib.load(model_path)

        estimators = getattr(forest, "estimators_", None)
        if not estimators:
            raise ModelLoadError("artefact is not a fitted IsolationForest (no estimators_)")

        metadata: dict[str, Any] = {}
        if meta_path.is_file():
            with meta_path.open("r", encoding="utf-8") as handle:
                metadata = json.load(handle)

        feature_order = tuple(metadata.get("featureOrder") or FEATURE_ORDER)
        n_features_in = int(getattr(forest, "n_features_in_", len(feature_order)))
        if len(feature_order) != n_features_in:
            raise ModelLoadError(
                f"metadata declares {len(feature_order)} features but the forest was fitted "
                f"on {n_features_in}"
            )
        unknown = [name for name in feature_order if name not in FEATURE_ORDER]
        if unknown:
            raise ModelLoadError(f"metadata names features this build does not know: {unknown}")

        raw_quantiles = metadata.get("quantiles") or {}
        quantiles: dict[str, dict[str, float]] = {}
        if isinstance(raw_quantiles, Mapping):
            for feature, grid in raw_quantiles.items():
                if not isinstance(grid, Mapping):
                    continue
                clean: dict[str, float] = {}
                for key, value in grid.items():
                    try:
                        clean[str(key)] = float(value)
                    except (TypeError, ValueError):
                        continue
                if clean:
                    quantiles[str(feature)] = clean

        # Precompute per-tree node depths and truncated-leaf corrections once,
        # so scoring a single vector is a handful of array lookups.
        node_depths: list[Any] = []
        leaf_corrections: list[Any] = []
        for estimator in estimators:
            tree = estimator.tree_
            node_depths.append(
                _compute_node_depths(np, tree.children_left, tree.children_right)
            )
            leaf_corrections.append(_expected_path_length_array(np, tree.n_node_samples))

        max_samples = int(getattr(forest, "max_samples_", 256) or 256)
        c_norm = expected_path_length(max_samples)
        if c_norm <= 0.0:
            raise ModelLoadError(f"degenerate forest: c(max_samples={max_samples}) = 0")

        return _LoadedModel(
            forest=forest,
            metadata=metadata,
            feature_order=feature_order,
            quantiles=quantiles,
            node_depths=node_depths,
            leaf_corrections=leaf_corrections,
            max_samples=max_samples,
            c_norm=c_norm,
            model_version=str(metadata.get("modelVersion") or MODEL_VERSION),
        )

    # -- introspection ------------------------------------------------------ #

    def info(self) -> dict[str, Any]:
        """Everything ``GET /model/info`` reports. No secrets, no file contents."""
        loaded = self._loaded
        report = self._last_report
        base: dict[str, Any] = {
            "modelVersion": self.model_version,
            "isTrained": loaded is not None,
            "threshold": self.threshold,
            "featureOrder": list(loaded.feature_order if loaded else FEATURE_ORDER),
            "modelDir": str(self.model_dir),
            "loadDetail": report.detail,
            "scoreFormula": "2 ** (-E[h(x)] / c(n)); a SHORT path (leaf near the root) is anomalous",
            "fallbackModelVersion": FALLBACK_MODEL_VERSION,
        }
        if loaded is None:
            base.update(
                {
                    "nEstimators": None,
                    "maxSamples": None,
                    "cNorm": None,
                    "contamination": None,
                    "randomState": None,
                    "trainedAt": None,
                    "nTrainingSamples": None,
                    "suggestedThreshold": None,
                    "sklearnVersion": None,
                    "hasQuantiles": False,
                    "explainer": "rule-engine",
                }
            )
            return base

        forest = loaded.forest
        base.update(
            {
                "nEstimators": int(getattr(forest, "n_estimators", self.n_estimators)),
                "maxSamples": loaded.max_samples,
                "cNorm": round(loaded.c_norm, 6),
                "contamination": _jsonable(getattr(forest, "contamination", None)),
                "randomState": _jsonable(getattr(forest, "random_state", None)),
                "trainedAt": loaded.metadata.get("trainedAt"),
                "nTrainingSamples": loaded.metadata.get("nSamples"),
                "suggestedThreshold": loaded.metadata.get("suggestedThreshold"),
                "sklearnVersion": loaded.metadata.get("sklearnVersion"),
                "hasQuantiles": bool(loaded.quantiles),
                "explainer": "training-quantiles" if loaded.quantiles else "rule-engine",
            }
        )
        return base

    # -- scoring ------------------------------------------------------------ #

    def average_path_length(self, features: Mapping[str, float]) -> float | None:
        """``E[h(x)]`` for one vector: the mean corrected path length over every
        tree in the forest.

        ``None`` when no forest is loaded, because the rule engine has no trees
        and therefore no path to measure. SHORT is the anomalous direction.
        """
        loaded = self._loaded
        if loaded is None:
            return None
        _mean_depth, mean_path = self._path_statistics(loaded, features)
        return mean_path

    def leaf_depth_statistics(self, features: Mapping[str, float]) -> dict[str, float] | None:
        """Depth-of-leaf statistics across the ensemble for one vector.

        Returns the mean raw node depth (how far from the ROOT the vector's leaf
        sits, averaged over the trees), the mean corrected path length, the
        normaliser ``c(max_samples)`` and the resulting score. ``None`` under
        the rule-engine fallback.
        """
        loaded = self._loaded
        if loaded is None:
            return None
        mean_depth, mean_path = self._path_statistics(loaded, features)
        return {
            "meanLeafDepth": round(mean_depth, 6),
            "meanPathLength": round(mean_path, 6),
            "cNorm": round(loaded.c_norm, 6),
            "anomalyScore": round(
                anomaly_score_from_path_length(mean_path, loaded.max_samples), 6
            ),
        }

    def score_one(self, match_id: str, features: Mapping[str, float]) -> ScoringResult:
        """Score a single feature vector. Never raises for model reasons."""
        loaded = self._loaded
        if loaded is None:
            return self._score_with_rules(match_id, features)
        try:
            return self._score_with_forest(loaded, match_id, features)
        except Exception:  # noqa: BLE001 - a broken forest must not break scoring
            logger.exception("model.score_failed | matchId=%s", match_id)
            return self._score_with_rules(match_id, features)

    def score_many(
        self, rows: Sequence[tuple[str, Mapping[str, float]]]
    ) -> list[ScoringResult]:
        """Score a batch. Kept as a loop on purpose.

        Vectorising the forest pass would save microseconds and cost the
        per-row isolation that stops one malformed vector poisoning the rest of
        the batch. Batches are capped by ``ANOMALY_MAX_BATCH_SIZE``.
        """
        return [self.score_one(match_id, features) for match_id, features in rows]

    # -- internals ---------------------------------------------------------- #

    def _path_statistics(
        self, loaded: _LoadedModel, features: Mapping[str, float]
    ) -> tuple[float, float]:
        """Return ``(mean raw leaf depth, mean corrected path length)``."""
        import numpy as np

        row = np.array(
            [[float(features[name]) for name in loaded.feature_order]],
            dtype=np.float32,
        )

        total_depth = 0.0
        total_path = 0.0
        estimators = loaded.forest.estimators_
        subspaces = getattr(loaded.forest, "estimators_features_", None)

        for index, estimator in enumerate(estimators):
            subset = row[:, subspaces[index]] if subspaces is not None else row
            leaf = int(estimator.apply(subset)[0])
            depth = float(loaded.node_depths[index][leaf])
            total_depth += depth
            # Truncated-leaf correction: the leaf still holds
            # tree_.n_node_samples[leaf] training points and stands in for a
            # subtree that was never grown.
            total_path += depth + float(loaded.leaf_corrections[index][leaf])

        n_trees = max(1, len(estimators))
        return total_depth / n_trees, total_path / n_trees

    def _score_with_forest(
        self, loaded: _LoadedModel, match_id: str, features: Mapping[str, float]
    ) -> ScoringResult:
        mean_depth, mean_path = self._path_statistics(loaded, features)
        score = round(anomaly_score_from_path_length(mean_path, loaded.max_samples), 6)

        reasons: list[str] = []
        seen: set[str] = set()
        for feature, _severity, sentence in quantile_reasons(features, loaded.quantiles):
            if feature in seen:
                continue
            seen.add(feature)
            reasons.append(sentence)
            if len(reasons) >= MAX_REASONS:
                break

        # Top up with rule-engine sentences when the quantile grid had little to
        # say (or was never written), so a flagged match is never handed back
        # with an empty explanation.
        if len(reasons) < MAX_REASONS:
            for hit in evaluate_rules(features):
                if hit.severity < RULE_REASON_SEVERITY_CUT or hit.feature in seen:
                    continue
                seen.add(hit.feature)
                reasons.append(hit.message)
                if len(reasons) >= MAX_REASONS:
                    break

        return ScoringResult(
            match_id=match_id,
            anomaly_score=score,
            is_anomalous=score >= self.threshold,
            leaf_depth=int(round(mean_depth)),
            average_path_length=round(mean_path, 6),
            model_version=loaded.model_version,
            threshold=self.threshold,
            reasons=reasons,
        )

    def _score_with_rules(self, match_id: str, features: Mapping[str, float]) -> ScoringResult:
        score, hits = rule_based_score(features)
        score = round(score, 6)
        reasons = [hit.message for hit in hits if hit.severity >= RULE_REASON_SEVERITY_CUT][
            :MAX_REASONS
        ]
        return ScoringResult(
            match_id=match_id,
            anomaly_score=score,
            is_anomalous=score >= self.threshold,
            # No forest is loaded, so there is no path to measure. A number
            # here would be indistinguishable from a measured one.
            leaf_depth=None,
            average_path_length=None,
            model_version=FALLBACK_MODEL_VERSION,
            threshold=self.threshold,
            reasons=reasons,
        )


# --------------------------------------------------------------------------- #
# numpy helpers (numpy is passed in so this module stays stdlib at import time) #
# --------------------------------------------------------------------------- #


def _compute_node_depths(np: Any, children_left: Any, children_right: Any) -> Any:
    """Depth of every node in a fitted sklearn tree. The root is depth 0.

    Iterative on purpose: an Isolation Forest tree over a large sub-sample can
    be deep enough to blow a recursive walk's stack.
    """
    n_nodes = int(len(children_left))
    depths = np.zeros(n_nodes, dtype=np.int32)
    stack: list[tuple[int, int]] = [(0, 0)]
    while stack:
        node, depth = stack.pop()
        depths[node] = depth
        left = int(children_left[node])
        if left != -1:  # sklearn's _tree.TREE_LEAF
            stack.append((left, depth + 1))
            stack.append((int(children_right[node]), depth + 1))
    return depths


def _expected_path_length_array(np: Any, n_node_samples: Any) -> Any:
    """Vectorised ``c(n)`` over a tree's per-node sample counts."""
    n = np.asarray(n_node_samples, dtype=np.float64)
    out = np.zeros_like(n)
    two = n == 2.0
    many = n > 2.0
    out[two] = 1.0
    nm = n[many]
    out[many] = 2.0 * (np.log(nm - 1.0) + EULER_GAMMA) - 2.0 * (nm - 1.0) / nm
    return out


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def utc_now_iso() -> str:
    """RFC 3339 / ISO 8601 instant with a trailing ``Z``."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
