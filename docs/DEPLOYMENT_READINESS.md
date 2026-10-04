# Local NestJS with cloud dependencies

Audit date: 4 October 2026. This is the current setup decision: keep NestJS on your computer; host Python on Google Cloud Run; retain the existing managed services. No cloud deployment or credential changes were made during this audit.

## What runs where

| Component | Location | Audit finding |
|---|---|---|
| NestJS HTTP API, Socket.IO and BullMQ workers | Your computer | `QUEUE_WORKERS_ENABLED=true` runs workers inside the API; no separate worker required initially |
| PostgreSQL | Supabase | Remote credentials configured; TLS and RLS enabled in configuration |
| Redis/Valkey | Aiven | Remote TLS URL configured |
| Document files | Cloudflare R2 | Bucket, endpoint and S3 credentials configured |
| Vector search | Qdrant Cloud | URL and API key configured |
| LLM generation | Groq | OpenAI-compatible endpoint and credentials configured |
| Parsing, embeddings, reranking, name detection | Google Cloud Run (to deploy) | Current `AI_SERVICE_URL` still points to localhost |
| Email | Ethereal currently | Cloud test inbox only; no real recipient delivery |

Supabase supplies PostgreSQL here. Authentication, JWTs, permissions, invitations and email generation are implemented by NestJS. Supabase Auth settings do not configure this application's email transport. The frontend should call NestJS, not connect directly to the database.

Your computer must remain awake with NestJS running for HTTP requests and queue jobs to be processed. Keeping the databases in the cloud does not keep local workers running.

## Verification completed

- `npm run build`: passed.
- `npm run typecheck`: passed.
- Direct serial Jest run: **40 suites, 748 tests passed**. An earlier run failed a timing-sensitive LLM bulkhead test; its isolated rerun and the complete serial rerun passed. Keep this flakiness on the cleanup list.
- Python `pytest -m 'not models'`: **93 passed, 17 deselected**. Real-model behavior was not verified by this run.
- Local environment passes Joi validation and cross-field checks. A production-mode validation also passes, but that does not enforce every deployment policy: secure cookies remained false.
- Backend and Python HMAC secrets match; no built-in development values were found in the checked core secrets.
- Backend embedding dimension is 768; Python's 0 means this model's native 768 dimensions, so these are compatible.
- Cloud probes were attempted, but network permission errors prevented verification. SMTP verification also failed in this environment; this does not establish invalid credentials. No emails were sent. Local Python `/livez` refused the connection.

Configured is not the same as operational. Database migrations, cloud credential validity, model availability, delivery and complete workflows still need live checks from your machine.

## Environment variables: what to do now

There are **321 NestJS schema variables**. All have rows in [the complete reference](ENVIRONMENT_VARIABLES.md), including defaults and purposes. You do not need to manually enter all 321: most are tuning controls with defaults. `.env.example` omits 56 schema keys, so it is not the complete reference.

### 1. Keep local application settings

For a local frontend on port 5173, use:

```dotenv
NODE_ENV=development
APP_HOST=0.0.0.0
APP_PORT=3000
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173
CORS_CREDENTIALS=true
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax
REFRESH_TOKEN_COOKIE_ENABLED=true
REFRESH_TOKEN_COOKIE_DOMAIN=
SWAGGER_ENABLED=true
LOG_PRETTY=true
QUEUE_WORKERS_ENABLED=true
DB_SYNCHRONIZE=false
DB_MIGRATIONS_RUN=false
DB_ROW_LEVEL_SECURITY=true
SEED_DEMO_DATA=false
```

Use your actual frontend origin if its port differs. Use `localhost` consistently instead of mixing it with `127.0.0.1`. Keep real secrets even in development because the application connects to real cloud data. These HTTP cookie settings are for the local setup, not a later public HTTPS deployment.

### 2. Preserve existing cloud connections and secrets

Keep the existing private values of these settings; do not regenerate them as part of deployment:

| Group | Variables | Important detail |
|---|---|---|
| Supabase | `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `DB_SCHEMA`, `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`, `DB_SSL_CA`, `DB_POOL_MAX`, `DB_ROW_LEVEL_SECURITY`, `DB_RLS_ROLE` | Current port is 5432. Use direct/session connections; this app's tenant context relies on database session state. Verify the RLS role exists and health reports enforcement. |
| Aiven | `REDIS_URL`, `REDIS_KEY_PREFIX`, `QUEUE_PREFIX`, `QUEUE_DRAIN_DELAY`, `QUEUE_STALLED_INTERVAL` | Use the Redis TLS/TCP URL, not an HTTPS REST URL. Keep queue namespaces stable and eviction disabled for queue data. |
| R2 | `STORAGE_S3_BUCKET`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | Private bucket; S3 credentials, not a general Cloudflare API token. |
| Qdrant | `QDRANT_URL`, `QDRANT_API_KEY`, optional `QDRANT_COLLECTION_PREFIX` | Preserve existing collection naming and embedding configuration for existing documents. |
| Groq | `LLM_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_DEFAULT_MODEL`, `LLM_ALLOWED_MODELS`, `LLM_MAX_CLASSIFICATION` | `openai` names the protocol, not the billing provider. Confirm configured model IDs still exist and support the tool behavior you use. |
| Core secrets | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PASSWORD_PEPPER`, `ENCRYPTION_KEY`, `AUDIT_HASH_SECRET`, `COOKIE_SECRET` | Preserve encryption/audit/pepper values for existing data. JWT signing secrets should be distinct. |
| Monitoring | `METRICS_TOKEN` | Keep private. No monitoring vendor is required to begin frontend work. |
| AI signing | `AI_SERVICE_SIGNING_SECRET`, `AI_SERVICE_KEY_ID` | Same pair in local NestJS and Cloud Run. |

