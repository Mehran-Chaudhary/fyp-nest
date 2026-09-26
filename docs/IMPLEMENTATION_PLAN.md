# Implementation Plan — Backend

**Project:** A Distributed AI Agent Management Platform
(with Privacy-Preserving RAG and Secure Workflow Orchestration)

**Scope of this document:** the NestJS backend only. The React frontend and the
Python/FastAPI AI service are separate deliverables; this plan states where they
attach.

---

## 1. How the sixteen proposal modules map onto five phases

The proposal lists sixteen modules. They are not independent — several cannot be
built before others exist — so the phases below are ordered by *dependency*, not
by the numbering in the proposal.

Three constraints drive the ordering:

1. **Everything is tenant-scoped.** Documents, agents, workflows and audit
   records all belong to a workspace. Until workspaces, membership and
   permissions exist, every later module would have to invent its own access
   rules and then be rewritten.
2. **The research component needs data to operate on.** The PII Redaction Engine
   (module 6.12) masks text retrieved from the vector store. It cannot be
   evaluated before retrieval works, which cannot work before ingestion works.
3. **Orchestration needs something to orchestrate.** The multi-agent workflow
   engine (6.9) routes output between agents. Agents must exist first.

| Phase | Theme | Proposal modules |
|-------|-------|------------------|
| **1** | Foundation, Identity & Multi-Tenancy | 6.1, 6.2, 6.3, 6.15, part of 6.14 |
| **2** | Knowledge Layer & Secure Retrieval | 6.4, 6.5, 6.6 |
| **3** | Inference, Agents & Privacy | 6.7, 6.8, 6.10, 6.12 |
| **4** | Orchestration, Tools & Real-Time | 6.9, 6.11, 6.13 (backend), 6.16 |
| **5** | Governance, Hardening & Operations | rest of 6.14, hardening of all |

---

## Phase 1 — Foundation, Identity & Multi-Tenancy · **IMPLEMENTED**

Everything the rest of the platform stands on: who a caller is, which tenant
they are acting inside, what they may do there, and an immutable record of what
they did.

**Proposal modules:** 6.1 Authentication & IAM · 6.2 Organization Workspace ·
6.3 Strict RBAC · 6.15 Secure Audit Logging · 6.14 (rate-limiting foundation)

### Delivered

| Area | What was built |
|------|----------------|
| **Configuration** | Every environment variable declared and validated with Joi; the process refuses to start on invalid configuration. Seven typed namespaces. |
| **Authentication** | Registration, sign-in, email verification, password reset, password change. Argon2id hashing with a keyed pepper and a scrypt fallback. Timing-equalised sign-in to prevent account enumeration. |
| **Sessions** | JWT access tokens (15 min) plus refresh token **rotation with reuse detection**. Presenting a spent token revokes the whole family and alerts the account owner. |
| **Revocation** | Per-token Redis denylist plus a per-user epoch, backed by a durable `tokens_valid_from` column so revocation survives a Redis outage. |
| **Multi-tenancy** | Workspaces with slugs, settings, ownership transfer, soft deletion. Tenant resolution from header or path, membership re-verified per request. |
| **RBAC** | Global permission catalogue covering **all five phases** (60+ keys), four immutable system roles per workspace, unlimited custom roles, wildcard matching, role priority ordering, two independent anti-escalation rules. |
| **Members & invitations** | Member directory with search and filtering, suspension, removal, self-service leave. Single-use expiring invitations bound to the invited address. |
| **API keys** | Workspace-scoped machine credentials with scopes capped by the issuer's own permissions, optional IP pinning, and immediate revocation. This is how the Python AI service will authenticate. |
| **Audit log** | Append-only, **hash-chained**, tamper-evident. Per-workspace chains, PostgreSQL trigger blocking UPDATE/DELETE, a verification endpoint that names the exact sequence where a chain breaks, and NDJSON export for external review. |
| **Network controls** | Per-workspace IP allowlisting with IPv4/IPv6 CIDR matching. |
| **Rate limiting** | Redis sliding-window limiter with named policies, keyed by principal rather than only by IP. |
| **Cross-cutting** | Structured logging with redaction, correlation IDs, consistent response envelope, stable machine-readable error codes, global exception filter, OpenAPI documentation, health/liveness/readiness probes. |

### Verification status

- `npm run typecheck` — clean
- `npm run build` — clean
- `npm test` — 184 tests at phase 1 close (343 including phase 2)
- Boot-time configuration validation — confirmed working against a live process
- **Verified during phase 2 (2026-09-24)** against a real PostgreSQL 18: the
  initial migration applies, the seed runs (catalogue, demo workspace, roles,
  members), sign-in and workspace-scoped HTTP work, and the audit chain verifies.
- **Found and fixed in phase 2:** health probes were served at `/v1/health`
  instead of `/health` (URI versioning applied despite the prefix exclusion),
  which would have failed every cloud host's health check.

### Design decisions worth defending in the report

These are the points an examiner is most likely to probe.

- **Permissions are not in the JWT.** Embedding them would make revocation take
  up to a full token lifetime to apply, which is incompatible with “strict
  RBAC”. They are resolved per request from a materialised column with a short
  Redis cache.
