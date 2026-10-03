# End-to-end environment gap report

**Date:** 2 October 2026 · **Scope:** what is missing or wrong in the environment before the backend can be tested end to end, and which free platforms supply each missing piece.

How this was produced:

- **Code cross-reference.** A script compared four sources of environment variables: the Joi schema in `src/config/env.validation.ts` (321 variables), every `process.env` read in `src/` and `scripts/`, `.env.example`, and your `.env` (59 keys).
- **Live, read-only checks** of every configured cloud service, made on 2 October 2026 from this machine. The checks were a connect plus `SELECT`, a Redis `PING`, an S3 `HeadBucket`, a Qdrant collection list and a Groq model list. Nothing was written to any service.
- **Code health:** `npm run typecheck` passes, and `npm test` passes all **748 tests in 40 suites**.
- **Free-tier limits** were checked against provider pages on the same date (sources at the end). Providers change their limits; re-check before relying on a number.

No secret value appears in this document. Where your `.env` is described, only presence, length or host is given.

Related documents: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) is the reference for every variable. [ENVIRONMENT.md §14](ENVIRONMENT.md) is the HTTP smoke-test walkthrough. [contracts/ai-service-v1.md](contracts/ai-service-v1.md) is the AI service specification.

---

## 1. Status board

| Component | Your provider | Live result (2 Oct) | Blocks e2e? | What to do |
|---|---|---|---|---|
| PostgreSQL | Supabase (session pooler, ap-south-1) | ❌ **`28P01` password authentication failed.** DNS and TCP (5432, 6543) are fine. | **Yes: nothing starts** | Reset the database password (§4.1) |
| Redis | Upstash (TLS) | ✅ `PONG` | Not today | ⚠️ The free tier allows 500 K commands a month. The app makes about 350 a minute while idle, which uses the allowance in about **24 hours of uptime**. Move to Aiven Valkey (§4.2) |
| Object storage | Cloudflare R2 | ✅ bucket accessible | No | Nothing |
| Vector store | Qdrant Cloud (sa-east-1) | ✅ authenticated, 0 collections (expected before the first upload) | No | Keep it active: free clusters are suspended after 1 week idle and deleted after 4 weeks |
| LLM | Groq | ✅ `qwen/qwen3.8-27b` is served | No | Remove `openai/gpt-oss-120b` from the allowlist (§2.6) |
| **Python AI service** | **none: not in this repository** | ❌ `AI_SERVICE_URL` is empty | **Yes, for uploads, RAG and name masking** | Build and host it (§4.3) |
| Name detection (PII NER) | off (`PII_NER_PROVIDER=none`) | patterns only | Partly | Depends on the AI service |
| Email | `MAIL_TRANSPORT=log` | links are printed to the console | No (log mode works) | Add SMTP for real inboxes (§4.4) |
| Platform admin | not set | `PLATFORM_ADMIN_*` empty | Yes, for the admin flows | Set before the first seed (§2.2) |
| API hosting | not deployed | n/a | For cloud e2e | Render free (§4.5) |
| Frontend link-up | URLs point at localhost | n/a | For browser e2e | §4.6 |
| Tracing | not set | n/a | No | Optional (§2.4) |

**In one sentence:** fix the Supabase password, build and host the AI service, set the admin variables, and move Redis off Upstash's free tier. Everything else is either already working or optional.

---

## 2. Missing and wrong variables, by priority

Legend: **Now** is what your `.env` holds (masked). **Set to** is the value it needs.

### 2.1 Blockers: the app cannot start or serve requests

| Variable | Now | Set to | Where to get it | Why |
|---|---|---|---|---|
| `DB_PASSWORD` | set (10 chars), **rejected** | the new database password | Supabase → Project Settings → Database → *Reset database password* | Login fails with `28P01`. Your username has the pooler form `postgres.<project-ref>`. Supavisor answers `28P01` only after it has found the project, so the host and the project ref are right and only the password is wrong. |

After the password works, run the migrations and the seed; this is a step, not a variable (§4.1). Supabase currently has none of this app's tables.

### 2.2 Needed for full feature coverage

