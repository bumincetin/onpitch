# Anomaly sidecar

An advisory Isolation Forest service that scores match-integrity feature
vectors for OnPitch. FastAPI + scikit-learn, HMAC-signed, no database access
in the request path.

**It is advisory, and every caller is written to survive its absence.**
`POST /api/internal/anomaly/check` gives it 2.5 seconds and records an
in-database rule-engine verdict on any timeout or non-2xx. Keep it that way: a
match must never fail to finalise because an ML service is down.

---

## 1. Run it

```bash
cd services/anomaly
python -m venv .venv
. .venv/bin/activate            # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt

cp .env.example .env            # fill in ANOMALY_SERVICE_SECRET
set -a; . ./.env; set +a        # PowerShell: set the vars however you prefer

uvicorn app.main:app --reload --port 8000
```

With no `artifacts/model.joblib` on disk the service still starts and serves the
**deterministic rule engine**, reporting `"modelVersion": "rules-fallback-v1"`.
That is a supported state — see
[§5](#5-cold-start-what-rules-fallback-v1-actually-does).

Docker:

```bash
docker build -t onpitch-anomaly services/anomaly
docker run --rm -p 8000:8000 \
  -e ANOMALY_SERVICE_SECRET="$ANOMALY_SERVICE_SECRET" \
  -e ANOMALY_ALLOWED_ORIGINS="https://app.example.com" \
  -v "$PWD/artifacts:/srv/anomaly/artifacts:ro" \
  onpitch-anomaly
```

Tests:

```bash
pip install "pytest>=8.2,<9" "httpx>=0.27,<0.29"
pytest -q
```

---

## 2. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/score` | HMAC signature | Score one feature vector |
| `POST` | `/score/batch` | HMAC signature | Score up to `ANOMALY_MAX_BATCH_SIZE` vectors |
| `GET` | `/healthz` | none | Liveness, and which scorer is active |
| `GET` | `/model/info` | HMAC signature | Model + training metadata |
| `POST` | `/model/reload` | `X-OnPitch-Admin-Token` | Re-read the artefact directory |

`/healthz` is open so an orchestrator can probe it; it reveals nothing an
attacker who can already reach the port would not learn from one failed
request. `/model/info` is signed because it describes the training corpus.

### `POST /score`

Request — exactly the `AnomalyFeatureVector` from `packages/shared/src/domain.ts`:

```json
{
  "matchId": "6f1b0b16-4d1b-4a9e-9f31-1f0a2b3c4d5e",
  "scoreVariance": 4.0,
  "reportingDelaySeconds": 120,
  "reporterCount": 2,
  "opposingReportAgreement": 0.0,
  "participantOverlapRatio": 0.9,
  "historicalReportDeviation": 2.1,
  "goalDiff": 9,
  "kickoffHour": 23,
  "venueBookingsLast7d": 1,
  "reporterAccountAgeDays": 2
}
```

Response — exactly what `anomalyVerdictResponseSchema` (Zod) parses back:

```json
{
  "matchId": "6f1b0b16-4d1b-4a9e-9f31-1f0a2b3c4d5e",
  "anomalyScore": 0.9616,
  "isAnomalous": true,
  "leafDepth": null,
  "averagePathLength": null,
  "modelVersion": "rules-fallback-v1",
  "threshold": 0.62,
  "reasons": [
    "reported scorelines disagree - variance 4.00 (corroborated reports sit at 0.00)",
    "the two sides told different stories - home/away report agreement 0%",
    "closed circuit - 90% of these players' earlier matches were against this same opposing group",
    "the first reporter's account is 2.0 day(s) old",
    "the reporters are historically 2.1 goals off the confirmed scoreline"
  ]
}
```

With a trained forest loaded, the same request returns
`"modelVersion": "if-v1"` and real numbers in `leafDepth` and
`averagePathLength`.

`snake_case` keys are accepted too, so the output of
`public.anomaly_features(match_id)` — which is `to_jsonb` of a composite type,
plus a nested `collusion` object — can be forwarded verbatim. The `collusion`
object is accepted and ignored: the forest was not trained on it, and folding
an unmodelled signal into the score would make the verdict unreproducible.

### `POST /score/batch`

```jsonc
// request
{ "matches": [ /* AnomalyFeatureVector, ... */ ] }

// response
{
  "results": [ /* AnomalyVerdict, in request order */ ],
  "count": 2,
  "flaggedCount": 1,
  "modelVersion": "if-v1",
  "threshold": 0.62,
  "scoredAt": "2026-08-30T12:00:00.000Z"
}
```

`results` is one-for-one with `matches` in the order sent, so the caller can
zip rather than match on id — `matchId` is not guaranteed unique in a
re-scoring sweep. Used by the `anomaly-sweep` Edge Function to drain
`public.matches_pending_anomaly_check(limit)`.

### Errors

Every non-2xx has one shape, so callers branch on a slug rather than on prose:

```json
{ "error": { "code": "signature_invalid", "message": "signature does not match the request body" },
  "requestId": "8f14e45fceea167a5a36dedd4bea2543" }
```

| Status | `error.code` |
|---|---|
| 401 | `signature_missing`, `signature_malformed`, `signature_invalid`, `timestamp_out_of_window`, `signing_not_configured` |
| 413 | `body_too_large` |
| 422 | `invalid_feature_vector`, `empty_body`, `empty_batch`, `batch_too_large` |
| 429 | `rate_limited` |
| 500 | `internal_error` |

---

## 3. Request signing

```
X-OnPitch-Timestamp: 1756500000                 # Unix seconds
X-OnPitch-Signature: 3f2a…c91                   # lowercase hex, 64 chars

signature = hex( HMAC_SHA256( secret, `${timestamp}.${rawBody}` ) )
```

Three properties the verifier depends on:

1. **The signed body is the raw bytes on the wire**, never a re-serialised
   object. A verifier that re-encodes passes its own tests and fails the moment
   key order or whitespace differs.
2. **The timestamp is inside the MAC**, so a captured body cannot be replayed
   with a fresh timestamp.
3. **Comparison is `hmac.compare_digest`**, so a byte-wise early exit cannot
   leak the expected signature one character at a time.

The skew window bounds replay rather than preventing it. A captured request
replayed *inside* the window (default 300s, symmetric — a far-future clock is
as suspicious as a stale one) still verifies. That is accepted here because the
endpoint is idempotent, advisory, rate-limited and on a private network; add a
nonce cache if any of those stop being true.

Caller side, in the Next.js route:

```ts
const ts = Math.floor(Date.now() / 1000).toString()
const body = JSON.stringify(featureVector)          // serialise ONCE
const sig = crypto.createHmac("sha256", process.env.ANOMALY_SERVICE_SECRET!)
  .update(`${ts}.${body}`).digest("hex")

const res = await fetch(`${process.env.ANOMALY_SERVICE_URL}/score`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-OnPitch-Timestamp": ts,
    "X-OnPitch-Signature": sig,
  },
  body,                                              // the SAME string
  signal: AbortSignal.timeout(2500),
})
```

By hand:

```bash
SECRET="$ANOMALY_SERVICE_SECRET"
BODY='{"matchId":"6f1b0b16-4d1b-4a9e-9f31-1f0a2b3c4d5e","scoreVariance":4.0,"reportingDelaySeconds":120,"reporterCount":2,"opposingReportAgreement":0.0,"participantOverlapRatio":0.9,"historicalReportDeviation":2.1,"goalDiff":9,"kickoffHour":23,"venueBookingsLast7d":1,"reporterAccountAgeDays":2}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -sS localhost:8000/score \
  -H "Content-Type: application/json" \
  -H "X-OnPitch-Timestamp: $TS" \
  -H "X-OnPitch-Signature: $SIG" \
  --data-raw "$BODY"
```

A `GET` has no body, so the signed string is `"${TS}."` over an empty payload:

```bash
TS=$(date +%s)
SIG=$(printf '%s.' "$TS" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -sS localhost:8000/model/info \
  -H "X-OnPitch-Timestamp: $TS" -H "X-OnPitch-Signature: $SIG"
```

---

## 4. How it plugs into `/api/internal/anomaly/check`

```
score report filed
      │
      ▼
public.evaluate_score_consensus(match_id)        ← layer 1, in-database rules
      │
      ▼
POST /api/internal/anomaly/check                 ← guarded by INTERNAL_API_TOKEN
      │
      ├─ public.anomaly_features(match_id)  ──►  the feature vector
      │
      ├─ POST {ANOMALY_SERVICE_URL}/score   ──►  THIS SERVICE   (2.5s, HMAC)
      │        │
      │        ├─ 2xx  → parse with anomalyVerdictResponseSchema
      │        │         source = 'isolation_forest'
      │        └─ else → in-database rule verdict
      │                  source = 'rule_engine'
      ▼
public.record_anomaly_verdict(
  p_match_id, p_source, p_anomaly_score, p_is_anomalous,
  p_reasons, p_model_version, p_leaf_depth, p_average_path_length)
      │
      ▼
match_anomaly_flags row  +  matches.anomaly_score
      │
      └─ score ≥ public.anomaly_score_threshold()  →  matches.requires_consensus = true
                                                       → peer-consensus round opens
```

Two consequences of that split:

- **The sidecar does not set `source`.** The verdict body carries no `source`
  field; the route decides between `'isolation_forest'` and `'rule_engine'`
  based on whether the sidecar answered at all. That is why a fallback verdict
  from *inside* the sidecar still comes back as a 200 with
  `modelVersion: "rules-fallback-v1"` — the route recorded that an ML service
  answered, and `model_version` says which brain did the answering.
- **Two thresholds exist and must be kept in step.** `ANOMALY_THRESHOLD` here
  and `public.anomaly_score_threshold()` in
  `supabase/migrations/0005_integrity_consensus.sql` both default to `0.62`.
  `record_anomaly_verdict` lets an explicit `p_is_anomalous` win over its own
  comparison, so the sidecar's boolean is authoritative — but a mismatch makes
  the recorded flag hard to explain after the fact. Change both.

The `anomaly-sweep` Edge Function does the same thing in bulk against
`/score/batch`, draining `public.matches_pending_anomaly_check(limit)`.

---

## 5. Cold start: what `rules-fallback-v1` actually does

Real Isolation Forests need real history, and on day one there is none. Rather
than ship an endpoint that 503s until someone finds a training set, the service
falls back to a fixed, deterministic rule engine, specified below.

Eleven heuristics each produce a severity in `[0, 1]` and carry a `strength` —
the most probability mass that rule may contribute alone. They combine with a
noisy-OR:

```
p     = 1 - Π (1 - severityᵢ × strengthᵢ)
score = p ^ 1.35
```

Noisy-OR because the heuristics are near-independent pieces of evidence
pointing the same way: any one raises suspicion, several raise it more, none
reaches 1.0 alone. The exponent pulls the middle of the range down so a couple
of soft signals stays under the 0.62 cut while a flat contradiction between the
two camps clears it.

| Rule | Fires when | Strength |
|---|---|---|
| `report_disagreement` | reported scorelines have variance > 0, saturating at 4.0 | 0.733 |
| `opposing_sides_disagree` | home and away reports contradict (needs ≥ 2 reporters) | 0.600 |
| `premature_report` | the result was filed *before* the final whistle | 0.600 |
| `closed_circuit` | > 60% of these players' earlier matches were against this same group | 0.500 |
| `fresh_reporter` | the first reporter's account is under 14 days old | 0.433 |
| `single_reporter` | exactly one participant reported | 0.400 |
| `unreliable_reporter` | reporters historically 0.5–4 goals off the confirmed score | 0.400 |
| `implausible_margin` | goal difference past 8, saturating at 20 | 0.367 |
| `late_report` | filed more than 1h after the whistle, saturating at 48h | 0.333 |
| `odd_kickoff_hour` | kickoff outside 07:00–23:59 venue-local | 0.267 |
| `quiet_venue` | fewer than 3 other bookings at the venue in the trailing 7 days | 0.233 |

Calibration points (all from `tests/test_scoring.py`, which is where to retune
them):

| Vector | Score | Flagged |
|---|---|---|
| ordinary Tuesday-night match | 0.000 | no |
| mild: late report, half-agreeing reports | 0.339 | no |
| the two camps flatly contradict each other | 0.859 | **yes** |
| filed before the whistle, alone, at 03:00 | 0.638 | **yes** |
| the `docs/API.md` example | 0.962 | **yes** |

Under the fallback, `leafDepth` and `averagePathLength` come back `null`. There
is no tree, so there is no path to measure, and a synthesised depth would be
indistinguishable from a measured one at the caller. The `null` is the signal
that no forest was involved.

A *corrupt* artefact degrades the same way: it is logged and the rule engine
takes over. The service does not refuse to start because a model file is bad.

---

## 6. The Isolation Forest, and which direction is which

Path length runs opposite to the score:

```
SHORT path  →  leaf near the ROOT  →  isolated immediately  →  ANOMALOUS  →  HIGH score
LONG  path  →  leaf deep in tree   →  hard to isolate       →  NORMAL     →  LOW  score
```

Each of the 200 trees splits on random features at random values until every
point is alone. `h(x)` is how many splits that took. Normalise by the average
path length of an unsuccessful BST search over `n` points:

```
c(n) = 2·H(n−1) − 2(n−1)/n          H(i) = ln(i) + γ,  γ = 0.5772156649015329
c(2) = 1,   c(n ≤ 1) = 0

score = 2^( −E[h(x)] / c(n) )       ∈ (0, 1]
```

so `E[h(x)] → 0` gives `score → 1`, `E[h(x)] = c(n)` gives exactly `0.5` (no
signal either way), and a deeply buried point tends to `0`. For reference,
`c(256) = 10.2448`.

`E[h(x)]` averages over every tree. Because each tree is fitted on a sub-sample,
its leaves are truncated: a leaf still holding `m > 1` training points stands in
for a subtree that was never grown, so `c(m)` is added to the measured node
depth. That is why the response carries both numbers:

- `leafDepth` — mean **raw** node depth, an integer. How far from the root.
- `averagePathLength` — `E[h(x)]`, truncated-leaf corrected, a float, slightly
  larger.

This reproduces scikit-learn's own `-IsolationForest.score_samples(X)`. We
compute it ourselves only because the platform contract needs those
intermediates, which sklearn does not expose. `train.py` asserts the two
formulations agree before writing an artefact.

### What `reasons` actually measures

Isolation Forests give no per-feature attribution, and these strings are not
SHAP values. With a trained model, each feature is placed on the empirical
quantile grid captured at training time and ranked by how far into its
*suspicious tail* it sits — high `scoreVariance` is suspicious, low
`reporterCount` is suspicious, `kickoffHour` is suspicious in either direction.
A reason therefore reports **"this value is unusual"**, and carries no claim
about which features the forest split on. When the quantile grid has little to
say, the rule-engine sentences top the list up, so a flagged match never comes
back with an empty explanation.

---

## 7. Retraining

```bash
# From the database, over the SESSION-mode pooler (port 5432)
export ANOMALY_TRAINING_DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres"
python train.py --source db --limit 50000

# Or from a CSV (camelCase or snake_case headers, extra columns ignored)
python train.py --source csv --csv data/features.csv

# Try it without writing anything
python train.py --source db --dry-run
```

**Port 5432, not 6543.** The transaction pooler returns the connection at every
`COMMIT` — right for serverless route handlers sharing a few backends, wrong
for a job that streams tens of thousands of rows through a server-side cursor
in one long transaction. `train.py` refuses a `:6543` or `pgbouncer=true` URL
rather than failing halfway through. It also needs a *direct* connection for
authorisation: `public.anomaly_features()` is `security definer` and calls
`private.assert_integrity_reader()`, which returns early when `auth.uid()` is
NULL — true for psycopg, false for PostgREST.

Useful flags: `--n-estimators` (200), `--contamination` (`auto` or a float in
`(0, 0.5]`), `--random-state` (1712, fixed so a rebuild reproduces the same
trees — a verdict you cannot reproduce is useless in a dispute),
`--exclude-flagged` (drop matches an admin already confirmed as anomalous so
the learned "normal" is cleaner), `--min-rows` (200; below that the job refuses
to fit, because a forest trained on a handful of matches learns noise and the
rule engine is genuinely better).

Output:

- `artifacts/model.joblib` — the fitted `IsolationForest`
- `artifacts/metadata.json` — feature order, per-feature training quantiles
  (these drive the `reasons`), the score distribution, a suggested threshold,
  and provenance (sklearn/numpy/python versions, row count, timestamp)

The feature **order** in the metadata is load-bearing: `app/model.py` builds
every input row from it, so a model trained on a different order still scores
correctly as long as its metadata travels with it.

Ship it without a restart:

```bash
curl -sS -X POST localhost:8000/model/reload \
  -H "X-OnPitch-Admin-Token: $ANOMALY_ADMIN_TOKEN"
```

The replacement snapshot is built in full before the swap, so a reload never
opens a window where scoring has no model, and a failed reload leaves the
previous scorer in place and reports why.

The suggested threshold is **reported, never applied**. Where the cut sits is a
product decision about how many real players get sent into a consensus round,
not something a training run should change under you.

---

## 8. Configuration

Every variable, its default and its meaning is in
[`.env.example`](./.env.example). The essentials:

| Variable | Default | Notes |
|---|---|---|
| `ANOMALY_SERVICE_SECRET` | — | **Required.** Must be byte-identical to the app's. ≥ 32 chars. |
| `ANOMALY_ALLOW_UNSIGNED` | `false` | Dev only. Refused when `ANOMALY_ENV=production`. |
| `ANOMALY_ADMIN_TOKEN` | `INTERNAL_API_TOKEN` | Guards `/model/reload`. Unset ⇒ endpoint closed to all. |
| `ANOMALY_MODEL_DIR` | `artifacts` | Missing ⇒ rule-engine fallback. |
| `ANOMALY_THRESHOLD` | `0.62` | Keep in step with `public.anomaly_score_threshold()`. |
| `ANOMALY_ALLOWED_ORIGINS` | `http://localhost:3000` | CORS allow-list, comma separated. |
| `ANOMALY_RATE_LIMIT` | `120` | Per peer, per window, **per process**. |
| `ANOMALY_MAX_BATCH_SIZE` | `200` | `/score/batch` cap. |
| `ANOMALY_TRAINING_DATABASE_URL` | `DIRECT_URL` | `train.py` only. Session mode, port 5432. |

The service refuses to start on a bad configuration rather than surfacing it as
a 500 an hour later: no secret and no `ANOMALY_ALLOW_UNSIGNED`, a secret under
32 characters, `ANOMALY_ALLOW_UNSIGNED=true` in production, a threshold outside
`[0, 1]`, and so on.

---

## 9. Operational notes

- **Keep it on a private network.** HMAC is defence in depth, not a reason to
  publish the port. The CORS lock is there for a misconfigured ingress, and
  browsers never call this service anyway.
- **Logs are one JSON object per line on stdout**, with a `requestId` on every
  record — taken from an inbound `X-Request-Id` when present, otherwise minted,
  and echoed back on the response. uvicorn's own loggers are routed through the
  same formatter so the stream stays machine-readable.
- **One worker.** Scoring is microseconds of CPU; a second process buys a
  second copy of the forest in memory and a rate limiter that counts to N
  twice. Scale with replicas.
- **The rate limiter is in-process.** N workers × R replicas means the
  effective limit is N × R × `ANOMALY_RATE_LIMIT`. It is a blast-radius cap on
  a private service, not a billing control; put a real one in the ingress if
  you need a global limit.
- **Failure drill.** Stop this service and confirm the platform still finalises
  matches — `docs/SECURITY.md` lists it as a launch checklist item. The
  fallback path is `source = 'rule_engine'` in `match_anomaly_flags`.

---

## 10. Layout

```
services/anomaly/
  app/
    __init__.py      package marker; re-exports the version constants
    config.py        environment parsing and validation (stdlib only)
    main.py          FastAPI: routes, JSON logging, CORS, error shape
    model.py         AnomalyDetector, the IF math, the rule engine, the explainer
    schemas.py       pydantic v2 wire models (the contract with packages/shared/src/domain.ts)
    security.py      HMAC verification and the rate limiter (stdlib only)
  tests/
    test_scoring.py  scoring, signing, and the cold-start fallback
  train.py           fit the forest, write model.joblib + metadata.json
  Dockerfile         python:3.12-slim, non-root, healthcheck
  requirements.txt
  .env.example
```

`model.py` and `security.py` import only the standard library at module scope —
numpy, scikit-learn and joblib are imported lazily inside the paths that need a
trained forest. That is what lets the rule engine and the signing scheme be
tested without the ML stack installed, and it is worth preserving.
