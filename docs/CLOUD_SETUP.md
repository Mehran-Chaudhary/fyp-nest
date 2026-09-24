# Cloud setup

Everything this backend depends on runs as a managed cloud service. This guide
lists what to provision, in order, and exactly which environment variables to
set on which service. It is organised by phase: do a phase's section when you
deploy that phase, not before.

> **Rule of thumb.** Every variable is documented in [`.env.example`](../.env.example)
> and validated at boot by `src/config/env.validation.ts`. If a value is wrong
> the process refuses to start and names the variable. Phase 2+ services are
> optional at boot: the API runs without them and answers
> `503 KNOWLEDGE_LAYER_NOT_CONFIGURED` (naming what's missing) on the endpoints
> that need them.

---

## The shape of the deployment

```
                ┌──────────────────────────┐
  browser ────▶ │ API  (npm run start:prod)│──┐
                └──────────────────────────┘  │     ┌─────────────────────┐
                ┌──────────────────────────┐  ├───▶ │ PostgreSQL          │  Neon / Supabase
                │ Worker (optional,        │──┤     ├─────────────────────┤
                │ npm run start:worker:prod│  ├───▶ │ Redis               │  Redis Cloud / Upstash
                └──────────────────────────┘  │     ├─────────────────────┤
                          │                    ├───▶ │ Object storage (S3) │  Cloudflare R2
                          │  HMAC-signed       │     ├─────────────────────┤
                          ▼  requests          └───▶ │ Qdrant              │  Qdrant Cloud
                ┌──────────────────────────┐         └─────────────────────┘
                │ Python AI service        │  Hugging Face Spaces / Render / Railway
                └──────────────────────────┘
```

The AI service never talks to Qdrant or the database. It only computes: bytes
in, chunks out; text in, vectors out. The backend stores results and enforces
access. See [ADR 0002](adr/0002-knowledge-layer-security.md) for why.

---

## Phase 1: PostgreSQL and Redis

### PostgreSQL (Neon, Supabase, RDS, …)

1. Create a database. Neon's free tier is enough for the project.
2. Set on **API and worker**:

   ```ini
   DB_HOST=<host>
   DB_PORT=5432
   DB_USERNAME=<user>
   DB_PASSWORD=<password>
   DB_NAME=<database>
   DB_SSL=true
   ```

3. From your machine, apply the schema and seed the permission catalogue:

   ```bash
   npm run migration:run
   npm run seed
   ```

   Re-run `npm run seed` after every deploy that adds permissions. It is
   idempotent, and since phase 2 it also upgrades the built-in roles of existing
   workspaces (for example, giving every Member `clearance:internal`).

> ⚠️ **Current `.env` status (checked 2026-09-24):** the database credentials in
> the local `.env` are rejected by the server (`password authentication failed
> for user "postgres"`). Fix `DB_USERNAME` / `DB_PASSWORD` before running
> migrations.

### Redis (Redis Cloud, Upstash, …)

1. Create a database. **Set its eviction policy to `noeviction`.** BullMQ keeps
   job state in Redis, and an evicting policy can silently drop queued documents
   under memory pressure. (Upstash: leave eviction disabled. Redis Cloud: set it
   in the database configuration.)
2. Set on **API and worker**:

   ```ini
   REDIS_URL=rediss://default:<password>@<host>:<port>
   ```

   `rediss://` (two s's) means TLS. It enables TLS for both the cache and the queues.

### Secrets

```bash
npm run generate:secrets            # prints fresh values
npm run generate:secrets -- --write # fills any empty ones in .env
```

Copy the generated values into your host's environment settings. **Never
rotate** `ENCRYPTION_KEY`, `AUDIT_HASH_SECRET` or `PASSWORD_PEPPER` casually:
from phase 2 on, `ENCRYPTION_KEY` also wraps every document's data key, so
changing it makes every stored document unreadable.

---

## Phase 2: the knowledge layer

Three new services plus the AI service. Provision in this order.

### Step 1: object storage (Cloudflare R2 recommended)

R2 has 10 GB free and no egress fees. Any S3-compatible provider works.

1. Create a bucket, e.g. `daiap-documents`. Keep it **private**: there are no
   public URLs, and downloads go through the API so they can be authorised and
   audited.
2. Create an API token with *Object Read & Write* on that bucket only.
3. Set on **API and worker**:

   ```ini
   STORAGE_S3_BUCKET=daiap-documents
   STORAGE_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   STORAGE_S3_REGION=auto
   STORAGE_S3_ACCESS_KEY_ID=<token access key id>
   STORAGE_S3_SECRET_ACCESS_KEY=<token secret>
   ```

   | Provider | `STORAGE_S3_ENDPOINT` | `STORAGE_S3_REGION` | Notes |
   |---|---|---|---|
   | Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` | |
   | AWS S3 | *(empty)* | your region | may set `STORAGE_S3_SERVER_SIDE_ENCRYPTION=AES256` |
   | Backblaze B2 | `https://s3.<region>.backblazeb2.com` | `<region>` | |
   | Supabase | `https://<project>.supabase.co/storage/v1/s3` | project region | `STORAGE_S3_FORCE_PATH_STYLE=true` |
   | MinIO | your URL | `us-east-1` | `STORAGE_S3_FORCE_PATH_STYLE=true` |

Files are encrypted by the backend **before** upload (AES-256-GCM, one key per
document), so the provider only ever stores ciphertext.

### Step 2: Qdrant Cloud

1. Create a free cluster (1 GB is plenty for the project).
2. Create an API key for it.
3. Set on **API and worker**:

   ```ini
   QDRANT_URL=https://<cluster-id>.<region>.aws.cloud.qdrant.io:6333
   QDRANT_API_KEY=<key>
   ```

Collections are created automatically, one per workspace
(`daiap_ws_<workspace id>`), on the first document ingested. Nothing to create
by hand. The vector store holds vectors and ids only, never document text.

### Step 3: the Python AI service

The service implements [the v1 contract](contracts/ai-service-v1.md): four
endpoints, all HMAC-signed.

1. Generate the shared signing secret (or take the one `generate:secrets` wrote):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. Deploy the AI service with **the same secret** in its environment
   (`DAIAP_SIGNING_SECRET` or whatever name it reads; the contract shows how it
   verifies). Hugging Face Spaces (free CPU, 16 GB RAM) runs
   sentence-transformers embedding models comfortably. Avoid hosts that sleep
   on idle for the AI service: a 30-second cold start will blow the embedding
   timeout.
3. Decide the embedding model **once**, and make both sides agree:

   | `EMBEDDING_MODEL` (label) | `EMBEDDING_DIMENSIONS` | Notes |
   |---|---|---|
   | `nomic-embed-text` | 768 | default here; uses `search_document:` / `search_query:` prefixes, see contract |
   | `bge-small-en-v1.5` | 384 | lighter, fast on CPU |
   | `bge-m3` | 1024 | multilingual (Urdu included), heavier |

   The AI service must report exactly this model name and dimension count; the
   backend rejects vectors from any other model.
4. Set on **API and worker**:

   ```ini
   AI_SERVICE_URL=https://<your-ai-service>
   AI_SERVICE_SIGNING_SECRET=<the shared secret>
   AI_SERVICE_KEY_ID=v1
   EMBEDDING_MODEL=nomic-embed-text
   EMBEDDING_DIMENSIONS=768
   ```

At boot the backend calls `GET /v1/health` and logs an error if the model or
dimensions disagree.

### Step 4: apply the phase 2 migration

```bash
npm run migration:run   # applies 1758600000000-KnowledgeLayer
npm run seed            # syncs the 3 new clearance permissions into every workspace
```

### Step 5: choose a process topology

**One service (simplest):** leave `QUEUE_WORKERS_ENABLED=true`. The API process
also processes documents.

**API + worker (recommended once uploads are regular):**

| Service | Start command | Env |
|---|---|---|
| API | `npm run build && npm run start:prod` | `QUEUE_WORKERS_ENABLED=false` |
| Worker | `npm run build && npm run start:worker:prod` | same env as the API (it forces workers on) |

Health check path for the API: **`/health/ready`** (database only). `/health`
is the full report and shows the knowledge-layer services as `degraded` when
unreachable. It is deliberately never "down" for them, so a Qdrant blip does
not take the API out of rotation.

### Step 6: verify

1. `GET /health` should show `object_storage`, `vector_store`, `ai_service` and
   `queue` as `up`.
2. Prove the access policy against **your** Qdrant (it creates and removes its
   own throwaway collection):

   ```bash
   QDRANT_URL=... QDRANT_API_KEY=... npm run test:integration
   ```

3. End-to-end against a **disposable** database (never production: it writes
   and deletes documents):

   ```bash
   # with DB_* pointing at a throwaway database
   npm run migration:run
   SEED_DEMO_DATA=true npm run seed
   KNOWLEDGE_E2E=true npm run test:e2e:knowledge
   ```

4. Smoke test through the API (as `hr@acme.test` in a demo database):

   ```bash
   # upload
   curl -X POST $API/api/v1/organizations/acme-corp/knowledge-bases/$KB/documents \
     -H "Authorization: Bearer $TOKEN" -F "file=@policy.pdf"
   # poll until status is READY
   curl $API/api/v1/organizations/acme-corp/documents/$DOC -H "Authorization: Bearer $TOKEN"
   # ask
   curl -X POST $API/api/v1/organizations/acme-corp/rag/query \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"query":"How many days of annual leave do I get?"}'
   ```

### Phase 2 checklist

| Variable | API | Worker | AI service |
|---|:-:|:-:|:-:|
| `STORAGE_S3_*` (bucket, endpoint, region, keys) | ✓ | ✓ | |
| `QDRANT_URL`, `QDRANT_API_KEY` | ✓ | ✓ | |
| `AI_SERVICE_URL` | ✓ | ✓ | |
| `AI_SERVICE_SIGNING_SECRET` | ✓ | ✓ | ✓ (same value) |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | ✓ | ✓ | must match |
| `QUEUE_WORKERS_ENABLED` | `false` if a worker runs | (forced `true`) | |
| Redis `noeviction` | ✓ | ✓ | |

---

## Operations

### Rotating the AI signing secret without downtime

1. Teach the AI service to accept two key ids (`v1` and `v2`) with their secrets.
2. Set `AI_SERVICE_KEY_ID=v2` and the new `AI_SERVICE_SIGNING_SECRET` on the API
   and worker; redeploy.
3. Remove `v1` from the AI service.

### Changing the embedding model

Vectors from two models are incomparable, and a collection's dimension is fixed.

1. Set the new `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` **and** a new
   `QDRANT_COLLECTION_PREFIX` (e.g. `daiap_v2_`) on the API, the worker and the AI
   service; redeploy.
2. Queue every document for re-indexing. The maintenance sweep treats these
   rows as an outbox and enqueues them within `MAINTENANCE_SWEEP_INTERVAL`:

   ```sql
   UPDATE documents
      SET index_version = index_version + 1, status = 'UPLOADED',
          enqueued_at = NULL, attempts = 0, last_status_at = now() - interval '2 minutes'
    WHERE deleted_at IS NULL AND status IN ('READY', 'FAILED');
   ```

3. Once every document is READY again, delete the old `daiap_ws_*` collections in
   the Qdrant dashboard.

### Failed documents and the dead-letter queue

- A document that failed for a **document** reason (encrypted PDF, no text) shows
  `status: FAILED` with a `failureCode` and a readable `statusMessage`. Fix the
  file and upload it again, or call `POST …/documents/:id/reindex`.
- A document that failed after exhausting retries on a **transient** reason (AI
  service down for longer than the backoff) is also recorded in the
  `dead-letter` queue, metadata only. Once the dependency is back, reindex it.
- Stalled or lost jobs need no action: the sweep resumes them.

### Deletion guarantees

Deleting a document or knowledge base destroys its encryption key inside the
same database transaction. From that moment every copy of the content is
unreadable, including database backups and any versioned bucket copies. The
stored objects and vectors are then removed by a background purge. A deleted
workspace keeps its knowledge for `ORGANIZATION_PURGE_GRACE` (7 days), after
which it is destroyed the same way. Its audit log is kept.

---

## Later phases (not needed yet)

| Phase | You will provision |
|---|---|
| 3 | An Ollama host with a GPU for inference; Presidio analyzer/anonymizer for PII redaction |
| 4 | Nothing new: the workflow engine reuses Redis/BullMQ |
| 5 | An OpenTelemetry collector (e.g. Grafana Cloud free tier); mTLS certificates between API and AI service |

Each phase's section will be added here when it is implemented.