- **Row-level tenancy, not schema-per-tenant**, despite the proposal's wording.
  Reasoning in `docs/adr/0001-multi-tenancy.md`.
- **Role priority exists alongside permissions.** Permission checks alone cannot
  stop an administrator from stripping the owner's roles, because `member:update`
  is exactly the permission an administrator is supposed to have.
- **The audit log is hash-chained, not merely append-only.** “We never issue an
  UPDATE” is a convention; a hash chain is evidence.
- **Redis fails open, PostgreSQL fails closed.** Each fallback is documented at
  its call site, and the durable checks are what make the cache-layer fail-open
  acceptable.

---

## Phase 2 — Knowledge Layer & Secure Retrieval · **IMPLEMENTED**

Getting enterprise documents into the platform and retrievable **under the same
RBAC rules** that govern everything else.

**Proposal modules:** 6.4 Document Ingestion & Parsing · 6.5 Vector Embedding &
Storage · 6.6 Secure RAG Retrieval Pipeline

### Delivered

| Area | What was built |
|------|----------------|
| **Access model** | A lattice: knowledge-base **compartments** (WORKSPACE or RESTRICTED, with READ/WRITE/MANAGE grants to roles, memberships or API keys) × document **classification** (PUBLIC → RESTRICTED) against **clearance** held as `clearance:*` permissions. Only `*:*` bypasses compartments — not the admin role. Hidden resources return 404; probes are audited. |
| **Secure retrieval** | Mandatory server-built filter applied **inside** the Qdrant search; callers can only narrow it. A **second, independent enforcement point**: passage text is fetched from PostgreSQL through a query restating the whole policy, so the policy holds even while stores disagree. |
| **Hybrid search** | Dense vectors + BM25 sparse vectors (computed in-process, IDF by Qdrant) fused with reciprocal rank fusion; optional cross-encoder rerank that degrades gracefully. |
| **Retrieval auditing** | `rag.query.executed` records which documents/chunks an answer drew on (never the query text — a keyed fingerprint instead). `rag.access.filtered` records which relevant documents the policy **withheld** and why, by id only. |
| **Encryption** | Per-document data keys (envelope encryption, AES-256-GCM, bound by associated data). Files in object storage and chunk text in PostgreSQL are ciphertext; the vector store holds no text at all. **Crypto-shredding**: deletion destroys the key in the same transaction, making backups unreadable too. |
| **Upload hardening** | Type from magic bytes, never the client's Content-Type; extension must agree; DOCX central directory inspected (macros refused, zip bombs refused); keyed duplicate detection; per-workspace storage quota under an advisory lock; UTF-8-safe filenames. |
| **Ingestion pipeline** | BullMQ, `UPLOADED → PARSING → CHUNKING → EMBEDDING → READY / FAILED`. Compare-and-set transitions, chunks persisted atomically with the stage change, **UUIDv5 chunk ids = vector point ids** (retries overwrite, never duplicate), per-batch checkpoints (resume after a crash), inactive-until-complete vectors, **zero-downtime reindex** (old version serves until the new one is ready). Transient vs permanent failure policy; metadata-only dead-letter queue. |
| **Reconciliation** | PostgreSQL is the source of truth and the outbox. A single scheduled sweep re-enqueues lost uploads, resumes stalled runs, finishes purges, re-syncs vector payloads after reclassification, and destroys deleted workspaces' knowledge after a grace period. |
| **AI service contract** | Typed client with HMAC request signing (method, path, query, timestamp, nonce, body hash), timeouts, jittered retries honouring `Retry-After`, a circuit breaker, a response-size ceiling and strict response validation. Full contract with a Python reference verifier in `docs/contracts/ai-service-v1.md`. |
| **Cloud infrastructure** | S3-compatible storage (R2, S3, B2, Supabase, MinIO), Qdrant Cloud with per-workspace collections (or tenant-indexed shared mode) and int8 quantisation, BullMQ on managed Redis. All optional at boot, with 503 responses naming missing variables; degraded-not-down health indicators. Optional dedicated worker process. |
| **RBAC upkeep** | 3 new permissions; the seed now also upgrades built-in roles in existing workspaces. Demo seed adds a WORKSPACE handbook and a RESTRICTED HR compartment. |

### Verification status

- `npm run typecheck`, `npm run lint`, `npm run build` — clean
- `npm test` — **343 tests, 16 suites, all passing** (159 new). Includes the
  retrieval policy evaluated over a payload corpus with Qdrant's filter
  semantics, upload inspection against real PDF/DOCX/ZIP bytes, encryption and
  signing properties, and the AI client against a fake transport.
- **Against real PostgreSQL 18:** both migrations apply, revert and re-apply;
  the seed runs and the system-role sync upgrades a simulated pre-phase-2
  workspace; live HTTP confirmed compartment invisibility (employee *and* admin
  get 404 on HR), clearance resolution per role, grant management, 503s naming
  missing configuration, and an intact audit chain.
- **End-to-end (`npm run test:e2e:knowledge`), real PostgreSQL, in-memory cloud
  stand-ins — 13/13:** upload → parse → chunk → embed → READY; ciphertext at rest
  everywhere; employee and admin never receive the payroll chunk while HR does;
  withheld documents audited; **crash mid-embedding resumes with 70 chunks and 70
  vectors, no duplicates**; zero-downtime reindex; SQL gate excludes a
  reclassified document before the vector payload syncs; download; delete
  shreds the key and purge removes vectors and objects; audit chain verifies.
