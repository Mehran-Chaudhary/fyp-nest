# Cloud setup

Everything this backend depends on runs as a managed cloud service. This guide
lists what to provision, in order, and exactly which environment variables to
set on which service. It is organised by phase: do a phase's section when you
deploy that phase, not before.

> **Rule of thumb.** Every variable is documented in [`.env.example`](../.env.example)
> and validated at boot by `src/config/env.validation.ts`. If a value is wrong
> the process refuses to start and names the variable. Phase 2+ services are
> optional at boot: the API runs without them and answers
> `503 KNOWLEDGE_LAYER_NOT_CONFIGURED` or `503 LLM_NOT_CONFIGURED` (naming
> what's missing) on the endpoints that need them. Phase 4 adds no new service
> at all: it runs on the PostgreSQL, Redis and model endpoint you already have.

---

## The shape of the deployment

```
     HTTPS + WebSocket (phase 4)
                ┌──────────────────────────┐
  browser ◀───▶ │ API  (npm run start:prod)│──┐
                └──────────────────────────┘  │     ┌─────────────────────┐
                ┌──────────────────────────┐  ├───▶ │ PostgreSQL          │  Neon / Supabase
                │ Worker (optional,        │──┤     ├─────────────────────┤
                │ npm run start:worker:prod│  ├───▶ │ Redis               │  Redis Cloud / Upstash
                └──────────────────────────┘  │     ├─────────────────────┤
                          │                    ├───▶ │ Object storage (S3) │  Cloudflare R2
                          │  HMAC-signed       │     ├─────────────────────┤
                          ▼  requests          ├───▶ │ Qdrant              │  Qdrant Cloud
                ┌──────────────────────────┐   │     └─────────────────────┘
                │ Python AI service        │   │  masked prompts only (phase 3)
                │ parse · embed · NER      │   │     ┌─────────────────────┐
                └──────────────────────────┘   └───▶ │ LLM endpoint        │  Ollama on a GPU VM
                  Hugging Face / Render / Railway    │ (behind a proxy)    │  / vLLM / hosted API
                                                     └─────────────────────┘
                                         HTTP tools, allowlisted hosts only (phase 4)
                                          ─────────▶ partner APIs you choose
```

The AI service never talks to Qdrant or the database. It only computes: bytes
in, chunks out; text in, vectors out; text in, entity spans out. The backend
stores results and enforces access. See [ADR 0002](adr/0002-knowledge-layer-security.md)
for why. The language model receives only masked prompts, through one gateway
([ADR 0003](adr/0003-inference-and-privacy.md)). Workflow steps travel through
Redis as references only; their content stays in PostgreSQL, encrypted per run
([ADR 0004](adr/0004-orchestration-tools-realtime.md)).

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

## Phase 3: inference, agents and privacy

Two new dependencies — **a language model endpoint** and **a name detector
(NER)** — and one migration. Both are optional at boot:

- without `LLM_BASE_URL`, the agent and chat endpoints answer
  `503 LLM_NOT_CONFIGURED` (naming the variable);
- without a working NER detector, each workspace's PII policy decides: refuse
  (`503 PII_DETECTION_UNAVAILABLE`, the default) or continue with the in-process
  pattern recognizers only. Nothing is ever sent to a model unmasked because a
  dependency is down.

Everything a model sees passes through the PII engine first: detected on the
way in, masked with placeholders (`[PERSON_1]`), re-scanned at the gateway
boundary, and unmasked in the answer. See [ADR 0003](adr/0003-inference-and-privacy.md).

### Step 1: a language model endpoint

Where the model runs is a privacy decision as well as a cost one. Prompts are
masked, but a masked prompt still carries the surrounding text of your
documents, so `LLM_MAX_CLASSIFICATION` tells the platform how far to trust the
endpoint: passages and conversation history above it are never put into a
prompt for that endpoint at all.

| Option | Good for | `LLM_PROVIDER` | `LLM_BASE_URL` | `LLM_MAX_CLASSIFICATION` |
|---|---|---|---|---|
| **Ollama on a GPU VM you control** (RunPod, Vast.ai, Lambda, a GCP/AWS/Azure GPU instance) | the proposal's "local LLM": data never leaves infrastructure you run | `ollama` | `https://ollama.<your-domain>` (through the proxy below) | `RESTRICTED` |
| **vLLM, TGI or llama.cpp** on a GPU VM you control | many concurrent users (continuous batching) | `openai` | `https://llm.<your-domain>/v1` | `RESTRICTED` |
| **Ollama's hosted models** | no GPU to manage | `ollama` | `https://ollama.com` | `INTERNAL` (third party) |
| **A hosted open-weight API**: Groq, Together, Fireworks, DeepInfra, OpenRouter | the cheapest start; development | `openai` | the provider's OpenAI-compatible base URL, e.g. `https://api.groq.com/openai/v1`, `https://api.together.xyz/v1`, `https://openrouter.ai/api/v1` | `INTERNAL` or `PUBLIC` |

`LLM_BASE_URL` for `ollama` is the server root with no path; for `openai` it
includes the version path, exactly as the provider documents it.

#### Recipe A: Ollama on your own GPU, behind an authenticating proxy

1. Rent a GPU VM. An 8B model at 4-bit needs about 6 GB of VRAM; a 24 GB card
   (RTX 4090, L4, A10) runs one comfortably with room for four concurrent
   requests. 70B models need 48 GB or more.
2. Install Ollama and pull the models you will allow:

   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ollama pull llama3.1:8b        # or qwen2.5:7b, mistral:7b, gemma2:9b
   ```

3. Configure the Ollama service (`sudo systemctl edit ollama`) to serve several
   requests at once and keep models loaded, and leave it bound to localhost
   (the default):

   ```ini
   [Service]
   Environment="OLLAMA_NUM_PARALLEL=4"
   Environment="OLLAMA_KEEP_ALIVE=30m"
   ```

4. **Never expose port 11434.** Ollama has no authentication: anyone who finds
   it can use your GPU, and pull or delete models. Put a TLS proxy with a
   bearer token in front. With Caddy (`/etc/caddy/Caddyfile`, token in
   Caddy's environment as `OLLAMA_PROXY_TOKEN`):

   ```caddy
   ollama.example.com {
       @authorized header Authorization "Bearer {env.OLLAMA_PROXY_TOKEN}"
       handle @authorized {
           reverse_proxy 127.0.0.1:11434 {
               flush_interval -1    # stream tokens as they are generated
           }
       }
       respond 401
   }
   ```

5. Set on the **API**:

   ```ini
   LLM_PROVIDER=ollama
   LLM_BASE_URL=https://ollama.example.com
   LLM_API_KEY=<OLLAMA_PROXY_TOKEN>
   LLM_DEFAULT_MODEL=llama3.1:8b
   LLM_ALLOWED_MODELS=llama3.1:8b,qwen2.5:7b
   LLM_MAX_CLASSIFICATION=RESTRICTED
   LLM_MAX_CONCURRENCY=4          # see "Sizing" below
   ```

#### Recipe B: a hosted API (fastest start)

```ini
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.groq.com/openai/v1      # or your provider's base URL
LLM_API_KEY=<provider API key>
LLM_DEFAULT_MODEL=<a model id from the provider's list>
LLM_ALLOWED_MODELS=<the same id, plus any others you allow>
LLM_MAX_CLASSIFICATION=INTERNAL
```

Model ids are the provider's own (`GET …/llm/models` shows what the endpoint
reports). Where a provider does not report token counts, usage is estimated and
flagged as such in the usage ledger.

#### Sizing and timeouts

- **Concurrency.** `LLM_MAX_CONCURRENCY` is per API process. With *N* API
  instances the model sees up to *N* × `LLM_MAX_CONCURRENCY` requests, so keep
  that at or below what it serves in parallel (`OLLAMA_NUM_PARALLEL`). Excess
  requests wait up to `LLM_QUEUE_TIMEOUT`, then get `503 LLM_BUSY` with
  `Retry-After`.
- **Context.** `num_ctx` is sent with every Ollama request, sized from the
  model's own context length within `LLM_MAX_CONTEXT_WINDOW`. Larger windows
  cost GPU memory per concurrent request.
- **Timeouts.** A cold model load can take tens of seconds, which is why
  `LLM_FIRST_TOKEN_TIMEOUT` defaults to 120 s. `LLM_REQUEST_TIMEOUT` must exceed
  `LLM_MAX_DURATION` by at least 10 s; the process refuses to start otherwise.
- **Streaming through your host.** Answers stream over Server-Sent Events with
  `Cache-Control: no-transform` and `X-Accel-Buffering: no`, so compression and
  nginx-style proxies pass them through unbuffered, and a heartbeat every 15 s
  keeps idle-connection reapers away. If your platform has a configurable
  request timeout, set it at or above `LLM_REQUEST_TIMEOUT`.

### Step 2: name detection (NER)

The pattern recognizers in the API find everything structural — cards, IBANs,
CNIC and SSN numbers, phones, emails, IPs, salaries, credentials, and the
workspace's deny list. **Names** need a statistical model. Choose one:

**Option 1 (recommended): the AI service you deployed in phase 2.** Implement
`POST /v1/pii/analyze` as specified in the
[contract](contracts/ai-service-v1.md#post-v1piianalyze-phase-3) — the
reference implementation is twenty lines of FastAPI around Presidio. It is
HMAC-signed like every other AI call, so there is nothing new to secure.

```bash
# in the AI service's image
pip install presidio-analyzer
python -m spacy download en_core_web_lg     # ~1 GB RAM
```

Then, on the **API**: `PII_NER_PROVIDER=ai-service` (the default). The AI
service's `/v1/health` should report `"pii": {"available": true, …}`.

**Option 2: a stock Presidio analyzer container**
(`mcr.microsoft.com/presidio-analyzer`). It has **no authentication**: run it
on a private network only (Railway private networking, a Render private
service, Cloud Run with internal ingress) or behind an authenticating proxy.

```ini
PII_NER_PROVIDER=presidio
PRESIDIO_ANALYZER_URL=http://presidio-analyzer.railway.internal:3000
PRESIDIO_API_KEY=                     # only if a proxy in front checks a token
```

**Option 3: no NER** (`PII_NER_PROVIDER=none`). Structural data is still masked,
but names are not detected. Workspaces on the default `REFUSE` policy will then
refuse every request that needs name detection; switch them deliberately to
`DEGRADE_TO_PATTERNS` (below) only if that trade-off is acceptable.

### Step 3: apply the migration and seed

```bash
npm run migration:run   # applies 1758700000000-InferenceAgentsPrivacy
npm run seed            # syncs the phase 3 permissions into every workspace's roles
```

In a demo database, `SEED_DEMO_DATA=true npm run seed` also creates two agents:
*Company Helpdesk* (handbook) and *HR Assistant* (HR policies, restricted to
the HR Manager role), and a PII policy with a deny-list term.

### Step 4: workspace policies (through the API, not the environment)

The environment sets platform defaults and ceilings; each workspace narrows
them, and every change is audited:

| Endpoint | Permission | What it controls |
|---|---|---|
| `PUT /v1/organizations/{org}/llm/policy` | `llm:manage` | allowed models (a subset of the platform's), default model, lower output and context ceilings |
| `PUT /v1/organizations/{org}/pii/policy` | `pii:policy:update` | entity types, score threshold, allow list (e.g. the company's own name), deny list (project code names), failure mode, or redaction off entirely |

Weakening the PII policy — dropping a type, raising the threshold, choosing
`DEGRADE_TO_PATTERNS`, turning redaction off — is audited with `weakened: true`.

### Step 5: verify

1. `GET /health` shows `llm` and `pii_detector` as `up` (both report
   `degraded`, never `down`, when unreachable, so they cannot take the API out
   of rotation).
2. `GET /v1/organizations/{org}/llm/models` lists your models, each marked
   allowed or not.
3. See the redaction work without calling the model:

   ```bash
   curl -X POST $API/api/v1/organizations/$ORG/pii/analyze \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"Ayesha Raza (ayesha@acme.test) earns PKR 950,000; card 4111 1111 1111 1111."}'

   # the exact, masked prompt an agent would send
   curl -X POST $API/api/v1/organizations/$ORG/agents/$AGENT/prompt-preview \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"content":"What does Ayesha Raza earn?"}'
   ```

4. Talk to an agent, streaming (`-N` disables curl's buffering):

   ```bash
   CONV=$(curl -s -X POST $API/api/v1/organizations/$ORG/conversations \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d "{\"agentId\":\"$AGENT\"}" | jq -r .data.id)
   curl -N -X POST $API/api/v1/organizations/$ORG/conversations/$CONV/messages/stream \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"content":"How many days of annual leave do I get?"}'
   ```

   Events: `meta`, then `status` (`retrieving`, `redacting`, `queued`,
   `generating`), `delta` with the text, and `done` with citations, usage and
   timings — or `error` with the same `code`, `status` and `details` a JSON
   error would carry.
5. End to end against a **disposable** database. The suite runs the real
   application against in-process stand-ins for the model and the NER service,
   so it needs only PostgreSQL and Redis:

   ```bash
   npm run migration:run
   SEED_DEMO_DATA=true npm run seed
   AGENTS_E2E=true npm run test:e2e:agents
   ```

6. Measure the redaction engine (`docs/benchmarks/pii-redaction.md`), and once
   the AI service implements `/v1/pii/analyze`, with names too:

   ```bash
   npm run benchmark:pii
   AI_SERVICE_URL=... AI_SERVICE_SIGNING_SECRET=... npm run benchmark:pii -- --ner ai-service
   ```

7. `GET /v1/organizations/{org}/llm/usage` reports invocations by outcome,
   tokens, latency percentiles and the **redaction overhead** (p50/p95/p99 and
   its share of total time) from live traffic.

### Phase 3 checklist

| Variable | API | Worker | AI service | GPU host / proxy |
|---|:-:|:-:|:-:|:-:|
| `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY` | ✓ | (same env group is fine) | | proxy token = `LLM_API_KEY` |
| `LLM_DEFAULT_MODEL`, `LLM_ALLOWED_MODELS` | ✓ | | | models pulled |
| `LLM_MAX_CLASSIFICATION` | ✓ (`RESTRICTED` only for a model you control) | | | |
| `LLM_MAX_CONCURRENCY` | ✓ | | | ≥ instances × this: `OLLAMA_NUM_PARALLEL` |
| `LLM_REQUEST_TIMEOUT` > `LLM_MAX_DURATION` + 10 s | ✓ (validated at boot) | | | |
| `PII_NER_PROVIDER` | ✓ | | implements `/v1/pii/analyze` | |
| `PRESIDIO_ANALYZER_URL` (option 2 only) | ✓ | | | private network |
| `PII_DEFAULT_ON_FAILURE` | ✓ (keep `REFUSE`) | | | |
| Migration `1758700000000` and `npm run seed` | once | | | |

---

## Phase 4: orchestration, tools and real-time

**Nothing new to provision.** The workflow engine runs on the Redis/BullMQ of
phase 2, agent steps call the model endpoint of phase 3 through the same
gateway, and the WebSocket is served by the API on its own HTTP port. What
changes is configuration — four things to get right — and one migration.

How it fits together ([ADR 0004](adr/0004-orchestration-tools-realtime.md)):

- A **workflow** is the JSON graph the React Flow canvas produces
  ([contract](contracts/workflow-graph-v1.md)): agents, tools, retrieval,
  conditions, supervisors, approvals. Each step is a BullMQ job that carries
  *references and a MAC* — never content. Inputs and outputs of every step
  (the inter-agent messages) are stored in PostgreSQL, encrypted under a key
  per run; deleting a run destroys its key.
- **Tools** are granted per agent. Every call is checked (permission, schema,
  information flow, personal data, budget), executed with a timeout, and
  recorded — refusals included — in the tool ledger and the audit log.
- **Real-time events** (Socket.IO) tell the canvas which step is running,
  what finished, what waits for approval. Events are metadata only; content is
  fetched over HTTP with its access checks ([contract](contracts/realtime-v1.md)).

### Step 1: give the worker the same environment as the API

From this phase, whoever runs the queue workers runs **agents and tools**:
workflow steps call the model, send email and call partner APIs from the
worker process. If you run a separate worker (phase 2, step 5), it needs
**every** variable the API has — `LLM_*`, `PII_*`, `TOOL_*`, `MAIL_*`/`SMTP_*`,
`WORKFLOW_*` included. The simplest way on Railway or Render is one shared
environment group for both services.

Any number of workers may run side by side, and the API can keep
`QUEUE_WORKERS_ENABLED=true` as well: a step is claimed with a compare-and-set
in PostgreSQL, so no step ever runs twice. Throughput is
`workers × WORKFLOW_CONCURRENCY` steps at once; model calls are further
limited per process by `LLM_MAX_CONCURRENCY`, so size the GPU host for
`(API + workers) × LLM_MAX_CONCURRENCY` parallel requests (Ollama:
`OLLAMA_NUM_PARALLEL`).

### Step 2: WebSocket through your platform and load balancer

Clients connect to `wss://<your API host>/realtime` (`REALTIME_PATH`) and
authenticate **in the handshake**: `{ token, organizationId }` for a person,
`{ apiKey }` for an API key. Credentials in the URL are refused.

