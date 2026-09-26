# Distributed AI Agent Management Platform — Backend

Backend for a multi-tenant SaaS platform that lets organizations create, deploy
and manage custom AI agents against their own private data, using locally hosted
LLMs and an active PII redaction layer so that sensitive enterprise information
never leaves the organization's control.

Final Year Project · Department of Computer Science, Air University Islamabad
Mohammad Mehran Chaudhary (232433) · Ahmad Hanbal (231653) · Ameer Abdullah (233087)
Supervisor: Ms. Maryam Wardah · Co-Supervisor: Mr. Qaiser Manzoor

---

## Status

**Phases 1 to 4 of 5 are implemented. One phase remains.**

- **Phase 1:** foundation, identity, multi-tenancy, RBAC and the tamper-evident
  audit log.
- **Phase 2:** the knowledge layer. Encrypted document storage, an async
  ingestion pipeline, hybrid vector search, and access-controlled retrieval
  that enforces compartments and clearance *inside* the search.
- **Phase 3:** inference, agents and privacy.
  - An LLM gateway for Ollama or any OpenAI-compatible server, streaming over
    SSE, which is also the privacy boundary.
  - The **PII Redaction Engine**: detect → mask → unmask, with the mapping
    destroyed at the end of each request and every outgoing prompt
    re-checked.
  - Versioned agents that act only with their user's access.
  - Token-budgeted conversational memory whose messages carry the sensitivity
    of what they were derived from.
- **Phase 4:** orchestration, tools and real-time.
  - A multi-agent **workflow engine** for the React Flow canvas: explicit
    bounded loops, supervisors, conditions and human approvals, with every
    step persisted, resumable and traceable from the audit log alone.
  - Queued jobs carry references and a MAC, never content; each run's messages
    are encrypted under its own key. A step ceiling and a token budget stop
    runaway loops before they reach the queue.
  - A **tool execution engine**: per-agent grants, strict schemas,
    information-flow control against prompt injection, and SSRF-safe HTTP
    tools.
  - **Live events over WebSocket**: authenticated at the handshake, scoped to
    the workspace, metadata only, and closed the moment access is revoked.

See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for the
five-phase plan and [`docs/CLOUD_SETUP.md`](docs/CLOUD_SETUP.md) for what to
provision.

| Check | Result |
|-------|--------|
| `npm run typecheck` / `lint` / `build` | clean |
| `npm test` | 671 tests, 29 suites, passing |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migrations + seed on real PostgreSQL 18 | ✅ all four migrations apply, revert and re-apply |
| Live HTTP and WebSocket (auth, workspaces, knowledge bases, grants; SSE agent turns against a mock model; workflow runs, live events, dead letters, health) | ✅ |
| `npm run test:e2e:knowledge` (real PostgreSQL, in-memory cloud stand-ins) | ✅ 13/13 |
| `npm run test:e2e:agents` (real PostgreSQL, stand-in model and NER) | ✅ 18/18 |
| `npm run test:e2e:workflows` (real PostgreSQL, Redis, BullMQ workers and Socket.IO; scripted model) | ✅ 26/26 — the three phase 4 exit criteria |
| `npm run benchmark:pii` ([report](docs/benchmarks/pii-redaction.md)) | 0 leaks in 15,806 entities; F1 99.79%; overhead p50 1.4 ms |
| `npm run test:integration` (live Qdrant) | ⏳ runs once `QDRANT_URL` is set |

### Outstanding

- **The database credentials in the local `.env` are rejected** by the server
  (`password authentication failed for user "postgres"`). Fix them before running
  migrations against your cloud database.
- Real document ingestion needs object storage, Qdrant and the Python AI service
  (implementing [the v1 contract](docs/contracts/ai-service-v1.md)). Until they
  are configured, upload and retrieval return `503
  KNOWLEDGE_LAYER_NOT_CONFIGURED` and name the missing variables; everything else
  works.
- Agents and chat need a model endpoint (`LLM_BASE_URL`; `503 LLM_NOT_CONFIGURED`
  until set), and name detection needs the AI service to implement
  `POST /v1/pii/analyze` (or a Presidio analyzer). See the phase 3 section of
  [`docs/CLOUD_SETUP.md`](docs/CLOUD_SETUP.md).
- Workflows with agent steps need that same model endpoint; workflows made of
  tools, conditions and approvals run today (the seeded *Bonus calculator* is
  one). HTTP tools stay off until `TOOL_HTTP_ALLOWED_HOSTS` lists their hosts.
  See the phase 4 section of [`docs/CLOUD_SETUP.md`](docs/CLOUD_SETUP.md).

---

