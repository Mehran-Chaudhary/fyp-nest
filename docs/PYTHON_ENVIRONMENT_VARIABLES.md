# Complete Python AI service environment reference

Audited 4 October 2026: **34 settings** from `ai-service/app/config.py`. Values below are source defaults, never local secret values. See [the deployment handoff](DEPLOYMENT_READINESS.md) for which values to set on Cloud Run.

The existing Docker image overrides `MODEL_DOWNLOAD=false`, `MODEL_CACHE_DIR=/srv/.models`, and model selections through build arguments. Cloud Run supplies `PORT`. `SERVICE_ROOT` means the Python service directory; `MIN_SECRET_LENGTH` is 32 characters. `EMBEDDING_DIMENSIONS=0` selects the model native dimension (768 for the current EmbeddingGemma model).

| Variable | Source default | Constraints |
|---|---|---|
| `AI_SERVICE_SIGNING_SECRET` | `REQUIRED` | min_length=MIN_SECRET_LENGTH |
| `AI_SERVICE_KEY_ID` | `'v1'` | pattern='^[A-Za-z0-9._-]{1,32}$' |
| `AI_SERVICE_PREVIOUS_SIGNING_SECRET` | `''` | — |
| `AI_SERVICE_PREVIOUS_KEY_ID` | `''` | — |
| `SIGNATURE_TOLERANCE_SECONDS` | `300` | ge=30, le=900 |
| `REPLAY_REDIS_URL` | `''` | — |
| `EMBEDDING_MODEL` | `'embeddinggemma-300m-int8'` | — |
| `EMBEDDING_DIMENSIONS` | `0` | ge=0, le=8192 |
| `RERANK_MODEL` | `'jina-reranker-v1-turbo-en'` | — |
| `PII_ENABLED` | `True` | — |
| `PII_SPACY_MODEL` | `'en_core_web_md'` | — |
| `PII_TRANSFORMER_MODEL` | `'bert-base-NER'` | — |
| `OCR_ENABLED` | `True` | — |
| `OCR_MAX_PAGES` | `50` | ge=0, le=2000 |
| `MODEL_CACHE_DIR` | `SERVICE_ROOT / '.models'` | — |
| `MODEL_DOWNLOAD` | `True` | — |
| `MODEL_WAIT_SECONDS` | `25.0` | ge=0, le=120 |
| `ONNX_THREADS` | `0` | ge=0, le=64 |
| `MAX_DOCUMENT_BYTES` | `64 * 1024 * 1024` | ge=1024 |
| `MAX_JSON_BYTES` | `16 * 1024 * 1024` | ge=1024 |
| `MAX_EMBED_INPUTS` | `256` | ge=1, le=4096 |
| `MAX_RERANK_DOCUMENTS` | `200` | ge=1, le=2000 |
| `MAX_PII_TEXTS` | `64` | ge=1, le=1024 |
| `MAX_PII_CHARACTERS` | `250000` | ge=1000 |
| `MAX_CHUNK_CHARACTERS` | `20000` | ge=1000, le=100000 |
| `CHUNK_CONTEXT_HEADERS` | `True` | — |
| `PARSE_CONCURRENCY` | `2` | ge=1, le=32 |
| `EMBED_CONCURRENCY` | `1` | ge=1, le=32 |
| `RERANK_CONCURRENCY` | `1` | ge=1, le=32 |
| `PII_CONCURRENCY` | `2` | ge=1, le=32 |
| `PORT` | `8000` | ge=1, le=65535 |
| `LOG_LEVEL` | `'INFO'` | pattern='^(DEBUG|INFO|WARNING|ERROR)$' |
| `LOG_FORMAT` | `'json'` | pattern='^(json|text)$' |
| `DOCS_ENABLED` | `False` | — |

The previous signing secret and key ID must be supplied together; the previous ID must differ from the current one. Preserve the current signing secret shared with NestJS. Use Secret Manager for secrets, including a credential-bearing replay Redis URL.

`OCR_ENABLED=true` alone does not install OCR dependencies. `MODEL_DOWNLOAD=false` requires the selected assets to have been baked into the image. Model build arguments and runtime selections must agree. For detailed purposes, see the comments in [the configuration source](../ai-service/app/config.py).