- **Run the API as a long-lived service** (Railway, Render web service, Fly
  machine, a VM, Cloud Run with a request timeout of at least an hour). A
  serverless function platform cannot hold a socket open.
- **Transports.** Keep `REALTIME_TRANSPORTS=websocket` (the default): it needs
  **no sticky sessions**, however many API instances run — events reach
  whichever instance holds the socket through Redis pub/sub. Only if you add
  `polling` (for networks that block WebSocket) do you need session affinity
  on the load balancer.
- **Idle timeouts.** Keep `REALTIME_PING_INTERVAL` (25 s) below the proxy's
  idle timeout (commonly 60 s; Cloudflare 100 s; AWS ALB 60 s by default).
- **Origins.** Browsers may open a socket only from an origin in
  `CORS_ORIGINS` — add your frontend's production origin there.
- **Client IPs.** Handshakes are throttled per IP
  (`REALTIME_MAX_HANDSHAKES_PER_MINUTE`); behind a proxy, set `TRUST_PROXY`
  (phase 1) so the real client IP is used.

### Step 3: the HTTP tool allowlist (egress)

HTTP tools (a workspace administrator defines them through the API) can call
**nothing** until you list the hosts they may reach:

```bash
TOOL_HTTP_ALLOWED_HOSTS=api.partner.com,*.crm.example.com,erp.example.com:8443
```