| Variable | Now | Set to | Where to get it | What it unlocks |
|---|---|---|---|---|
| `AI_SERVICE_URL` | **empty** | `https://<your-ai-service>` (root, no `/v1`) | The service you deploy (§4.3) | Document upload, ingestion, RAG retrieval, the `knowledge_search` tool, name masking. Without it, uploads and searches answer `503 KNOWLEDGE_LAYER_NOT_CONFIGURED`. |
| `AI_SERVICE_SIGNING_SECRET` | set (43 chars) ✅ | keep, and give the **same value** to the AI service | already in `.env` | HMAC request signing; must match on both sides |
| `AI_SERVICE_KEY_ID` | default `v1` | `v1` (must match the service) | n/a | Secret rotation |
| `EMBEDDING_MODEL` | default `nomic-embed-text` | the exact label your AI service returns | your AI service | The backend rejects any embedding whose `model` field differs |
| `EMBEDDING_DIMENSIONS` | default `768` | the model's real dimension (768 for nomic, 384 for bge-small) | your AI service | The backend rejects vectors of the wrong length; the Qdrant collections are created with this size |
| `PII_NER_PROVIDER` | `none` | `ai-service` | n/a | Masks **names** before prompts reach Groq. Patterns (cards, IBANs, CNICs, emails, phones, salaries) already work without it. |
| `PII_DEFAULT_ON_FAILURE` | `DEGRADE_TO_PATTERNS` | `REFUSE` once the AI service is live | n/a | Fail closed if name detection goes down |
| `PLATFORM_ADMIN_EMAIL` | **empty** | your email | you | `npm run seed` creates the platform administrator only when this and the password are both set |
| `PLATFORM_ADMIN_PASSWORD` | **empty** | 12+ characters with upper case, lower case and a digit, containing no part of your name or email | you | The seed refuses a password that fails the live policy. Remove it from the host after the first seed. |
| `PLATFORM_ADMIN_NAME` | default | `Your Name` | you | It is checked against the password too |
| `TOOL_HTTP_ALLOWED_HOSTS` | empty, which **disables HTTP tools** | for example `api.open-meteo.com` (free, no key) | n/a | Lets agents and workflows call an external HTTP API. Leave it empty if you do not demo HTTP tools. |
| `REDIS_URL` | Upstash (works) | an Aiven Valkey `rediss://` URI | §4.2 | Without the change, the free command allowance runs out after about a day of uptime |

**Email (only for real inboxes; log mode already lets you finish every flow from the console):**

| Variable | Now | Set to (Ethereal, for testing) | Set to (Brevo, for real delivery) |
|---|---|---|---|
| `MAIL_TRANSPORT` | `log` | `smtp` | `smtp` |
| `SMTP_HOST` | empty | `smtp.ethereal.email` | `smtp-relay.brevo.com` |
| `SMTP_PORT` | default 587 | `587` | `587` |
| `SMTP_SECURE` | default false | `false` (STARTTLS) | `false` |
| `SMTP_USERNAME` | empty | the generated Ethereal user | your Brevo SMTP login |
| `SMTP_PASSWORD` | empty | the generated Ethereal password | your Brevo SMTP key |
| `MAIL_FROM_ADDRESS` | default `no-reply@localhost` | any address | **a sender verified in Brevo** |
| `MAIL_FROM_NAME` | default | `DAIAP` | `DAIAP` |

### 2.3 Needed once deployed (Render plus a hosted frontend)

| Variable | Local value now | Value on Render | Note |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | Production refuses insecure defaults and the demo seed, and turns on HSTS |
| `APP_PORT` | `3000` | **do not set** | The app falls back to Render's injected `PORT` |
| `APP_URL` | `http://localhost:3000` | `https://<service>.onrender.com` | Used in email links and the Swagger server URL |
| `FRONTEND_URL` | `http://localhost:5173` | `https://<frontend-host>` | Used in invitation, verification and reset links |
| `CORS_ORIGINS` | the two localhost origins | the frontend origin exactly, comma-separated | Never `*` in production |
| `COOKIE_SECURE` | default false | `true` | |
| `COOKIE_SAME_SITE` | default `lax` | `none` **if the frontend is on a different site** (for example `*.vercel.app` versus `*.onrender.com`) | With the refresh cookie on (the default), the refresh token is sent **only** in the cookie. A `lax` cookie is not sent on cross-site `fetch`, so every page reload would sign the user out. Safari blocks third-party cookies whatever this is set to; a shared parent domain avoids the problem. |
| `LOG_PRETTY` | `true` | `false` | |
| `TRUST_PROXY` | default `1` | `1` | Correct for Render's single proxy. The rate limiter and the IP allowlist depend on it. |
| `QUEUE_WORKERS_ENABLED` | `true` | `true` | One service runs both the API and the workers |
| All secrets | set ✅ | **copy the exact same values** | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `AUDIT_HASH_SECRET`, `PASSWORD_PEPPER`, `COOKIE_SECRET`, `METRICS_TOKEN`, `AI_SERVICE_SIGNING_SECRET`. Changing the encryption, audit or pepper value later breaks existing data. |