## Requirements

| | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.11 | Developed on 22.14 |
| PostgreSQL | ≥ 13 | Needs `gen_random_uuid()`; verified on 18 |
| Redis | ≥ 6 | `maxmemory-policy noeviction` (it holds BullMQ jobs); streams, pub/sub and Lua (phase 4 events) |
| S3-compatible storage | any | phase 2: Cloudflare R2 recommended |
| Qdrant | ≥ 1.10 | phase 2: Qdrant Cloud; needs the Query API for hybrid search |
| Python AI service | contract v1 | phase 2: see `docs/contracts/ai-service-v1.md`; phase 3 adds `/v1/pii/analyze` |
| LLM endpoint | Ollama ≥ 0.5, or OpenAI-compatible | phase 3: a GPU host behind an authenticating proxy, or a hosted API |

All of these run as managed cloud services. [`docs/CLOUD_SETUP.md`](docs/CLOUD_SETUP.md)
walks through provisioning each one and which variables to set where. Docker
Compose is provided for PostgreSQL and Redis if you ever want them locally.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start PostgreSQL and Redis

Either use the provided stack:

```bash
docker compose up -d
```

…or point the `.env` in the next step at instances you already have running.

### 3. Create your configuration

```bash
cp .env.example .env
```

Then generate real signing and encryption secrets:

```bash
npm run generate:secrets -- --write
```

This fills in `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`,
`AUDIT_HASH_SECRET`, `PASSWORD_PEPPER` and `COOKIE_SECRET` with 32 bytes of
CSPRNG output each. It never overwrites a value that is already set, because
rotating `AUDIT_HASH_SECRET` invalidates every existing audit record and rotating
`PASSWORD_PEPPER` locks every user out.

Now edit `.env` and set your database credentials:

```ini
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=<your password>
DB_NAME=ai_agent_platform
```

`.env.example` documents every variable, including the ones later phases will
need.

### 4. Create the database

```bash
createdb ai_agent_platform
```

Or, if you are using the Docker stack, it already exists.

### 5. Run migrations and seed

```bash
npm run migration:run
npm run seed
```

The seed synchronises the permission catalogue — required, since
`@RequirePermissions('agent:create')` cannot work if the key does not exist in
the database — and provisions a platform administrator if you set
`PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`.

For a workspace pre-populated with five accounts and two custom roles that
demonstrate the RBAC model, set `SEED_DEMO_DATA=true` before seeding.

### 6. Run

```bash
npm run start:dev
```

| | |
|---|---|
| API | http://localhost:3000/api/v1 |
| Swagger UI | http://localhost:3000/docs |
| OpenAPI JSON | http://localhost:3000/docs-json |
| Health | http://localhost:3000/health (full) · `/health/ready` (use for cloud health checks) · `/health/live` |

The OpenAPI document is the contract for the React frontend — generate the client
from `/docs-json` rather than hand-writing request types.

---

## Quick tour

```bash
# Register. Returns an access token and sets an httpOnly refresh cookie.
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery-7","firstName":"Your","lastName":"Name"}'

# Create a workspace. Seeds its four built-in roles and makes you the owner.
curl -X POST http://localhost:3000/api/v1/organizations \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acme Corporation"}'

# Everything workspace-scoped needs the workspace, by id or slug.
curl http://localhost:3000/api/v1/organizations/acme-corporation/members \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'X-Organization-Id: acme-corporation'

# Verify the audit chain has not been tampered with.
curl http://localhost:3000/api/v1/organizations/acme-corporation/audit-logs/verify \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'X-Organization-Id: acme-corporation'

# Phase 2: create a restricted knowledge base, upload into it, ask a question.
curl -X POST http://localhost:3000/api/v1/organizations/acme-corporation/knowledge-bases \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"name":"HR Policies","accessMode":"RESTRICTED","defaultClassification":"CONFIDENTIAL"}'

curl -X POST http://localhost:3000/api/v1/organizations/acme-corporation/knowledge-bases/<kbId>/documents \
  -H 'Authorization: Bearer <accessToken>' -F 'file=@leave-policy.pdf'

curl -X POST http://localhost:3000/api/v1/organizations/acme-corporation/rag/query \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"query":"How many days of annual leave do I get?"}'
```

```bash
# Phase 3: see what the model would receive, masked, without calling it.
curl -X POST http://localhost:3000/api/v1/organizations/acme-corp/pii/analyze \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"text":"Ayesha Raza (ayesha.raza@acme.test) earns PKR 950,000; card 4111 1111 1111 1111."}'

# Talk to an agent, streaming. -N stops curl buffering the events.
curl -X POST http://localhost:3000/api/v1/organizations/acme-corp/conversations \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"agentId":"<agentId>"}'
curl -N -X POST http://localhost:3000/api/v1/organizations/acme-corp/conversations/<conversationId>/messages/stream \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"content":"How many days of annual leave do I get?"}'
```