A tool's host is fixed when it is defined — the model's arguments only fill
the path, query and body — and must match this list. Whatever the host
resolves to must be a public address: private, loopback and link-local ranges
are refused, the cloud metadata service (`169.254.169.254`, `fd00:ec2::254`)
**always**, and the connection is pinned to the address that was checked.
Redirects are not followed. Leave `TOOL_HTTP_ALLOW_PRIVATE_NETWORKS` and
`TOOL_HTTP_ALLOW_INSECURE` false; the service refuses to boot with them on in
production or staging.

Credentials for a partner API (bearer token, API key header, basic auth) are
given when the tool is created and stored encrypted with the master key; they
are never returned by the API and never shown to the model.

The built-in `send_email` tool sends through `MAIL_TRANSPORT`: set
`MAIL_TRANSPORT=smtp` and the `SMTP_*` variables (phase 1) for real delivery.
It only ever reaches members of the workspace, and only those allowed to see
what the conversation contains.

### Step 4: apply the migration and seed

```bash
npm run migration:run   # applies 1758800000000-OrchestrationToolsRealtime
npm run seed            # syncs the phase 4 permissions (tool:*, workflow:approve, …) into roles
```

In a demo database, `SEED_DEMO_DATA=true npm run seed` also creates an
*Operations Assistant* agent (calculator, date, email) and two published
workflows: **Bonus calculator** — a calculator step that runs with no model
configured — and **Handbook answer with sign-off** — the Company Helpdesk
drafts, a person approves.