### 2.4 Optional: the defaults are fine for e2e

| Variable(s) | When you would set them |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` | To ship traces to any OTLP backend, for example Grafana Cloud's free tier. Not needed for e2e. |
| `RAG_RERANK_ENABLED=true` | Only if your AI service implements `POST /v1/rerank` |
| `AI_SERVICE_TLS_*`, `LLM_TLS_*` | Mutual TLS to self-hosted endpoints. Not needed for Groq or a public AI service. |
| `REQUIRE_EMAIL_VERIFICATION=true` | To test the verify-first flow once SMTP works |
| `MFA_REQUIRED_FOR_PLATFORM_ADMINS=true` | After you have enrolled MFA on the admin account |
| `REDIS_KEY_PREFIX`, `QUEUE_PREFIX` | Already set (`daiap:cloud:`, `daiap_cloud_bull`); keep them |

The rest of the 321 schema variables are tuning values with validated defaults.

### 2.5 Test-only variables (not in the schema; set them in the shell)

| Variable | Used by | Value |
|---|---|---|
| `KNOWLEDGE_E2E` | `npm run test:e2e:knowledge` | `true`, or the suite prints "Skipped" |
| `AGENTS_E2E` | `npm run test:e2e:agents` | `true` |
| `WORKFLOWS_E2E` | `npm run test:e2e:workflows` | `true` |
| `SEED_DEMO_DATA` | `npm run seed` | `true`, **only on a disposable database**. The e2e suites need the `acme-corp` demo workspace. |
| `QDRANT_URL`, `QDRANT_API_KEY` | `npm run test:integration` | Must be **exported in the shell**: Jest does not read `.env`, so the suite silently skips without them. It creates and deletes its own `daiap_it_*` collection. |
| `THROTTLE_AUTH_LIMIT` | scripted HTTP tests | `500`. The default of 10 per 15 minutes is exhausted quickly from one IP. |
| `PASSWORD_BREACH_CHECK` | scripted tests | `off`, which avoids calling the breach API on every registration |
| `STANDIN_PARSE_DELAY_MS` | `npm run start:standins` | milliseconds of simulated parse delay (default 1500) |

### 2.6 Values in your `.env` worth changing

| Variable | Now | Recommendation |
|---|---|---|
| `LLM_ALLOWED_MODELS` | `qwen/qwen3.8-27b,openai/gpt-oss-120b` | Drop `gpt-oss-120b`. On Groq it fails every agent that uses tools (`tool_use_failed`), because it ignores the platform's text tool protocol. Qwen follows the protocol. |
| `LLM_MAX_CLASSIFICATION` | `INTERNAL` | Keep it: it is correct for a third-party API. Expect CONFIDENTIAL and RESTRICTED passages to be **withheld** from Groq prompts during RAG tests. That is the design working, not a bug. |
| `PII_NER_PROVIDER`, `PII_DEFAULT_ON_FAILURE` | `none`, `DEGRADE_TO_PATTERNS` | Switch to `ai-service` and `REFUSE` once the AI service answers `/v1/health` |
| `QUEUE_DRAIN_DELAY`, `QUEUE_STALLED_INTERVAL` | `60s`, `120s` | Keep them while on Upstash. On Valkey you may return to the defaults (`5s`, `30s`) for snappier jobs. |
| `LLM_DEFAULT_MAX_OUTPUT_TOKENS`, `LLM_MAX_OUTPUT_TOKENS`, `QUOTA_TOKENS_PER_MINUTE` | 512, 1000, 8000 | Keep them: Groq's free tier refuses Qwen requests above 1,000 output tokens and allows 8 K tokens a minute |

---

## 3. Feature × dependency matrix

"After §4.1" means the feature works as soon as the database password is fixed and migrated.

| Feature area | Needs | Status |
|---|---|---|
| Register, login, refresh, sessions, MFA (TOTP), password policy | PostgreSQL, Redis | After §4.1 |
| Email verification, password reset, invitations | + mail | After §4.1, with links on the console; a real inbox needs SMTP |
| Workspaces, members, roles, API keys, IP allowlist, audit log | PostgreSQL, Redis | After §4.1 |
| Document **upload** and ingestion | R2 **+ Qdrant + AI service** (all three) | ❌ `503` until `AI_SERVICE_URL` is set |
| Document **download** | R2 only | After §4.1, once something has been uploaded |
| Retrieval and RAG search | Qdrant + AI service (it embeds the query) | ❌ until the AI service exists |
| PII analysis preview | Patterns: none. Names: AI service. | Patterns after §4.1; names need §4.3 |
| Model list, direct chat | Groq | After §4.1 |
| Agents and conversations | Groq (+ RAG for knowledge-grounded agents) | Plain agents after §4.1; grounded agents need §4.3 |
| Tools `calculator`, `current_datetime` | none | After §4.1 |
| Tool `knowledge_search` | RAG | Needs §4.3 |
| Tool `send_email` | mail | After §4.1 (log mode) |
| HTTP tools | `TOOL_HTTP_ALLOWED_HOSTS` | Disabled until you set it |
| Workflows (multi-agent, approvals, dead-letter queue) | Redis workers + Groq | After §4.1 |
| Real-time Socket.IO events | Redis | After §4.1 |
| Quotas, rate limits, circuit breakers | PostgreSQL, Redis | After §4.1 |
| Command Centre analytics | PostgreSQL | After §4.1 |
| Personal-data export and erasure | PostgreSQL (+ R2) | After §4.1 |
| Prometheus `/metrics` | `METRICS_TOKEN` ✅ | Works |
| Tracing | `OTEL_*` | Optional |

---

## 4. Free platforms: step by step

### 4.1 Supabase: fix the database (blocker)

1. Open [supabase.com/dashboard](https://supabase.com/dashboard) and select the project. If it shows **Paused**, click *Restore*: free projects pause after one week without activity.
2. Go to **Project Settings → Database → Reset database password**. Choose a password and save it.
3. Put it in `.env` as `DB_PASSWORD=...`. Quote it if it contains `#` or spaces. Avoid `$`, which `.env` variable expansion would mangle. Keep every other `DB_*` value as it is: session pooler on port 5432, `DB_SSL=true` with your CA, `DB_POOL_MAX=8` and `DB_RLS_ROLE=daiap_rls` are correct for Supabase.
4. Migrate, then seed the admin. Set `PLATFORM_ADMIN_*` first, and **do not** set `SEED_DEMO_DATA` on this database:

   ```powershell
   npm run migration:run
   npm run seed
   ```

