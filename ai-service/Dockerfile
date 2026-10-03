# syntax=docker/dockerfile:1.7
#
# DAIAP AI service image. Models are downloaded at BUILD time and baked in,
# so a container starts from local files: fast cold starts, and no runtime
# dependency on Hugging Face or GitHub being reachable.
#
#   docker build -t daiap-ai-service .
#   docker run -p 8000:8000 -e AI_SERVICE_SIGNING_SECRET=... daiap-ai-service
#
# Choose other models with build args (labels from app/models/registry.py):
#   docker build --build-arg EMBEDDING_MODEL=bge-small-en-v1.5 --build-arg RERANK_MODEL=none .

ARG PYTHON_VERSION=3.13

# ── Build: dependencies and models ───────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS build

ARG EMBEDDING_MODEL=embeddinggemma-300m-int8
ARG RERANK_MODEL=bge-reranker-base
ARG PII_TRANSFORMER_MODEL=bert-base-NER
ARG PII_SPACY_MODEL=en_core_web_md

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /srv
RUN python -m venv /opt/venv
COPY requirements.txt .
RUN /opt/venv/bin/pip install -r requirements.txt

COPY app ./app
RUN /opt/venv/bin/python -m app.models.download \
        --embedding "$EMBEDDING_MODEL" \
        --rerank "$RERANK_MODEL" \
        --ner "$PII_TRANSFORMER_MODEL" \
        --spacy "$PII_SPACY_MODEL" \
        --spacy-wheel-dir /tmp/wheels \
        --cache-dir /srv/.models \
 && if ls /tmp/wheels/*.whl >/dev/null 2>&1; then /opt/venv/bin/pip install --no-deps /tmp/wheels/*.whl; fi \
 && rm -rf /tmp/wheels \
 && find /srv/.models -name "*.lock" -delete

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim

ARG EMBEDDING_MODEL=embeddinggemma-300m-int8
ARG RERANK_MODEL=bge-reranker-base
ARG PII_TRANSFORMER_MODEL=bert-base-NER
ARG PII_SPACY_MODEL=en_core_web_md

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MODEL_CACHE_DIR=/srv/.models \
    MODEL_DOWNLOAD=false \
    HF_HUB_OFFLINE=1 \
    EMBEDDING_MODEL=${EMBEDDING_MODEL} \
    RERANK_MODEL=${RERANK_MODEL} \
    PII_TRANSFORMER_MODEL=${PII_TRANSFORMER_MODEL} \
    PII_SPACY_MODEL=${PII_SPACY_MODEL} \
    LOG_FORMAT=json \
    PORT=8000

COPY --from=build /opt/venv /opt/venv
COPY --from=build --chown=app:app /srv /srv

WORKDIR /srv
USER app
EXPOSE 8000

# One worker: models load once per process and are shared by the request lanes.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 75 --no-access-log --proxy-headers --forwarded-allow-ips='*'"]