### Step 5: verify

1. `GET /health` shows `workflow_engine` and `realtime` as `up`. Like every
   probe since phase 2 they report `degraded`, never `down`.
   `workflow_engine` turns `degraded` with `stalledSteps` or `overdueSteps`
   above zero when no process is consuming the queue — the usual cause is a
   worker service without `QUEUE_WORKERS_ENABLED=true`.
2. Run the seeded workflow (no model needed):

   ```bash
   WF=$(curl -s "$API/api/v1/organizations/$ORG/workflows?limit=100" \
     -H "Authorization: Bearer $TOKEN" | jq -r '.data[] | select(.name=="Bonus calculator") | .id')
   RUN=$(curl -s -X POST $API/api/v1/organizations/$ORG/workflows/$WF/runs \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"input":{"salary":950000}}' | jq -r .data.id)
   curl -s $API/api/v1/organizations/$ORG/workflow-runs/$RUN/content \
     -H "Authorization: Bearer $TOKEN"          # "Bonus: 95000"
   curl -s $API/api/v1/organizations/$ORG/workflow-runs/$RUN/trace \
     -H "Authorization: Bearer $TOKEN"          # rebuilt from the audit log alone
   ```

3. Watch a run live (Node, `npm i socket.io-client`):

   ```js
   const { io } = require('socket.io-client');
   const socket = io(API, { path: '/realtime', transports: ['websocket'],
                            auth: { token: TOKEN, organizationId: ORG } });
   socket.on('ready', () => socket.emit('subscribe', { runId: RUN }, console.log));
   socket.on('event', (e) => console.log(e.type, e.nodeId ?? '', e.data));
   ```

