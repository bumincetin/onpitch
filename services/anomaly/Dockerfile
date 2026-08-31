# syntax=docker/dockerfile:1
#
# Halisaha anomaly sidecar.
#
#   docker build -t halisaha-anomaly services/anomaly
#   docker run --rm -p 8000:8000 \
#     -e ANOMALY_SERVICE_SECRET="$ANOMALY_SERVICE_SECRET" \
#     -e ANOMALY_ALLOWED_ORIGINS="https://app.example.com" \
#     -v "$PWD/artifacts:/srv/anomaly/artifacts:ro" \
#     halisaha-anomaly
#
# The image also runs the training job, so a retrain needs no second build:
#   docker run --rm -e ANOMALY_TRAINING_DATABASE_URL=... \
#     -v "$PWD/artifacts:/srv/anomaly/artifacts" \
#     halisaha-anomaly python train.py --source db --limit 50000
#
# Keep this container on a private network. It is a server-to-server sidecar
# and has no business being reachable from the internet, HMAC or not.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ANOMALY_MODEL_DIR=/srv/anomaly/artifacts

WORKDIR /srv/anomaly

# scikit-learn's wheels link against OpenMP, which python:*-slim does not ship.
# Without libgomp1 the first `import sklearn` dies with a missing
# libgomp.so.1 -- and it dies at runtime, not at build time, so it is worth
# installing here rather than discovering it in production.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Dependencies before source, so an edit to app/ does not re-resolve the wheels.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY train.py ./

# Non-root. The artefact directory is created and owned before the drop so a
# mounted volume and the training job both work without a chown at runtime.
RUN useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin anomaly \
 && mkdir -p /srv/anomaly/artifacts \
 && chown -R anomaly:anomaly /srv/anomaly

USER anomaly

EXPOSE 8000

# python:*-slim has no curl and no wget. Probing with the interpreter avoids
# adding a package purely so the healthcheck can make one HTTP request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request;\
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"]

# One worker on purpose. Scoring is microseconds of CPU, so a second process
# buys nothing but a second copy of the forest in memory and a rate limiter
# that counts to N twice (see the note in app/security.py). Scale with
# replicas behind the ingress if you ever need to.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--no-server-header", "--proxy-headers"]
