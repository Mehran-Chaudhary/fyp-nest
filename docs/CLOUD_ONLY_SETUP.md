# Your cloud only backend setup guide

Follow this document from top to bottom. Everything runs in the cloud. You do not need Docker, a local database, a local Redis server, or a local model.

Prepared for this repository on 29 September 2026. The previous local setup guide is not needed for this route.

**Our target:** get the core backend online first, then enable chat, then document uploads and document-based agents. This makes failures easier to identify.

**Important:** most services below have free allowances, but a completely free deployment is a development/demo setup. Sleeping servers, limited memory and API quotas prevent a promise of uninterrupted background processing.

## 1 Create these accounts

| What you need | Platform | What to create |
|---|---|---|
| Backend hosting | [Render](https://render.com/docs/free) | One Node Web Service connected to your GitHub repository |
| Database | [Neon](https://neon.com/blog/new-usage-based-pricing) | One Free project and database |
| Redis | [Upstash](https://upstash.com/pricing/redis) | One Free Redis database |
| Files | [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) | One private Standard storage bucket |
| Vector search | [Qdrant Cloud](https://qdrant.tech/documentation/cloud/create-cluster/) | One Free cluster and database API key |
| AI answers | [Groq](https://console.groq.com/docs/rate-limits) | One API key and an available chat model |

Start with Render, Neon and Upstash. Add R2, Qdrant and Groq using the steps below. Choose nearby regions where practical.

You also need a **custom AI service** for document parsing, embeddings and the default name detector. That service is not implemented in this repository. Section 7 explains this separately so you do not waste time trying random URLs.

Free allowance does not always mean no billing activation or payment method. Check the provider's signup screen and set available usage alerts. In particular, R2 charges for usage beyond its free allowance.

## 2 Set up the database on Neon

1. Create a Neon project and database.
2. Open its connection details.
3. Select the **direct connection**, with connection pooling disabled.
4. Save the host, database name, username and database password privately.
5. Later, enter these into Render Environment:

```dotenv
DB_HOST=YOUR_NEON_DIRECT_HOST
DB_PORT=5432
DB_USERNAME=YOUR_NEON_DATABASE_USER
DB_PASSWORD=YOUR_NEON_DATABASE_PASSWORD
DB_NAME=YOUR_NEON_DATABASE_NAME
DB_SCHEMA=public
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SYNCHRONIZE=false
DB_MIGRATIONS_RUN=false
DB_ROW_LEVEL_SECURITY=true
```

Use the actual port if your provider shows a different one. Your database username/password are not your Neon dashboard login.

Do not paste the entire connection string into `DB_HOST`. This backend does not read `DATABASE_URL`; split the connection into the fields above. A pooled Neon hostname contains `-pooler`; use the direct hostname for this project's session-based tenant isolation. [Neon connection guide](https://github.com/neondatabase/website/blob/main/content/docs/get-started/connect-neon.md).

Initially **omit `DB_RLS_ROLE`**. After migrations and first boot, check the `row_level_security` component in `/health`. If the login bypasses RLS, set `DB_RLS_ROLE=daiap_rls` only after confirming that migration created and granted that role. An ordinary non-bypassing owner can work without a role override.

**Done when:** you have the five connection values and a direct TLS endpoint.

## 3 Set up Redis on Upstash

1. Create a Redis database.
2. Keep eviction disabled so queue records are not automatically evicted.
3. Open its connection details and find the Redis TCP/TLS credentials.
4. Copy the `rediss://` URL, or construct it from the host, port, username and password shown there.

```dotenv
REDIS_URL=rediss://default:YOUR_ENCODED_PASSWORD@YOUR_HOST:YOUR_PORT
REDIS_KEY_PREFIX=daiap:cloud:
QUEUE_PREFIX=daiap_cloud_bull
QUEUE_WORKERS_ENABLED=true
```

Prefer copying the provider-generated URI so special characters are encoded correctly. **Do not use an HTTPS REST URL or REST token.** This backend uses ioredis and BullMQ over a Redis connection.

`QUEUE_WORKERS_ENABLED=true` means the same Render process serves the API and processes background jobs. This avoids a separate worker deployment for the first version.

Upstash supports BullMQ, but its documentation warns that queue polling generates commands even without many jobs. Watch your free command allowance. [Upstash BullMQ instructions](https://upstash.com/docs/redis/integrations/bullmq).

**Done when:** `REDIS_URL` is saved and eviction is disabled.

## 4 Put the backend on Render

Your code must be in a GitHub repository that Render can access. No Dockerfile is required for a native Node Web Service.

1. In Render, create a **Web Service**.
2. Connect the backend repository and choose its branch.
3. Select the **Node** runtime and Free instance for the initial demo.
4. Use the repository root as the root directory.
5. Configure:

| Render field | Value |
|---|---|
| Build command | `npm ci --include=dev && npm run build` |
| Initial start command | `npm run migration:run && npm run seed && npm run start:prod` |
| Health check path | `/health/ready` |

The initial start command applies migrations and creates the permission catalogue before opening the API. Use one instance for this initial setup. It runs migrations/seed again on restarts until you change it.

**After the first successful deployment**, change Start Command to `npm run start:prod`. For later releases with schema/permission changes, deliberately run migrations and seed again. A paid pre-deploy job is optional; it is not required for this initial single-instance route. Do not prune development dependencies before these TypeScript-based migration/seed commands run. [Render deployment stages](https://render.com/docs/deploys).

In **Environment**, add the database and Redis settings from sections 2 and 3, plus:

```dotenv
NODE_ENV=production
APP_HOST=0.0.0.0
APP_URL=https://YOUR_BACKEND.onrender.com
FRONTEND_URL=https://YOUR_FRONTEND_HOST
CORS_ORIGINS=https://YOUR_FRONTEND_HOST
CORS_CREDENTIALS=true
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
LOG_LEVEL=info
LOG_PRETTY=false
SWAGGER_ENABLED=true
MAIL_TRANSPORT=log
REQUIRE_EMAIL_VERIFICATION=false
SEED_DEMO_DATA=false
```

Replace placeholders. Copy Render's assigned backend URL into `APP_URL`. If the frontend is not deployed yet, temporarily use the backend URL for `FRONTEND_URL` and `CORS_ORIGINS` while testing in Swagger. Email links will not have working frontend pages until you set the real frontend URL.

**Do not set `APP_PORT`.** The backend will use Render's injected `PORT`. Do not change the default API prefix/version.

For Node, select a compatible patched runtime: Node 22.13+ within the 22.x line, or Node 24.11+. The root package's older minimum is insufficient for the installed TypeORM dependency. This checkout was verified on Node 22.14.0; use the host's supported version selection to pin your chosen compatible release.

### Copy your existing secrets

Your current `.env` already has these generated values. Copy the existing values into Render Environment; this does not require hosting anything locally:

```text
JWT_ACCESS_SECRET
JWT_REFRESH_SECRET
ENCRYPTION_KEY
AUDIT_HASH_SECRET
PASSWORD_PEPPER
COOKIE_SECRET
```

Keep them private. Do not upload `.env` to GitHub. Do not regenerate encryption/audit/pepper values when keeping existing data. Access and refresh signing secrets must be different.

### Create your administrator during the first seed

Also set:

```dotenv
PLATFORM_ADMIN_EMAIL=YOUR_REAL_EMAIL
PLATFORM_ADMIN_PASSWORD=YOUR_UNIQUE_STRONG_PASSWORD
PLATFORM_ADMIN_NAME="Your Name"
```

Choose a unique password with at least 12 characters, uppercase, lowercase and a number, avoiding your name/email and obvious patterns. Render's environment editor expects raw values: enter `Your Name` without dotenv quote characters when filling its individual value field.

After successful seed and login, remove `PLATFORM_ADMIN_PASSWORD` from Render and redeploy. An existing user's password is not reset by changing that bootstrap variable.

**Done when:** deployment succeeds, `/health/ready` responds successfully, and `/docs` opens. Other AI/storage components may still report unconfigured; this is expected at this checkpoint.

## 5 Add file storage on Cloudflare R2

1. Open R2 and create a private Standard bucket, for example `daiap-documents`.
2. Create R2 S3 credentials with **Object Read and Write** permissions for that bucket.
3. Copy the Access Key ID, Secret Access Key and S3 endpoint.
4. Add these in Render Environment:

```dotenv
STORAGE_S3_BUCKET=daiap-documents
STORAGE_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_S3_REGION=auto
STORAGE_S3_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
STORAGE_S3_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY
STORAGE_S3_FORCE_PATH_STYLE=false
STORAGE_KEY_PREFIX=daiap/cloud/
```

Use the exact endpoint shown by R2, including any jurisdiction-specific variant. Do not use a public download URL or append the bucket name to the endpoint. Keep the bucket private; your API handles authorized downloads. [R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/).

**Done when:** `/health` reports working object storage after redeployment. This checks connectivity; an actual upload later checks the complete path.

## 6 Add vector storage on Qdrant Cloud

1. Create a Free cluster and wait until it is available.
2. Copy the cluster REST URL.
3. Create a **database API key** with collection creation/read/write access.
4. Add:

```dotenv
QDRANT_URL=YOUR_CLUSTER_HTTPS_URL
QDRANT_API_KEY=YOUR_DATABASE_API_KEY
QDRANT_COLLECTION_PREFIX=daiap_cloud_
QDRANT_TENANCY=collection
```

Use the exact URL and port Qdrant supplies. The cluster dashboard address and cloud-management key are not the values needed here. The backend creates its collections automatically. [Qdrant database authentication](https://qdrant.tech/documentation/cloud/authentication/).

**Done when:** `/health` reports a working vector store. Actual searchable vectors appear after document ingestion.

## 7 Complete the missing AI service

**This step requires application code that is not in this repository.** The backend expects a separate service with these routes:

| Route | What it must do |
|---|---|
| `GET /v1/health` | Report compatible service/model details |
| `POST /v1/documents/parse` | Turn uploaded file bytes into ordered text chunks |
| `POST /v1/embeddings` | Turn text into vectors of the expected size |
| `POST /v1/pii/analyze` | Detect names and other configured entities |

Give the developer of that service [this repository's exact contract](contracts/ai-service-v1.md). All requests use its HMAC-signature protocol. Ordinary model endpoints do not automatically implement it.

Ask your team for these five items:

1. The deployed HTTPS service root URL.
2. Its matching HMAC signing secret, at least 32 random characters.
3. Its signing key ID, normally `v1`.
4. Its exact embedding model label and vector dimension.
5. Confirmation that all four routes work, including name detection.

Then enter in Render:

```dotenv
AI_SERVICE_URL=https://YOUR_DEPLOYED_AI_SERVICE
AI_SERVICE_SIGNING_SECRET=YOUR_SHARED_SIGNING_SECRET
AI_SERVICE_KEY_ID=v1
EMBEDDING_MODEL=EXACT_MODEL_LABEL_FROM_AI_SERVICE
EMBEDDING_DIMENSIONS=ACTUAL_VECTOR_DIMENSION
PII_NER_PROVIDER=ai-service
PII_DEFAULT_ON_FAILURE=REFUSE
RAG_RERANK_ENABLED=false
```

Use the root URL without adding `/v1`; the client appends its routes. The service must use the same secret. The contract example names its Python variable `DAIAP_SIGNING_SECRET`, but the actual implementation determines that name.

**Hosting decision:** a native Python web service on Render can avoid Docker, but whether a free instance can run this implementation depends on its model memory and startup requirements. No suitable fully free deployment has been verified for this missing implementation. We must implement/obtain it and measure its needs before promising a free host. The documented default embedding/name models can be too heavy for a small free instance.

Do not assume new Hugging Face compute Spaces are universally free: its current overview says creating Gradio/Docker compute Spaces requires a paid plan, even though CPU Basic hardware has no hourly charge. [Current Spaces overview](https://huggingface.co/docs/hub/spaces-overview).

**You cannot skip this step and still claim full document-based AI works.** Auth and workspace management can already be tested while this service is pending.

## 8 Add AI answers using Groq

1. Create a Groq API key.
2. Select a currently available chat model from its console.
3. Copy the exact model ID into both model fields below.

```dotenv
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=YOUR_GROQ_API_KEY
LLM_DEFAULT_MODEL=YOUR_EXACT_MODEL_ID
LLM_ALLOWED_MODELS=YOUR_EXACT_MODEL_ID
LLM_MAX_CLASSIFICATION=INTERNAL
LLM_MAX_CONCURRENCY=1
```

Here `openai` means the compatible API protocol. You do not need an OpenAI account for this Groq configuration. Free quotas vary by model. [Groq compatibility](https://console.groq.com/docs/openai), [free plan limits](https://console.groq.com/docs/rate-limits).

**Pick a model that follows the platform's tool protocol.** Agents call tools (calculator, date, email, knowledge search) by writing `<tool_call>{…}</tool_call>` in their answer. Qwen models do this. `openai/gpt-oss-*` models use their own native tool channel instead, and Groq rejects the request with `tool_use_failed` ("Tool choice is none, but model called a tool"), so every agent with a tool fails with `LLM_UNAVAILABLE`. Use gpt-oss only for agents without tools and for direct chat. Verified on 2026-09-29:

```dotenv
LLM_DEFAULT_MODEL=qwen/qwen3.8-27b
LLM_ALLOWED_MODELS=qwen/qwen3.8-27b,openai/gpt-oss-120b
# Groq's free tier refuses any Qwen request asking for more than 1,000 output tokens.
LLM_DEFAULT_MAX_OUTPUT_TOKENS=512
LLM_MAX_OUTPUT_TOKENS=1000
# The free tier allows 8,000 tokens per minute per model; throttle to match.
QUOTA_TOKENS_PER_MINUTE=8000
LLM_MAX_RETRIES=2
```

The default privacy policy still requires a functioning name detector before model calls. A correct Groq key alone may therefore not make chat work until section 7 is complete.

For an explicitly limited demo with synthetic data, pattern-only privacy can be configured with `PII_NER_PROVIDER=none` and `PII_DEFAULT_ON_FAILURE=DEGRADE_TO_PATTERNS`. This does not detect names and may require updating an existing workspace's saved policy. It is not the configuration for full privacy testing.

**Done when:** the model appears in the backend's model list and a real chat request completes.

## 9 Keep email simple at first

Leave these values for initial testing:

```dotenv
MAIL_TRANSPORT=log
REQUIRE_EMAIL_VERIFICATION=false
```

Emails appear in Render logs; they are not delivered. You can copy an action token from a logged verification/reset link and submit it through Swagger.

For SMTP testing later, use a Mailtrap Email Sandbox and its SMTP integration credentials. Set `MAIL_TRANSPORT=smtp`, then `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME`. A sandbox captures messages rather than delivering to real recipients. [Mailtrap setup](https://docs.mailtrap.io/email-sandbox/setup).

Render Free blocks outbound SMTP ports 25, 465 and 587. A provider-supported alternative such as Mailtrap sandbox port 2525 avoids those listed blocked ports; verify it from your deployment. Real delivery needs an appropriate provider/port or an email-API integration change. [Render restrictions](https://render.com/docs/free).

Do not enable mandatory email verification until your intended verification flow works.

## 10 Test using Swagger in your browser

Open `https://YOUR_BACKEND.onrender.com/docs`. This requires no frontend or local API server.

Complete the following checks in order. Use synthetic test data and stop at the first failed checkpoint.

| Order | What to do in Swagger | What success looks like |
|---|---|---|
| 1 | `POST /api/v1/auth/login` with your administrator email/password | Response contains `data.tokens.accessToken` |
| 2 | Click Authorize and paste the access token into the Bearer field | Protected calls can authenticate |
| 3 | `POST /api/v1/organizations` with `name` and a unique `slug` | A workspace is created; save its ID |
| 4 | `GET /api/v1/auth/me` | Your account details are returned |
| 5 | `POST /api/v1/organizations/{organizationId}/knowledge-bases` | A knowledge base is created; save its ID |
| 6 | Upload a small TXT using `POST .../knowledge-bases/{knowledgeBaseId}/documents` | Upload accepted; save its document ID |
| 7 | Repeat `GET .../documents/{documentId}` | Status reaches `READY` |
| 8 | `POST .../rag/query` with a question about that file | Relevant passages are returned |
| 9 | `POST .../pii/analyze` with synthetic names/email addresses | Expected entities are masked |
| 10 | `GET .../llm/models`, then `POST .../llm/chat` | Your chosen model generates an answer |
| 11 | Create an agent, attach the knowledge base, publish it and create a conversation | A document-grounded answer is returned |
| 12 | Create/publish a simple workflow and start a run | Its status reaches `COMPLETED` |

For steps abbreviated with `...`, use the organization's route shown in Swagger. Swagger displays the exact request schema and required fields; remove optional example fields you do not need.

Simple workspace body:

```json
{"name":"My Test Workspace","slug":"my-test-workspace"}
```

Simple knowledge base body:

```json
{"name":"Test Documents","accessMode":"WORKSPACE","defaultClassification":"INTERNAL"}
```

Upload a short file containing: `Every employee receives 25 days of annual leave per year.` Then use this retrieval body, replacing the ID:

```json
{"query":"How many annual leave days are available?","knowledgeBaseIds":["YOUR_KNOWLEDGE_BASE_UUID"]}
```

Simple model chat body:

```json
{"messages":[{"role":"user","content":"Reply with a short greeting."}]}
```

A file reaching `READY` and being retrieved proves much more than a green health page. The repository's automated AI tests use test doubles, so passing them does not prove your cloud keys/model/parser work.

## 11 If something fails

| Problem | First thing to check |
|---|---|
| Render will not start | Deployment logs; required secrets; compatible Node version; database credentials; failed migration/seed |
| Database authentication error | Neon database role/password and direct host, not your dashboard login |
| Redis error | TLS TCP connection URL; not HTTPS REST credentials |
| API starts but uploads return 503 | R2, Qdrant and custom AI service must all be configured |
| File never leaves UPLOADED | `QUEUE_WORKERS_ENABLED=true`, working Redis and an awake Render service |
| File reaches FAILED | Document failure details and Render logs; parser, embedding dimensions or storage/vector errors |
| PII detection unavailable | The selected name detector is missing, down or incompatible |
| Groq request rejected | Current model ID, API key, free quota and workspace model policy |
| 401 after working earlier | Access token expired; log in again for the next Swagger test |
| 403 or 404 on a resource | Correct workspace, membership, role and document/agent permissions |
| Browser frontend login differs from Swagger | Exact CORS origin and cookie policy; cross-site cookies may need SameSite none plus Secure |
| Slow first request | Render Free waking from inactivity |

Render Free sleeps after 15 minutes without inbound traffic. Background work does not make that an always-on service. Keep your demo active while testing; if reliable unattended jobs become essential, an always-on backend host is the first upgrade to consider. [Render free service behavior](https://render.com/docs/free).

## 12 Your completion checklist

- [ ] Neon database created and direct credentials entered in Render.
- [ ] Upstash Redis created, eviction disabled and TLS connection entered.
- [ ] Render native Node service deployed with existing secrets.
- [ ] Migrations and permission/admin seed completed successfully.
- [ ] Start command changed to `npm run start:prod` after initial setup.
- [ ] `/health/ready` and `/docs` work.
- [ ] R2 private bucket and S3 credentials configured.
- [ ] Qdrant cluster and database key configured.
- [ ] Custom AI service implemented/deployed and all required routes verified.
- [ ] Matching embedding model/dimensions and HMAC secret configured.
- [ ] Groq key/model configured and a real answer generated.
- [ ] A real file reaches READY and its content can be retrieved.
- [ ] A document-based agent and an asynchronous workflow complete.

**For now you can skip:** Docker, local servers, a separate worker service, your own GPU, custom domains, monitoring vendors, reranking and client mTLS. Real email can wait until the main flow works. Keep other tuning variables at their defaults.

Do not paste all 317 variables into Render. Start with the values in this document. If a special setting becomes necessary, its exact definition is in [the complete variable reference](ENVIRONMENT_VARIABLES.md).

This document is a setup plan, not a claim that deployment has been completed. No cloud accounts were created or charged and no existing credentials were changed while preparing it.