4. End to end against a **disposable** PostgreSQL and Redis. The suite runs
   the real application — queues, workers, sockets — with a scripted model,
   and proves the phase's exit criteria: a three-agent run traced from the
   audit log alone; a failing step dead-lettered with no sensitive value left
   anywhere in Redis or PostgreSQL; a runaway loop stopped by the step ceiling.

   ```bash
   npm run migration:run
   SEED_DEMO_DATA=true npm run seed
   WORKFLOWS_E2E=true npm run test:e2e:workflows
   ```

### Phase 4 checklist

| Variable / action | API | Worker | Load balancer / platform |
|---|:-:|:-:|:-:|
| Same environment as the API (`LLM_*`, `PII_*`, `TOOL_*`, `MAIL_*`, `SMTP_*`, `WORKFLOW_*`) | ✓ | **✓ (now required)** | |
| `QUEUE_WORKERS_ENABLED` | `true`, or `false` if workers run | (forced `true`) | |
| `REALTIME_TRANSPORTS=websocket` | ✓ | | WebSocket upgrades allowed; no sticky sessions needed |
| `REALTIME_PING_INTERVAL` below the proxy idle timeout | ✓ | | idle timeout ≥ 60 s |
| `CORS_ORIGINS` includes the frontend origin (also the socket origin) | ✓ | | |
| `TRUST_PROXY` set behind a proxy | ✓ | | |
| `TOOL_HTTP_ALLOWED_HOSTS` (empty = no HTTP tools) | ✓ | ✓ | outbound HTTPS to those hosts |
| `TOOL_HTTP_ALLOW_PRIVATE_NETWORKS=false`, `TOOL_HTTP_ALLOW_INSECURE=false` | ✓ | ✓ | |
| `MAIL_TRANSPORT=smtp` + `SMTP_*` for `send_email` | ✓ | ✓ | |
| GPU host sized for `(API + workers) × LLM_MAX_CONCURRENCY` | | | `OLLAMA_NUM_PARALLEL` |
| Migration `1758800000000` and `npm run seed` | once | | |

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