Do not put any of these credentials into frontend environment variables. This application reads separate `DB_*` fields, not `DATABASE_URL` or Supabase browser API keys.

### 3. Change NestJS after Cloud Run deploys

```dotenv
AI_SERVICE_URL=https://YOUR_CLOUD_RUN_SERVICE_URL
AI_SERVICE_KEY_ID=v1
# Preserve AI_SERVICE_SIGNING_SECRET and copy it privately to Cloud Run.
EMBEDDING_MODEL=embeddinggemma-300m-int8
EMBEDDING_DIMENSIONS=768
EMBEDDING_BATCH_SIZE=8
AI_SERVICE_TIMEOUT=90s
PII_NER_PROVIDER=ai-service
PII_DEFAULT_ON_FAILURE=REFUSE
PII_TIMEOUT=30s
RAG_RERANK_ENABLED=true
```

Restart NestJS after editing. The 30-second PII timeout is a starting budget, not a cold-start guarantee: measure a cold request. If the detector is unavailable, refusal is intentional. Do not weaken privacy behavior to hide an unavailable Python service.

### 4. Cloud Run Python configuration

Use the existing [Dockerfile](../ai-service/Dockerfile), with `ai-service/` as the build context. It installs dependencies and downloads the model assets into the image. You do not upload your Windows `.venv` or start a local Python service afterward.

| Variable | Value/action |
|---|---|
| `AI_SERVICE_SIGNING_SECRET` | Secret Manager secret containing the existing backend secret |
| `AI_SERVICE_KEY_ID` | `v1`, matching NestJS |
| `EMBEDDING_MODEL` | `embeddinggemma-300m-int8` |
| `EMBEDDING_DIMENSIONS` | `768` explicitly, or `0` for this model's native dimension |
| `RERANK_MODEL` | `jina-reranker-v1-turbo-en` |
| `PII_ENABLED` | `true` |
| `PII_SPACY_MODEL` | `en_core_web_md` |
| `PII_TRANSFORMER_MODEL` | `bert-base-NER` |
| `MODEL_DOWNLOAD` | `false` (Docker image sets this) |
| `MODEL_CACHE_DIR` | `/srv/.models` (Docker image sets this) |
| `LOG_FORMAT` / `LOG_LEVEL` | `json` / `INFO` |
| `DOCS_ENABLED` | `false` |
| `PORT` | Let Cloud Run inject it; Docker command respects it |
| `REPLAY_REDIS_URL` | Existing managed TLS Redis URL for shared nonce protection; recommended across revisions/replicas |

The Python service does not need your database, R2, Qdrant, SMTP, JWT or Groq credentials. `REPLAY_REDIS_URL` is the optional exception for shared request replay protection. Even a one-instance limit can involve overlapping revisions during deployments; shared replay storage avoids relying on process-local nonce history.

All remaining Python variables and defaults are declared in [app/config.py](../ai-service/app/config.py): signature tolerance and rotation pair; model loading wait and ONNX threads; OCR enable/page limit; document/JSON/input/chunk ceilings; parse/embed/rerank/PII concurrency; and chunk context headers. The [Python example](../ai-service/.env.example) contains the commonly adjusted subset. Leave the rotation pair empty until deliberately rotating keys.

Start with the repository's suggested 4 vCPU / 4 GiB, concurrency 8, request timeout 300 seconds, minimum instances 0 and maximum instances 1. These are starting settings to measure, not proven capacity guarantees. Keep one Uvicorn worker so models are not loaded repeatedly per process.

Allow unauthenticated access at the Cloud Run IAM layer with this existing client: NestJS sends an application HMAC, not a Google identity token. `/v1/*` remains signature-protected; `/livez` is public. Do not put the signing secret in the frontend.

Use `/livez` for process liveness, then verify the signed `/v1/health` through NestJS for actual model readiness. Models load in background threads; with request-based CPU allocation, verify cold-start loading and the first real request instead of assuming an idle instance warms itself. Minimum instances and CPU billing settings affect costs and readiness.

