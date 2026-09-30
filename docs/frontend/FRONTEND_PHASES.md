# Frontend Roadmap: Phases and Checklist

**Product:** AgentVault, the Distributed AI Agent Management Platform (FYP, Air University)
**Frontend:** React + TypeScript, a separate repository from this backend
**Backend contract:** this repository (NestJS). Base URL `/api/v1`, Swagger at `/docs`.
**Design reference:** the six mockup screens in `doc/Updated_FYP_Proposal_Distributed_AI_Agents (2).docx`, section 13 (dark "AgentVault" theme).

This file is the plan. Each phase gets its own detailed specification (endpoints,
request and response shapes, screens, flows, acceptance criteria) before work on it
starts. **Phase 1:** [`PHASE_1_FOUNDATION_AUTH_WORKSPACE.md`](PHASE_1_FOUNDATION_AUTH_WORKSPACE.md).
**Phase 2:** [`PHASE_2_WORKSPACE_ADMINISTRATION.md`](PHASE_2_WORKSPACE_ADMINISTRATION.md).
**Phase 3:** [`PHASE_3_KNOWLEDGE_DOCUMENT_VAULT.md`](PHASE_3_KNOWLEDGE_DOCUMENT_VAULT.md).

The backend is complete. The phases are ordered by what depends on what: nothing in a
phase needs a later phase, and every phase ends with something demonstrable.

---

## Summary

| # | Phase | Main screens | Backend endpoints | Needs these backend services configured |
|---|-------|-------------|------------------|---------------------------------------|
| 1 | Foundation, Authentication & Workspace Shell | Sign in / Sign up, MFA, password recovery, email verification, workspace picker / creation, app shell, account settings | 29 | PostgreSQL, Redis |
| 2 | Workspace Administration: Team, Roles & Security | Team, invitations (+ accept page), roles editor, API keys, workspace settings, IP allowlist | 30 | Mail (for invitations) |
| 3 | Knowledge Bases & Document Vault | Document Vault (mockup 5), knowledge bases, access grants, retrieval playground | 19 | Object storage, Qdrant, Python AI service |
| 4 | Agent Builder, Models & Privacy Controls | AI Agents list, Agent Builder (mockup 3), versions, model policy, PII policy + "what the model sees" playground | 21 | LLM endpoint, PII detector |
| 5 | Agent Chat: Conversations & Streaming | Chat with an agent, conversation history, citations and sensitivity labels | 10 | LLM endpoint |
| 6 | Tools & Workflow Canvas (design time) | Tools registry, HTTP tool editor, Workflow list, React Flow canvas (mockup 4), versions and publish | 20 | none new |
| 7 | Workflow Runs, Approvals & Real-Time | Run workflow, run history and detail, live canvas status, approvals inbox, dead letters, trace, notification tray | 12 + WebSocket | Redis (BullMQ workers), realtime enabled |
| 8 | Command Centre, Audit & Governance | Dashboard (mockup 2), Audit & Security Logs (mockup 6), quotas and usage, agent circuit breakers, system health | 21 | none new |
| 9 | Production Readiness & FYP Demo Polish | No new screens: deployment, end-to-end tests, accessibility, performance, demo script | 0 | Everything, deployed |

Endpoint counts are approximate: a few endpoints are reused across phases. The
per-phase specifications list them exactly.

---

## Cross-cutting rules (apply to every phase)

These are set up once in Phase 1 and every later phase depends on them.

- **One envelope.** Every JSON response is either `{ success: true, data, meta }` or
  `{ success: false, error: { code, message, details? }, meta }`. Branch on
  `error.code`, never on `message`. Paginated lists put the pagination in
  `meta.pagination`.
- **Workspace context.** Every workspace-scoped call sends
  `X-Organization-Id: <workspace uuid>`, and the same id goes in the URL path. The
  header wins over the path on the server, so the two must never disagree.
- **Permissions drive the UI.** Hide or disable controls the member cannot use, and
  still handle `403 PERMISSION_DENIED` gracefully. The server is the authority.
- **Tokens.** Keep the access token in memory. The refresh token is an httpOnly
  cookie. Refreshes are single-flight across all tabs, because two concurrent
  refreshes sign the user out everywhere (reuse detection).
- **Hidden means 404.** Resources the user cannot see come back as 404, not 403.
  Render these as "not found", never "access denied".
- **Show `meta.requestId`** (the `X-Request-Id` header) on every error message, so a
  bug report can be traced to the server log.

---

## Phase 1: Foundation, Authentication & Workspace Shell