### When the NER detector is down

With the default `REFUSE` policy, agent turns and chat answer
`503 PII_DETECTION_UNAVAILABLE` (audited as `pii.redaction.failed`, and recorded
as `REFUSED` in the usage ledger) until it is back. Nothing is sent. If a
workspace must keep working, an administrator can switch it to
`DEGRADE_TO_PATTERNS` with `PUT …/pii/policy` — structural data stays masked,
names do not — and switch it back afterwards. Both changes are audited.

### `PII_EGRESS_BLOCKED`

The gateway re-scans every outgoing prompt. A finding means a value that was
supposed to be masked was about to leave: the request is refused with `500
PII_EGRESS_BLOCKED` and audited as **CRITICAL** (`pii.egress.blocked`, entity
types only, never values). It indicates a defect in the masking pipeline, not a
user error: capture the request id from the audit record and investigate.

### A workflow run failed or looks stuck

- `GET /v1/organizations/{org}/workflow-runs/{run}` shows every step with its
  status, attempts, error code and failure class (`TRANSIENT`, `TIMEOUT`,
  `POLICY`, `PERMANENT`); `…/trace` rebuilds the run from the audit log.
- `GET /v1/organizations/{org}/workflow-runs/dead-letters` lists steps that
  failed for good — metadata only, by design: debugging works without anyone
  reading the payloads. `inputFingerprint` repeats when the same input keeps
  failing.