- **Pending the cloud services:** `npm run test:integration` runs the exit
  criterion against a live Qdrant (5 tests, skipped until `QDRANT_URL` is set),
  and real ingestion needs the Python AI service implementing the v1 contract.

### Exit criteria

- ✅ A document in a restricted knowledge base is not retrievable by a member
  lacking access — proven over payloads in unit tests, end to end against real
  PostgreSQL, and by an integration test asserting on Qdrant's returned payloads
  (runs when `QDRANT_URL` is set).
- ✅ Ingestion survives a worker crash mid-embedding without duplicating chunks —
  proven end to end.

### Design decisions worth defending in the report

See [`docs/adr/0002-knowledge-layer-security.md`](adr/0002-knowledge-layer-security.md).
The short version: the policy is part of the query *and* of the text fetch; the
vector store holds no text; deletion is crypto-shredding; PostgreSQL is the
source of truth and the other stores converge on it; the AI service computes and
never decides.

### Original plan (for reference)

### Deliverables

1. **Storage abstraction** — local filesystem driver plus S3/MinIO, behind one
   interface. Uploads validated by magic-byte sniffing rather than the
   client-supplied MIME type, which is trivially forged.
2. **Knowledge bases** — a grouping entity, each with its own access
   classification, so a workspace can hold an “HR Policies” base that most
   members cannot read.
3. **Document entity & upload endpoints** — PDF, DOCX and TXT, with a per-file
   status machine (`UPLOADED → PARSING → CHUNKING → EMBEDDING → READY / FAILED`)
   surfaced to the Document Vault screen.
4. **Async ingestion pipeline** — BullMQ queues introduced here rather than in
   phase 4, because parsing and embedding a 200-page PDF cannot happen in a
   request. Brings retry, backoff and a dead-letter queue with it.
5. **Python AI service contract** — a typed HTTP client. The AI service performs
   parsing, chunking and embedding; this backend owns metadata, access control
   and orchestration. Authenticated with the phase 1 API keys.
6. **Qdrant integration** — one collection per workspace (physical isolation at
   the vector layer, which *is* appropriate there), with `organizationId`,
   `knowledgeBaseId` and `classification` written into every point's payload.
7. **Secure retrieval** — the core of module 6.6. Every query carries a
   **mandatory** metadata filter built from the caller's resolved permissions.
   The filter is constructed server-side from the request context and can never
   be supplied or widened by the caller.
8. **Retrieval auditing** — `rag.query.executed` and `rag.access.filtered`
   records, so “which documents did this answer draw on, and what was withheld?”
   is answerable after the fact.

### Why the RBAC filter is the interesting part

The proposal identifies standard RAG systems as blindly fetching from the vector
store. The defect is not the fetch — it is that the fetch is unfiltered. A vector
search returns the *semantically* nearest chunks, with no notion of who is
asking. If an employee asks “what is the CEO's salary?”, a naive pipeline
retrieves the payroll chunk and hands it to the model, which dutifully answers.

The mitigation is to make the authorization filter part of the query itself, not
a post-retrieval check. Filtering after retrieval still loads the data into
process memory and into whatever logs the retrieval path writes.

### Exit criteria

- A document uploaded to a restricted knowledge base is **not** retrievable by a
  member lacking access, verified by an integration test that asserts on the
  vector store's returned payloads, not just on the HTTP response.
- Ingestion survives a worker crash mid-embedding without duplicating chunks.

---

## Phase 3 — Inference, Agents & Privacy · **IMPLEMENTED**

Local LLM inference, the agent abstraction, conversational memory, and the
project's research component.

**Proposal modules:** 6.7 Local LLM Gateway · 6.8 Agent Builder & Persona Engine ·
6.10 Agent Memory & Context · 6.12 PII Redaction Engine

### Delivered