**Goal:** a person can create an account, sign in (including two-step verification),
recover their password, verify their email, create or pick a workspace and land in a
permission-aware app shell. They can also manage their own profile, security and
personal data.

- [ ] Project scaffold (Vite, React, TypeScript, router, TanStack Query, Tailwind +
      component kit), dark AgentVault theme tokens, environment config, dev proxy
- [ ] API client: envelope parsing, typed `ApiError`, `X-Organization-Id`,
      request id surfacing, 429 / `Retry-After` handling, timeouts
- [ ] Token manager: in-memory access token, cookie refresh, single-flight +
      cross-tab lock, 401 → refresh → retry once, broadcast sign-out
- [ ] Sign in (+ MFA challenge step, account lockout), Sign up, Forgot password,
      Reset password, Verify email (+ resend)
- [ ] App boot / session restore; route guards (public, authenticated, workspace)
- [ ] Workspace picker, create workspace (onboarding), workspace switcher, last-used
      workspace
- [ ] App shell (sidebar, top bar, user menu) with permission-gated navigation and
      placeholder pages for Phases 2–8
- [ ] Workspace access error pages (not found, suspended, membership suspended, IP
      not allowed, MFA required, email not verified)
- [ ] Account → Profile; Security (change password, two-step verification
      setup/disable/recovery codes, devices/sessions, sign out everywhere); Privacy
      (download my data, erase account)

**Endpoints:** `auth/*` (20), `auth/me/export`, `DELETE auth/me`, `GET/POST
organizations`, `GET organizations/:id`, `GET organizations/:id/members/me`,
`GET permissions`,
`GET /health/live`.

---

## Phase 2: Workspace Administration (Team, Roles, Invitations, Security)

**Goal:** workspace owners and admins run their workspace: invite people, assign
roles, build custom roles (such as "HR Manager"), issue API keys and lock the
workspace down.

**Detailed spec:** [`PHASE_2_WORKSPACE_ADMINISTRATION.md`](PHASE_2_WORKSPACE_ADMINISTRATION.md).

- [ ] Workspace settings: name, description, logo URL; audit retention; document
      chunking defaults; require MFA (needs `security:update` and an MFA-verified
      session); require a verified email; allowed email domains
- [ ] Danger zone: transfer ownership, delete workspace (owner only)
- [ ] Team directory: search, filter by status (including removed) and role,
      pagination, last active; member detail
- [ ] Member actions: replace roles, suspend / reactivate, remove, edit workspace
      profile (display name, title), leave workspace. The UI must respect role
      priority: you cannot act on members who rank at or above you.
- [ ] Invitations: invite by email + role + message, list by status, resend, revoke
- [ ] **Invitation landing page `/invitations/accept?token=`** (the backend emails
      this exact route): preview → sign in or register as the invited address →
      accept → enter the workspace
- [ ] Roles & permissions: list, role detail, create / edit custom roles with the
      permission catalogue grouped by category (dangerous permissions flagged),
      priority, colour; delete; "recompute" repair action
- [ ] API keys: list, create (scopes from `api-keys/scopes`, expiry, optional IP
      pinning), **show the secret once**, revoke
- [ ] Security: IP allowlist rules (CIDR, IPv4/IPv6, last matched), enable/disable
      enforcement (refused with no active rules, or when it would lock you out)

**Endpoints:** `PATCH/DELETE organizations/:id`, `…/transfer-ownership`,
`…/ip-rules` (GET/POST/DELETE), `…/ip-enforcement`; `…/members` (list, get, roles,
patch, suspend, reactivate, remove, leave); `…/invitations` (list, create, resend,
revoke), `invitations/preview`, `invitations/accept`; `…/roles` (get, create, update,
delete, recompute); `…/api-keys` (scopes, list, create, revoke).

**Watch out:** error codes `CANNOT_ESCALATE_PRIVILEGES`, `CANNOT_MODIFY_SELF`,
`CANNOT_REMOVE_LAST_OWNER`, `ROLE_IMMUTABLE`, `ROLE_IN_USE`, `SEAT_LIMIT_REACHED`,
`MEMBERSHIP_SUSPENDED`, `IP_ALLOWLIST_SELF_LOCKOUT`, `INVITATION_*`. Saving
`settings` is a partial update: send only what changed.

---

## Phase 3: Knowledge Bases & Document Vault (Secure RAG)

**Goal:** upload enterprise documents into access-controlled knowledge bases, watch
them go through the ingestion pipeline, inspect their chunks and PII report, and
query them securely. This is mockup screen 5.