- Fix the cause, then `POST …/workflow-runs/{run}/resume`: failed steps run
  again, finished ones keep their outputs. `POST …/cancel` stops a run and
  aborts its in-flight model calls wherever they run.
- Steps whose worker died are taken over automatically after
  `WORKFLOW_STALL_THRESHOLD` by the reconciliation sweep (every
  `WORKFLOW_SWEEP_INTERVAL`); a step that kills its worker on every attempt is
  stopped and dead-lettered instead of crashing workers forever.
- `WORKFLOW_STEP_LIMIT_EXCEEDED` / `WORKFLOW_TOKEN_BUDGET_EXCEEDED`: a circuit
  breaker stopped the run (audited as `agent.circuit_broken`). Raise the
  workflow's own `maxSteps` / `maxTokens` settings if the work is legitimate.

### Adding an HTTP tool

1. Add its host to `TOOL_HTTP_ALLOWED_HOSTS` (and redeploy API and worker).
2. `POST /v1/organizations/{org}/tools` with the definition (`http.url` with
   `{{parameter}}` placeholders in the path or query, a JSON Schema for the
   parameters, and `secret` for its credential); `POST …/tools/{id}/test`
   calls it once with sample arguments.
3. Grant it to an agent (`tools.toolIds` on the agent). By default an external
   tool accepts only `PUBLIC` context and refuses arguments carrying personal
   data; loosen its `dataPolicy` deliberately, if at all — every weakening is
   audited.

### Changing models

Add the model to the GPU host (`ollama pull …`) and to `LLM_ALLOWED_MODELS`,
redeploy, then allow it per workspace with `PUT …/llm/policy`. An agent pinned
to a model that is no longer allowed answers `422 LLM_MODEL_NOT_ALLOWED`, and
one the endpoint no longer serves `422 LLM_MODEL_NOT_FOUND`, both listing the
models that can be used; edit the agent (a new version) to switch.

---

## Later phases (not needed yet)

| Phase | You will provision |
|---|---|
| 5 | An OpenTelemetry collector (e.g. Grafana Cloud free tier); mTLS certificates between API and AI service |

Each phase's section will be added here when it is implemented.