```bash
# Phase 4: run the seeded workflow (it needs no model) and read its trace.
curl -X POST http://localhost:3000/api/v1/organizations/acme-corp/workflows/<workflowId>/runs \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"input":{"salary":950000}}'
curl http://localhost:3000/api/v1/organizations/acme-corp/workflow-runs/<runId>/content \
  -H 'Authorization: Bearer <accessToken>'     # {"output":"Bonus: 95000", …}
curl http://localhost:3000/api/v1/organizations/acme-corp/workflow-runs/<runId>/trace \
  -H 'Authorization: Bearer <accessToken>'     # rebuilt from the audit log alone
```

Live events: connect Socket.IO to `ws://localhost:3000` with path `/realtime`
and `auth: { token, organizationId }`, then `emit('subscribe', { runId })` —
see [`docs/contracts/realtime-v1.md`](docs/contracts/realtime-v1.md).

With `SEED_DEMO_DATA=true`, the demo workspace `acme-corp` has an open
**Company Handbook** and a RESTRICTED **HR Policies** compartment admitting only
the HR Manager (MANAGE) and Compliance Auditor (READ) roles. Sign in as
`employee@acme.test` or `admin@acme.test` and HR Policies does not exist for you.
It also has three agents: **Company Helpdesk** (the handbook), **HR Assistant**
(HR Policies, usable only by the HR Manager role) and **Operations Assistant**
(calculator, date and email tools); and two published workflows: **Bonus
calculator** (no model needed) and **Handbook answer with sign-off** (the
Helpdesk drafts, a person approves — not the one who asked).

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build |
| `npm run start:worker:prod` | Run the compiled background worker (optional separate service) |
| `npm run start:worker:dev` | Worker in watch mode |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Unit tests |
| `npm run test:integration` | Live tests against cloud services (skipped unless configured) |
| `npm run test:e2e:knowledge` | Knowledge layer end to end on a **disposable** database (`KNOWLEDGE_E2E=true`) |
| `npm run test:e2e:agents` | Agents, memory and PII redaction end to end on a **disposable** database (`AGENTS_E2E=true`) |
| `npm run test:e2e:workflows` | Workflows, tools and real-time end to end on a **disposable** database and Redis (`WORKFLOWS_E2E=true`) |
| `npm run benchmark:pii` | PII Redaction Engine accuracy and overhead → `docs/benchmarks/` (`-- --ner ai-service` to include names) |
| `npm run test:cov` | Coverage |
| `npm run lint` | ESLint with `--fix` |
| `npm run migration:run` | Apply pending migrations |
| `npm run migration:revert` | Roll back the last migration |
| `npm run migration:generate -- src/database/migrations/Name` | Generate from entity changes |
| `npm run seed` | Sync permissions, provision admin, optional demo data |
| `npm run db:setup` | Migrate then seed |
| `npm run generate:secrets` | Print fresh secrets (`-- --write` to fill `.env`) |

---

## Architecture

```
src/
├── config/          Typed, Joi-validated configuration namespaces
├── common/          Cross-cutting: guards, decorators, filters, interceptors, utils
├── database/        Entities registry, data source, migrations, seeds
├── shared/          Infrastructure: crypto, redis, mail, logging, request context,
│                    object storage (S3), vector store (Qdrant), AI service client, queues,
│                    the event bus (Redis Streams + pub/sub) behind real-time events
├── worker.ts        Optional dedicated background worker entry point
└── modules/         Feature modules
    ├── auth/            Sign-in, token rotation, sessions, recovery
    ├── users/           Identities and one-time tokens
    ├── organizations/   Tenants, settings, IP allowlist
    ├── memberships/     Member directory and lifecycle
    ├── invitations/     Workspace invitations
    ├── rbac/            Roles, permissions, effective-permission materialisation
    ├── api-keys/        Machine credentials for service-to-service calls
    ├── audit/           Tamper-evident compliance log
    ├── knowledge/       Phase 2: knowledge bases, documents, ingestion, secure retrieval
    │   ├── domain/          Classification lattice, access scope, status machine
    │   ├── knowledge-bases/ Compartments and grants
    │   ├── documents/       Upload inspection, encryption, the Document Vault
    │   ├── ingestion/       BullMQ pipeline, reconciliation sweep, purges
    │   └── retrieval/       Policy filters and two-point enforcement
    ├── privacy/         Phase 3: the PII Redaction Engine
    │   ├── domain/          Recognizers, masking session, sealed vault, stream unmasker
    │   └── detection/       Pattern + NER detection (AI service or Presidio), NER cache
    ├── llm/             Phase 3: the gateway (egress check, bulkhead, breaker, deadlines),
    │                    providers (Ollama, OpenAI-compatible), policies, usage ledger
    ├── agents/          Phase 3: versioned agents, persona engine, conversations,
    │                    token-budgeted memory with information-flow labels;
    │                    phase 4: the ReAct tool loop, agents as workflow steps
    ├── tools/           Phase 4: tool registry, executor (checks, IFC, budgets, ledger),
    │                    built-ins, SSRF-safe HTTP tools
    ├── workflows/       Phase 4: graph validation, scheduler, engine (claims, leases,
    │                    settlement, sweep), per-run encryption, approvals, traces
    ├── realtime/        Phase 4: the Socket.IO gateway, handshake auth, rooms, revocation
    └── health/          Liveness and readiness probes
src/benchmarks/pii/      The redaction benchmark: synthetic annotated corpus and scoring
src/testing/             Stand-ins for the cloud services, used by the end-to-end suites
```

