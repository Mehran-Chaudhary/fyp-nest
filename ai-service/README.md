# DAIAP AI service

The Python service behind the backend's knowledge layer and privacy engine. It
implements [contract v1](../docs/contracts/ai-service-v1.md) and nothing else:

| Endpoint | Does | Used by |
|---|---|---|
| `POST /v1/documents/parse` | File bytes → structured, token-sized chunks | Document ingestion |
| `POST /v1/embeddings` | Texts → unit vectors | Ingestion and every RAG query |
| `POST /v1/rerank` | Query + passages → relevance order | RAG, when `RAG_RERANK_ENABLED=true` |
| `POST /v1/pii/analyze` | Texts → name/place/organisation spans | The PII engine, before every model call |
| `GET /v1/health` | Models, dimensions, capabilities | Backend boot check and `/health` |
| `GET /livez` | Process is alive (unsigned) | Your host's health check |

It stores nothing, keeps no tenant data between requests, never talks to the
database or the vector store, and never logs document, query or PII text (or
filenames, which often contain names). Every `/v1/*` request must carry the
backend's HMAC signature.

---

## What is inside, and why

**Parsing** keeps the structure retrieval needs:

- **PDF** runs on PDFium. Headings come from type size and weight, paragraphs are rebuilt across line and page breaks with hyphenation undone, and lists are detected. Running headers, footers and page numbers are removed. Scanned pages are counted; with the `ocr` extra installed they are OCR'd. The OCR hook is tested with a stand-in engine, but the RapidOCR adapter itself has not been run yet: the package could not be installed on the development network. Verify it before relying on scanned-PDF support.
- **DOCX** keeps Word's own structure: heading styles, numbered lists, and tables rendered as Markdown tables.
- **Markdown** goes through a CommonMark parser, so tables and code fences stay whole. **TXT** handles encoding detection (UTF-8/16, Windows-1252, and others).

**Chunking** is structure-aware and token-exact:

- Sizes are counted with the embedding model's own tokenizer.
- Paragraphs, lists, tables and code stay whole when they fit. Otherwise they split at sentences, list items, or table rows (each piece repeats the header row).
- Small sibling sections share a chunk.
- Overlap is made of whole sentences, never half a word.
- Every chunk begins with its section path, e.g. `Leave Policy > Annual Leave`, so a chunk that only says "twenty days, accrued monthly" is still found by a search for annual leave.