**Detailed spec:** [`PHASE_3_KNOWLEDGE_DOCUMENT_VAULT.md`](PHASE_3_KNOWLEDGE_DOCUMENT_VAULT.md).
Build it against `npm run start:standins` (in-memory storage, vector store and AI
service) until the real knowledge layer is deployed.

- [ ] Knowledge bases: list (sidebar with document counts), create/edit (access
      mode `WORKSPACE` / `RESTRICTED`, default classification, inherited chunking),
      delete (type the name)
- [ ] Access grants on restricted knowledge bases: role / member (membership id) /
      API key with `READ` / `WRITE` / `MANAGE`, with a self-lockout warning
- [ ] Document Vault table: filter by knowledge base, status (Indexing =
      `PARSING,CHUNKING,EMBEDDING`) and classification; title search and an "Ask"
      mode backed by retrieval; sort; pagination; bulk actions
- [ ] Upload: drag and drop, client-side pre-checks, one file per request (3 in
      parallel) with an XHR progress bar, classification always sent, per-file error
      messages (`DOCUMENT_DUPLICATE`, `DOCUMENT_TYPE_NOT_ALLOWED`,
      `DOCUMENT_CONTENT_MISMATCH`, `STORAGE_QUOTA_EXCEEDED`, …)
- [ ] Pipeline status: `UPLOADED → PARSING → CHUNKING → EMBEDDING → READY | FAILED`
      (poll while any document is in progress; retries visible in `statusMessage`;
      a reindex keeps the previous version searchable), pipeline status panel
- [ ] Document detail: metadata, processing timings, chunks, edit and reclassify,
      reindex / retry, download (filename from `filename*`), delete (irreversible:
      crypto-shredded)
- [ ] PII redaction report per document (placeholders, per-page counts, degraded
      banner; `pii:reveal` to unmask, audited)
- [ ] Retrieval playground: query → passages with sources, relative scores and
      timings; "my access scope" panel
- [ ] Graceful `503 KNOWLEDGE_LAYER_NOT_CONFIGURED` / `OBJECT_STORAGE_UNAVAILABLE` /
      `AI_SERVICE_UNAVAILABLE` / `VECTOR_STORE_UNAVAILABLE` /
      `PII_DETECTION_UNAVAILABLE` states

**Endpoints (E60–E78, 19):** `…/knowledge-bases` (8, including grants),
`…/documents` (8, including upload), `…/rag/query`, `…/rag/access-scope`,
`…/pii/documents/:id/report`.

**Watch out:** hidden knowledge bases and documents above your clearance return 404
and are left out of lists and counts. The Administrator role does not bypass restricted
knowledge bases; only the owner does. Uploads are limited to 50 MB, 120 s including the
transfer, and 100 per hour.

---

## Phase 4: Agent Builder, Models & Privacy Controls

**Goal:** build and version "digital employees", choose which models the workspace
may use, and configure and demonstrate the PII Redaction Engine (the research
component). This is mockup screen 3.

- [ ] AI Agents list (visibility `PRIVATE` = draft / `WORKSPACE` = published, model,
      knowledge bases)
- [ ] Agent Builder tabs: Persona & Model (identity, tone, language, instructions,
      model, temperature, max tokens), Knowledge Base (attach bases you can read),
      Tool Access (grant tools; read-only list from `…/tools`), RBAC & Access
      (visibility, allowed roles, classification ceiling)
- [ ] Save with optimistic concurrency (`AGENT_VERSION_CONFLICT` → reload and
      reapply); publish / unpublish; delete
- [ ] Version history, view a version, restore (appends a new version)
- [ ] Prompt preview ("what the model will receive", masked)
- [ ] Models: list available models; workspace model policy (allowlist, default)
- [ ] Privacy: PII policy (entity types, threshold, allow/deny lists, failure mode
      `REFUSE` / `DEGRADE_TO_PATTERNS`), entity type catalogue