### Request pipeline

Four global guards run in a deliberate order — the order is a security property,
not a style choice:

1. **RateLimitGuard** — before anything expensive, so a rejected request does not
   pay for a JWT verification and a database lookup.
2. **AuthenticationGuard** — establishes *who*. Fails closed: a route with no
   `@Auth()` or `@Public()` requires a Bearer token.
3. **OrganizationContextGuard** — establishes *which tenant*, and proves
   membership against the database.
4. **PermissionsGuard** — establishes *may they*.

### Response shape

Every response uses one envelope, so the frontend has a single place to read a
correlation id and a single way to detect failure:

```jsonc
// success
{ "success": true, "data": { }, "meta": { "requestId": "…", "timestamp": "…" } }

// failure
{ "success": false,
  "error": { "code": "PERMISSION_DENIED", "message": "…", "details": { } },
  "meta": { "requestId": "…", "timestamp": "…", "path": "…" } }
```

Branch on `error.code`, never on `message`. Codes are stable; messages may be
reworded or localised. `meta.requestId` is also returned as `X-Request-Id` and
written into both the application log and the audit log, so one identifier links
a user's report to the exact server-side trace.

---

## Security notes

Worth knowing before changing anything in this codebase.

- **Routes are protected by default.** No `@Auth()` or `@Public()` means Bearer
  required. Forgetting to protect a new endpoint produces a 401 during
  development rather than a silent hole.
- **Permissions are not in the JWT.** They are resolved per request, so removing
  a member takes effect immediately rather than at token expiry.
- **Refresh tokens rotate, and reuse is detected.** Presenting an already-spent
  token revokes every session in that family and emails the account owner.
- **Nothing recoverable is stored.** Passwords are Argon2id; refresh tokens,
  invitations, reset links and API keys are stored only as HMAC digests.
- **The audit log is hash-chained** and protected by a PostgreSQL trigger that
  rejects UPDATE and DELETE. `/audit-logs/verify` recomputes the chain and names
  the exact sequence number where it breaks.
- **Two independent anti-escalation rules** in RBAC: you cannot grant a
  permission you do not hold, and you cannot act on a member who outranks you.
  The second is not redundant — `member:update` is exactly the permission an
  administrator legitimately has, and without role priority it would be a
  workspace-takeover primitive.
- **Redis fails open; PostgreSQL fails closed.** Caching and rate limiting
  degrade gracefully during a Redis outage; the authoritative checks
  (`users.tokens_valid_from`, membership status) always run against the database.
- **Retrieval enforces access twice.** Inside the vector search (a filter built
  on the server; requests can narrow it, never widen it) and again when passage
  text is read from PostgreSQL. The vector store holds no text.
- **Document content is ciphertext everywhere it rests,** under per-document
  keys. Deleting a document destroys its key immediately, so backups become
  unreadable too. Deletion is irreversible by design.
- **Upload types come from file bytes,** never from the client's
  `Content-Type`. Macro-enabled and zip-bomb DOCX files are refused.
- **Requests to the AI service are HMAC-signed** with replay protection, and
  its responses are validated as untrusted input.
- **Nothing reaches a language model except through the gateway, and nothing
  sensitive leaves it.** The gateway re-scans every outgoing prompt; a value that
  should have been masked blocks the request, which is audited as CRITICAL.
  There is no "send unmasked if detection fails" mode: the default refuses.