5. Start the API with `npm run start:dev`, then open `http://localhost:3000/health`. Check that `row_level_security` says it is enforced under the `daiap_rls` role.
6. **Security: disable Supabase's Data API.** Go to Project Settings → Data API and switch it off. Supabase exposes the `public` schema over REST with the public anon key, and nine of this app's tables, `users` among them, have no RLS policies. This backend never uses the Data API.

**Free limits:** 2 active projects, 500 MB database, pause after 1 week idle.

### 4.2 Redis: move to Aiven for Valkey (recommended free option)

Why move: your Upstash database works, but its free tier allows **500,000 commands a month**. This app's six BullMQ workers poll Redis about 350 times a minute even when idle, which is about 21,000 an hour, so the allowance lasts roughly **24 hours of uptime**. Redis priced by memory has no such ceiling.

| Option | Free allowance | Fit |
|---|---|---|
| **Aiven for Valkey** (recommended) | 1 GB RAM (512 MB usable), no per-command billing, **no card**, default eviction policy `noeviction` (what BullMQ requires) | One free Valkey per organization. It may be powered off after a period with no activity (you get an email first); reactivate it from the console. |
| Redis Cloud Free | 30 MB, about 30 connections | Works, but this app opens about 16 connections per process, and the database is deleted after 14 days without reads or writes. You must set the eviction policy to `noeviction` yourself. |
| Upstash (keep) | 500 K commands a month | Fine for short test sessions only. Watch the usage graph. |

Steps for Aiven:

1. Sign up at [console.aiven.io](https://console.aiven.io/signup) (no card).
2. **Create service → Valkey → Free plan**, then choose the region nearest your API.
3. When it is *Running*, copy the **Service URI**. It looks like `rediss://default:<password>@<host>:<port>`.
4. Set `REDIS_URL=<that URI>` in `.env` and later on Render. Keep `REDIS_KEY_PREFIX` and `QUEUE_PREFIX`.
5. Under *Advanced configuration*, confirm `valkey_maxmemory_policy` is `noeviction`.
6. Start the API and check `GET /health`: the `redis` component should be `up`.

### 4.3 The Python AI service (the largest missing piece)

**What is missing:** the repository holds the client (`src/shared/ai-service/`), the contract ([ai-service-v1.md](contracts/ai-service-v1.md)) and in-memory test doubles, but **no deployable AI service**. Groq does not replace it: it has no embedding models, and it does not speak the HMAC-signed contract.

**What it must implement:** all requests are HMAC-signed with `AI_SERVICE_SIGNING_SECRET`; the reference FastAPI middleware is in the contract.

| Route | Purpose | Suggested free library |
|---|---|---|
| `GET /v1/health` | Report the embedding model and dimensions, and whether PII is available | n/a |
| `POST /v1/documents/parse` | Bytes → ordered text chunks, sized in **embedding-model tokens** | `pypdf`, `python-docx`, the model tokenizer |
| `POST /v1/embeddings` | Texts → vectors (`document` or `query` prefix) | `fastembed` (ONNX on CPU, no GPU) |
| `POST /v1/pii/analyze` | Names → spans in Python code-point offsets | `presidio-analyzer` + spaCy |
| `POST /v1/rerank` | Optional | skip (`RAG_RERANK_ENABLED=false`) |

**Two model profiles.** Pick one; it fixes two variables.

| Profile | Embedding | NER model | Approximate RAM* | Set in the backend |
|---|---|---|---|---|
| **Standard**, matching the current defaults | `nomic-ai/nomic-embed-text-v1.5` | `en_core_web_lg` | about 2 GB | `EMBEDDING_MODEL=nomic-embed-text`, `EMBEDDING_DIMENSIONS=768` |
| **Light**, for 512 MB hosts | `BAAI/bge-small-en-v1.5` | `en_core_web_sm` | about 0.5 GB | `EMBEDDING_MODEL=bge-small-en-v1.5`, `EMBEDDING_DIMENSIONS=384` |

\* Estimates, not measurements. Measure the real figure once the service is built.

**Where to host it for free:**

| Host | Free allowance | Verdict |
|---|---|---|
| **Google Cloud Run** | Every month: 2 M requests, 180 K vCPU-seconds, 360 K GiB-seconds. Request-based billing, scale to zero. | **Best fit for the Standard profile.** A 2 GiB, 1 vCPU instance gets about 50 hours of busy time a month free. It needs a billing account (a card); set a budget alert. Cold starts load the models, so the first call may time out (§4.3 note). |
| Your PC + **Cloudflare quick tunnel** | Free, no account, any RAM | Best for **testing now**. Run `cloudflared tunnel --url http://localhost:8000` and get an `https://*.trycloudflare.com` URL for `AI_SERVICE_URL`. The URL changes on every run, and your PC must stay on. |
| Render Free / Koyeb Free | 512 MB, 0.1 vCPU. Sleeps after 15 minutes (Render) or 1 hour (Koyeb). | **Light profile only.** On Render it shares the 750 free instance-hours with the API. |
| Hugging Face Spaces | — | **No longer free:** creating Docker or Gradio Spaces now needs a PRO plan. |

Deploy steps for Cloud Run, once the service exists with a `Dockerfile`:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com), enable billing, and add a **budget alert** (Billing → Budgets) of, say, $1.
2. Install the gcloud CLI and run `gcloud auth login`, then `gcloud config set project <id>`.
3. From the service folder:

   ```powershell
   gcloud run deploy daiap-ai --source . --region asia-south1 --memory 2Gi --cpu 1 `
     --allow-unauthenticated --set-env-vars DAIAP_SIGNING_SECRET=<same as AI_SERVICE_SIGNING_SECRET>
   ```

   Unauthenticated at Cloud Run's level is correct here, because every request is HMAC-verified by the service itself. For anything more than a demo, store the secret in Secret Manager rather than a plain environment variable. `--source .` builds the image with Cloud Build and stores it in Artifact Registry. An image with the models baked in can exceed Artifact Registry's 0.5 GB free storage; the overage costs a few cents a month.
4. Put the printed `https://daiap-ai-…run.app` URL in `AI_SERVICE_URL`. Set `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` per your profile, then `PII_NER_PROVIDER=ai-service`.
5. Restart the backend. At boot it calls `/v1/health` and logs an error if the model or dimensions disagree. `GET /health` should show `ai_service` and `pii_detector` up.

