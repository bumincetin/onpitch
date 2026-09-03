#!/usr/bin/env python
"""Fit the Isolation Forest and write the artefacts the service loads.

Usage
-----
From a CSV (columns may be camelCase or snake_case, extras ignored)::

    python train.py --source csv --csv data/features.csv

Straight from Postgres::

    export ANOMALY_TRAINING_DATABASE_URL="postgresql://...pooler.supabase.com:5432/postgres"
    python train.py --source db --limit 50000

Both write ``model.joblib`` and ``metadata.json`` into ``--output`` (default
``artifacts/``). The running service picks them up on a restart, or immediately
via ``POST /model/reload`` with the admin token.

------------------------------------------------------------------------------
WHY PORT 5432 AND NOT 6543
------------------------------------------------------------------------------
Supabase fronts Postgres with Supavisor in two modes:

* **Transaction mode, port 6543** (``DATABASE_URL``, ``?pgbouncer=true``). The
  connection returns to the pool at every COMMIT. That suits serverless route
  handlers, where hundreds of short-lived lambdas share a handful of backends.
  It is wrong here, because a returned connection loses server-side cursors,
  prepared statements and session ``SET``s.
* **Session mode, port 5432** (``DIRECT_URL``). One client owns one backend for
  the life of the connection. That is what a long analytical read needs, and
  what this script asks for.

So this job uses ``ANOMALY_TRAINING_DATABASE_URL`` (falling back to
``DIRECT_URL``), and refuses to run against ``:6543``. A training pull is a
single long transaction streaming tens of thousands of rows through a
server-side cursor; on the transaction pooler it would either be broken up
mid-read or hold a pooled backend for minutes, on a database that is also
serving bookings.

Authorisation note: ``public.anomaly_features()`` is ``security definer`` and
calls ``private.assert_integrity_reader()``, which returns early when
``auth.uid()`` is NULL. A direct psycopg session carries no PostgREST JWT
claims, so ``auth.uid()`` is NULL and the read is allowed. That is why this
must be a direct connection and not a PostgREST call.

------------------------------------------------------------------------------
WHAT GETS WRITTEN
------------------------------------------------------------------------------
``model.joblib``   the fitted ``sklearn.ensemble.IsolationForest``
``metadata.json``  feature order, training quantiles (which drive the
                   explainer's ``reasons``), the score distribution over the
                   training set, a suggested threshold, and provenance.

The feature ORDER in metadata is load-bearing: ``app/model.py`` builds every
input row from it, so a model trained on a different order still scores
correctly as long as the metadata travels with it.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

# Import the service's own math so the scores this script reports are, by
# construction, the scores the service will produce. A formula duplicated here
# would drift from the one production uses.
from app.model import (
    DEFAULT_CONTAMINATION,
    DEFAULT_N_ESTIMATORS,
    DEFAULT_RANDOM_STATE,
    DEFAULT_THRESHOLD,
    FEATURE_ORDER,
    METADATA_FILENAME,
    MODEL_FILENAME,
    MODEL_VERSION,
    QUANTILE_LEVELS,
    anomaly_score_from_path_length,
    expected_path_length,
    quantile_key,
)

#: Accepted spellings for every feature, so a CSV exported from either the app
#: or the database loads without hand-editing headers.
COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "score_variance": ("score_variance", "scoreVariance"),
    "reporting_delay_seconds": ("reporting_delay_seconds", "reportingDelaySeconds"),
    "reporter_count": ("reporter_count", "reporterCount"),
    "opposing_report_agreement": ("opposing_report_agreement", "opposingReportAgreement"),
    "participant_overlap_ratio": ("participant_overlap_ratio", "participantOverlapRatio"),
    "historical_report_deviation": ("historical_report_deviation", "historicalReportDeviation"),
    "goal_diff": ("goal_diff", "goalDiff"),
    "kickoff_hour": ("kickoff_hour", "kickoffHour"),
    "venue_bookings_last_7d": (
        "venue_bookings_last_7d",
        "venueBookingsLast7d",
        "venue_bookings_last7d",
    ),
    "reporter_account_age_days": ("reporter_account_age_days", "reporterAccountAgeDays"),
}

#: Pull only matches that actually have reports; a match with no score report
#: has an all-zero vector that would teach the forest that zero is normal.
TRAINING_QUERY = """
select public.anomaly_features(m.id) as features
from public.matches m
where m.status <> 'cancelled'::public.match_status
  and m.kickoff_at < now()
  and exists (select 1 from public.score_reports sr where sr.match_id = m.id)
  {flagged_filter}
