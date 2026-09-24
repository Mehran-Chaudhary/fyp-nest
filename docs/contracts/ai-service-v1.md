# AI service contract, v1

The interface between this backend and the Python AI service. The backend is
the only client. This document is the specification; the TypeScript side lives
in `src/shared/ai-service/`.

**Division of labour.** The AI service does stateless computation: it turns
bytes into chunks and text into vectors. It stores nothing, holds no tenant
data between requests, and never talks to the vector store or the database.
The backend decides what may be processed, stores the results encrypted, and
enforces who may retrieve them.

Conventions:

- JSON bodies are `snake_case`. All endpoints are under `/v1`.
- Every request carries `X-Request-Id` (log it; it links your logs to the
  backend's audit trail) and, where a workspace is involved, `X-Organization-Id`
  (log it; never use it for authorisation).
- `X-DAIAP-Contract: 1` is sent on every request.

---

## Authentication: HMAC request signing

Every request is signed. **Reject any request that fails verification with
`401`.** A static token would be replayable and would not protect the body;
the signature covers the method, exact path and query, a timestamp, a
single-use nonce and a hash of the body.

Headers sent:

| Header | Value |
|---|---|
| `X-DAIAP-Key-Id` | which secret signed it (e.g. `v1`), for rotation |
| `X-DAIAP-Timestamp` | Unix seconds |
| `X-DAIAP-Nonce` | random UUID, unique per request |
| `X-DAIAP-Content-SHA256` | lowercase hex SHA-256 of the raw body (of `b""` when there is none) |
| `X-DAIAP-Signature` | `v1=` + lowercase hex HMAC-SHA256 of the canonical string |

Canonical string: six lines joined with `\n`, no trailing newline:

```
DAIAP-HMAC-SHA256
<METHOD uppercase>
<path + "?" + query exactly as received, or just the path if no query>
<timestamp>
<nonce>
<content sha256 hex>
```

Verification rules:

1. Unknown key id → 401.
2. `|now − timestamp| > 300 s` → 401.
3. Nonce seen within the last 300 s → 401 (replay). Keep an in-memory TTL set;
   for several replicas, share it in Redis.
4. SHA-256 of the received body ≠ `X-DAIAP-Content-SHA256` → 401.
5. Constant-time compare of the signature → 401 on mismatch.

### Reference implementation (FastAPI)

```python
import hashlib, hmac, os, time
from cachetools import TTLCache
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

SECRETS = {"v1": os.environ["DAIAP_SIGNING_SECRET"].encode()}
TOLERANCE = 300
seen_nonces = TTLCache(maxsize=100_000, ttl=TOLERANCE * 2)

app = FastAPI()

def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)

@app.middleware("http")
async def verify_signature(request: Request, call_next):
    h = request.headers
    secret = SECRETS.get(h.get("x-daiap-key-id", ""))
    try:
        timestamp = int(h.get("x-daiap-timestamp", ""))
    except ValueError:
        return error(401, "INVALID_SIGNATURE", "missing timestamp")
    nonce = h.get("x-daiap-nonce", "")
    presented = h.get("x-daiap-signature", "")
    if not secret or not nonce or not presented.startswith("v1="):
        return error(401, "INVALID_SIGNATURE", "missing signing headers")
    if abs(time.time() - timestamp) > TOLERANCE:
        return error(401, "INVALID_SIGNATURE", "stale timestamp")
    if nonce in seen_nonces:
        return error(401, "INVALID_SIGNATURE", "replayed nonce")

    body = await request.body()
    content_sha = hashlib.sha256(body).hexdigest()
    if not hmac.compare_digest(content_sha, h.get("x-daiap-content-sha256", "")):
        return error(401, "INVALID_SIGNATURE", "body hash mismatch")

    target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    canonical = "\n".join(["DAIAP-HMAC-SHA256", request.method.upper(), target,
                           str(timestamp), nonce, content_sha])
    expected = hmac.new(secret, canonical.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, presented[3:]):
        return error(401, "INVALID_SIGNATURE", "signature mismatch")

    seen_nonces[nonce] = True
    return await call_next(request)
```

`request.url.query` is the raw query string as received, which is what was
signed. Do not rebuild it from parsed parameters.

---

## Errors

Any non-2xx response should carry:

```json
{ "error": { "code": "ENCRYPTED_DOCUMENT", "message": "The PDF is password protected." } }
```

`code`: `UPPER_SNAKE_CASE`, ≤ 64 chars. `message` is shown to the end user on the
failed document, so make it helpful and free of internals.

How the backend reacts:

| Status | Meaning to the backend |
|---|---|
| `400`, `413`, `415`, `422` | **Permanent** problem with this input. The document is marked FAILED with your `code` and `message`, and it is not retried. |
| `401`, `403` | Signature rejected. Treated as a deployment fault; retried and logged loudly. |
| `408`, `429`, `5xx`, timeouts | **Transient.** Retried with backoff (`Retry-After` honoured), then dead-lettered. Repeated failures open the backend's circuit breaker. |

Suggested codes: `UNSUPPORTED_FILE_TYPE` (415), `DOCUMENT_TOO_LARGE` (413),
`UNPARSEABLE_DOCUMENT` (422), `ENCRYPTED_DOCUMENT` (422), `TOO_MANY_CHUNKS` (422),
`MODEL_NOT_AVAILABLE` (503), `MODEL_LOADING` (503 + `Retry-After`),
`INVALID_SIGNATURE` (401).

---

## `POST /v1/documents/parse`

Extracts text and splits it into chunks.

Request: the **raw file bytes** as the body, `Content-Type: application/octet-stream`.
Options are query parameters (sorted alphabetically, since they are part of the
signed path):

| Parameter | Example | Meaning |
|---|---|---|
| `chunk_overlap` | `64` | overlap between consecutive chunks, **in tokens of the embedding model** |
| `chunk_size` | `512` | target chunk size, in tokens |
| `file_type` | `pdf` \| `docx` \| `txt` \| `md` | already verified by the backend from the file's bytes |
| `filename` | `leave-policy.pdf` | for logging only |
| `max_chunks` | `20000` | refuse with `422 TOO_MANY_CHUNKS` above this |

Headers also include `X-Document-Id`.

Response `200`:

```json
{
  "document": { "page_count": 12, "language": "en" },
  "chunks": [
    { "text": "Annual leave policy. Every employee…", "token_count": 498, "page_start": 1, "page_end": 2 },
    { "text": "…", "token_count": 505, "page_start": 2, "page_end": 2 }
  ],
  "parser": { "name": "docling", "version": "2.1.0" }
}
```

- `chunks` in document order. The backend re-numbers them itself; an `index`
  field is accepted and ignored.
- `token_count`, `page_start`, `page_end`, `document.*`, `parser`: optional but
  recommended. Pages are 1-based.
- Whitespace-only chunks are dropped by the backend. An empty `chunks` array
  marks the document `DOCUMENT_EMPTY` ("scanned documents need OCR").
- Each chunk's `text` must be ≤ 100,000 characters.
- Chunk on structure where possible (headings, paragraphs), then by tokens.
  Tables should stay whole within a chunk when they fit.

---

## `POST /v1/embeddings`

```json
{ "model": "nomic-embed-text", "input_type": "document", "inputs": ["text one", "text two"] }
```

- `input_type`: `document` when indexing, `query` when searching. Asymmetric
  models need this. For nomic-embed-text, prefix inputs with `search_document: `
  / `search_query: `. For E5, `passage: ` / `query: `.
- Up to `EMBEDDING_BATCH_SIZE` inputs per request (default 32).
- Truncate over-long inputs to the model's context window; do not fail them.

Response `200`:

```json
{ "model": "nomic-embed-text", "dimensions": 768, "embeddings": [[0.0123, -0.044, …], […]], "usage": { "tokens": 812 } }
```

The backend **rejects** the response unless:

- `model` equals the requested model exactly,
- there is one embedding per input, in input order,
- every embedding has exactly `EMBEDDING_DIMENSIONS` finite numbers and is not
  all zeros.

Normalising to unit length is recommended; the vector store uses cosine distance.

---

## `POST /v1/rerank` (optional)

Used only when `RAG_RERANK_ENABLED=true`. If it fails, retrieval degrades to the
fused ranking instead of failing.

```json
{ "query": "how many leave days?", "documents": ["passage one", "passage two", "…"], "top_n": 8 }
```

Response `200`: best first, `index` refers to the input array.

```json
{ "model": "bge-reranker-v2-m3", "results": [ { "index": 2, "score": 0.93 }, { "index": 0, "score": 0.41 } ] }
```

---

## `GET /v1/health`

Signed like everything else (no body). Called once at backend boot and by the
backend's `/health` report.

```json
{
  "status": "ok",
  "contract_version": 1,
  "embedding": { "model": "nomic-embed-text", "dimensions": 768 },
  "rerank": { "available": false }
}
```

The backend logs an error at boot if `embedding` disagrees with its
`EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS`.

---

## Limits and behaviour the backend relies on

- **Idempotent and stateless.** The same request may arrive more than once
  (retries, resumed jobs). Return the same result; store nothing.
- **Response size** ≤ `AI_SERVICE_MAX_RESPONSE_SIZE` (64 MB); larger is refused.
- **Timeouts:** parse ≤ `AI_SERVICE_PARSE_TIMEOUT` (300 s), everything else ≤
  `AI_SERVICE_TIMEOUT` (30 s).
- **Never log document text or query text.** Log the request id, workspace id,
  document id, sizes and timings.