- **The placeholder mapping never touches storage.** It is sealed under a key
  that exists only for the request and is zeroed at its end.
- **Agents never hold access of their own.** An agent retrieves with its user's
  access, narrowed by its own knowledge bases and ceiling, so attaching HR to a
  public agent does not show HR to the public.
- **Answers inherit the sensitivity of their sources.** A conversation message
  carries the classification and compartments of what it was derived from, and
  is withheld from anyone, owner included, who can no longer read them.
- **Agent versions are append-only** (a trigger rejects UPDATE), so what an agent
  said can always be traced to the exact configuration and prompt template that
  produced it.
- **The queue is not trusted.** A workflow job carries references and a MAC
  keyed from its run's key — no content — so a compromised Redis can neither
  read a run nor forge or redirect a step (rejections are audited CRITICAL).
  Inter-agent messages are encrypted under a key per run; deleting a run
  destroys it.
- **A run acts as whoever started it,** re-checked before every step: removing
  a member stops their running workflows at the next step.
- **Tools are checked at the sink.** Every call is granted, permitted, schema-
  checked and flow-checked: after an agent reads untrusted content, tools with
  side effects are disabled; data above a tool's clearance never reaches it.
  Every call, refusals included, is in the ledger and the audit log.
- **HTTP tools cannot be pointed inward.** Allowlisted hosts only, public
  addresses only (pinned against DNS rebinding), no redirects, and the cloud
  metadata service refused even in development.
- **A WebSocket is only as good as its latest check.** Sockets authenticate at
  the handshake, receive only rooms derived from verified ids, and are closed
  as soon as access changes. Events carry no content.

### Before deploying

```ini
NODE_ENV=production
COOKIE_SECURE=true
COOKIE_SAME_SITE=strict
CORS_ORIGINS=https://your-frontend.example.com   # never *
DB_SSL=true
REDIS_TLS=true
REQUIRE_EMAIL_VERIFICATION=true
MAIL_TRANSPORT=smtp
TRUST_PROXY=<number of proxies in front of the app>
TOOL_HTTP_ALLOWED_HOSTS=<only the partner APIs your tools need>
```

All four secrets are **required** in production — the schema refuses to start
without them, and bootstrap throws if it detects a development default.

---

## Documentation

- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — the five-phase
  plan, what each delivers, exit criteria, risks
- [`docs/adr/0001-multi-tenancy.md`](docs/adr/0001-multi-tenancy.md) — why
  row-level tenancy rather than schema-per-tenant, and what replaces the
  guarantee
- [`docs/adr/0002-knowledge-layer-security.md`](docs/adr/0002-knowledge-layer-security.md) —
  the access lattice, two-point enforcement, crypto-shredding, convergence
- [`docs/adr/0003-inference-and-privacy.md`](docs/adr/0003-inference-and-privacy.md) —
  the gateway as privacy boundary, request-scoped masking, fail-closed
  detection, agents as delegates, information-flow labels
- [`docs/adr/0004-orchestration-tools-realtime.md`](docs/adr/0004-orchestration-tools-realtime.md) —
  PostgreSQL as the source of truth, references-only jobs, bounded loops and
  circuit breakers, tool checks and information-flow control, egress control,
  metadata-only real-time events, traces from the audit log
- [`docs/benchmarks/pii-redaction.md`](docs/benchmarks/pii-redaction.md) — measured
  accuracy and overhead of the PII Redaction Engine, reproducible
- [`docs/CLOUD_SETUP.md`](docs/CLOUD_SETUP.md) — provisioning each cloud service,
  per phase, and which variables go where
- [`docs/contracts/ai-service-v1.md`](docs/contracts/ai-service-v1.md) — the
  Python AI service contract, with a reference signature verifier and a
  Presidio reference for `/v1/pii/analyze`
- [`docs/contracts/workflow-graph-v1.md`](docs/contracts/workflow-graph-v1.md) —
  the workflow JSON the canvas produces: node types, handles, templates, loops,
  validation errors, the tool schema dialect
- [`docs/contracts/realtime-v1.md`](docs/contracts/realtime-v1.md) — the
  WebSocket protocol: handshake, rooms, subscriptions, events, replay,
  revocation

---

## Known environment notes

- **NestJS 12 ships as pure ESM.** Node 22 can `require()` it, so the compiled
  CommonJS build runs fine — but Jest's own runtime cannot below Node 24.9, which
  is why `jest.config.mjs` runs the suite in native ESM mode via
  `--experimental-vm-modules`.
- **`ora` is pinned via `overrides`** because the Nest CLI crashes on Node 22
  with an ESM require cycle otherwise.