| Area | What was built |
|------|----------------|
| **LLM gateway** | One gateway for every model call, and the privacy boundary: an **egress check** re-scans the exact outgoing payload on every request (known values + context-free recognizers) and refuses with `PII_EGRESS_BLOCKED`, audited CRITICAL. Ollama's native API and any OpenAI-compatible server (vLLM, TGI, hosted open-weight APIs). Model allowlists at three levels (endpoint, platform, workspace); an authoritative model check before any work. Bulkhead with a bounded, cancellable queue; circuit breaker for endpoint faults only; retries **only before the first token**; first-token, idle and total deadlines; output ceiling; `num_ctx` and `keep_alive` always sent; reasoning blocks (`<think>`) removed; a self-calibrating token estimator. A **model trust tier** (`LLM_MAX_CLASSIFICATION`) keeps passages above it out of prompts for a third-party endpoint. |
| **PII Redaction Engine** | Detect → mask → unmask. **Detection** in two layers: validated in-process recognizers (Luhn + issuer, IBAN mod-97, CNIC/SSN ranges, phones incl. `00`/`+` prefixes, emails, IPs, salaries in figures and words, credentials, deny lists) and NER for names through the AI service's `/v1/pii/analyze` or a Presidio analyzer. Unicode canonicalisation defeats full-width and zero-width evasion; Python code-point offsets converted. NER cache keyed by HMAC, holding offsets only. **Masking** in one request-scoped session per prompt: consistent placeholders, partial-name linking, propagation to undetected mentions; the mapping sealed with a per-request AES-256-GCM key and destroyed with the request — never stored. **Unmasking** as tokens stream, never exposing half a placeholder, tolerant of mangled ones, measuring invented placeholders. |
| **Fail-closed policy** | Per-workspace PII policy (types, threshold, allow/deny lists, failure mode): `REFUSE` by default when NER is down, or an explicit `DEGRADE_TO_PATTERNS`; no "send unmasked" mode exists. Every weakening is audited with `weakened: true`. |
| **Agents** | Persona engine (identity, tone, language, grounding, citations) compiled with fixed platform rules: retrieved text is data, placeholders are copied exactly. **Append-only versions** (UPDATE blocked by a trigger), config digests, rollback by appending, prompt-template version recorded with each answer, instructions encrypted. Visibility (draft/published) and role-restricted access. **An agent is a delegate, not a principal**: retrieval runs with the user's access, narrowed by the agent's knowledge bases and classification ceiling — the confused-deputy problem is removed by construction. Editors cannot attach what they cannot read; hidden bases survive their edits. |
| **Conversations & memory** | Token-budgeted context window (answer reserved, margin, mandatory system + question, passages by rank, contiguous newest-first history). **Information-flow labels** on every message (the high-water mark of its inputs), re-checked against current access on every read and prompt inclusion — deleting a document withdraws the answers derived from it. Per-conversation keys with crypto-shredding. Supervisors see masked content; `reveal=true` needs `pii:reveal`, audited CRITICAL. Turn lease against interleaving, idempotent sends, partial answers kept on interruption. |
| **Streaming API** | SSE over POST: JSON errors before the stream opens, `error` events (with status and retry hint) after; `meta` / `status` / `delta` / `done`; heartbeats; `no-transform` and `X-Accel-Buffering: no` so compression and proxies pass it through; client disconnect cancels generation on the GPU. |
| **Measurement** | A content-free usage ledger (`llm_invocations`): outcome, reported or estimated tokens, TTFT, queue time, redaction time split into detection, egress and unmasking; `GET …/llm/usage` with percentiles and the redaction share of total time. A deterministic **benchmark harness** (`npm run benchmark:pii`) over a documented synthetic corpus with obfuscations and decoys. |
| **Cloud & configuration** | All optional at boot with 503s naming missing variables; cross-field validation of timeouts; degraded-never-down health indicators for the model and the NER detector; Phase 3 section in `docs/CLOUD_SETUP.md` (GPU host behind an authenticating proxy, hosted APIs, NER options). |

### Verification status

- `npm run typecheck`, `npm run lint`, `npm run build` — clean
- `npm test` — **583 tests, 25 suites, all passing** (240 new). Covers:
  - the recognizers against look-alikes;
  - masking, linking and propagation;
  - a streaming-unmask fuzz over 300 random chunkings per output;
  - the gateway against a scripted provider (egress block, bulkhead, breaker,
    retry-before-first-token, every deadline, client abort, placeholder
    unmasking across tokens);
  - both provider dialects against scripted HTTP;
  - agent access, versioning, labels, budgeting and prompt escaping;
  - the detection service's cache isolation and failure policy.
- **Against real PostgreSQL 18:** the migration applies, reverts and re-applies;
  the full application boots; the seed creates the demo agents and PII policy.
- **End-to-end (`npm run test:e2e:agents`), real PostgreSQL, in-process
  stand-ins for the model and NER — 18/18.** The main checks:
  - none of 11 sensitive values reach the prompt at the gateway boundary;
  - the answer is unmasked for HR, labelled RESTRICTED and cited;
  - ciphertext at rest, and an audit log with no PII;
  - streaming never splits a placeholder;
  - the confused deputy is refused;
  - an auditor sees content masked, and reveal is audited;
  - NER down gives 503 under `REFUSE` and proceeds under `DEGRADE`;
  - a simulated masking bug is blocked at egress;
  - version restore is verified by digest, and `UPDATE` is blocked by the trigger;
  - deleting a document withdraws derived answers;
  - conversation deletion shreds its key;
  - the audit chain verifies.
- **Live HTTP smoke test** (built server, real HTTP, a mock Ollama speaking
  NDJSON) — 11/11:
  - SSE streams uncompressed and incrementally despite gzip negotiation;
  - an unknown model gets 422 JSON before the stream opens;
  - a missing vector store is an in-stream 503 naming the variables, and the
    model is never called;
  - idempotent sends return 409;
  - a client disconnect aborts the upstream generation and is recorded as
    CANCELLED.
- **Benchmark** ([`docs/benchmarks/pii-redaction.md`](benchmarks/pii-redaction.md)),
  2,000 documents, 15,806 entities:
  - **0 leaks**;
  - micro precision / recall / F1 of 99.58% / 100% / 99.79% on structural
    types;
  - 0 false egress blocks;
  - every document round-trips to the same entities;
  - redaction overhead p50 1.4 ms, p95 12 ms per prompt.

  The harness found and drove fixes for:
  - propagation corrupting years;
  - context-sensitive egress false blocks;
  - phone and ISBN look-alikes;
  - a 5× masking slowdown from per-request Unicode regex compilation.