- [ ] PII analyze playground: paste text → highlighted entities → masked text with
      placeholders (mockup's "PII Redaction Preview")
- [ ] Optional: direct model playground (`llm/chat`, `llm/chat/stream`)

**Endpoints:** `…/agents` (11), `…/llm/models`, `…/llm/policy` (GET/PUT),
`…/llm/chat`, `…/llm/chat/stream`, `…/pii/policy` (GET/PUT), `…/pii/entity-types`,
`…/pii/analyze`, `GET …/tools`.

**Watch out:** `LLM_NOT_CONFIGURED`, `LLM_MODEL_NOT_ALLOWED`,
`PII_DETECTION_UNAVAILABLE` (fail-closed), `CLASSIFICATION_EXCEEDS_CLEARANCE`.

---

## Phase 5: Agent Chat (Conversations & Streaming)

**Goal:** talk to agents with streamed answers that show citations and the
sensitivity of what they were derived from.

- [ ] Conversation list (per agent), create, rename, archive / unarchive, delete
- [ ] Chat view: history with paging, message labels (classification), citations to
      source documents, tool-call indicators
- [ ] **Streaming over SSE via `POST …/messages/stream`.** This must use `fetch` with
      a `ReadableStream` parser, because `EventSource` cannot POST. Events: `meta`,
      `status`, `delta`, `tool`, `done`, `error`. Heartbeats. Stop button aborts the
      request, which cancels generation on the server.
- [ ] Idempotent sends (client message id); handle `CONVERSATION_BUSY`,
      `MESSAGE_DUPLICATE`
- [ ] Error states inside the stream (`error` event with retry hint) and before it
      (JSON envelope): `LLM_BUSY`, `LLM_TIMEOUT`, `PII_EGRESS_BLOCKED`,
      `AGENT_CIRCUIT_OPEN`, `CONVERSATION_TOKEN_BUDGET_EXCEEDED`, `QUOTA_EXCEEDED`,
      `TOKEN_RATE_LIMITED`
- [ ] "My quota" indicator (`GET …/quotas/me`)
- [ ] Supervisors with `conversation:read_all`: masked view; reveal requires
      `pii:reveal` and is audited

**Endpoints:** `…/conversations` (8), `…/quotas/me`,
`…/circuits/agents/:agentId`.

---

## Phase 6: Tools & Workflow Canvas (design time)

**Goal:** register tools and visually compose multi-agent workflows on a React Flow
canvas, then validate, version and publish them. This is mockup screen 4, editing
only.

- [ ] Tools registry: built-in and HTTP tools, enable/disable, create/edit HTTP tools
      (JSON-schema arguments in the supported subset, allowlisted hosts only,
      credentials write-only), test a tool, tool execution ledger
- [ ] Workflow list: status `DRAFT` / `ACTIVE` (published) / `ARCHIVED`
- [ ] Canvas: node palette from `…/workflows/node-types` (trigger, agent, tool,
      retrieval, condition, supervisor, approval, output), handles, edges, bounded
      loops, node property panel (retries, timeout, templates)
- [ ] Serialise exactly per `docs/contracts/workflow-graph-v1.md`; server-side
      validate (`…/workflows/validate`) with errors pinned to nodes and edges
- [ ] Save definition (optimistic concurrency, `WORKFLOW_VERSION_CONFLICT`),
      versions, restore, publish, archive, delete

**Endpoints:** `…/tools` (7), `…/workflows` (13, everything except starting a run).

---

## Phase 7: Workflow Runs, Approvals & Real-Time Events

**Goal:** run workflows and watch them execute live, approve human-in-the-loop
steps, and debug failures from metadata alone.

- [ ] Run workflow: input form generated from the trigger's input schema; idempotent
      start
- [ ] Run history (per workflow and workspace) and run detail: status, steps,
      tokens, output (`…/content`), step content, cancel, resume (from failed
      steps), delete
- [ ] **Socket.IO client** (path `/realtime`, `auth: { token, organizationId }`):
      `ready`, `event`, `notification`, subscribe to a run, `resume` with
      `lastEventId` after reconnect, `auth:refresh` before expiry, `auth:expired` /
      `auth:revoked` handling. See `docs/contracts/realtime-v1.md`.
- [ ] Live canvas: node status colours driven by `step.*` / `tool.*` events
- [ ] Approvals inbox (`workflow:approve`): approve / reject with separation of
      duties (`WORKFLOW_SELF_APPROVAL_FORBIDDEN`)
- [ ] Dead-letter viewer (typed, metadata-only records)
- [ ] Trace view rebuilt from the audit log (`…/trace`, needs `audit:read`)
- [ ] Notification tray (bell icon) fed by `notification` events

**Endpoints:** `POST …/workflows/:id/runs`, `…/workflow-runs` (11), WebSocket.

---

## Phase 8: Command Centre, Audit & Governance

**Goal:** the landing dashboard and the compliance and governance screens (mockups 2
and 6).

- [ ] Command Centre dashboard: KPI tiles (active agents, tasks, PII redactions,
      token usage), time series (7D/30D/90D), top agents / members, security event
      feed, system status pill from `/health`
- [ ] Audit & Security Logs: filterable list, detail drawer, statistics tiles,
      **verify hash chain** (shows the exact broken sequence if any), export NDJSON,
      archives
- [ ] Token quotas: list, create/edit/delete (workspace / agent / member), history,
      platform-managed quotas read-only (`QUOTA_MANAGED_BY_PLATFORM`)
- [ ] Agent circuit breakers: open circuits, reset
- [ ] LLM usage: latency percentiles, token spend, redaction overhead share

**Endpoints:** `…/analytics/*` (4), `…/audit-logs/*` (6), `…/quotas*` +
`…/circuits*` (9), `…/llm/usage`, `/health`.

---

## Phase 9: Production Readiness & FYP Demo Polish

- [ ] Production deployment: the frontend and API served **same-site** (reverse
      proxy / rewrites for `/api`), or the backend's cookie settings changed for
      cross-site use (`COOKIE_SAME_SITE=none`, `COOKIE_SECURE=true`). WebSocket
      proxying for `/realtime`. `FRONTEND_URL` / `CORS_ORIGINS` set on the backend.
- [ ] End-to-end tests of the critical journeys (Playwright): sign-up → workspace →
      upload → agent → chat → workflow run → audit verify
- [ ] Error-state audit: every `ErrorCode` a screen can receive has a designed state
- [ ] Accessibility pass (keyboard, focus, contrast in the dark theme), responsive
      layout down to tablet
- [ ] Performance: code-split routes (the canvas and charts are heavy), query
      caching, bundle budget
- [ ] Demo script and seeded demo workspace (`SEED_DEMO_DATA=true`: `acme-corp`,
      five demo accounts, agents, workflows)

---

## Backend issues found while writing the specifications

Eighteen backend issues surfaced while preparing the phase specifications. **All were
fixed in the backend on 2026-09-30** and re-verified against a running server; the
phase specifications describe the fixed behaviour. Details: Phase 1 specification
section 14 (BF-1…BF-5), Phase 2 specification section 10 (BF-6…BF-12), Phase 3
specification section 11 (BF-13…BF-18).

| # | Was | Fixed behaviour |
|---|-----|-----------------|
| BF-1 | `GET /auth/me` never returned `permissions` / `activeOrganizationId` | Returned when `X-Organization-Id` is sent |
| BF-2 | Every rate-limit bucket was per IP; refresh and the account actions shared 10 requests / 15 min per IP | Signed-in calls count per user; refresh has its own policy (60 / 15 min per session) |
| BF-3 | A refresh in the same second as `change-password` returned an already-revoked token | Revocation is millisecond-precise: refresh immediately |
| BF-4 | Some validation errors were keyed by the message's first word (`"Password"`, `"a"`, `"each"`) | Always keyed by the property path |
| BF-5 | `GET /auth/me` omitted `mfaEnabled` and `avatarUrl` | Both returned |
| BF-6 | **Security.** Saving workspace `settings` replaced the whole object (turning off `requireMfa`) | Partial update; `null` clears one setting |
| BF-7 | Editing another member's profile checked rank only | Also requires `member:update` |
| BF-8 | Re-inviting a suspended member (or their acceptance) reactivated them | Refused with `409 MEMBERSHIP_SUSPENDED` |
| BF-9 | Invitation preview without a token returned 500 | `422 VALIDATION_FAILED` |
| BF-10 | Resending an invitation the sweep had marked `EXPIRED` failed; expiry at acceptance was not saved | Resend revives it; preview and accept mark expiry |
| BF-11 | **Security.** IP enforcement could lock out everyone, including the admin enabling it | Refused with `409 IP_ALLOWLIST_SELF_LOCKOUT` |
| BF-12 | Chunking defaults and `requireVerifiedEmail` were not applied; `lastMatchedAt` / `lastActiveAt` never written; `REMOVED` filter empty | All applied or recorded |
| BF-13 | `null` for a knowledge base's name, access mode or default classification failed in the database with a field-less `422`; `""` descriptions were stored | Field-keyed `422`; `""`/`null` clears the description; `null` chunk settings inherit |
| BF-14 | `PATCH` document with `classification: null` returned **500**; `title`/`tags: null` a field-less `422` | Field-keyed `422` |
| BF-15 | A knowledge base's chunk overlap was validated against the platform size, not the effective one, then silently shrunk at ingestion | Validated against knowledge base → workspace → platform; field-keyed `422` |
| BF-16 | Knowledge-base list ignored `sortDirection` for `sortBy=name` | Honoured |
| BF-17 | Over-long retrieval query: `422` without a field | `details.fields.query` |
| BF-18 | Document list filtered by one status only | `status` accepts a comma-separated list |