**Cold-start note.** On any scale-to-zero host, the first call after a sleep loads the models. Ingestion survives this, because it retries with backoff. PII analysis has a 10 s budget (`PII_TIMEOUT`); for testing, raise it to `30s` or warm the service first with one `/v1/health` call.

**Privacy note.** The AI service sees documents in plaintext. Running the models inside it (as above) keeps them away from third parties. Calling a hosted embedding API from inside the service would work technically, but would send document text to that provider.

### 4.4 Email

| Purpose | Platform | Steps |
|---|---|---|
| **Testing** (recommended for e2e) | [Ethereal Email](https://ethereal.email). Free, no signup, unlimited. Mail is captured and never delivered. | Click *Create Ethereal Account* and copy the SMTP host, user and password into §2.2. Read every invitation, reset and verification mail in its web inbox. It suits the `@acme.test` demo addresses, which cannot receive real mail anyway. |
| Real delivery | [Brevo](https://www.brevo.com). Free forever: **300 emails a day**, no card. | Sign up → **Senders, Domains & Dedicated IPs → Senders → add and verify** your from-address → **SMTP & API → SMTP** → generate an SMTP key. Use `smtp-relay.brevo.com:587` with your SMTP login and key. Add DKIM for your domain if you have one; deliverability improves. |
| Avoid | Mailtrap Sandbox free | Now only 50 test emails a month |

### 4.5 Render: host the API (free web service)

1. Push the repository to GitHub. At [dashboard.render.com](https://dashboard.render.com), choose **New → Web Service** and connect the repository.
2. Runtime **Node**, instance **Free**, region **Singapore** (closest to Supabase's Mumbai region).
3. Build command: `npm ci --include=dev && npm run build`.
4. Start command: `npm run start:prod`. Run migrations and the seed once from your PC against Supabase (§4.1) rather than on every boot.
5. Health check path: `/health/ready`.
6. Environment: everything in §2.3, plus the `DB_*`, `REDIS_URL`, `STORAGE_*`, `QDRANT_*`, `LLM_*`, `AI_SERVICE_*`, `PII_*` and mail values from your `.env`. Do **not** set `APP_PORT`. Pin Node with `NODE_VERSION=22.14.0`: TypeORM needs `^22.13`, which is stricter than `package.json`'s `>=20.11`.
7. Limits to expect: 512 MB RAM and 0.1 CPU. The service sleeps after 15 minutes without inbound traffic, and waking takes about a minute, during which Socket.IO clients reconnect. 750 free instance-hours a month per workspace.

### 4.6 Frontend link-up

- **Same parent domain** (for example `app.example.com` and `api.example.com`): keep `COOKIE_SAME_SITE=lax` and optionally set `REFRESH_TOKEN_COOKIE_DOMAIN=.example.com`. This is the most robust choice.
- **Different sites** (for example `*.vercel.app` and `*.onrender.com`): set `COOKIE_SAME_SITE=none` and `COOKIE_SECURE=true`. Safari may still drop the refresh cookie (third-party cookie blocking).
- Either way, set `FRONTEND_URL` and `CORS_ORIGINS` to the exact frontend origin (scheme and host, no trailing slash).

### 4.7 Services you already have: keep them healthy

| Service | Free limits | Action |
|---|---|---|
| Qdrant Cloud | 1 GB RAM cluster (about 1 M vectors of 768 dimensions). Suspended after 1 week idle, deleted after 4. | Open the console weekly while testing. Your cluster is in sa-east-1 (São Paulo), far from Supabase in Mumbai. Expect a few hundred milliseconds per search. Recreating it nearer is optional. |
| Cloudflare R2 | 10 GB-month storage free | Nothing |
| Groq | Free per-model limits (about 8 K tokens a minute, 1 K requests a day on Qwen) | Already matched by your `.env` caps |

---

## 5. Ready-to-paste blocks

### 5.1 Additions and changes to your local `.env`

```dotenv
# §4.1: the database
DB_PASSWORD=<new Supabase password>

# §4.2: Redis (after creating Aiven Valkey)
REDIS_URL=rediss://default:<password>@<host>:<port>

# §4.3: the AI service (Standard profile shown)
AI_SERVICE_URL=https://<your-ai-service>
AI_SERVICE_KEY_ID=v1
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
PII_NER_PROVIDER=ai-service
PII_DEFAULT_ON_FAILURE=REFUSE

# §2.2: the platform administrator (remove the password after the first seed)
PLATFORM_ADMIN_EMAIL=<you@example.com>
PLATFORM_ADMIN_PASSWORD=<strong unique password>
PLATFORM_ADMIN_NAME="<Your Name>"

# §4.4: email (Ethereal shown)
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=<ethereal user>
SMTP_PASSWORD=<ethereal password>
MAIL_FROM_ADDRESS=no-reply@daiap.test
MAIL_FROM_NAME=DAIAP

# §2.6: the model allowlist
LLM_ALLOWED_MODELS=qwen/qwen3.8-27b

# Optional: HTTP tools demo
TOOL_HTTP_ALLOWED_HOSTS=api.open-meteo.com
```

### 5.2 Automated e2e suites on a disposable database

The three e2e suites boot the real `AppModule`, which **reads your `.env`, which points at Supabase**. They write and delete demo data, so **never run them against the real database.** Shell variables override `.env`, so set them in a **fresh** PowerShell window. Use non-empty values only: `@nestjs/config` treats `''` as unset, and the `.env` value wins.

For the disposable database, either:

- create a second free Supabase project, `daiap-e2e` (the free plan allows two), or
- use local PostgreSQL and Redis. `docker compose up -d` starts both. This is test-only infrastructure; production stays cloud-only.

```powershell
# Disposable database
$env:DB_HOST='<e2e host>'; $env:DB_PORT='5432'; $env:DB_NAME='postgres'
$env:DB_USERNAME='<e2e user>'; $env:DB_PASSWORD='<e2e password>'
$env:DB_SSL='true'          # 'false' for local Docker
$env:DB_RLS_ROLE='daiap_rls' # keep it: Supabase's login and Docker's superuser both bypass RLS without it

# Isolated Redis keys (or point REDIS_URL at a local/test Redis)
$env:REDIS_KEY_PREFIX='daiap:e2e:'; $env:QUEUE_PREFIX='daiap_e2e_bull'

# Undo the Groq tuning in .env, which the suites do not expect
$env:PII_DEFAULT_ON_FAILURE='REFUSE'; $env:QUOTA_TOKENS_PER_MINUTE='100000'
$env:LLM_DEFAULT_MAX_OUTPUT_TOKENS='1024'; $env:LLM_MAX_OUTPUT_TOKENS='4096'
$env:LLM_MAX_CONCURRENCY='4'; $env:LLM_MAX_RETRIES='1'
$env:PASSWORD_BREACH_CHECK='off'; $env:THROTTLE_AUTH_LIMIT='500'

npm run migration:run
$env:SEED_DEMO_DATA='true'; npm run seed

$env:KNOWLEDGE_E2E='true'; npm run test:e2e:knowledge
$env:AGENTS_E2E='true';    npm run test:e2e:agents
$env:WORKFLOWS_E2E='true'; npm run test:e2e:workflows
```

These suites replace R2, Qdrant, the AI service and the LLM with in-memory stand-ins, so they need only PostgreSQL and Redis. They prove the security properties: tenant isolation, access-controlled retrieval, prompts free of PII at the model boundary, dead-letter hygiene and approval separation. The real cloud integrations are covered by §6.

---

## 6. Recommended test order

| # | Command or action | Needs | Proves |
|---|---|---|---|
| 1 | `npm run typecheck` and `npm test` | nothing | ✅ Done: 748 / 748 pass |
| 2 | `$env:QDRANT_URL=…; $env:QDRANT_API_KEY=…; npm run test:integration` | Qdrant | Restricted documents never come back from the real vector store |
| 3 | §5.2 e2e suites | disposable PostgreSQL + Redis | Full module graph and security properties |
| 4 | Fix Supabase (§4.1), then `npm run start:dev` and `GET /health` | real cloud | Every dependency reports `up` |
| 5 | Live HTTP walkthrough, [ENVIRONMENT.md §14](ENVIRONMENT.md) A→G | real cloud + AI service | Login → upload → ingest → retrieve → agent with RAG → workflow → Socket.IO → email |
| 6 | Deploy to Render (§4.5) and repeat step 5 against the public URL with the frontend | everything | Production shape: cookies, CORS, proxy IPs, sleep and wake |

---

## 7. Repository issues found during this audit

These do not stop a test run, but they are worth fixing. Each is a small, separate task.

1. **`.env.example` is missing 53 of the 321 schema variables.** The gap is most of phase 5: `MFA_*`, `PASSWORD_BREACH_*`, `QUOTA_*`, `AGENT_MAX_TOKENS_*`, `AGENT_CIRCUIT_*`, `METRICS_TOKEN`, `WORKER_HTTP_PORT`, `OTEL_*`, the lifecycle and retention variables, `AI_SERVICE_TLS_*`, `LLM_TLS_*`, `DB_ROW_LEVEL_SECURITY`, `DB_RLS_ROLE` and `PORT`.
2. **`.env.example` still has a pre-implementation "Phase 5" placeholder block** with six variables the code never reads: `DEFAULT_MONTHLY_TOKEN_QUOTA`, `MTLS_ENABLED`, `MTLS_CA_CERT`, `MTLS_SERVER_CERT`, `MTLS_SERVER_KEY` and `AUDIT_RETENTION_DAYS`. Anyone copying them gets no effect.
3. **`npm run test:e2e` is broken.** It points at `test/jest-e2e.config.mjs`, but `test/` is empty. The working suites are the three `test:e2e:*` scripts.
4. **`LLM_TLS_SERVERNAME` is read but not validated.** `src/config/client-tls.ts` reads `${prefix}_SERVERNAME` for both prefixes, but only `AI_SERVICE_TLS_SERVERNAME` is in the schema.
5. **The documentation disagrees with your real setup.** `CLOUD_ONLY_SETUP.md` says to use Neon, while your `.env` uses Supabase. `ENVIRONMENT.md` §2 describes an older local snapshot.
6. **`package.json` `engines` says `>=20.11`,** but TypeORM needs `^20.19 || ^22.13 || >=24.11`.
7. **The Supabase Data API exposes tables without RLS** (§4.1, step 6). This is a configuration step, but an important one.

---

## 8. Checklist

- [ ] Supabase password reset; `DB_PASSWORD` updated; `npm run migration:run` succeeds
- [ ] `PLATFORM_ADMIN_*` set; `npm run seed` creates the admin
- [ ] Supabase Data API disabled
- [ ] Redis moved to Aiven Valkey (`REDIS_URL`) and `/health` shows redis up
- [ ] AI service built against the contract and deployed; `AI_SERVICE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` match it
- [ ] `PII_NER_PROVIDER=ai-service`, `PII_DEFAULT_ON_FAILURE=REFUSE`
- [ ] `gpt-oss-120b` removed from `LLM_ALLOWED_MODELS`
- [ ] SMTP configured (Ethereal for testing, Brevo for real)
- [ ] `test:integration` passes against Qdrant
- [ ] The three `test:e2e:*` suites pass on a disposable database
- [ ] Live walkthrough A→G passes locally
- [ ] Render deployed with the §2.3 values; walkthrough passes against the public URL with the frontend

---

### Sources (free-tier limits, checked 2 October 2026)

- Hugging Face, [Spaces overview](https://huggingface.co/docs/hub/spaces-overview): Docker and Gradio Spaces require a paid plan to create
- Upstash, [pricing and comparison](https://upstash.com/blog/upstash-vs-redis-cloud-a-2026-comparison): 500 K commands a month free
- Aiven, [Valkey free tier](https://aiven.io/docs/products/valkey/concepts/valkey-free-tier), [free plan rules](https://aiven.io/docs/platform/concepts/free-plan) and [memory and eviction](https://aiven.io/docs/products/valkey/concepts/memory-usage)
- Redis, [Cloud data eviction](https://redis.io/docs/latest/operate/rc/databases/configuration/data-eviction-policies/), and Redis Cloud free database deletion ([support article](https://support.redislabs.com/hc/en-us/articles/33138489404818))
- Render, [Deploy for Free](https://render.com/docs/free)
- Supabase, [pricing](https://supabase.com/pricing)
- Qdrant, [create a cluster](https://qdrant.tech/documentation/cloud/create-cluster/)
- Google Cloud, [Cloud Run pricing](https://cloud.google.com/run/pricing)
- Koyeb free instance ([summary](https://www.srvrlss.io/provider/koyeb/))
- Brevo free plan ([summary](https://sendlayer.com/blog/best-free-smtp-servers/)); Mailtrap [pricing](https://mailtrap.io/pricing)
- BullMQ, [going to production](https://docs.bullmq.io/guide/going-to-production) (`noeviction`)