- **Pending the cloud services:** a real model endpoint, and the AI service
  implementing `/v1/pii/analyze` (then `npm run benchmark:pii -- --ner
  ai-service` measures names).

### Original plan (for reference)

### Deliverables

1. **LLM gateway** — an Ollama client with model allowlisting per workspace,
   parameter validation, token accounting, timeouts and a circuit breaker.
   Streaming responses over SSE, because local inference latency makes anything
   else unusable.
2. **Agent entity & CRUD** — persona, system prompt, model, parameters, attached
   knowledge bases, granted tools, and the RBAC rules the agent operates under.
   Versioned, so changing a production agent's prompt is auditable and reversible.
3. **Conversations & messages** — per user, per agent, with a sliding context
   window and token-budget-aware truncation rather than a fixed message count.
4. **PII Redaction Engine** — the research component. A three-stage pipeline:

   - **Detect** — Microsoft Presidio, with a per-workspace configurable entity
     set.
   - **Mask** — replace each entity with a stable placeholder (`[PERSON_1]`),
     holding the reverse mapping **encrypted** (AES-256-GCM, using the phase 1
     `EncryptionService`) and scoped to the single request.
   - **Unmask** — restore the real values in the response shown to an authorised
     user, so the answer is coherent while the model never saw the originals.

5. **Fail-closed policy** — when redaction fails or is unavailable, the request
   is refused rather than silently sent unmasked. Configurable per workspace,
   defaulting to closed.
6. **`pii:reveal` enforcement** — already in the phase 1 catalogue as the most
   sensitive permission on the platform. Only holders see unmasked values in
   redaction reports.
7. **Benchmarking harness** — the proposal commits to measuring “the exact
   processing time added by the PII Redaction Engine layer”. Instrumented here,
   with per-request timings recorded alongside token counts.

### The critical subtlety

Masking must happen **after** retrieval and **before** the prompt is assembled,
and the mapping must never be persisted beyond the request. A mapping table
sitting in the database is a decrypted PII store with extra steps — it would
recreate exactly the exposure the engine exists to prevent.

### Exit criteria

- ✅ A synthetic HR document containing names, salaries and card numbers produces
  an LLM prompt (captured at the gateway boundary) containing **none** of them —
  proven end to end with 11 values, and enforced in production by the gateway's
  egress check on every request.
- ✅ Measured redaction overhead reported against a documented corpus —
  `docs/benchmarks/pii-redaction.md` (reproducible with `npm run benchmark:pii`),
  plus live per-workspace figures from `GET …/llm/usage`.

### Design decisions worth defending in the report

See [`docs/adr/0003-inference-and-privacy.md`](adr/0003-inference-and-privacy.md).
The short version:

- the gateway is the privacy boundary and re-checks every payload;
- the mapping lives and dies with the request;
- the system fails closed;
- an agent is a delegate, never a principal;
- derived answers carry the labels of what they were derived from.

---

## Phase 4 — Orchestration, Tools & Real-Time · **IMPLEMENTED**

Turning individual agents into collaborating ones.

**Proposal modules:** 6.9 Multi-Agent Workflow Engine · 6.11 Tool Execution
Engine · 6.13 Interactive Workflow Canvas (backend half) · 6.16 Real-Time
Notification & WebSocket Engine

### Delivered