order by m.kickoff_at desc
limit %(limit)s
"""

#: Optional hygiene: drop matches an admin already confirmed as anomalous, so
#: the "normal" manifold the forest learns is not partly made of known fraud.
#: Off by default: Isolation Forest is unsupervised, and `contamination`
#: already assumes some fraction of the corpus is anomalous.
FLAGGED_FILTER = """
  and not exists (
    select 1 from public.match_anomaly_flags f
    where f.match_id = m.id and f.is_anomalous
  )
"""

MIN_TRAINING_ROWS = 200


class TrainingError(RuntimeError):
    """Anything that should stop the job with a clear message, not a traceback."""


# --------------------------------------------------------------------------- #
# Loading                                                                      #
# --------------------------------------------------------------------------- #


def _resolve_column(frame: Any, canonical: str) -> str:
    for candidate in COLUMN_ALIASES[canonical]:
        if candidate in frame.columns:
            return candidate
    raise TrainingError(
        f"input is missing the {canonical!r} feature "
        f"(accepted spellings: {', '.join(COLUMN_ALIASES[canonical])})"
    )


def load_from_csv(path: Path) -> Any:
    import pandas as pd

    if not path.is_file():
        raise TrainingError(f"no such CSV: {path}")
    frame = pd.read_csv(path)
    renames = {_resolve_column(frame, name): name for name in FEATURE_ORDER}
    frame = frame.rename(columns=renames)
    return frame[list(FEATURE_ORDER)]


def load_from_db(dsn: str, limit: int, exclude_flagged: bool) -> Any:
    import pandas as pd
    import psycopg

    query = TRAINING_QUERY.format(flagged_filter=FLAGGED_FILTER if exclude_flagged else "")
    rows: list[dict[str, Any]] = []

    # `with psycopg.connect(...)` commits and closes on exit. A server-side
    # (named) cursor streams the result set instead of materialising every row
    # in the client at once -- which is only possible because this is a session
    # -mode connection.
    with psycopg.connect(dsn, autocommit=False) as conn:
        with conn.cursor(name="anomaly_training_cursor") as cursor:
            cursor.itersize = 2000
            cursor.execute(query, {"limit": limit})
            for record in cursor:
                payload = record[0]
                if isinstance(payload, str):
                    payload = json.loads(payload)
                if isinstance(payload, dict):
                    rows.append(payload)

    if not rows:
        raise TrainingError("the training query returned no rows")

    frame = pd.DataFrame(rows)
    renames = {_resolve_column(frame, name): name for name in FEATURE_ORDER}
    frame = frame.rename(columns=renames)
    return frame[list(FEATURE_ORDER)]


def clean(frame: Any) -> Any:
    """Coerce to numeric, drop unusable rows, report what was dropped."""
    import numpy as np
    import pandas as pd

    numeric = frame.apply(pd.to_numeric, errors="coerce")
    before = len(numeric)
    numeric = numeric.replace([np.inf, -np.inf], np.nan).dropna()
    dropped = before - len(numeric)
    if dropped:
        print(f"  dropped {dropped} row(s) with non-numeric, NaN or infinite features")
    return numeric.astype("float64")


# --------------------------------------------------------------------------- #
# Fitting                                                                      #
# --------------------------------------------------------------------------- #


def contamination_arg(raw: str) -> float | str:
    if raw.lower() == "auto":
        return "auto"
    try:
        value = float(raw)
    except ValueError:
        raise argparse.ArgumentTypeError("--contamination must be 'auto' or a float") from None
    if not 0.0 < value <= 0.5:
        raise argparse.ArgumentTypeError("--contamination must be in (0, 0.5]")
    return value


def max_samples_arg(raw: str) -> int | float | str:
    if raw.lower() == "auto":
        return "auto"
    try:
        value = float(raw)
    except ValueError:
        raise argparse.ArgumentTypeError("--max-samples must be 'auto', an int or a float") from None
    return int(value) if value.is_integer() and value > 1 else value


def fit_forest(matrix: Any, args: argparse.Namespace) -> Any:
    from sklearn.ensemble import IsolationForest

    forest = IsolationForest(
        n_estimators=args.n_estimators,
        max_samples=args.max_samples,
        contamination=args.contamination,
        # Fixed seed: two runs over the same rows must produce the same trees,
        # or a verdict cannot be reproduced during a dispute.
        random_state=args.random_state,
        bootstrap=False,
        n_jobs=-1,
    )
    forest.fit(matrix)
    return forest


def path_lengths(forest: Any, matrix: Any) -> Any:
    """``E[h(x)]`` per row, using the same walk ``app/model.py`` performs.

    Kept here (rather than calling into the detector) because the detector
    scores one row at a time by design; training needs the whole matrix.
    """
    import numpy as np

    from app.model import _compute_node_depths, _expected_path_length_array

    n_rows = matrix.shape[0]
    totals = np.zeros(n_rows, dtype=np.float64)
    subspaces = getattr(forest, "estimators_features_", None)

    for index, estimator in enumerate(forest.estimators_):
        subset = matrix[:, subspaces[index]] if subspaces is not None else matrix
        leaves = estimator.apply(subset)
        tree = estimator.tree_
        depths = _compute_node_depths(np, tree.children_left, tree.children_right)
        corrections = _expected_path_length_array(np, tree.n_node_samples)
        totals += depths[leaves] + corrections[leaves]

    return totals / max(1, len(forest.estimators_))


def build_metadata(
    forest: Any,
    frame: Any,
    scores: Any,
    args: argparse.Namespace,
    source: str,
) -> dict[str, Any]:
    import numpy as np
    import sklearn

    quantiles: dict[str, dict[str, float]] = {}
    for feature in FEATURE_ORDER:
        column = frame[feature].to_numpy(dtype="float64")
        quantiles[feature] = {
            quantile_key(level): float(np.quantile(column, level)) for level in QUANTILE_LEVELS
        }

    score_quantiles = {
        quantile_key(level): float(np.quantile(scores, level)) for level in QUANTILE_LEVELS
    }

    # If contamination is a number, the operator has already stated what share
    # of the corpus they believe is dirty; the matching score quantile is the
    # threshold that flags exactly that share. Reported, never auto-applied:
    # the platform's cut lives in `public.anomaly_score_threshold()` and in
    # ANOMALY_THRESHOLD, and moving it is a product decision.
    if isinstance(args.contamination, float):
        suggested = float(np.quantile(scores, 1.0 - args.contamination))
    else:
        suggested = float(np.quantile(scores, 0.95))

    max_samples = int(getattr(forest, "max_samples_", 256))
    return {
        "modelVersion": args.model_version,
        "trainedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "featureOrder": list(FEATURE_ORDER),
        "nSamples": int(len(frame)),
        "source": source,
        "nEstimators": int(forest.n_estimators),
        "maxSamples": max_samples,
        "cNorm": round(expected_path_length(max_samples), 6),
        "contamination": args.contamination,
        "randomState": args.random_state,
        "quantiles": quantiles,
        "scoreQuantiles": score_quantiles,
        "suggestedThreshold": round(suggested, 6),
        "operationalThreshold": DEFAULT_THRESHOLD,
        "flaggedAtOperationalThreshold": int((scores >= DEFAULT_THRESHOLD).sum()),
        "sklearnVersion": sklearn.__version__,
        "numpyVersion": np.__version__,
        "pythonVersion": platform.python_version(),
        "excludedFlaggedMatches": bool(args.exclude_flagged),
    }


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #


def resolve_dsn() -> str:
    dsn = (
        os.environ.get("ANOMALY_TRAINING_DATABASE_URL")
        or os.environ.get("DIRECT_URL")
        or ""
    ).strip()
    if not dsn:
        raise TrainingError(
            "set ANOMALY_TRAINING_DATABASE_URL (or DIRECT_URL) to the Supavisor "
            "SESSION-mode connection string on port 5432"
        )
    if ":6543" in dsn or "pgbouncer=true" in dsn:
        raise TrainingError(
            "that is the transaction-mode pooler (port 6543). It hands the connection back "
            "at every COMMIT, which breaks the server-side cursor this job streams through. "
            "Use the session-mode string on port 5432 (DIRECT_URL)."
        )
    return dsn


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="train.py",
        description="Fit the OnPitch Isolation Forest and write model.joblib + metadata.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--source", choices=("csv", "db"), default="csv", help="where to read features from"
    )
    parser.add_argument("--csv", type=Path, default=Path("data/features.csv"))
    parser.add_argument(
        "--limit", type=int, default=50_000, help="max rows to pull when --source db"
    )
    parser.add_argument(
        "--exclude-flagged",
        action="store_true",
        help="skip matches already flagged anomalous, so the learned 'normal' is cleaner",
    )
    parser.add_argument("--output", type=Path, default=Path("artifacts"))
    parser.add_argument("--n-estimators", type=int, default=DEFAULT_N_ESTIMATORS)
    parser.add_argument("--max-samples", type=max_samples_arg, default="auto")
    parser.add_argument("--contamination", type=contamination_arg, default=DEFAULT_CONTAMINATION)
    parser.add_argument("--random-state", type=int, default=DEFAULT_RANDOM_STATE)
    parser.add_argument("--model-version", default=MODEL_VERSION)
    parser.add_argument(
        "--min-rows",
        type=int,
        default=MIN_TRAINING_ROWS,
        help="refuse to fit on fewer rows than this",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="fit and report, but write nothing"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        if args.source == "csv":
            source = f"csv:{args.csv}"
            print(f"reading {args.csv} ...")
            frame = load_from_csv(args.csv)
        else:
            dsn = resolve_dsn()
            source = "db:session-mode"
            print(f"pulling up to {args.limit} feature vectors over the session-mode pooler ...")
            frame = load_from_db(dsn, args.limit, args.exclude_flagged)

        frame = clean(frame)
        if len(frame) < args.min_rows:
            raise TrainingError(
                f"only {len(frame)} usable row(s); refusing to fit on fewer than "
                f"{args.min_rows}. An Isolation Forest trained on a handful of matches "
                f"learns noise, and the rule-engine fallback is better than a bad model. "
                f"Override with --min-rows if you know what you are doing."
            )

        matrix = frame.to_numpy(dtype="float32")
        print(f"fitting IsolationForest on {matrix.shape[0]} x {matrix.shape[1]} ...")
        forest = fit_forest(matrix, args)

        mean_paths = path_lengths(forest, matrix)
        max_samples = int(getattr(forest, "max_samples_", 256))
        scores = _score_array(mean_paths, max_samples)

        # Guard against the vectorised score and the service's scalar score
        # drifting apart. If this ever trips, the model would report one number
        # at training time and a different one in production.
        scalar_check = anomaly_score_from_path_length(float(mean_paths[0]), max_samples)
        if abs(scalar_check - float(scores[0])) > 1e-9:
            raise TrainingError(
                f"score formula mismatch: vectorised {float(scores[0])!r} vs "
                f"app.model {scalar_check!r}"
            )

        metadata = build_metadata(forest, frame, scores, args, source)

        print(
            f"  c(max_samples={metadata['maxSamples']}) = {metadata['cNorm']}\n"
            f"  training score p50={metadata['scoreQuantiles']['p50']:.4f} "
            f"p95={metadata['scoreQuantiles']['p95']:.4f} "
            f"p99={metadata['scoreQuantiles']['p99']:.4f}\n"
            f"  suggested threshold {metadata['suggestedThreshold']:.4f} "
            f"(operational cut is {DEFAULT_THRESHOLD}, which flags "
            f"{metadata['flaggedAtOperationalThreshold']} of {metadata['nSamples']} rows)"
        )

        if args.dry_run:
            print("--dry-run: nothing written")
            return 0

        _write_artifacts(args.output, forest, metadata)
        print(
            f"\nwrote {args.output / MODEL_FILENAME} and {args.output / METADATA_FILENAME}\n"
            f"restart the sidecar, or POST /model/reload with X-OnPitch-Admin-Token."
        )
        return 0

    except TrainingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _score_array(mean_paths: Any, max_samples: int) -> Any:
    import numpy as np

    c = expected_path_length(max_samples)
    if c <= 0.0:
        return np.full_like(mean_paths, 0.5)
    return np.clip(np.power(2.0, -mean_paths / c), 0.0, 1.0)


def _write_artifacts(output: Path, forest: Any, metadata: dict[str, Any]) -> None:
    import joblib

    output.mkdir(parents=True, exist_ok=True)
    joblib.dump(forest, output / MODEL_FILENAME, compress=3)
    with (output / METADATA_FILENAME).open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