Cloud Run requires billing and offers a free allowance, not a guaranteed zero bill. Image storage/builds, networking and other services can cost separately. Set budget alerts and monitor usage; alerts are not spending caps. See [Cloud Run pricing](https://cloud.google.com/run/pricing) and [CPU/billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings).

OCR is not launch-verified: the locked requirements do not include `rapidocr`, and the README explicitly records the adapter as unverified. Test scanned PDFs separately or leave OCR-dependent behavior out of the initial supported flow.

### 5. Email: choose test capture or real delivery

The current `SMTP_HOST` is Ethereal. [Ethereal never delivers to real recipients](https://ethereal.email/faq). It is acceptable for controlled testing of verification, invitation and password-reset templates.

For real delivery, configure a transactional email provider's verified sender and SMTP credentials:

```dotenv
MAIL_TRANSPORT=smtp
MAIL_FROM_NAME=DAIAP
MAIL_FROM_ADDRESS=YOUR_VERIFIED_SENDER
SMTP_HOST=YOUR_PROVIDER_SMTP_HOST
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=YOUR_SMTP_LOGIN
SMTP_PASSWORD=YOUR_SMTP_CREDENTIAL
SMTP_REJECT_UNAUTHORIZED=true
```

Port 587 with `SMTP_SECURE=false` uses STARTTLS; port 465 normally uses `SMTP_SECURE=true`. Follow the provider's configuration. Set `REQUIRE_EMAIL_VERIFICATION=true` only once delivery and the frontend verification route are working. The current effective value is false.

Because NestJS stays local, Render's SMTP-port block does not apply. If you later choose Render Free, revisit this: it blocks 25/465/587 and this backend currently implements only `smtp` and `log`, not an HTTPS email API transport. See [Render's policy](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports).

## Steps to finish the backend handoff

1. Deploy the Python image to Cloud Run and set its HMAC secret. Confirm models load successfully. Do not change embedding models for existing vectors without a reindex plan.
2. Replace local `AI_SERVICE_URL`, restart NestJS, and check `/health`. The readiness endpoint `/health/ready` does not certify the AI stack: dependencies can report degraded without removing the API from service.
3. From your machine, run `npm run migration:show`. If migrations are pending, back up existing data and apply `npm run migration:run` deliberately. Do not use schema synchronization. This audit did not modify database schema.
4. Confirm permissions are seeded. Run `npm run seed` when needed. For a first admin, supply `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_ADMIN_NAME`; remove the seed password afterward. Keep `SEED_DEMO_DATA=false` for a real shared database.
5. Prove registration, login, cookie refresh, logout, workspace permissions, invitation, verification and reset. Ethereal proves capture only; real delivery requires a real inbox test.
6. Upload a small TXT/PDF, wait until it reaches `READY`, retrieve a known fact from it, and test document download. This exercises R2, queues, Python, Qdrant and the database together.
7. Run an agent conversation with streaming, a tool-enabled turn, and a workflow with approval/resume. Verify Socket.IO events and workspace isolation, including a denied cross-workspace request.
8. Export/use `/docs-json` as the frontend API contract. Record any unsupported or degraded feature explicitly before starting that screen.

No destructive E2E suite was run against your cloud database. Use disposable infrastructure for automated suites that create/delete tenant data.

## Frontend can start now

Start with [the frontend phases](frontend/FRONTEND_PHASES.md) and [foundation/auth/workspace](frontend/PHASE_1_FOUNDATION_AUTH_WORKSPACE.md). You can build these while Python deployment is completed; document/RAG screens need the real upload and retrieval checks above.

For a Vite frontend, these are proposed frontend variables (NestJS does not read them):

```dotenv
VITE_API_BASE_URL=http://localhost:3000/api/v1
VITE_SOCKET_URL=http://localhost:3000
VITE_SOCKET_PATH=/realtime
```

Use `credentials: 'include'` for cookie-based auth calls; keep the access token in memory; serialize token refreshes; send `X-Organization-Id` for workspace requests. Socket.IO is not a raw WebSocket: use its client with the configured path, websocket transport, and `{ token, organizationId }` handshake auth. Follow [the realtime contract](contracts/realtime-v1.md).

If the frontend is hosted publicly later, `localhost:3000` means each visitor's own computer. This local-backend setup is suitable for your development and controlled demos, not for remote users without deliberately exposing a reachable backend.

## Documentation corrections from this audit

- Older `CLOUD_ONLY_SETUP.md` describes a Python service that did not exist yet; it now exists. It also describes a different database/Redis choice. Use this guide for the current architecture.
- The full NestJS reference covers 321 keys, despite its previous 319-key heading.
- The real Python signing variable is `AI_SERVICE_SIGNING_SECRET`, not the old illustrative `DAIAP_SIGNING_SECRET`.
- The root Node engine minimum is looser than installed dependencies. The lockfile's TypeORM requires `^20.19.0 || ^22.13.0 || >=24.11.0`; this audit passed on Node 22.14.0. Choose a compatible patched runtime when hosting later.
- Supabase direct/session connections are required by this repository's RLS implementation. See [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres).

The backend is ready for frontend development work, but cloud AI deployment and live end-to-end acceptance remain outstanding before calling the complete system deployed.