| Area | What was built |
|------|----------------|
| **Workflow definitions** | The React Flow graph as the contract ([`docs/contracts/workflow-graph-v1.md`](contracts/workflow-graph-v1.md)): trigger, agent, tool, retrieval, condition, supervisor, approval and output nodes. Validation is the boundary: an acyclic core plus **explicit, bounded loops** (condition-controlled back edges over single-entry, single-exit regions); references checked against the workspace *and* the editor's own access; templates that only reference ancestors; paths into an agent's JSON output checked against its output schema; passages only into agents; a worst-case step bound; unknown properties dropped. Append-only versions, publish, restore, test runs of drafts, a node catalogue for the canvas palette. |
| **Execution engine** | PostgreSQL is the source of truth; BullMQ only delivers. Each step settles in **one transaction** under the run's row lock — encrypted output, labels, audit record, successors, run completion — so no state exists in which a step finished but its successors were lost. Deterministic step ids; **compare-and-set claims bound to a dispatch number** (stale and replayed jobs are no-ops); heartbeat leases with takeover; a reconciliation sweep (lost jobs, stalled steps, deadlines, expired approvals, stuck runs, retention). Dead-path elimination, AND-joins, error edges, loops, and the **Supervisor pattern** (LLM router with a validated JSON decision, or round robin), each round a persisted step. Resume from failed steps, cancel reaching in-flight model calls, admission control per workspace, idempotent starts. |
| **Queues and the DLQ** | Engine-owned retries (per node: attempts, jittered exponential backoff, timeouts) for transient failures only. Every final failure is dead-lettered as a **typed, metadata-only record** — no free text, no error messages, no ciphertext — with a keyed fingerprint of the input. Poison steps (a worker crash on every attempt) are capped and dead-lettered. |
| **Inter-agent payloads** | Jobs carry **references and a MAC** (HMAC keyed by HKDF of the run's data key), never content: a compromised Redis yields nothing, cannot mint a job, and cannot redirect one to another workspace (rejected, audited CRITICAL). Step inputs and outputs are sealed with AES-256-GCM under a **per-run key** with AAD bound to run, step and field; deletion and retention crypto-shred the run. |
| **Circuit breakers** | The **step ceiling**, checked when steps are scheduled — a runaway loop stops before its next step reaches the queue — and a **per-run token budget** charged after every model call. Both fail the run and are audited `agent.circuit_broken`; per-edge loop limits and supervisor round limits bound each construct on its own. |
| **Tool Execution Engine** | A registry of built-in tools (calculator, current date and time, knowledge search, email to members) and workspace HTTP tools, with **per-agent grants**. Signatures in a strict JSON Schema subset that rejects every keyword it does not enforce. Checks in a fixed order — granted, enabled, permitted as the delegating principal, arguments valid, approval, **information flow** (confidentiality ceiling and an integrity lattice against prompt injection), personal data in arguments, budgets — then a timeout, a result ceiling, and an idempotency claim for side effects. A content-free ledger (`tool_executions`) and audit records for every call, refusals included. |
| **Egress control** | HTTP tools reach only allowlisted hosts (`TOOL_HTTP_ALLOWED_HOSTS`); the origin is fixed at definition, arguments fill path, query and body only (traversal refused). Every resolved address must be public; the connection is pinned to it (no DNS rebinding); the cloud metadata service is refused even in development; redirects are not followed; response and header limits; credentials encrypted and never shown to the model. |
| **ReAct loop** | A text protocol (`<tool_call>` JSON, generation stopped at the closing tag) that works with every model the gateway serves and keeps the privacy boundary intact: calls pass the egress check and the streaming unmasker, results are escaped and masked in the **same** masking session. Bounded iterations, repeat detection, a failure limit, token-bounded results with eliding, a forced final answer. Conversations stream a `tool` event; agents in workflows run the same loop. |
| **WebSocket gateway** | Socket.IO on the API's port ([`docs/contracts/realtime-v1.md`](contracts/realtime-v1.md)). Authenticated at the handshake with the HTTP machinery (token + workspace, or API key; never in the URL), origin-checked, throttled per IP, capped per user, IP-allowlisted. Rooms derived from verified ids only; a second tenant check on every delivery; subscriptions to other people's runs refused and audited. **Metadata-only events** from a Redis Stream (replay after reconnect) and pub/sub (fan-out across API instances), published atomically; no sticky sessions needed. Access re-checked periodically and **immediately on any access change**; revoked sockets are told why and closed. |
| **Traceability** | Every fact of a run is written to the hash-chained audit log as it happens, the step's record inside its settlement transaction; `GET …/workflow-runs/{id}/trace` rebuilds the run — steps, edges, tool calls, approvals — from the audit log alone and reports whether it is complete. Indexed by run. |
| **Human in the loop** | Approval nodes with separation of duties (no self-approval by default), approvers cleared for the label of what they approve, timeouts decided by policy, decisions audited with the settlement. |
| **Cloud & configuration** | Nothing new to provision (Redis/BullMQ, the model gateway and the API port are reused). Every variable validated with cross-field checks (step vs model timeouts, stall vs heartbeat, private networks and plain HTTP refused in production). Degraded-never-down health indicators for the engine and real-time. Seeded demo: a tool-using agent and two published workflows, one of which runs with no model. Phase 4 section in `docs/CLOUD_SETUP.md`; [ADR 0004](adr/0004-orchestration-tools-realtime.md). |

### Verification status

- `npm run typecheck`, `npm run lint`, `npm run build` — clean
- `npm test` — **671 tests, 29 suites, all passing** (88 new). Covers:
  - graph validation (loops, supervisors, references, typed paths, limits);
  - the scheduler (chains, dead paths, joins, error edges, loops and their
    limits, supervisor rounds, idempotent recomputation);
  - templates and conditions, including inherited-property reads;
  - job MACs against every kind of tampering;
  - dead-letter sanitisation and trace reconstruction;
  - failure classification;
  - the schema subset (including a `__proto__` bypass);
  - the tool-call parser and stream filter;
  - the information-flow lattice;
  - SSRF address classification and allowlists;
  - the calculator;
  - HTTP request rendering and traversal;
  - real-time routing and event sanitisation.
- **Against real PostgreSQL 18:** the migration applies, reverts and
  re-applies; the application boots (API with WebSocket and four queue
  workers); the seed is idempotent and creates the demo workflows.
- **End-to-end (`npm run test:e2e:workflows`) — 26/26.** Real PostgreSQL,
  real Redis, real BullMQ workers and Socket.IO; a scripted model. The main
  checks:
  - a three-agent workflow with a tool call and a structured-output repair
    completes, and its trace is rebuilt from 12 audit records alone;
  - the model saw placeholders only;
  - the initiator's socket got 18 metadata-only events, while a colleague and
    another workspace got none, and their subscriptions were refused;
  - after reading an injected web page, the agent could not send email
    (integrity), and the attempt was audited;
  - an outside recipient was refused, and a member was notified live without
    content;
  - SSRF: the metadata address and unlisted hosts were refused, and a redirect
    was not followed;
  - a failing step retried with backoff and was dead-lettered, and **no
    sensitive value exists anywhere in Redis or in any table**;
  - resume re-ran only the failed step; deletion shredded the key and the
    trace survived;
  - a runaway loop was stopped by the step ceiling with the queue empty, and
    the token budget broke the circuit;
  - self-approval was refused, and the administrator's approval was traced;
  - cancel aborted the in-flight model call;
  - crash recovery and poison-step capping;
  - forged and redirected jobs were rejected (CRITICAL), and a replayed job
    was a no-op;
  - a removed member's socket was closed at once;
  - the audit chain verifies.

  The phase 3 suite still passes, 18/18.
- **Live smoke test** (built server, real HTTP and WebSocket) — 29/29: handshake
  auth, validation, publish, input schemas, idempotency, live events, branching
  with dead-path elimination, trace, dead letters, the seeded workflow with no
  model configured, health.
- Verification found and drove fixes for:
  - a boot-order crash (the gateway subscribing before Redis connected);
  - global HTTP interceptors wrapping WebSocket acknowledgements;
  - stale jobs able to claim a retry early;
  - poison steps re-dispatched forever;
  - an approval decision audited outside its transaction;
  - a job with a tampered workspace skipped silently instead of rejected;
  - a `__proto__` schema bypass;
  - template paths reading inherited properties;
  - cloud metadata reachable in development mode;
  - an unindexed trace query.

### Exit criteria

- ✅ A three-agent workflow completes end to end and its full trace is
  reconstructible from the audit log alone — steps, edges, tool calls, agent
  versions and tokens, from 12 records, `complete: true`; it still stands after
  the run is deleted.
- ✅ A deliberately failing step lands in the DLQ with **no** sensitive payload
  recoverable from it — the record is typed metadata, and a scan of every key
  in Redis and every row of every table finds none of the run's sensitive
  values.
- ✅ An infinite-loop workflow is stopped by the step ceiling rather than by
  exhausting the queue — 6/6 steps, circuit breaker audited, queue empty.

### Design decisions worth defending in the report

See [`docs/adr/0004-orchestration-tools-realtime.md`](adr/0004-orchestration-tools-realtime.md).
The short version:

- PostgreSQL decides and the queue only delivers;
- the broker carries references it cannot forge, not content;
- loops are explicit and bounded, and the step ceiling stops them before the
  queue;
- a run acts as its initiator, re-checked every step;
- every tool call is checked, labelled and recorded;
- untrusted content disables side effects (integrity);
- sockets see only what their verified identity entitles them to, and only
  metadata.

### Original plan (for reference)

#### Deliverables

1. **Workflow definition** — the JSON graph the React Flow canvas produces,
   validated server-side: acyclic (or with explicit bounded loops), every node
   referencing an agent or tool the workspace actually owns, and every edge
   type-compatible.
2. **Execution engine** — the Supervisor pattern from the AutoGen reference.
   A supervisor node routes output to the next agent, with per-step persistence
   so a run can be resumed rather than restarted.
3. **Queue infrastructure** — BullMQ (introduced in phase 2) extended with
   per-step retry, exponential backoff, execution timeouts and a **dead-letter
   queue that stores metadata only**, never payloads. The proposal is explicit
   that DLQ debugging must work from metadata alone under Zero-Trust
   constraints, and that constraint is a design input rather than a limitation
   to work around.
4. **Tool Execution Engine** — a registry of executable functions with JSON
   Schema signatures, per-agent grants, sandboxed execution, per-tool timeouts,
   and an egress allowlist for tools that make outbound calls.
5. **ReAct loop** — parse the model's tool-call intent, execute, feed the result
   back, iterate to a bounded depth. Every step audited as `tool.executed` or
   `tool.execution.denied`.
6. **WebSocket gateway** — live execution events to the canvas. Authenticated at
   handshake using the phase 1 token machinery, and **subscription-scoped to the
   workspace**: a socket must never receive another tenant's events.
7. **Encrypted inter-agent payloads** — TLS to Redis (already configurable in
   phase 1 via `REDIS_TLS`) plus application-level encryption of step payloads,
   so a compromised broker yields ciphertext.

#### Exit criteria

- A three-agent workflow completes end to end and its full trace is
  reconstructible from the audit log alone.
- A deliberately failing step lands in the DLQ with **no** sensitive payload
  recoverable from it.
- An infinite-loop workflow is stopped by the step ceiling rather than by
  exhausting the queue.

---

## Phase 5 — Governance, Hardening & Operations

Making it defensible, measurable and operable.

**Proposal modules:** 6.14 Token Throttling & Rate Limiting (completion), plus
hardening across all modules.

### Deliverables

1. **Token quotas** — per workspace, per agent and per member, tracked against
   real consumption from the phase 3 gateway. The `quota:manage` and `usage:read`
   permissions already exist in the catalogue.
2. **Circuit breaking** — agents that loop or overrun their budget are broken
   open and audited as `agent.circuit_broken`. The proposal names runaway agents
   exhausting tokens as a core problem; this is the control that addresses it.
   *Workflow runs already have it (phase 4: the step ceiling and the per-run
   token budget); what remains is conversations and quotas across runs.*
3. **Analytics** — the Command Centre screen: throughput, latency distributions,
   token spend, PII redaction counts, security event feed.
4. **PostgreSQL row-level security** — RLS policies as a third, independent
   tenancy layer beneath the guard and the repository filter. Deferred to this
   phase deliberately: it requires per-request session variables on pooled
   connections, and adding that machinery before the access patterns settled
   would have been premature.
5. **mTLS** — mutual TLS between this backend and the Python AI service, as the
   proposal specifies for internal APIs.
6. **Observability** — OpenTelemetry traces spanning frontend → backend → AI
   service → Ollama, and Prometheus metrics.
7. **MFA (TOTP)** — the `mfaEnabled` / `mfaSecret` columns are already on the
   user entity, unused, for exactly this.
8. **Data lifecycle** — audit retention with the documented deletion escape
   hatch, session pruning, token cleanup, GDPR-style export and erasure.
9. **Breached-password check** — Have I Been Pwned's k-anonymity range API,
   deferred because it is the only outbound network call the platform would
   otherwise make and that deserves an explicit decision.
10. **Deployment** — multi-stage Docker build, compose stack for the full
    system, CI running typecheck/lint/test/build, load testing, and a
    security review pass.

### Exit criteria

- A workspace exceeding its quota is throttled, not crashed.
- Load test at target concurrency with p95 latency recorded.
- No high or critical findings from `npm audit` or the security review.

---

## 2. Work division

The proposal assigns modules per team member. The phases cut across those
assignments, which is normal — phase 1 is shared infrastructure everyone builds
on.

| Member | Proposal responsibility | Primary phases |
|--------|------------------------|----------------|
| **Ameer Abdullah** | Frontend canvas & security access — Auth/IAM, Workspaces, RBAC, Agent Builder UI, Workflow Canvas, WebSockets | Phase 1 (consumes this API), Phase 4 (canvas + sockets) |
| **Ahmad Hanbal** | Core orchestration & backend — Workflow engine, agent memory, tool execution, throttling, audit logging | Phase 1 (audit, throttling), Phase 4 (engine, tools), Phase 5 (quotas) |
| **Mohammad Mehran Chaudhary** | AI brain & data layer — Ingestion, embeddings, secure RAG, LLM gateway, PII redaction | Phase 2 (ingestion, RAG), Phase 3 (gateway, PII) |

The backend delivered in phase 1 is the contract all three depend on: it is what
the frontend authenticates against and what the Python service calls back into.

---

## 3. Risks and how each is handled

| Risk | Impact | Handling |
|------|--------|----------|
| Local LLM latency on available hardware | Phase 3 unusable for demos | SSE streaming, aggressive caching, and a documented fallback to a smaller model. The proposal already lists this as a known constraint. |
| Presidio accuracy on edge cases | Research component under-performs | Report measured recall honestly against a synthetic corpus; fail-closed policy means a miss degrades to refusal, not disclosure. |
| Vector store tenant leakage | Catastrophic — the project's core claim | Collection-per-workspace **and** mandatory payload filters. Two independent layers, plus an integration test asserting on returned payloads. |
| Audit write throughput under load | Slow writes in a busy workspace | Per-workspace advisory lock means tenants never block each other; if it becomes a real bottleneck, batched appends with a periodic chain checkpoint. Measured in phase 5 before optimising. |
| Scope: sixteen modules is a lot | Incomplete submission | Phase ordering is dependency-driven, so an incomplete later phase still leaves a coherent, demonstrable system. Phases 1–3 alone demonstrate the privacy thesis. |

---

## 4. Current status

| Phase | Status |
|-------|--------|
| 1 — Foundation, Identity & Multi-Tenancy | ✅ Implemented; verified against real PostgreSQL during phase 2 |
| 2 — Knowledge Layer & Secure Retrieval | ✅ Implemented; verified end to end against real PostgreSQL. Live runs await the cloud services and the Python AI service (see `docs/CLOUD_SETUP.md`) |
| 3 — Inference, Agents & Privacy | ✅ Implemented; verified end to end against real PostgreSQL and over live HTTP with a mock model endpoint; benchmarked. Live runs await a model endpoint and the AI service's `/v1/pii/analyze` (see `docs/CLOUD_SETUP.md`) |
| 4 — Orchestration, Tools & Real-Time | ✅ Implemented; verified end to end against real PostgreSQL, Redis, BullMQ workers and Socket.IO with a scripted model, and over live HTTP and WebSocket. Live agent runs await the model endpoint of phase 3 (see `docs/CLOUD_SETUP.md`) |
| 5 — Governance, Hardening & Operations | Next |

**One phase remains.** Phase 5 hardens and measures what now exists: token
quotas per workspace, agent and member on top of the per-run budgets of phase
4; metrics and tracing; mTLS between the API and the AI service; load tests of
the engine's settlement path and the audit chain; and the operational
runbooks. Nothing in it changes the privacy, access or orchestration model.