**Models** run on ONNX Runtime directly (no PyTorch). Each is pinned to an
exact Hugging Face commit in [`app/models/registry.py`](app/models/registry.py).
The defaults were chosen by measurement on a 4-core laptop CPU (i5-8365U),
see [Choosing models](#choosing-models):

| Role | Default | Why |
|---|---|---|
| Embeddings | `embeddinggemma-300m-int8`: Google EmbeddingGemma 300M, int8 | Best open embedding model under 500M parameters on MTEB. 100+ languages including Urdu (English questions find Urdu passages). 768 dimensions, Matryoshka 512/256/128 |
| Reranker | `jina-reranker-v1-turbo-en`, int8 | 1.5 s for 32 candidates on CPU, BEIR 49.6, 8K context. `bge-reranker-base` scores higher but took 15 s |
| PII | Presidio + spaCy `en_core_web_md` + a transformer NER (see [PII accuracy](#pii-accuracy)) | Union of a statistical and a transformer detector: a missed name is a leak |

**Security:**

- HMAC verification over the exact raw path and query, the body hash, the timestamp and a single-use nonce.
- Replay protection, in memory or shared through Redis.
- Two keys accepted during a rotation.
- Body limits enforced before parsing.
- A non-root container.

**Operations:**

- Models load in the background at startup, so `/livez` answers immediately. A request for a model still loading gets `503 MODEL_LOADING` with `Retry-After`, which the backend retries.
- CPU work runs in separate lanes, so a long parse never blocks a PII check.
- Logs are structured JSON, with the backend's `X-Request-Id` on every line.

---

## Run it locally (Windows PowerShell)

Needs Python 3.11+ (tested on 3.13).

```powershell
cd D:\fyp_backend_nest\ai-service
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt   # exact, tested versions
.venv\Scripts\python -m pip install pytest pypdf           # only to run the tests

# Models: ~800 MB, pinned revisions; the spaCy wheel is SHA-256 checked.
.venv\Scripts\python -m app.models.download --spacy-wheel-dir .models\wheels
.venv\Scripts\python -m pip install --no-deps (Get-ChildItem .models\wheels\en_core_web_md-*.whl)

Copy-Item .env.example .env
# Set AI_SERVICE_SIGNING_SECRET in .env to the backend's AI_SERVICE_SIGNING_SECRET.

.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`GET http://127.0.0.1:8000/livez` should answer `{"status":"alive"}`. Model
loading finishes about 15 seconds later; the log says `model ready` for each
component.

### Connect the backend

In the backend's `.env`:

```dotenv
AI_SERVICE_URL=http://127.0.0.1:8000
AI_SERVICE_KEY_ID=v1
EMBEDDING_MODEL=embeddinggemma-300m-int8
EMBEDDING_DIMENSIONS=768
PII_NER_PROVIDER=ai-service
PII_DEFAULT_ON_FAILURE=REFUSE
# CPU-sized calls: 8 chunks per embedding request, with time to spare.
EMBEDDING_BATCH_SIZE=8
AI_SERVICE_TIMEOUT=90s
PII_TIMEOUT=20s
RAG_RERANK_ENABLED=true
```

Restart the backend. It calls `/v1/health` at boot and logs
`AI service reachable (status: ok)`. Its own `/health` should then show
`ai_service` and `pii_detector` as `up`.

`EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` must be identical on both sides.
The backend rejects vectors from any other model.

---

## Tests

```powershell
.venv\Scripts\python -m pytest
```

- **Contract and security:** signature, replay, tampering, rotation and size limits. Two cross-language tests run the backend's own TypeScript signer and verifier against this service, in both directions.
- **Parsing:** real PDFs built with PDFium, DOCX built with python-docx, Markdown, text and encodings.
- **Chunking rules.**
- **Every endpoint** through the signature gate.
- **Real models** (marked `models`, skipped when not downloaded):
  - paraphrased-question retrieval in English;
  - English → Urdu cross-lingual retrieval;
  - reranking;
  - NER offsets in text with emoji;
  - texts longer than the NER window.

The backend's PII benchmark exercises the whole path, including the backend's
client, signing and offset conversion:

```powershell
# with this service running on :8000 and the same secret
cd D:\fyp_backend_nest
$env:AI_SERVICE_URL="http://127.0.0.1:8000"; $env:AI_SERVICE_SIGNING_SECRET="<secret>"
npm run benchmark:pii -- --ner ai-service --out .tmp/pii-bench
```

---

## PII accuracy

On the backend's benchmark (2,000 synthetic HR, finance, support and chat
documents, 4,575 annotated person names, seed 20260924):

PII_TABLE_PLACEHOLDER

Every structural type (cards, IBANs, CNICs, phones, emails, credentials,
salaries) is found by the backend's own validated recognizers at 0% leakage.
This service adds the names.

---

## Choosing models

Measured on an Intel i5-8365U (4 cores, 8 threads, laptop power envelope),
int8 ONNX:

| Embedding model | Speed | Languages | Notes |
|---|---|---|---|
| `embeddinggemma-300m-int8` (default) | ~280 tokens/s | 100+ | Highest quality. About 15 s per backend batch of 8 chunks |
| `multilingual-e5-small` | ~2,100 tokens/s | ~100 | 7.7x faster, 384 dimensions, lower retrieval quality. For small or slow hosts |
| `nomic-embed-text` | ~500 tokens/s | English | The backend's old default label |
| `bge-small-en-v1.5` | fastest | English | 384 dimensions, for 512 MB hosts |

`embeddinggemma-300m-q4` was measured too. It was no faster on this CPU and
agreed only 0.96 (cosine) with the int8 build, so it is not recommended.

Changing the embedding model changes the vector space. Follow the backend's
"Changing the embedding model" procedure (docs/CLOUD_SETUP.md): use a new
`QDRANT_COLLECTION_PREFIX` and re-index. Choose before the first upload if you
can.

---

## Deploy (Google Cloud Run)

Cloud Run's free tier is 180,000 vCPU-seconds and 360,000 GiB-seconds a
month, billed only while requests run. It needs a billing account; set a budget
alert.

```bash
gcloud run deploy daiap-ai \
  --source . \
  --region asia-south1 \
  --cpu 4 --memory 4Gi \
  --concurrency 8 --timeout 300 \
  --min-instances 0 --max-instances 1 \
  --set-env-vars AI_SERVICE_KEY_ID=v1,LOG_FORMAT=json \
  --set-secrets AI_SERVICE_SIGNING_SECRET=daiap-ai-signing-secret:latest \
  --allow-unauthenticated
```

`--allow-unauthenticated` is correct here. Cloud Run's IAM check would need a
Google identity token the backend does not send, and every `/v1/*` request is
HMAC-verified by the service itself. One instance keeps the in-memory replay
store exact. For more replicas, set `REPLAY_REDIS_URL`.

Then set the backend's `AI_SERVICE_URL` to the `https://daiap-ai-….run.app`
URL.

**Cold starts:** after scaling to zero, the first request waits for the models
to load (~15 s). Ingestion retries through it. The first PII check after an
idle period may need `PII_TIMEOUT=30s`, or set `--min-instances 1` (billed).

**Other hosts:** any Docker host with ≥ 2 GB RAM. On 512 MB hosts (Render
Free, Koyeb Free) use:

```
--build-arg EMBEDDING_MODEL=multilingual-e5-small --build-arg RERANK_MODEL=none
--build-arg PII_TRANSFORMER_MODEL=none --build-arg PII_SPACY_MODEL=en_core_web_sm
```

Then set the backend's `EMBEDDING_MODEL=multilingual-e5-small` and
`EMBEDDING_DIMENSIONS=384`.

---

## Operations

**Rotating the signing secret:**

1. Here, set `AI_SERVICE_PREVIOUS_SIGNING_SECRET` / `AI_SERVICE_PREVIOUS_KEY_ID` to the current pair and the new pair as `AI_SERVICE_SIGNING_SECRET` / `AI_SERVICE_KEY_ID=v2`. Deploy.
2. On the backend, set the new secret and `AI_SERVICE_KEY_ID=v2`. Deploy.
3. Remove the previous pair here.

**Health:** `GET /v1/health` (signed) reports each model's state (`pending`, `loading`, `ready`, `failed` or `disabled`). A failed model is reported by its exception type; the details are in the logs.

**Configuration reference:** [`.env.example`](.env.example).
