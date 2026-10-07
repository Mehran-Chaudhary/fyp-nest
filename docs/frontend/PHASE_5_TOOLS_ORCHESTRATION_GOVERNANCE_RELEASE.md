# Phase 5 — Tools, Workflow Orchestration, Governance & Release

**Frontend implementation handoff · revision 1 · 7 October 2026**

**Product:** AgentVault / Distributed AI Agent Management Platform
**Backend baseline:** `69a9ba9` plus the fixes recorded in [P5-G01–P5-G06](#13-backend-constraints-and-release-decisions) (in the working tree, not yet committed)
**Phase:** 5 of exactly 5 — the final phase
**Status:** specification ready and every operation proven against a live backend with real queues, real model calls, real outbound HTTP and real email; frontend implementation and browser acceptance not yet verified.

**Read with:** [Master roadmap/checklist](FRONTEND_PHASES.md), [Phase 1](PHASE_1_FOUNDATION_AUTH_WORKSPACE.md), [Phase 2](PHASE_2_WORKSPACE_ADMINISTRATION.md), [Phase 3](PHASE_3_KNOWLEDGE_DOCUMENT_VAULT_PRIVACY.md), [Phase 4](PHASE_4_AGENTS_MODELS_CONVERSATIONAL_AI.md), the [Phase 5 live verification report](PHASE_5_LIVE_VERIFICATION.md), and the backend contracts it supersedes for the frontend: [workflow graph v1](../contracts/workflow-graph-v1.md) and [real-time v1](../contracts/realtime-v1.md).

> The owner requested this handoff. It authorizes Phase 5 work; it does not establish that unobserved Phase 1–4 browser tests passed. Reuse the Phase 1 HTTP adapter, session refresh, workspace isolation and error handling; the Phase 2 role and member screens; the Phase 3 knowledge pickers; and the Phase 4 agent picker, usage view and governance error handling. All 53 Phase 5 HTTP operations and the Socket.IO channel are specified here. Phase 5 ends with the release gate (section 14): nothing is "done" until the whole product is demonstrated end to end.

## Contents

1. [Delivery outcome and evidence](#1-delivery-outcome-and-evidence)
2. [Shared integration contract](#2-shared-integration-contract)
3. [The access model](#3-the-access-model)
4. [Concepts the screens depend on](#4-concepts-the-screens-depend-on)
5. [Screens and workflows](#5-screens-and-workflows)
6. [Validation and wire models](#6-validation-and-wire-models)
7. [Complete endpoint register](#7-complete-endpoint-register)
8. [Detailed endpoint contracts](#8-detailed-endpoint-contracts)
9. [State, cache, real-time and concurrency](#9-state-cache-real-time-and-concurrency)
10. [Errors and recovery](#10-errors-and-recovery)
11. [Implementation sequence](#11-implementation-sequence)
12. [Acceptance checklist and demonstration](#12-acceptance-checklist-and-demonstration)
13. [Backend constraints and release decisions](#13-backend-constraints-and-release-decisions)
14. [Release, deployment and the final demonstration](#14-release-deployment-and-the-final-demonstration)
15. [Source map and delivery record](#15-source-map-and-delivery-record)
16. [Appendix A — TypeScript helpers](#appendix-a--typescript-helpers)

## 1. Delivery outcome and evidence

Deliver the orchestration and governance half of the product, then release the whole of it. Administrators define **tools** — built-in ones and HTTP integrations locked down by data policy — and test them. Builders draw **workflows** on a canvas (agents, tools, retrieval, conditions, loops, supervisor teams, human approvals), validate, version and publish them. Members **run** them and watch each step live over Socket.IO; approvers decide the steps that wait for a person. Supervisors inspect runs with personal data masked, read the tamper-evident **trace**, and recover failed runs. Compliance staff search, verify and export the **audit** log. The Command Centre shows **analytics**; administrators set token **quotas** and reset agent **circuit breakers**. Every person can download **their own data** or **erase their account**. A canvas that draws boxes is not completion: every control follows the access rules in section 3, every run state in section 4.3 is rendered honestly, and live views reconcile with REST after any gap (section 9.3).

| Area | Operations | Required outcome |
|---|---:|---|
| Tools | 7 (01–07) | Catalogue with built-ins and HTTP tools, create, read, edit (versioned), delete, test with real execution, the content-free tool ledger |
| Workflow definitions | 13 (08–20) | Directory, node palette, live validation, create, read, rename, save canvas (versioned), history, version detail, restore, publish, archive, delete |
| Runs | 12 (21–32) | Start (with idempotency and test runs), lists (mine/everyone), run detail with steps, run and step content (labels, masking, reveal), audit-derived trace, cancel, resume, approval queue and decisions, dead letters, delete |
| Audit | 6 (33–38) | Search with filters, statistics, chain verification, NDJSON export, retention archives and their download |
| Analytics | 4 (39–42) | Overview, time series, top rankings, security event feed |
| Quotas and circuits | 9 (43–51) | Workspace quotas with live consumption, my quotas, create/update/delete, history; open circuits, one agent's breaker, reset |
| Personal data | 2 (52–53) | Download my data (a JSON file), erase my account |
| **HTTP total** | **53** | All covered by register, contracts and acceptance |
| Real-time | Socket.IO | Authenticated socket per workspace, automatic rooms, run subscriptions with replay, notifications, in-place token refresh, revocation |
| Release | — | Production configuration, deployment readiness, the end-to-end FYP demonstration (section 14) |

### Verification honesty

- Controllers, DTOs, services, guards, the workflow engine, the step executor, the tool executor, the event bus, the socket gateway, the governor and the lifecycle services were read against `69a9ba9`.
- On **7 October 2026 (Asia/Karachi)** an owner-requested live run exercised **all 53 operations and the Socket.IO channel** with real HTTP requests and real sockets. Result: **783 checks, 783 passed** — see the [report](PHASE_5_LIVE_VERIFICATION.md) and [machine-readable results](PHASE_5_LIVE_RESULTS.json).
- The run used a **dedicated instance** of the same build on `http://localhost:3100`, against the same cloud stack as the development backend (Supabase PostgreSQL with row-level security, Aiven Valkey queues and pub/sub, Cloudflare R2, Qdrant Cloud, the project's AI service, Groq `qwen/qwen3.8-27b`, Ethereal mail). Its only configuration differences are listed in the report: an HTTP-tool egress allowlist (`postman-echo.com`, `httpbin.org`; the development `.env` has none, P5-G20), its own Redis key and queue prefixes so it never shares jobs or events with the development server, a smaller database pool, a 15 s maintenance sweep (so approval and run timeouts resolve in minutes) and a tighter agent-circuit window (so one large turn opens a breaker).
- Members joined through the **real invitation flow** (emails read from the Ethereal inbox over IMAP); one member verified their email through the real Phase 1 link; MFA was enrolled with real TOTP codes. Tools made **real outbound HTTPS calls**; `send_email` delivered a **real email**; agent steps made **real model calls**. No database rows were written directly.
- Model output is non-deterministic, so content-dependent observations are recorded separately under `facts.modelObservations` and never counted. Every contract property (shapes, statuses, stored state, labels, masking, events) is a counted check.
- Everything marked *source* was read from code but not produced live. Section 13 lists what remains unverified.
- **Six backend defects were found and fixed** with regression tests (P5-G01–P5-G06). One of them (P5-G06) silently stopped all live Socket.IO events a few minutes after the server went quiet; read it before building the real-time layer.

## 2. Shared integration contract

### Addresses and request modes

Product API base: `http://localhost:3000/api/v1`. Socket.IO: same origin, **path `/realtime`** (not under `/api/v1`). Frontend local origin: `http://localhost:5173`. Operations 01–51 are workspace-scoped; 52–53 are account-scoped (no workspace header).

```http
Authorization: Bearer <in-memory-access-token>
Accept: application/json
X-Organization-Id: <same-canonical-workspace-uuid-as-the-path>   (01–51 only)
```

As in Phases 3–4, the **header wins** over the path when they disagree. Build both from one captured workspace ID.

| Mode | Used by | Notes |
|---|---|---|
| JSON | 50 operations | `Content-Type: application/json`; unknown properties are rejected with 422 (except inside a workflow `graph`, where they are dropped, section 4.2) |
| NDJSON download | Audit export (36), archive download (38) | `200 application/x-ndjson`, `Content-Disposition: attachment; filename="audit-log.ndjson"`. Fetch with the bearer header and save the blob; a browser navigation cannot send the header. A refusal is an ordinary JSON envelope (P5-G05) |
| JSON file download | Personal-data export (52) | `200 application/json`, **no envelope**, `Content-Disposition: attachment; filename="personal-data-YYYY-MM-DD.json"`, `Cache-Control: no-store` |
| Socket.IO 4 | Real-time (section 4.6) | `socket.io-client` 4.x, `path: '/realtime'`, `transports: ['websocket']`, credentials in the handshake `auth` payload |

`Content-Disposition` and `x-request-id` are exposed through CORS, so the download filename and the request ID are readable from `fetch`. Use Appendix A `readDownload`, which branches on the status, never on the content type.

### Time budgets

| Operations | Server budget | Client guidance |
|---|---|---|
| Tool test (07) | the tool's `timeoutMs` (default 15 s, at most `TOOL_MAX_TIMEOUT` 60 s) plus the request | 75 s |
| Start a run (21) | returns at once (**202**); the run executes in the background | 30 s; then watch over the socket or poll |
| Validate (10), save canvas (14), publish (18) | reference checks against agents, tools and knowledge bases | 30 s |
| Audit verify (35), export (36), personal export (52) | proportional to the log / your data | 120 s; show progress as indeterminate |
| Everything else | 30 s | The Phase 1 default |

A run itself is bounded by `WORKFLOW_RUN_TIMEOUT` (30 min default, lowered per workflow by `settings.runTimeoutMs`), each step by `WORKFLOW_STEP_TIMEOUT` (10 min) and each approval by its node's `timeoutMs` (default `WORKFLOW_APPROVAL_TIMEOUT`, 24 h).

### Envelope and pagination

Same envelope as Phases 1–4. `meta.pagination` (`page`, `limit`, `totalItems`, `totalPages`, `hasPreviousPage`, `hasNextPage`) on: tools (01), ledger (03), workflows (08), versions (15), runs (22), dead letters (31), audit search (33). **Unpaginated arrays:** approvals (29, at most 100 oldest first), archives (37), top (41), security events (42, cursor `before`), quotas (43, 44), history (48), circuits (49). Wrapped object: node types (09) `data.nodeTypes`. Downloads (36, 38, 52) are not enveloped on success.

### Rate policies and limits

| Limit | Default | Applies to | Refusal |
|---|---|---|---|
| default | 120 requests / 60 s per user | everything not listed | 429 `RATE_LIMIT_EXCEEDED` |
| workflow | **30 run starts / 60 s per user** | 21 | 429 `RATE_LIMIT_EXCEEDED` |
| Active runs per workspace | **20** (`WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG`) queued, running or waiting | 21 | 429 `WORKFLOW_CONCURRENCY_LIMIT`, `Retry-After: 30`, `details {active, limit}` |
| email | **5 / hour per user** | personal-data export (52) | 429 `RATE_LIMIT_EXCEEDED` |
| auth | 10 / 15 min | account erasure (53) | 429 `RATE_LIMIT_EXCEEDED` |
| Token budgets and rates | section 4.7 | every model call, in conversations and in runs | 429 `QUOTA_EXCEEDED` / `TOKEN_RATE_LIMITED` |
| Socket handshakes | 60 / minute per IP | connecting | `connect_error` `RATE_LIMIT_EXCEEDED` |
| Sockets per person or key | 10 | connecting | `connect_error` `REALTIME_CONNECTION_LIMIT` |
| Socket messages | 30 / 10 s per socket | subscribe, resume, refresh… | `error {code: RATE_LIMIT_EXCEEDED}`, then the socket is closed |

Every HTTP refusal carries `Retry-After`; read it rather than hard-coding numbers.

### Common handling

- DTO failures: **422 `VALIDATION_FAILED`** with `details.fields` keyed by property path (`settings.runTimeoutMs`, `http.query`, `dataPolicy.maxClassification`). Malformed path UUIDs on workflow, run, step, quota and circuit routes: **400 `BAD_REQUEST`**; malformed tool ids are **404 `TOOL_NOT_FOUND`** (no pipe on that route).
- **`null` is accepted only where this document says it clears something** (workflow `description`, tool `secret`, quota `label`). Anywhere else it is **422** naming the field (P5-G02). To leave a field unchanged, omit it.
- Switch on `error.code` and status; `error.message` is display text. Unknown codes get a generic fallback.
- Pessimistic updates everywhere: tools and workflows carry `version`/`expectedVersion`, and the server is the source of truth for run state. The canvas keeps its own unsaved state (section 9.2).
- 403 is not a refresh signal. **401 `AUTH_PASSWORD_MISMATCH` and `MFA_CODE_INVALID` on erasure (53) are not session expiry**: keep the session, show a field error.

### Shared dependencies from Phases 1–4

| Dependency | Why |
|---|---|
| Contextual `GET /auth/me` | `permissions` drive every control (section 3); `id` recognises your own runs |
| `GET /organizations/:id/members` (member:read) | resolve `initiatorUserId`, `decidedById`, quota `subjectId` (MEMBER) and audit actors to names |
| `GET /organizations/:id/agents` (agent:read) | the agent picker on agent and supervisor nodes; resolve `agentId` in steps, analytics and circuits ("Deleted agent" when unknown) |
| `GET /organizations/:id/knowledge-bases` (knowledgebase:read) | the base picker on retrieval nodes |
| `GET /organizations/:id/api-keys` (apikey:read) | resolve `initiatorApiKeyId` and API_KEY quota subjects |
| `GET /organizations/:id/llm/usage` (usage:read) | the analytics overview's `inference` section has the same shape (Phase 4 `UsageSummary`) |
| `PUT /organizations/:id/members/:memberId/roles` | not used by Phase 5 screens, but changing roles changes live socket rooms and stops runs (sections 4.3, 4.6) |

A missing secondary permission disables only the dependent control ("Choosing agents needs agent:read"); it must not break the canvas.

## 3. The access model

### 3.1 Route permissions

The route permission is checked before anything is looked up: a missing permission is **403 `PERMISSION_DENIED`** with `details.missingPermissions`. "Keys" marks routes that also accept an API key (machine clients; irrelevant to the browser but they appear as run and quota owners).

| Action | Permission | Keys |
|---|---|---|
| List/read tools | `tool:read` | yes |
| Define a tool | `tool:create` | no |
| Edit a tool | `tool:update` | no |
| Delete a tool | `tool:delete` | no |
| **Test** a tool | `tool:update` **and** `tool:execute` | no |
| The tool ledger | `tool:read` **and** `usage:read` | yes |
| List/read workflows, node types, versions | `workflow:read` | yes |
| Validate a graph | **any one of** `workflow:create`, `workflow:update` | no |
| Create a workflow | `workflow:create` | no |
| Rename, save canvas, restore | `workflow:update` | no |
| Publish, archive | `workflow:publish` | no |
| Delete a workflow | `workflow:delete` | no |
| Start a run | `workflow:execute` (+ `workflow:update` to run an unpublished version) | yes |
| Read runs, content, steps | `workflow:read` (own runs) — `workflow:read_all` for everyone's | yes |
| Reveal personal data in run content | `pii:reveal` (even for your own run, P5-G11) | yes |
| Cancel / resume | `workflow:execute` (checked first, for everyone); someone else's run also needs `workflow:update` and visibility | yes |
| Delete a finished run | `workflow:read`; your own, or anyone's with `workflow:delete` | yes |
| Approval queue, decide | `workflow:approve` (+ clearance for the step's label, + not your own run) | no |
| Dead letters | `workflow:update` | no |
| Run trace | `workflow:read` **and** `audit:read` | no |
| Audit search, statistics, archives list | `audit:read` | no |
| Verify the chain | `audit:verify` | no |
| Export, archive download | `audit:export` | no |
| Analytics overview, time series, top agents/models | `usage:read` | yes |
| Top members / API keys | `usage:read` **and** `quota:manage` | yes |
| Security feed | **any one of** `audit:read`, `security:read` | no |
| List quotas, history | **any one of** `usage:read`, `quota:manage` | no |
| My quotas | **any one of** `usage:read`, `llm:invoke`, `agent:execute` | yes |
| Create/update/delete quotas | `quota:manage` | no |
| Circuits list, one agent | **any one of** `usage:read`, `quota:manage`, `agent:read` | no |
| Reset a circuit | **any one of** `quota:manage`, `agent:update` | no |
| Export my data, erase my account | a signed-in person (no workspace permission) | no |

### 3.2 Who sees which run

```text
can read a run      = you started it (user, or the API key you are)
                   or you hold workflow:read_all          (supervision)
can control it      = you started it and hold workflow:execute
                   or you hold workflow:update             (anyone's run)
can decide a step   = you hold workflow:approve
                   and your clearance and compartments dominate the step's label
                   and you did not start the run (unless the node sets allowSelfApproval)
```

- A run you cannot read **does not exist for you**: **404 `WORKFLOW_RUN_NOT_FOUND`** on read, content, cancel, resume, delete and socket subscription — identical to an unknown id (verified for a Member, a Viewer and another tenant). The route permission is checked first, so a Viewer cancelling or resuming gets **403** (no `workflow:execute`) before any lookup (verified).
- `scope=all` without `workflow:read_all` is **403** (verified for a Member).
- An API key reads only the runs it started (verified: the key's list held exactly its own run), and its runs act with **its scopes**: a key with `workflow:execute` but not `tool:execute` starts a run whose tool step is denied (`PERMISSION`), so the run fails (verified). Give integration keys every scope their workflows use (`tool:execute`, `agent:execute`, `rag:query`, clearances).
- Runs **act as their initiator, re-checked before every step** (section 4.3.6). Losing `workflow:execute` stops your runs at their next step.

### 3.3 Content: labels, masking and reveal

Every run and every step carries an information-flow **label** — `classification` plus the knowledge bases and documents it drew on — exactly like Phase 4 messages. Each content read re-checks the label against the reader's access **today**:

| Reader | Result | Verified |
|---|---|---|
| The run's initiator, cleared | `contentState: "VISIBLE"` | yes |
| A supervisor (`workflow:read_all`), cleared | `"MASKED"`: personal data replaced by placeholders (`[EMAIL_ADDRESS_1]`), audited `workflow.run.supervised`; `"VISIBLE"` when nothing needed masking | yes |
| A supervisor with `reveal=true` and `pii:reveal` | `"VISIBLE"` with real values, audited CRITICAL `pii.unmasked` | yes (owner) |
| `reveal=true` without `pii:reveal` | **403 `PERMISSION_DENIED`** — even on your own run (P5-G11) | yes |
| Anyone whose clearance or compartments do not dominate the label | `"WITHHELD"`, `withheldReason: "CLEARANCE"` / `"COMPARTMENT"` / `"SOURCE_DELETED"`, `input: null`, `output: null` | yes (CLEARANCE) |
| Masking unavailable (AI service down, policy REFUSE) | `"WITHHELD"`, `"REDACTION_UNAVAILABLE"` | source |
| A run deleted or erased | 404 (the key is destroyed) | yes |

The same rules apply to approval messages in the queue: an approver who is not cleared sees `message: null` and `canDecide: false` (verified). **Approval messages are not masked** for cleared approvers, even in someone else's run (P5-G13).

### 3.4 Tools: where data may go

A tool is the only way data leaves an agent's answer or a run, so every call passes eight checks in order (section 4.1.3). For the UI the consequences are: a tool's `dataPolicy` decides what context may flow into it and whether it may receive personal data; `requiresApproval` tools only run behind an approval node; `requiredPermissions` (built-ins) are checked against the person the run or agent acts for. Members and Viewers hold `tool:read`, so they **see every HTTP tool's URL, headers and data policy** — never its credential (P5-G15).

### 3.5 Built-in roles, verified live

| | Owner | Administrator | Member | Viewer |
|---|---|---|---|---|
| Tools: read / create / update / delete / execute | ✓✓✓✓✓ | ✓✓✓✓✓ | ✓ – – – ✓ | ✓ – – – – |
| Test tools (update + execute) | ✓ | ✓ | – | – |
| Workflows: read / create / update / publish / delete | ✓✓✓✓✓ | ✓✓✓✓✓ | ✓ – – – – | ✓ – – – – |
| Run / supervise (read_all) / approve | ✓✓✓ | ✓✓✓ | ✓ – – | – – – |
| Audit: read / export / verify | ✓✓✓ | ✓✓✓ | – – – | – – – |
| Analytics (`usage:read`) / rank people / security feed | ✓✓✓ | ✓✓✓ | ✓ – – | – – – |
| Quotas: read / manage | ✓✓ | ✓✓ | ✓ – | – – |
| Reveal personal data | ✓ | – | – | – |

Phase 5 keys per role (live contextual `/auth/me`):

```text
owner    audit:export audit:read audit:verify quota:manage security:read security:update tool:create tool:delete tool:execute tool:read tool:update usage:read workflow:approve workflow:create workflow:delete workflow:execute workflow:publish workflow:read workflow:read_all workflow:update
admin    audit:export audit:read audit:verify quota:manage security:read security:update tool:create tool:delete tool:execute tool:read tool:update usage:read workflow:approve workflow:create workflow:delete workflow:execute workflow:publish workflow:read workflow:read_all workflow:update
member   tool:execute tool:read usage:read workflow:execute workflow:read
viewer   tool:read workflow:read
```

Design consequences: a **Member** can run published workflows, watch their own runs, see the tool catalogue (with HTTP tool URLs), the tool ledger, the analytics overview and the workspace quotas (P5-G15), but cannot build, test, approve or supervise. A **Viewer** can browse tools and workflow definitions but cannot run anything or read analytics. An **Administrator** does everything except reveal personal data and erase the workspace. Roles are editable (Phase 2), so **derive every control from the permission list, never from role names**; the live run used a custom "Flow Approver" role (`workflow:read`, `workflow:read_all`, `workflow:approve`, no clearance) to prove label-aware approvals.

### 3.6 UI rules: compute once, use everywhere

```ts
can = phase5Capabilities(contextual GET /auth/me → data.permissions)   // Appendix A
show "Run" only if can.runWorkflows and the workflow is ACTIVE
show "Test run (draft)" only if can.testRunWorkflows
show the approval inbox only if can.approve; per row use approvalControls(item)
show run controls from runActions(run, me, can) — the server re-checks
```

Handle every 403/404 anyway: roles, publication and approvals change while pages are open, and live sockets move rooms as access changes (section 4.6.4).


## 4. Concepts the screens depend on

### 4.1 Tools

#### 4.1.1 Built-in and HTTP tools

Two kinds share one catalogue and one id space (UUIDs; built-ins have the **same name-based id in every workspace**):

| Built-in | Arguments | Required permission (beyond `tool:execute`) | Data policy | Output for templates |
|---|---|---|---|---|
| `calculator` | `expression` (string) | — | internal: any classification, no side effects | a number |
| `current_datetime` | `timezone` (IANA name, optional) | — | internal | `{ iso, timeZone, formatted }` |
| `knowledge_search` | `query` (required), filters | `rag:query` | internal; results capped at the model endpoint's classification ceiling | `{ passages: [{ documentTitle, text, classification, score, … }] }` |
| `send_email` | `to`, `subject` (≤200), `body` (≤5,000) | `member:read` | INTERNAL ceiling, INTERNAL integrity, **side effects**, real values allowed, at most `TOOL_EMAIL_MAX_PER_RUN` (5) per run | `{ delivered }` |

`send_email` delivers only to a member of the workspace whose account is **ACTIVE (email verified)** and who is cleared for everything the conversation or run has seen; anyone else is denied with `TOOL_INFORMATION_FLOW_BLOCKED` (reason `RECIPIENT`) — and the message says "does not belong to a member" even for an unverified member (P5-G08, verified). A successful send pushes a metadata-only `notification` (`kind: "agent_email"`) to the recipient's socket (verified).

An **HTTP tool** is a request template a workspace administrator defines:

- `http.url`: an absolute **https** URL whose **origin is fixed** and must be on the platform egress allowlist `TOOL_HTTP_ALLOWED_HOSTS` (hostnames or `*.example.com`). `{{parameter}}` placeholders are allowed in the path, query, header values and string leaves of the JSON body — never in the scheme, host or port (422 `TOOL_DEFINITION_INVALID`, verified). Path values are percent-encoded one segment at a time and `.`/`..` are refused, so arguments cannot walk out of the fixed path.
- **The allowlist is empty on the development deployment**, which disables HTTP tools entirely (creation is refused at `/http/url`, P5-G20). The live run used an instance with `postman-echo.com,httpbin.org` allowed. Show `available: false` and the refusal's issue text ("Ask the platform operator to add it").
- `http.auth`: `none`, `bearer` (`Authorization: Bearer <secret>`), `header` (`headerName: <secret>`) or `basic` (`username` + secret). The **secret is write-only**: stored encrypted, never returned (`hasSecret` says whether one exists), not echoed in test results (verified). `secret: null` on update removes it — after which **every call fails** `TOOL_EXECUTION_FAILED` "This tool’s credential has not been configured." (verified, permanent in runs). Flag "Credential missing" whenever `auth.type !== 'none'` and `hasSecret` is false.
- `http.headers` may not set transport or reserved headers (`Authorization`, `Cookie`, `Host`, `X-Forwarded-*`, …; verified).
- `http.responsePath`: a JSON pointer (`/data/items`, ≤8 segments) selecting part of a JSON response; that is what the model reads and what a workflow template sees.
- `parameters`: a **strict JSON Schema subset** (section 6): every keyword accepted is enforced; `pattern`, `oneOf`, `$ref` and the like are **refused** (verified), so a schema can never look stricter than it is.
- `timeoutMs`: 500 ms – `TOOL_MAX_TIMEOUT` (60 s), default `TOOL_DEFAULT_TIMEOUT` (15 s).

#### 4.1.2 Data policy: confidentiality, integrity, personal data

Every call carries the labels of everything the agent or run has seen so far, and every tool declares what it accepts:

| Field | Meaning | Default for an HTTP tool |
|---|---|---|
| `maxClassification` | the most sensitive context that may flow into the tool ("no write down") | `PUBLIC` |
| `minIntegrity` | the least trusted context it may be called from — after reading untrusted external content, tools that act are refused (prompt-injection defence) | `INTERNAL` with side effects, else `EXTERNAL` |
| `piiArguments` | `deny`: a call carrying personal data is refused, and the outgoing request is re-scanned; `unmask`: real values are sent | `deny` |
| `sideEffects` | the call changes something | `true` for anything but `GET` |

Loosening any of these is allowed but **audited as a weakening** (`tool.updated` with `metadata.weakened: true` and the list, verified). Show a confirmation: "This lets INTERNAL data reach api.example.com." Results of HTTP tools are labelled `EXTERNAL` integrity (`resultIntegrity`).

#### 4.1.3 What happens when a tool runs

Every call — from an agent's reasoning loop, a workflow tool node, or a test — passes the same checks, in order, and ends in exactly one **outcome**:

| # | Check | Refused as (`status: "denied"`) | Denial reason |
|---|---|---|---|
| 1 | Granted (agent) / exists, enabled, available | `TOOL_NOT_GRANTED`, `TOOL_DISABLED` | `NOT_GRANTED`, `DISABLED` |
| 2 | The person acted for holds `tool:execute` + `requiredPermissions` | `PERMISSION_DENIED` | `PERMISSION` |
| 3 | Arguments valid against the schema (≤16 KB) | `TOOL_ARGUMENTS_INVALID` | `ARGUMENTS` |
| 4 | Approved, if `requiresApproval` | `TOOL_APPROVAL_REQUIRED` | `APPROVAL` |
| 5 | Context labels within `maxClassification` / `minIntegrity` | `TOOL_INFORMATION_FLOW_BLOCKED` | `CONFIDENTIALITY`, `INTEGRITY` |
| 6 | Personal data in the arguments or the outgoing request | `TOOL_PII_BLOCKED`, `TOOL_EGRESS_BLOCKED` | `PII`, `EGRESS` |
| 7 | Call budgets (per answer, per run) | `TOOL_CALL_LIMIT` | `CALL_LIMIT` |
| 8 | Side effects claimed once per execution id (a retried step never sends twice) | `TOOL_EXECUTION_FAILED` | `DUPLICATE` |

Then the tool runs under its timeout: `status: "ok"` with the result, or `status: "error"` with `TOOL_TIMEOUT` (verified: a 1 s tool against a 3 s endpoint) or `TOOL_EXECUTION_FAILED` (verified: upstream 500). Built-in `send_email` adds `RECIPIENT`. All three outcomes are **written to the ledger and the audit log**.

Verified with real HTTPS calls: a `GET` returned the echo service's JSON at `responsePath`; the same tool with `"Contact imran.siddiqui@acme.test"` in its arguments was **denied `TOOL_PII_BLOCKED`** before any request left; an approval-gated `POST` sent its JSON body.

#### 4.1.4 Versions

`version` starts at 1 and increases when **behaviour** changes: description, parameters, HTTP configuration, data policy, approval, timeout — or the credential. `displayName` and `enabled` change in place (verified). `digest` is SHA-256 of the behaviour; every execution records the version and digest it ran. Send `expectedVersion` on edits: a stale one is **409 `RESOURCE_CONFLICT`** `{expectedVersion, currentVersion}` (verified). Built-ins cannot be edited (**409 `TOOL_DEFINITION_INVALID`**) or deleted (404).

#### 4.1.5 Testing a tool

`POST …/tools/:id/test` **really runs the tool** once, as you, through every check above, with a PUBLIC, TRUSTED context and approval granted (you wrote the arguments). It answers **200 whatever the outcome**: read `data.status` (`ok` / `error` / `denied`). `content` is what the model would receive (before masking), `truncated` when it exceeded `TOOL_MAX_RESULT_SIZE` (32 KB). An unknown or deleted tool id is also a 200 `denied` `TOOL_NOT_GRANTED`, not a 404 (P5-G16). Show test results as a console: status chip, duration, code and message, and the content in a monospace viewer. **A test of `send_email` sends a real email; a test of a side-effecting HTTP tool performs the action.** Say so on the button.

#### 4.1.6 The ledger

`GET …/tools/executions` lists every call in the workspace, refused ones included, newest first — **content-free**: no arguments, no results; `argumentsDigest` is a keyed hash (equal calls match, nothing is revealed), `resultBytes` the size. Filters: `toolId` (built-in ids work), `runId`. Statuses `RUNNING` (a side-effecting call in progress or whose outcome was lost), `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `DENIED` with `denialReason` (verified: all five outcome kinds and five denial reasons appeared).

### 4.2 Workflow definitions

#### 4.2.1 The graph document

A workflow is a React Flow–shaped JSON graph. The full specification is [workflow graph v1](../contracts/workflow-graph-v1.md); the frontend essentials, verified against the validator:

```json
{ "schemaVersion": 1,
  "nodes": [ { "id": "calc", "type": "tool", "position": { "x": 200, "y": 0 }, "label": "Double it", "data": { … } } ],
  "edges": [ { "id": "e1", "source": "start", "target": "calc", "sourceHandle": "out" } ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 } }
```

- Node `id`: 1–64 letters, digits, `-`, `_`, unique; templates refer to nodes by id, so keep ids readable and **never regenerate them**.
- `position`, `label`, `viewport`: canvas state, stored, never interpreted.
- Edge `sourceHandle` chooses **which outcome** of the source the edge follows; absent = `out`. `targetHandle` is ignored.
- Limits: `WORKFLOW_MAX_NODES` (50), `WORKFLOW_MAX_EDGES` (150), 512 KB.

| Node | Key `data` | Source handles | `{{nodes.<id>.output}}` |
|---|---|---|---|
| `trigger` (exactly one) | `inputSchema` (default `{ input: string }`) | `out` | the run input object |
| `agent` | `agentId`*, `prompt` (template), `useTools`, `maxToolIterations`, `output` (`text` or `json` + schema), `timeoutMs`, `retry` | `out`, `error` | the answer (string), or the JSON its schema describes |
| `tool` | `toolId`*, `arguments`* (literal or templates; a string that is exactly one reference keeps its type), `timeoutMs`, `retry` | `out`, `error` | the tool's structured result (calculator: a number; HTTP: the JSON at `responsePath`) |
| `retrieval` | `query`* (template), `knowledgeBaseIds`, `topK` | `out`, `error` | `[{ title, text, classification, documentId, knowledgeBaseId, score }]` |
| `condition` | `rules`* `[{ id, value, operator, operand?, caseSensitive? }]` | each rule `id`, `else` | `{ handle, matchedRule }` |
| `supervisor` | `strategy`* (`llm`/`round_robin`), `agentId`, `goal`, `maxRounds`* | `worker`, `done`, `error` | when finished: the last worker's output |
| `approval` | `message` (template), `timeoutMs` (60 s–30 d), `onTimeout` (`reject`/`approve`), `allowSelfApproval` | `approved`, `rejected` | `{ decision, decidedBy }` |
| `output` (at least one) | `value` (template; default the predecessor's output) | — | its value |

\* required. **Build the palette and property panels from `GET …/workflows/node-types`**, which serves exactly this (types, handles, field types, options); it is the validator's own table, and the static contract document is stale on two handles (retrieval and supervisor also have `error`, P5-G26).

Condition rules: `operator` is one of `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte`, `is_true`, `is_false`, `is_empty`, `is_not_empty`. **`gt`/`gte`/`lt`/`lte` need a numeric `operand`** (`100`, not `"100"`); the unary `is_*` take none; a refused rule is dropped, so its handle is then reported invalid too (verified: `NODE_DATA_INVALID` + `HANDLE_INVALID`). Rule ids: a letter then letters, digits, `-`, `_` (≤32), not `else`/`error`/`out`.

Templates reference data only: `{{input}}`, `{{input.a.b}}`, `{{nodes.<id>.output}}`, `{{nodes.<id>.output.items[0]}}`, and a trailing `?` for an optional reference (a loop's first iteration). A reference must name an **ancestor**. Inside text, non-strings render as JSON.

Loops are explicit **back edges** from a condition rule: `"data": { "loop": { "maxIterations": 2, "onExhausted": "fall_through" } }`. The body runs at most `maxIterations + 1` times (verified: iterations 0, 1, 2 then the `else` branch); `onExhausted: "fail"` fails the run with `WORKFLOW_LOOP_EXHAUSTED` (verified). Every other cycle is `CYCLE`.

Supervisor teams: workers are agent nodes connected **only** by the supervisor's `worker` edge; `round_robin` hands rounds to workers in order (verified with two workers), `llm` lets a model choose (source). Each round is a supervisor step (`lead#0`, `lead#1`, …) whose handle names the worker (`worker:w1`), and the worker's step takes the **round as its iteration** (`w2#1`); the last round takes `done` (verified).

`settings` (on create and save) can only **lower** the platform ceilings: `maxSteps` (2–`WORKFLOW_MAX_STEPS` 100), `maxTokens` (≥1,000, ≤`WORKFLOW_MAX_TOKENS_PER_RUN`), `runTimeoutMs` (≥1,000, ≤`WORKFLOW_RUN_TIMEOUT` 30 min).

#### 4.2.2 Validation

`POST …/workflows/validate` checks a graph without saving: structure, handles, loops, templates, types, and whether **you** can use every agent, tool and knowledge base it names. Call it from the canvas as the user edits (debounced, ~600 ms; never more than one in flight). The report is `{valid, errors[], warnings[], stepBound}`; each issue has `code`, `message` and the `nodeId` or `edgeId` to highlight (Appendix A `issuesByElement`). Verified error codes include `TRIGGER_MISSING`, `TRIGGER_MULTIPLE`, `OUTPUT_MISSING`, `NODE_TYPE_UNKNOWN`, `NODE_DATA_INVALID`, `CYCLE`, `EDGE_DANGLING`, `HANDLE_INVALID`, `UNREACHABLE`, `REFERENCE_NOT_ANCESTOR`, `TEMPLATE_INVALID`, `TYPE_MISMATCH` (retrieval into a tool; a field a JSON output schema rules out), `REFERENCE_UNKNOWN` (an agent you cannot see), `TOOL_ARGUMENT_MISSING`, `GRAPH_VERSION`; warnings `DEAD_END`, `STEP_BOUND`, `INPUT_FIELD_UNKNOWN`. A structurally broken graph (a dangling edge) may stop the analysis before later checks: fix the first errors first. `stepBound` is the worst-case number of steps a run can schedule; show it beside the step ceiling.

#### 4.2.3 Versions are append-only

| Action | Effect |
|---|---|
| Create | version 1 (`changeNote: "Created."`); default graph trigger → output |
| Save canvas (`PUT …/definition`) | appends version N+1 **valid or not** (drafts are never lost), with its report — **unless nothing changed** (same digest: no version, verified) |
| Rename / description (`PATCH`) | in place, no version |
| Restore version N | appends a **copy** (`restoredFromVersion: N`, same digest, verified); answers **201** (P5-G17) |
| Publish version N (default current) | must be valid **and re-validated now** against current agents, tools and bases; sets `publishedVersion`, status `ACTIVE` |

- Runs always use (and pin) the **published** version; saving never changes a run in flight or the published version.
- A **valid** graph is stored **normalised**: properties the server does not understand are dropped (verified), so reload the canvas from the saved version. An **invalid** draft is stored as sent (P5-G19).
- Send `expectedVersion` (the `currentVersion` you loaded): stale is **409 `WORKFLOW_VERSION_CONFLICT`** `{expectedVersion, currentVersion}` (verified).

#### 4.2.4 Lifecycle

```text
DRAFT ──publish──▶ ACTIVE ──archive──▶ ARCHIVED ──publish──▶ ACTIVE
   (every state) ──delete──▶ gone (active runs are cancelled; run history stays)
```

Archived workflows refuse new runs (**409 `WORKFLOW_NOT_ACTIVE`**) but editors can still test-run a version (verified). Publishing an older version is allowed and is how you roll back (verified: publishing version 2 after version 4).

### 4.3 Runs

#### 4.3.1 States

```text
run:   RUNNING ⇄ WAITING_APPROVAL ─▶ COMPLETED | FAILED | CANCELLED | TIMED_OUT      (FAILED/TIMED_OUT ─resume─▶ RUNNING)
step:  QUEUED ─▶ RUNNING ─▶ SUCCEEDED | FAILED          (QUEUED ◀─ retry)
                       └─▶ WAITING_APPROVAL ─▶ SUCCEEDED
       created SKIPPED when its branch was not taken; CANCELLED when the run ends first
```

`QUEUED` exists in the enum but a started run is `RUNNING` at once (202). Steps are keyed by `nodeId` **and** `iteration` (loops and supervisor rounds create one step per iteration); `predecessors` lists `nodeId#iteration` of the steps that made it ready; `handles` is the outcome taken.

#### 4.3.2 How a run executes

A node runs when all its incoming edges are resolved and at least one is live (its source took that handle). All resolved and none live: **SKIPPED**, and everything below it (verified: the untaken branch of a condition). A run completes when nothing is left and at least one output ran (`WORKFLOW_NO_OUTPUT` otherwise). Its **output** is the value of its output node — with several output nodes, **an object keyed by the ids of those that ran** (verified: `{"small": "Small amount: 60"}`).

#### 4.3.3 Failures, retries, error edges, dead letters

| Failure class | Examples | Retried? |
|---|---|---|
| `TRANSIENT` | `LLM_BUSY`, `TOKEN_RATE_LIMITED`, `AI_SERVICE_UNAVAILABLE`, `TOOL_EXECUTION_FAILED` on a 5xx, `WORKFLOW_OUTPUT_INVALID` | yes, jittered exponential backoff (`WORKFLOW_STEP_BACKOFF` 10 s → 5 min), up to `retry.maxAttempts` (default `WORKFLOW_STEP_MAX_ATTEMPTS` 3) |
| `TIMEOUT` | `LLM_TIMEOUT`, `WORKFLOW_STEP_TIMEOUT`, `TOOL_TIMEOUT` | yes |
| `POLICY` | `TOOL_PII_BLOCKED`, `QUOTA_EXCEEDED`, `PERMISSION_DENIED`, `WORKFLOW_PRINCIPAL_REVOKED` | **never** (verified: `TOOL_PII_BLOCKED`, attempt 1, run FAILED) |
| `PERMANENT` | `WORKFLOW_TEMPLATE_ERROR`, invalid arguments | never |

A step that fails for good follows its **`error` edge** if it has one — the failure becomes an outcome and the run continues (verified: a timed-out tool routed to a fallback output, run COMPLETED) — otherwise the run **FAILED** with `errorCode` and `errorStepId`. Either way a **metadata-only dead letter** is recorded (node, code, class, attempts; no payload). `step.retrying` events announce each retry with its delay.

#### 4.3.4 Cancel, resume, time out, delete

- **Cancel** (`QUEUED`/`RUNNING`/`WAITING_APPROVAL`): immediate; in-flight steps are aborted wherever they run, waiting steps become CANCELLED (verified). A finished run: **409 `WORKFLOW_RUN_FINISHED`**.
- **Resume** (`FAILED` or `TIMED_OUT` only): failed and cancelled steps run again with retry counts reset; completed steps keep their outputs; the deadline is reset to the **platform** `WORKFLOW_RUN_TIMEOUT` (P5-G18). Verified: a run whose tool failed was resumed after the tool was fixed and COMPLETED with only that step re-run. A CANCELLED or COMPLETED run: **409 `WORKFLOW_RUN_NOT_RESUMABLE`** (verified).
- **Time out**: the maintenance sweep (every `WORKFLOW_SWEEP_INTERVAL`, 1 min) ends active runs past `deadlineAt` as **TIMED_OUT** `WORKFLOW_TIMEOUT` (verified with a 2 s deadline) — so expect up to one sweep interval of lag.
- **Delete** (finished runs only; active: **409 `RESOURCE_CONFLICT`** "Cancel the run before deleting it."): the run's key is destroyed, content unrecoverable at once, rows removed; the **audit trail and trace stay** (verified).

#### 4.3.5 Idempotency and test runs

- `idempotencyKey` (≤128): starting again with the same key returns the **first run** with `duplicate: true` (verified). Keys are scoped to the **workflow, not the person**: another member reusing a key gets the first member's run back (verified, P5-G09). Generate a fresh UUID per user submission and reuse it only to retry that submission.
- `version`: run a version other than the published one — a **test run**, which needs `workflow:update` (403 otherwise, verified), works on drafts and archived workflows, and must be a valid version (**422 `WORKFLOW_INVALID`**, verified).
- `input` is validated against the trigger's `inputSchema` (defaults applied): **422 `WORKFLOW_INPUT_INVALID`** with `details.issues` (verified), and at most `WORKFLOW_MAX_INPUT_SIZE` (64 KB, **413 `PAYLOAD_TOO_LARGE`**).

#### 4.3.6 A run acts as its initiator

Exactly like an agent (Phase 4, section 3.4), a run is a **delegate**: every step re-reads the initiator's membership and permissions from the database before it starts. Retrieval sees only what the initiator can read; tools run with the initiator's permissions; labels rise with what was read. If the initiator is removed, suspended, erased or loses `workflow:execute`, the run stops at its next step with **`WORKFLOW_PRINCIPAL_REVOKED`** (POLICY). Verified: a run waiting for approval whose initiator was demoted to Viewer failed at the step after the approval.

#### 4.3.7 Ceilings

| Ceiling | Refusal | Verified |
|---|---|---|
| Steps per run (`settings.maxSteps`, `WORKFLOW_MAX_STEPS`) | run FAILED `WORKFLOW_STEP_LIMIT_EXCEEDED` (audited `agent.circuit_broken`) | yes (`maxSteps: 2`) |
| Tokens per run (`settings.maxTokens`) | `WORKFLOW_TOKEN_BUDGET_EXCEEDED` | source |
| Loop iterations | `WORKFLOW_LOOP_EXHAUSTED` with `onExhausted: "fail"` | yes |
| Active runs per workspace (20) | 429 `WORKFLOW_CONCURRENCY_LIMIT`, `Retry-After: 30` | yes |
| Tool calls per run (`TOOL_MAX_CALLS_PER_RUN` 50) | tool denied `CALL_LIMIT` | source |

### 4.4 Approvals

An approval node pauses its branch: the step becomes `WAITING_APPROVAL` with `approval {requestedAt, expiresAt}`, the run `WAITING_APPROVAL`, and an `approval.requested` event reaches every socket in the approvers room.

- The **queue** (`GET …/workflow-runs/approvals`) lists up to 100 waiting steps of the workspace, oldest first, each with the rendered `message` (or `null` when you are not cleared for the step's label) and `canDecide` (false when not cleared, or when you started the run and the node does not allow self-approval). Verified: an Administrator saw the message and `canDecide: true`; an approver without clearance saw `message: null`, `canDecide: false`; the Administrator saw `canDecide: false` on their own run.
- **Deciding** (`approve`/`reject`, optional `comment` ≤2,000 stored encrypted): your own run is **403 `WORKFLOW_SELF_APPROVAL_FORBIDDEN`**; not cleared is **403 `FORBIDDEN`** "You are not cleared…" (audited `access.denied`); already decided, cancelled or timed out is **409 `WORKFLOW_APPROVAL_NOT_PENDING`** (all verified). The step SUCCEEDS with handle `approved` or `rejected` and `approval.decision/decidedAt/decidedBy: "person"/decidedById`; `approval.decided` is published.
- **Timeouts**: at `expiresAt` the sweep decides by the node's `onTimeout` (`reject` by default) with `decidedBy: "timeout"` (verified: `onTimeout: "approve"`, 60 s).
- A tool that `requiresApproval` runs only as a tool node **after an approval node that was approved**; agents can never call it on their own (denied `TOOL_APPROVAL_REQUIRED`). **Validation does not catch an approval-gated tool placed without an approval node** (verified: valid, no warning, P5-G27): the step is denied at run time. Warn on the canvas when a tool node whose tool has `requiresApproval` has no approval ancestor on its `approved` path.

### 4.5 Content of runs and steps

Run **content** is `{input, output}`; **step content** is what one step was given and what it handed on: a tool step's rendered arguments and its result (verified: `"30 * 2"` → `60`), an approval step's rendered `message`, a retrieval step's passages (verified fields), an agent step's prompt and answer. Content is decrypted per request under the label, masking and reveal rules of section 3.3, and is never in events or lists. Treat it like conversation content: memory only, never in URLs, logs or analytics.

### 4.6 Real-time (Socket.IO)

#### 4.6.1 Connecting

```ts
import { io } from 'socket.io-client';
const socket = io(API_ORIGIN, {
  path: '/realtime',                   // REALTIME_PATH; not a namespace — io(`${API_ORIGIN}/realtime`) is wrong
  transports: ['websocket'],           // the server allows websocket only by default
  auth: { token: accessToken, organizationId: workspaceId },   // UUID or slug
});
```

- Credentials go **only** in `auth`. A token in the URL is refused (`AUTH_SCHEME_NOT_ALLOWED`, verified).
- **One socket per workspace**; to switch workspace, close it and open another. The first message is **`ready`** `{organizationId, rooms, expiresAt, serverTime}` (verified: `expiresAt` is the access token's expiry in epoch ms; `null` for an API key).
- A refused handshake arrives as `connect_error`; `err.data.code` carries the same code an HTTP error would, and the client does **not** retry it automatically:

| `err.data.code` | Meaning | Verified |
|---|---|---|
| `AUTH_TOKEN_MISSING` | no credential | yes |
| `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_REVOKED` | refresh over HTTP (Phase 1), then reconnect once | invalid: yes |
| `AUTH_SCHEME_NOT_ALLOWED` | token in the URL | yes |
| `ORGANIZATION_CONTEXT_REQUIRED` | no `organizationId` | yes |
| `ORGANIZATION_NOT_FOUND` | not a member (answered as for an unknown workspace) | yes |
| `ORGANIZATION_SUSPENDED`, `MEMBERSHIP_SUSPENDED`, `IP_NOT_ALLOWED` | as Phase 1–2 | source |
| `API_KEY_*` | an API key socket | yes (unknown key) |
| `REALTIME_CONNECTION_LIMIT` | more than 10 sockets for this person (across tabs) | yes |
| `RATE_LIMIT_EXCEEDED` | more than 60 handshakes per minute from this IP (`retryAfterSeconds`) | source |
| **no code** (`err.data` undefined, `err.message` "websocket error") | the network, **an origin not in `CORS_ORIGINS`**, or real-time disabled — the documented `REALTIME_ORIGIN_NOT_ALLOWED`/`REALTIME_DISABLED` codes never reach a browser (P5-G07, verified) | yes |

#### 4.6.2 Rooms you get without asking

| Room | Joined when | Receives | Verified |
|---|---|---|---|
| your own | always | `run.*` of runs **you** started; `notification`s addressed to you | yes |
| all runs | you hold `workflow:read_all` | `run.*` of every run in the workspace | yes (Administrator, no step events) |
| approvers | you hold `workflow:approve` | `approval.requested`, `approval.decided` | yes |
| an API key's own | key sockets | `run.*` of the key's runs | yes |

`ready.rooms` lists them (verified: Member → own room only; Administrator → own, runs, approvers). **Rooms follow access**: when a role changes, the server re-checks sockets at once and joins or leaves rooms (verified: after a Viewer became a Flow Approver, their open socket received the next `approval.requested`). No event announces a room change.

#### 4.6.3 Watching one run

Step-level events (`step.*`, `tool.*`) go only to sockets **subscribed** to that run:

```js
socket.emit('subscribe', { runId, lastEventId }, (ack) => { /* {ok, runId, replayed, events} | {ok:false, code, message} */ });
socket.emit('unsubscribe', { runId }, (ack) => {});
```

You may subscribe to your own runs, or any run with `workflow:read_all`. Someone else's run, another workspace's run and an unknown id are all answered **`WORKFLOW_RUN_NOT_FOUND`** (verified, and audited `realtime.subscription.denied`). A malformed id is `VALIDATION_FAILED`; a key or person without `workflow:read` gets `PERMISSION_DENIED` (verified). At most 50 subscriptions per socket. With `lastEventId` the ack replays what you missed **for that run** (use `"0-0"` right after starting a run to get everything so far, verified).

#### 4.6.4 Events

Every event is **metadata only** (verified: no input, output, prompt or result text ever appeared):

```json
{ "id": "1791333331234-0", "type": "step.completed", "organizationId": "…", "at": "2026-10-07T…Z",
  "runId": "…", "workflowId": "…", "stepId": "…", "nodeId": "calc", "initiatorUserId": "…",
  "data": { "iteration": 0, "nodeType": "tool", "handles": ["out"], "durationMs": 412, "tokens": 0, "toolCalls": 1, "classification": "PUBLIC" } }
```

Delivered on the `event` channel (and `notification` for notifications). `id` is the event's position in the workspace stream: keep the newest you have seen, and **compare ids numerically** (`<ms>-<seq>`, Appendix A `compareEventIds`).

| `type` | `data` | Verified |
|---|---|---|
| `run.started` | `workflowVersion`, `steps` | yes |
| `run.resumed` | `stepsReset` | yes |
| `run.completed` / `run.failed` / `run.cancelled` / `run.timed_out` | `status`, `errorCode?`, `steps`, `tokensUsed` | completed, failed, cancelled: yes |
| `step.queued`, `step.skipped` | `iteration`, `nodeType` | yes |
| `step.started` | `iteration`, `nodeType`, `attempt` | yes |
| `step.retrying` | `iteration`, `nodeType`, `attempt`, `errorCode`, `delayMs` | source |
| `step.completed` | `iteration`, `nodeType`, `handles`, `durationMs`, `tokens`, `toolCalls`, `classification` | yes (agent step `tokens > 0`) |
| `step.failed` | as completed + `errorCode`, or `iteration`, `nodeType`, `errorCode`, `failureClass`, `attempt` | yes |
| `step.waiting_approval` | `iteration`, `nodeType`, `expiresAt` | yes |
| `tool.called` | `tool`, `executionId`, `ok`, `durationMs`, `errorCode?` | yes |
| `tool.denied` | `tool`, `executionId`, `reason`, `errorCode` | source |
| `approval.requested` | `iteration`, `nodeType`, `expiresAt`, `classification` | yes |
| `approval.decided` | `iteration`, `nodeType`, `decision`, `decidedBy` | yes (person and timeout) |
| `notification` `agent_email` | `kind`, `agentId` (null from a test), `subjectLength` | yes |
| `notification` `quota.threshold` / `quota.exhausted` | `kind`, `quotaId`, `scope`, `period`, `limit`, `percent`, and `threshold` or `enforcement` | yes (both) |
| `notification` `agent.circuit_opened` | `kind`, `agentId`, `reason`, `cooldownSeconds` | yes |

`run.queued` and `run.waiting` are declared but never published. Ordering caveat: a run's first `step.queued` can arrive **before** `run.started` (observed in the live run) — apply events by id, not by arrival assumptions.

#### 4.6.5 Missing nothing

Live delivery is at most once. After any gap — a reconnect, a hidden tab, page load — recover in this order:

1. Connect (or reconnect) and wait for `ready`.
2. Re-`subscribe` to the runs on screen with your newest `lastEventId`; then `resume` `{lastEventId}` for room-level events (it replays what you missed **for the rooms you are in now**, verified).
3. **Reload the run over REST** (`GET …/workflow-runs/:id`) — it is always authoritative — and fold newer events onto it (Appendix A `runViewFrom` + `applyRunEvent`).

Replay covers the last `REALTIME_STREAM_MAXLEN` (1,000) events of the workspace, at most `REALTIME_STREAM_TTL` (24 h) old, up to `REALTIME_REPLAY_MAX` (200) per request **before** the room filter, with no "more" flag: after a long gap, rely on REST. A malformed `lastEventId` replays nothing (no error, verified). Notifications have **no REST store**: one missed beyond the replay window is gone, so show them as a toast/tray, not as a durable inbox.

#### 4.6.6 Keeping the socket authorised

| Server → client | Meaning | What to do | Verified |
|---|---|---|---|
| `auth:expired {code}` | the access token's lifetime ended; the socket closes | refresh over HTTP, reconnect — better, avoid it with `auth:refresh` | yes (two sockets whose tokens were not refreshed were closed at expiry) |
| `auth:revoked {code}` | access is gone (removed, suspended, token or key revoked, a different user's token sent); the socket closes | do not reconnect automatically with the same credential | yes (key revoked; foreign token) |
| `error {code: "RATE_LIMIT_EXCEEDED"}` | more than 30 messages in 10 s; the socket closes | back off | yes |

Refresh in place, keeping subscriptions: `socket.emit('auth:refresh', { token: newAccessToken }, ack)` → `{ok: true, expiresAt}` (verified: three people's sockets were refreshed in place during the run and stayed open). The token must belong to the same user; anything else closes the socket with `auth:revoked`. A server-initiated close reports `disconnect` reason `"io server disconnect"` and Socket.IO does not reconnect by itself.

> **P5-G06, read this.** On the verification day the server's event-bus subscription to Redis was silently lost after a quiet period, so **no live event reached any socket** while `/health` still said `eventBus: "subscribed"`; events were still recorded and `resume`/`subscribe` replays returned them. The backend fix keeps the subscription alive and makes the health check honest. The frontend must not depend on live events alone either: while a run is visibly active and no event has arrived for 30 s, refetch it over REST (Appendix A `createRealtimeClient` + section 9.3).

### 4.7 Governance: quotas and circuit breakers

#### 4.7.1 Quotas

| Field | Values |
|---|---|
| `scope` | `ORGANIZATION` (everyone), `MEMBER` (`subjectId` = the member's **user id**), `AGENT` (agent id), `API_KEY` (key id) |
| `period` | `MINUTE` = a **rate** (token bucket, `rate.available`); `DAY` / `MONTH` = a **budget** reset at the UTC calendar boundary (`usage`) |
| `enforcement` | `HARD` refuses calls that would exceed; `SOFT` only alerts |
| `alertThreshold` | percent (default 80): at the first crossing per period, quota managers (and the member, for MEMBER scope) get a `quota.threshold` notification |
| `managedBy` | `PLATFORM` rows mirror the deployment (the plan's monthly allowance — 2,000,000 tokens on FREE — and `QUOTA_TOKENS_PER_MINUTE`); they appear in lists but cannot be changed or removed (**403 `QUOTA_MANAGED_BY_PLATFORM`**, verified) |

- Every model call (conversations, direct chat, agent steps in runs) is admitted against every applicable quota, reserving its **worst case** (estimated prompt + maximum output). That is why a small budget refuses a call whose actual spend would have fitted (verified: a HARD 60-token daily member budget refused a call reserving more).
- Refusals: **429 `QUOTA_EXCEEDED`** with `Retry-After` = seconds to the period reset (verified), **429 `TOKEN_RATE_LIMITED`** `{quotaId, scope, tokensPerMinute, requested, retryAfterSeconds}` (verified with a 10-token workspace rate). A rate is a token bucket refilling continuously: a **full** bucket admits one call even if it is larger than the whole rate (emptying it), and the next call waits for the refill (verified) — so a small rate paces large calls rather than blocking them forever.
- One quota per scope, subject, period and manager: a duplicate is **409 `RESOURCE_CONFLICT`**; a subject outside the workspace is **422** (verified).
- `usage` = `{used, reserved, remaining, percent, periodStart, resetsAt}`; `reserved` is held by calls in flight. **A new budget starts from what its subject already spent this period** (summed from the usage ledger), not from zero (verified: a member budget created after their agent runs showed the day's spend at once) — say so in the editor, because a new HARD budget below today's spend refuses the next call. `history` lists past periods: `tokensUsed`, `requests`, `rejected`, `alertedAt`, `exhaustedAt` (verified).
- Changes are audited (`quota.created/updated/deleted`; raising a limit or HARD→SOFT is marked `weakened`) and apply at once in this process, within `QUOTA_CACHE_TTL` (30 s) elsewhere.

#### 4.7.2 Agent circuit breakers

An agent is paused automatically — every call refused with **503 `AGENT_CIRCUIT_OPEN`** for `AGENT_CIRCUIT_COOLDOWN` (5 min) — when it spends more than `AGENT_CIRCUIT_MAX_TOKENS` within `AGENT_CIRCUIT_WINDOW` (`RUNAWAY_SPEND`), or fails `AGENT_CIRCUIT_FAILURE_THRESHOLD` (5) times in a row for reasons of its own (`REPEATED_FAILURES`: egress blocks, context overflows, rejected or unusable output). Opening is audited `agent.circuit_broken` and pushed as `agent.circuit_opened` to members holding `quota:manage` or `agent:update`. After the cooldown the next call is let through (half-open). Verified: one oversized turn opened the breaker (`RUNAWAY_SPEND`), the next turn was refused 503 with `Retry-After` and `details {agentId, reason, openedAt, retryAfterSeconds}`, the open circuit was listed, and a reset closed it (`wasOpen: true`, then `false`). In runs, `AGENT_CIRCUIT_OPEN` is TRANSIENT: the step retries after the cooldown.

### 4.8 The audit log

Every security-relevant action in the workspace is appended to a **hash chain**: each record's `hash` is an HMAC of its content and the previous record's hash (`sequence` 1, 2, 3…). Records cannot be updated or deleted (a database trigger refuses it).

- **Search** with filters (section 6); `severity` `WARNING`/`CRITICAL` is the security subset. `requestId` pulls every record one request wrote: it is the `x-request-id` of the response (verified), so a support view can link a failed action to its audit trail.
- **Verify** recomputes the chain and answers `{valid, recordsChecked, brokenAtSequence?, reason?}`; the check itself is audited.
- **Export** streams the stored records as NDJSON, oldest first. Each line carries `sequence`, `previousHash` and `hash`, so a holder of the file can check offline that **nothing was removed or reordered** (verified: every line links to the previous one; Appendix A `checkExportLinks`). Recomputing the hashes needs the server's `AUDIT_HASH_SECRET`, so content integrity is established by `verify`, not offline (P5-G21). A time window exports a slice that starts mid-chain.
- **Retention** (`AUDIT_RETENTION`, off by default) prunes old records behind a signed anchor and keeps an encrypted archive; `archives` lists prunings and `archives/:sequence` downloads one as NDJSON whose last `hash` equals the anchor's. With retention off the list is empty (verified) and the download is source-only (P5-G23).
- Audit metadata is redacted of secrets and content, but it is still sensitive: IP addresses, user agents, actor labels.

### 4.9 Analytics (the Command Centre)

All analytics are **metadata**: counts, tokens, latencies, labels — never content. Windows default to the last 30 days, at most 400 days (hourly series: 14 days); `from` must be before `to` (**422**, verified). The overview has eight sections: `inference` (the Phase 4 usage summary), `activity`, `workflows` (runs by outcome, active now, duration percentiles, tokens, dead letters), `tools` (calls by outcome, `denialsByReason`), `knowledge`, `privacy` (entities masked by type, egress blocks, refusals, degraded masking), `governance` (throttled calls, budget exhaustions, rate-limit events, circuit breaks — which also count runs stopped by their step or token ceiling, audited the same way — open circuits, budgets near their limit) and `security` (by severity, top alerts, failed sign-ins, access denials). Time series return **every bucket** (zero, or `null` for a percentile with no data, verified) so charts need no gap filling. Ranking members or API keys needs `quota:manage` as well. The security feed pages with `before` (strictly older, verified) and ignores `to` (P5-G22).

### 4.10 Personal data

- **Export** (`GET /auth/me/export`): a JSON **file** (not an envelope) of everything the platform holds about and from you across every workspace: account, memberships, devices (sessions), **your own conversations and workflow runs decrypted**, the API keys you issued, monthly usage, your activity trail; `truncated` names sections cut at `DATA_EXPORT_MAX_ITEMS`. Workspace documents and other people's data are excluded (verified: your runs included, another member's not). Rate limited to **5 per hour** (verified). Audited `user.data.exported`.
- **Erasure** (`DELETE /auth/me`): needs your password, a current TOTP or recovery code if MFA is on, and the exact phrase `ERASE MY ACCOUNT`. It is **refused while you own a workspace other people belong to** (**409 `ACCOUNT_ERASURE_BLOCKED`** with `details.workspaces [{id, name, otherMembers}]` — transfer ownership first, Phase 2). Otherwise, at once and irreversibly: workspaces only you belong to are deleted, your conversations and runs are crypto-shredded (active runs cancelled), API keys you issued revoked, memberships ended, sessions and tokens deleted, invitations to you anonymised, the account anonymised and closed; a farewell email goes to the original address (all verified). Usage and tool ledgers keep a pseudonymous id; the audit log is kept as evidence.

### 4.11 Operator diagnostics

`GET /health` (public, no secrets) reports each dependency with timings and circuit states — including `realtime` (`eventBus`, `connections` on this instance) and `workflow_engine` (`workersEnabled`, `stalledSteps`, `overdueSteps`). `GET /health/ready` is the readiness probe. `GET /metrics` is Prometheus text for infrastructure, behind its **own bearer token** (`METRICS_TOKEN`; 401 without it, verified) — never call it from the browser. An operator page may show `/health` to holders of `security:read`; ordinary users should see only a friendly "Some features are degraded" banner derived from it.


## 5. Screens and workflows

Suggested frontend routes (not backend endpoints). `:id` is the workspace.

| Route | Visible when | Content |
|---|---|---|
| `/w/:id/tools` | `tool:read` | Catalogue: built-ins and HTTP tools, kind filter, search, availability and data-policy badges |
| `/w/:id/tools/new`, `/w/:id/tools/:toolId/edit` | `tool:create` / `tool:update` | HTTP tool editor (section 5.1) |
| `/w/:id/tools/:toolId` | `tool:read` | Detail: schema, policy, version, test console (`tool:update` + `tool:execute`), recent executions (`usage:read`) |
| `/w/:id/tools/executions` | `tool:read` + `usage:read` | The ledger |
| `/w/:id/workflows` | `workflow:read` | Directory: status filter, search, published version, last run |
| `/w/:id/workflows/:wfId` | `workflow:read` | Canvas (read-only without `workflow:update`), versions panel, publish/archive, Run |
| `/w/:id/workflows/:wfId/runs` | `workflow:read` | Runs of this workflow |
| `/w/:id/runs` | `workflow:read` | My runs; "Everyone" tab with `workflow:read_all` |
| `/w/:id/runs/:runId` | `workflow:read` | Live run view: canvas overlay, step timeline, content panels, controls, trace link |
| `/w/:id/approvals` | `workflow:approve` | Approval inbox |
| `/w/:id/runs/dead-letters` | `workflow:update` | Dead-letter list with "Resume run" |
| `/w/:id/audit` | `audit:read` | Search, statistics, verify (`audit:verify`), export (`audit:export`), archives |
| `/w/:id/command-centre` | `usage:read` | Analytics overview, charts, rankings; security feed with `audit:read` or `security:read` |
| `/w/:id/governance` | `usage:read` or `quota:manage` | Quotas with gauges, history, editor (`quota:manage`); open circuits and reset |
| `/account/data` | signed in | Download my data; erase my account |
| `/w/:id/operations` | `security:read` (product choice) | Health detail (operator view); never `/metrics` |

### Common product quality

Separate loading, empty, filtered-empty, forbidden, not-found-or-hidden, pending, live and retryable states. Keyboard operation everywhere — **including the canvas**: every node and edge must be selectable and editable without a mouse (a node list with "Add node", "Connect to…", "Delete" actions beside the canvas), and the property panel is a normal form. Visible focus, 360 px layouts (the canvas becomes the node list plus a read-only minimap on narrow screens), reduced motion (no animated edges), non-colour status cues (icons and text for step states). Announce live run progress politely (`aria-live="polite"`, on step completion and run end, not on every event). Never render tool results, run content, approval messages, audit metadata or workflow names as raw HTML.

### 5.1 Tools

- **Catalogue:** name, display name, kind badge, `available` (grey out with "Not available on this deployment"), `enabled`, data-policy chips (classification ceiling, "may receive personal data" only when `piiArguments: unmask`, "acts" when `sideEffects`), "Needs approval" when `requiresApproval`, version. Built-ins are read-only.
- **HTTP tool editor:** name (immutable after create, `^[a-z][a-z0-9_]{2,47}$`, explain "the model calls it by this name"), display name, description ("the model reads this to decide when to use the tool"), method, URL with a placeholder-aware hint, query/headers key-value editors, JSON body editor (POST/PUT/PATCH only), auth type and secret (a password field; on edit show "Credential set" with Replace/Remove), response path, timeout, parameters (a schema builder for the supported subset, or a JSON editor validated client-side against section 6's keyword list), data policy with the defaults pre-filled and a warning on every loosening, approval and enabled toggles.
- **On 422 `TOOL_DEFINITION_INVALID`:** map `details.issues[].path` (JSON pointers like `/http/url`, `/parameters/properties/q`) to fields; show the message verbatim (they are written for administrators). The allowlist refusal tells the user to contact the operator.
- **Test console:** an arguments form generated from `parameters`; a warning on side-effecting tools and on `send_email`; results as status, duration, code/message and content. The test is recorded in the ledger and audit.
- **Delete:** "Agents granted this tool stop being offered it at once; its credential is destroyed; history stays."

### 5.2 Workflow canvas

- **Palette** from `GET …/node-types`; **property panels** from each type's `fields`; agent, tool and knowledge-base pickers from Phases 3–4 (only what the editor can see).
- **Editing loop:** keep the loaded version as the base; debounce `POST …/validate` on change; outline invalid nodes and edges (Appendix A `issuesByElement`); show warnings separately. "Save" sends `PUT …/definition` with `expectedVersion` and an optional change note, then **reloads the canvas from the returned version** (the server normalises). Saving an invalid graph is allowed: show "Saved as a draft with N problems".
- **Unsaved changes:** warn on navigation; on 409 `WORKFLOW_VERSION_CONFLICT`, offer "Reload theirs" or "Keep mine and save as a new version on top" (re-send with the new `expectedVersion`).
- **Templates:** an autocomplete on template fields offering `input.*` (from the trigger schema) and `nodes.<ancestor>.output…` (Appendix A `templateReferences` for highlighting).
- **Conditions:** a numeric input for `gt/gte/lt/lte` operands (send a number), none for `is_*`; each rule's id becomes an edge handle.
- **Loops:** only from a condition rule handle back to an earlier node; ask for `maxIterations` and `onExhausted`.
- **Versions panel:** newest first, `isCurrent`/`isPublished`, validity, change note, author; "Restore" (confirm: "adds version N+1, identical to version N") and "Publish this version".
- **Publish/archive:** publish is disabled with the reason when the version is invalid; the server re-validates (422 `WORKFLOW_INVALID` lists `details.errors`). Archive confirms "Members can no longer run it; history stays."
- **Delete:** "Runs in progress are cancelled. Run history stays."

### 5.3 Starting and watching runs

- **Run dialog:** a form generated from the trigger's `inputSchema` (default: one text area "input"); generate an `idempotencyKey` per submission; editors get "Run version N (test)". On 202 navigate to the run view.
- **Run view:** the canvas with each node coloured by its latest step (Appendix A `applyRunEvent`), a step timeline (attempts, durations, tokens, tool calls, failure class, `predecessors`), and panels for run and step content (fetched on demand, section 3.3 notices). Controls from `runActions`: Cancel, Resume (with "Re-runs only what failed"), Delete (finished only), Trace (`audit:read`).
- **Live:** subscribe on open with `lastEventId: "0-0"` (or your newest id), unsubscribe on leave, refetch the run on terminal events and on reconnect; if a run is active and silent for 30 s, refetch over REST (section 9.3).
- **Errors:** render `errorCode` with Appendix A `runErrorText`; for `WORKFLOW_PRINCIPAL_REVOKED` explain that runs act as the person who started them.

### 5.4 Approval inbox

Rows from `GET …/workflow-runs/approvals`: workflow, node, requested and expiry times (countdown), initiator (resolve the name), classification badge, the message (or "You are not cleared for this request") and Approve/Reject with an optional comment (Appendix A `approvalControls`). Refresh on `approval.requested`/`approval.decided` events and every 60 s. After a decision, remove the row optimistically and reconcile on the response; on 409 `WORKFLOW_APPROVAL_NOT_PENDING` say "Already decided or expired".

### 5.5 Supervision, trace and dead letters

- **Everyone's runs** (`scope=all`): initiator (person or "API client"), workflow, status, classification, tokens. Content opens MASKED; "Reveal personal data" (`pii:reveal`) behind a confirmation that it is audited; never cache revealed content.
- **Trace:** `GET …/trace` returns a reconstruction from the audit chain; show `complete` prominently ("Every promised record is present") and list `problems` if any. Treat `trace` as a structured document (render steps, predecessors, versions, tool calls).
- **Dead letters:** node, type, iteration, attempts, error code and class, time, run status; link to the run and offer Resume when the run is FAILED or TIMED_OUT.

### 5.6 Audit

Filters (action, action prefix, severity, status, actor type and id, resource type and id, request id, IP, time window), paginated table, record detail with redacted metadata. Statistics cards. "Verify chain" (`audit:verify`) with the result banner ("Verified 4,120 records" / "Broken at record 1,042: content altered"). "Export" (`audit:export`) downloads NDJSON for a window; optionally run `checkExportLinks` before offering the file. Archives list with download.

### 5.7 Command Centre

Overview cards per section; charts from `timeseries` (every bucket present; `null` = "no data", not 0); rankings (agents and models for everyone with `usage:read`; members and API keys only with `quota:manage`, and label the view "who uses what"); the security feed with "Load older" (`before` = the last row's `at`). Resolve ids through the Phase 2–4 lists; show "Deleted …" when unknown.

### 5.8 Governance

- **Quotas:** platform rows first (read-only, labelled "Set by the platform"), then workspace rows; gauges from `usage`/`rate` (Appendix A `quotaGauge`); history drawer. Editor (`quota:manage`): scope, subject picker (member → **user id**, agent, API key), period, limit, HARD/SOFT, alert threshold, label. Raising a limit or HARD→SOFT shows "This relaxes a control; it is audited".
- **My quotas** (`quotas/me`): a compact panel in the account menu or chat composer.
- **Circuits:** open circuits with agent name, reason (`RUNAWAY_SPEND` "spent unusually many tokens", `REPEATED_FAILURES` "failed repeatedly"), opened time and a countdown to `retryAt`; "Close now" (`quota:manage` or `agent:update`).
- **Notifications:** toast quota alerts and circuit openings from the socket; link to the governance page.

### 5.9 Account data

"Download my data" (warn: "The file contains your conversations and workflow inputs in clear text"), limited to 5 per hour — show the countdown on 429. "Erase my account": a danger zone that first checks ownership (list workspaces you own with other members — from Phase 1/2 data — and link to "Transfer ownership"), then asks for the password, a TOTP or recovery code if MFA is on, and the typed phrase `ERASE MY ACCOUNT`. On success: clear every cache and store, close sockets, sign out locally, show the outcome counts, and route to the public landing page.

## 6. Validation and wire models

Use JSON booleans and numbers. Omit untouched fields. Unknown properties are 422 everywhere except inside `graph` (dropped when valid) and tool `http.body`/`parameters` (free-form JSON validated by their own rules).

### Body fields

| DTO / field | Contract |
|---|---|
| **Tool create** `name` | required, `^[a-z][a-z0-9_]{2,47}$`; unique among live tools of the workspace and not a built-in name (409 `TOOL_NAME_TAKEN`); immutable |
| `displayName` | required, trimmed, 1–80 |
| `description` | required, trimmed, 10–1,000 |
| `parameters` | required object: a JSON Schema of the supported subset with `type: "object"` at the root (below) |
| `http` | required `{method, url, query?, headers?, body?, auth, responsePath?}` (section 4.1.1); `auth.headerName` required for `header`, `auth.username` for `basic` |
| `dataPolicy` | optional, partial `{maxClassification, minIntegrity, piiArguments, sideEffects}`; omitted fields take the defaults |
| `requiresApproval`, `enabled` | optional booleans (default false, true) |
| `timeoutMs` | optional integer 500–600,000, clamped to `TOOL_MAX_TIMEOUT` |
| `secret` | optional string ≤4,096, write-only |
| **Tool update** | every create field except `name` optional; `secret` may be `null` (removes it); `expectedVersion` integer ≥1. A partial `dataPolicy` merges with the current policy |
| **Tool test** `arguments` | required object, validated by the tool's schema at execution (a violation is a `denied` outcome, not a 422) |
| **Workflow create** `name` | required, trimmed, 1–80, unique ignoring case among live workflows (409 `WORKFLOW_NAME_TAKEN`) |
| `description` | optional ≤2,000 (`null` clears) |
| `graph` | optional object (default trigger → output); ≤512 KB |
| `settings` | optional `{maxSteps 2–10,000, maxTokens 1,000–100,000,000, runTimeoutMs ≥1,000}`, each clamped to the platform ceiling |
| **Workflow update** | `name` (not null), `description` (`null` clears) |
| **Save definition** | `graph` required; `settings`, `changeNote` ≤500, `expectedVersion` ≥1 optional |
| **Validate** | `graph` required object |
| **Publish** | `version` optional ≥1 (default current) |
| **Restore** | `changeNote` optional ≤500 |
| **Start run** `input` | required object, checked against the trigger's `inputSchema` (422 `WORKFLOW_INPUT_INVALID` `{issues}`), ≤64 KB (413) |
| `idempotencyKey` | optional ≤128 |
| `version` | optional ≥1: a test run (needs `workflow:update`) |
| **Approval decision** `decision` | `approve` / `reject` |
| `comment` | optional ≤2,000, stored encrypted |
| **Quota create** `scope`, `period` | required enums |
| `subjectId` | UUID, required unless `ORGANIZATION` (ignored then); must exist in the workspace (422) |
| `tokenLimit` | required integer 1–10¹² |
| `enforcement` | `HARD` (default) / `SOFT` |
| `alertThreshold` | integer 1–100 (default 80) |
| `label` | optional ≤120 |
| **Quota update** | `tokenLimit`, `enforcement`, `alertThreshold` optional; `label` optional, `null` clears |
| **Erase account** `password` | required ≤1,024 |
| `confirmation` | exactly `ERASE MY ACCOUNT` |
| `code` / `recoveryCode` | six digits (spaces allowed) / ≤32; one required when MFA is on |

`null` is accepted **only** where the table says it clears: workflow `description`, tool `secret`, quota `label`. Anywhere else it is 422 naming the field (P5-G02; verified for every Phase 5 body).

**JSON Schema subset** (tool parameters, trigger input schemas, agent output schemas): `type` (or an array of types), `title`, `description`, `enum` (≤100), `const`, `default` (applied to absent properties), `examples`, `minLength`/`maxLength` (≤100,000), `format` (`email`, `uri`, `uuid`, `date`, `date-time`), `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`, `properties`, `required`, `additionalProperties` (boolean), `items` (one schema), `minItems`/`maxItems`/`uniqueItems`, `$schema`. **Refused:** `$ref`, `$defs`, `pattern`, `patternProperties`, `oneOf`, `anyOf`, `allOf`, `not`, `if` and anything else. Nesting ≤6, ≤100 properties, property names are identifiers ≤64 (not `__proto__`, `constructor`, `prototype`).

### Query parameters

| List | Inputs | Ordering and notes |
|---|---|---|
| Tools (01) | `page`, `limit` 1–100, `search` (name or display name), `kind` `BUILTIN`/`HTTP` | built-ins first, then HTTP tools by name; paged in memory |
| Ledger (03) | `page`, `limit`, `toolId` (UUID, built-in ids included), `runId` (UUID) | newest first |
| Workflows (08) | `page`, `limit`, `search` (name), `status` `DRAFT`/`ACTIVE`/`ARCHIVED` | last updated first |
| Versions (15) | `page`, `limit` | newest first |
| Runs (22) | `page`, `limit`, `scope` `mine`/`all`, `status`, `workflowId` (UUID) | newest first |
| Run content (24, 25) | `reveal=true` | needs `pii:reveal` |
| Dead letters (31) | `page`, `limit` | newest first |
| Audit (33) | `page`, `limit`, `action` (exact, enum), `actionPrefix`, `status`, `severity`, `actorType`, `actorId` (UUID), `resourceType`, `resourceId`, `requestId`, `ipAddress`, `from`, `to` | newest first |
| Verify (35) | `maxRecords` (positive integer; anything non-numeric is ignored and the whole chain is checked, P5-G10) | |
| Export (36) | `from`, `to` (ISO dates; 422 otherwise) | oldest first |
| Analytics (39–42) | `from`, `to`; timeseries `metric` (required), `interval` `day`/`hour`; top `dimension` (required), `limit` 1–50; security `limit` 1–200, `before` | windows ≤400 days (hourly ≤14) |
| Quota history (48) | `periods` 1–36 (default 12) | newest first |

### Response types

These are the exact Appendix A `phase5-types.ts`; every top-level field was asserted on live responses (the `… shape` checks in the results file).

```ts
// Phase 5 wire types (handoff section 6). Every field was read from the DTOs and
// services and asserted on live responses by the verification harness.

export type UUID = string;
export type ISODate = string;
export type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type Integrity = 'TRUSTED' | 'INTERNAL' | 'EXTERNAL';

// ── Tools ───────────────────────────────────────────────────────────────────

export type ToolKind = 'BUILTIN' | 'HTTP';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type HttpAuth =
  | { type: 'none' }
  | { type: 'bearer' }
  | { type: 'header'; headerName: string }
  | { type: 'basic'; username: string };

export interface HttpToolConfig {
  method: HttpMethod;
  /** Fixed https origin + path; `{{param}}` placeholders only in the path. */
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** JSON body (POST/PUT/PATCH); string leaves may be templates. */
  body?: unknown;
  auth: HttpAuth;
  /** JSON pointer into the response, e.g. `/data/items`. */
  responsePath?: string;
}

export interface ToolDataPolicy {
  /** Most sensitive context that may flow into the tool. */
  maxClassification: Classification;
  /** Least trusted context the tool may be called from. */
  minIntegrity: Integrity;
  /** deny: calls carrying personal data are refused; unmask: real values are sent. */
  piiArguments: 'unmask' | 'deny';
  sideEffects: boolean;
}

/** The JSON Schema subset tools, trigger inputs and agent outputs use. */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'uri' | 'uuid' | 'date' | 'date-time';
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface Tool {
  id: UUID;                       // built-ins: the same name-based UUID in every workspace
  kind: ToolKind;
  name: string;                   // what the model calls it by
  displayName: string;
  description: string;
  parameters: JsonSchema;
  dataPolicy: ToolDataPolicy;
  resultIntegrity: Integrity;
  requiresApproval: boolean;
  requiredPermissions: string[];  // beyond tool:execute
  timeoutMs: number;
  version: number;
  digest: string;
  enabled: boolean;
  available: boolean;             // false: a dependency is not configured on this deployment
  // HTTP tools only:
  http?: HttpToolConfig;
  hasSecret?: boolean;
  createdAt?: ISODate | null;
  updatedAt?: ISODate | null;
}

export interface CreateToolInput {
  name: string;
  displayName: string;
  description: string;
  parameters: JsonSchema;
  http: HttpToolConfig;
  dataPolicy?: Partial<ToolDataPolicy>;
  requiresApproval?: boolean;
  timeoutMs?: number;
  enabled?: boolean;
  secret?: string;                // write-only
}
export interface UpdateToolInput extends Partial<Omit<CreateToolInput, 'name' | 'secret'>> {
  secret?: string | null;         // null removes the credential; omit to keep it
  expectedVersion?: number;
}

export type ToolExecutionStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'DENIED';
export type ToolDenialReason =
  | 'NOT_GRANTED' | 'DISABLED' | 'PERMISSION' | 'ARGUMENTS' | 'CONFIDENTIALITY' | 'INTEGRITY'
  | 'PII' | 'EGRESS' | 'APPROVAL' | 'CALL_LIMIT' | 'RECIPIENT' | 'DUPLICATE';

export interface ToolExecution {
  id: UUID;
  createdAt: ISODate;
  completedAt: ISODate | null;
  toolName: string;
  toolId: UUID | null;
  toolVersion: number | null;
  status: ToolExecutionStatus;
  denialReason: ToolDenialReason | null;
  errorCode: string | null;
  agentId: UUID | null;
  conversationId: UUID | null;
  workflowRunId: UUID | null;
  workflowStepId: UUID | null;
  durationMs: number | null;
  resultBytes: number;
  contextClassification: Classification | null;
  contextIntegrity: Integrity | null;
  sideEffects: boolean;
  argumentsDigest: string | null; // keyed digest: equal calls match, nothing is revealed
}

export type ToolTestResult =
  | { status: 'ok'; executionId: UUID; durationMs: number; content: string; truncated: boolean }
  | { status: 'error' | 'denied'; executionId: UUID; durationMs: number; code: string; message: string };

// ── Workflow graphs (docs/contracts/workflow-graph-v1.md) ───────────────────

export type NodeType = 'trigger' | 'agent' | 'tool' | 'retrieval' | 'condition' | 'supervisor' | 'approval' | 'output';
export interface RetryPolicy { maxAttempts?: number; backoffMs?: number }
export type ConditionOperator =
  | 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'is_true' | 'is_false' | 'is_empty' | 'is_not_empty';
/** gt/gte/lt/lte need a numeric operand; the unary operators (is_*) take none. */
export interface ConditionRule { id: string; value: string; operator: ConditionOperator; operand?: string | number | boolean; caseSensitive?: boolean }

export interface NodeDataByType {
  trigger: { inputSchema?: JsonSchema };
  agent: {
    agentId: UUID; prompt?: string; useTools?: boolean; maxToolIterations?: number;
    output?: { format: 'text' } | { format: 'json'; schema: JsonSchema };
    timeoutMs?: number; retry?: RetryPolicy;
  };
  tool: { toolId: UUID; arguments: Record<string, unknown>; timeoutMs?: number; retry?: RetryPolicy };
  retrieval: { query: string; knowledgeBaseIds?: UUID[]; topK?: number };
  condition: { rules: ConditionRule[] };
  supervisor: { strategy: 'llm' | 'round_robin'; agentId?: UUID; goal?: string; maxRounds?: number };
  approval: { message?: string; timeoutMs?: number; onTimeout?: 'reject' | 'approve'; allowSelfApproval?: boolean };
  output: { value?: string };
}
export type GraphNode = {
  [T in NodeType]: { id: string; type: T; label?: string; position?: { x: number; y: number }; data: NodeDataByType[T] };
}[NodeType];
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Which outcome of the source the edge follows; absent = 'out'. */
  sourceHandle?: string;
  data?: { loop?: { maxIterations: number; onExhausted?: 'fall_through' | 'fail' } };
}
export interface WorkflowGraph {
  schemaVersion: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface NodeTypeDescriptor {
  type: NodeType;
  label: string;
  description: string;
  outputs: string[];              // `rule:<id>` = one handle per condition rule
  produces: 'json' | 'text' | 'passages' | 'none' | 'text-or-json';
  multiple: boolean;
  fields: Array<{
    name: string;
    type: 'uuid' | 'string' | 'template' | 'integer' | 'boolean' | 'enum' | 'object' | 'array' | 'json-schema';
    required: boolean;
    description: string;
    options?: string[];
  }>;
}

export interface GraphIssue { code: string; message: string; nodeId?: string; edgeId?: string }
export interface ValidationReport { valid: boolean; errors: GraphIssue[]; warnings: GraphIssue[]; stepBound: number | null }

export interface WorkflowSettings { maxSteps?: number; maxTokens?: number; runTimeoutMs?: number }
export type WorkflowStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export interface WorkflowVersion {
  version: number;
  graph: WorkflowGraph;           // what the server understood: reload the canvas from it
  settings: WorkflowSettings;
  digest: string;
  valid: boolean;
  validation: ValidationReport;
  changeNote: string | null;
  restoredFromVersion: number | null;
  createdById: UUID | null;
  createdAt: ISODate;
  isCurrent: boolean;
  isPublished: boolean;
}
export interface WorkflowSummary {
  id: UUID;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  currentVersion: number;
  publishedVersion: number | null;
  createdById: UUID | null;
  publishedAt: ISODate | null;
  lastRunAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}
export interface Workflow extends WorkflowSummary { definition: WorkflowVersion }

// ── Runs ────────────────────────────────────────────────────────────────────

export type RunStatus = 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
export type StepStatus = 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
export type FailureClass = 'TRANSIENT' | 'PERMANENT' | 'TIMEOUT' | 'POLICY';

export interface Run {
  id: UUID;
  workflowId: UUID;
  workflowVersion: number;
  status: RunStatus;
  trigger: 'MANUAL' | 'API';
  initiatorUserId: UUID | null;
  initiatorApiKeyId: UUID | null;
  classification: Classification;  // the most sensitive data the run touched
  integrity: Integrity;
  maxSteps: number;
  stepsScheduled: number;
  maxTokens: number;
  tokensUsed: number;
  toolCalls: number;
  errorCode: string | null;
  errorStepId: UUID | null;
  createdAt: ISODate;
  startedAt: ISODate | null;
  completedAt: ISODate | null;
  deadlineAt: ISODate;
  duplicate?: boolean;            // returned for a repeated idempotency key
}
export interface StepApproval {
  requestedAt: ISODate;
  expiresAt: ISODate;
  decision?: 'approved' | 'rejected';
  decidedAt?: ISODate;
  decidedBy?: 'person' | 'timeout';
  decidedById?: UUID | null;
}
export interface StepToolCall { executionId: UUID; tool: string; status: 'ok' | 'error' | 'denied'; code?: string; reason?: string; durationMs: number }
export interface Step {
  id: UUID;
  nodeId: string;
  nodeType: NodeType;
  iteration: number;
  status: StepStatus;
  handles: string[];              // the outcome taken: which edges are live
  predecessors: string[];         // "nodeId#iteration"
  attempt: number;
  maxAttempts: number;
  classification: Classification;
  integrity: Integrity;
  agentId: UUID | null;
  agentVersion: number | null;
  toolId: UUID | null;
  toolVersion: number | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  toolCalls: StepToolCall[];
  errorCode: string | null;
  failureClass: FailureClass | null;
  deadLettered: boolean;
  approval: StepApproval | null;
  inputBytes: number;
  outputBytes: number;
  startedAt: ISODate | null;
  completedAt: ISODate | null;
  durationMs: number | null;
  createdAt: ISODate;
}
export interface RunDetail extends Run { steps: Step[] }

export interface StartRunInput { input: Record<string, unknown>; idempotencyKey?: string; version?: number }

export type ContentState = 'VISIBLE' | 'MASKED' | 'WITHHELD';
export type RunWithheldReason = 'CLEARANCE' | 'COMPARTMENT' | 'SOURCE_DELETED' | 'REDACTION_UNAVAILABLE' | 'NOT_AVAILABLE';
export interface ContentView {
  contentState: ContentState;
  withheldReason?: RunWithheldReason;
  input?: unknown;                // null when withheld
  output?: unknown;
  classification: Classification;
}

export interface ApprovalItem {
  runId: UUID;
  stepId: UUID;
  workflowId: UUID;
  nodeId: string;
  requestedAt: ISODate;
  expiresAt: ISODate;
  initiatorUserId: UUID | null;
  classification: Classification;
  message: string | null;         // null when you are not cleared for the step's label
  canDecide: boolean;
}
export interface ApprovalDecisionInput { decision: 'approve' | 'reject'; comment?: string }

export interface DeadLetter {
  runId: UUID;
  stepId: UUID;
  workflowId: UUID;
  workflowVersion: number;
  nodeId: string;
  nodeType: NodeType;
  iteration: number;
  attempts: number;
  errorCode: string | null;
  failureClass: FailureClass | null;
  deadLetteredAt: ISODate;
  runStatus: RunStatus;
}
export interface RunTrace { runId: UUID; complete: boolean; problems: string[]; trace: Record<string, unknown> }

// ── Real-time ───────────────────────────────────────────────────────────────

export interface ReadyPayload { organizationId: UUID; rooms: string[]; expiresAt: number | null; serverTime: ISODate }
export type EventDatum = string | number | boolean | null | string[] | number[];
export type RealtimeEventType =
  | 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.timed_out'
  | 'step.queued' | 'step.started' | 'step.retrying' | 'step.completed' | 'step.failed' | 'step.skipped'
  | 'step.waiting_approval' | 'tool.called' | 'tool.denied' | 'approval.requested' | 'approval.decided';
export interface RealtimeEvent {
  id: string;                     // stream position "<ms>-<seq>": keep the newest for resume
  type: RealtimeEventType;
  organizationId: UUID;
  at: ISODate;
  runId?: UUID;
  workflowId?: UUID;
  stepId?: UUID;
  nodeId?: string;
  initiatorUserId?: UUID;
  data: Record<string, EventDatum>;
}
export type NotificationKind = 'agent_email' | 'quota.threshold' | 'quota.exhausted' | 'agent.circuit_opened';
export interface NotificationEvent {
  id: string;
  type: 'notification';
  organizationId: UUID;
  at: ISODate;
  runId?: UUID;
  data: { kind: NotificationKind } & Record<string, EventDatum>;
}
export type Ack<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; code: string; message: string };
export type SubscribeAck = Ack<{ runId: UUID; replayed: number; events: RealtimeEvent[] }>;
export type ResumeAck = Ack<{ replayed: number; events: Array<RealtimeEvent | NotificationEvent> }>;
export type RefreshAck = Ack<{ expiresAt: number }>;

// ── Audit ───────────────────────────────────────────────────────────────────

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export interface AuditLog {
  id: UUID;
  sequence: string;               // bigint as a string
  action: string;
  status: string;
  severity: AuditSeverity;
  actorType: string;
  actorId: UUID | null;
  actorLabel: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  httpMethod: string | null;
  httpPath: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: ISODate;
}
export interface AuditStatistics {
  totalRecords: string;
  headSequence: string;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  topActions: Array<{ action: string; count: number }>;
}
export interface ChainVerification {
  organizationId: UUID;
  valid: boolean;
  recordsChecked: number;
  brokenAtSequence?: string;
  brokenRecordId?: UUID;
  reason?: string;
  verifiedAt: ISODate;
  prunedThroughSequence?: string;
  anchors?: number;
}
export interface AuditArchive {
  sequence: string;
  firstSequence: string;
  recordsPruned: number;
  cutoff: ISODate;
  archived: boolean;
  archiveSha256: string | null;
  createdAt: ISODate;
}
/** One line of the NDJSON export: the stored record, with its chain fields. */
export interface AuditExportLine extends Omit<AuditLog, 'createdAt'> {
  organizationId: UUID;
  previousHash: string;
  hash: string;
  createdAt: ISODate;
}

// ── Analytics ───────────────────────────────────────────────────────────────

export interface UsageSummary {
  from: ISODate; to: ISODate;
  totals: {
    invocations: number; completed: number; failed: number; cancelled: number; refused: number;
    blocked: number; throttled: number; promptTokens: number; completionTokens: number;
    entitiesMasked: number; degradedRedactions: number; estimatedTokenCounts: number;
  };
  latencyMs: { totalP50: number | null; totalP95: number | null; timeToFirstTokenP50: number | null; timeToFirstTokenP95: number | null };
  redactionOverhead: { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; shareOfTotal: number | null };
  byModel: Array<{ model: string; invocations: number; promptTokens: number; completionTokens: number; totalP50Ms: number | null }>;
  byAgent: Array<{ agentId: UUID | null; invocations: number; promptTokens: number; completionTokens: number }>;
}
export interface AnalyticsOverview {
  from: ISODate;
  to: ISODate;
  inference: UsageSummary;
  activity: { activeMembers: number; activeApiKeys: number; activeAgents: number; conversationsStarted: number; turns: number };
  workflows: {
    runs: number; completed: number; failed: number; cancelled: number; timedOut: number; active: number;
    durationP50Ms: number | null; durationP95Ms: number | null; tokens: number; deadLetters: number;
  };
  tools: { calls: number; succeeded: number; failed: number; timedOut: number; denied: number; denialsByReason: Record<string, number> };
  knowledge: { documentsByStatus: Record<string, number>; storedBytes: number; retrievalQueries: number; withheldEvents: number };
  privacy: { entitiesMasked: number; entitiesByType: Record<string, number>; egressBlocked: number; refusedForRedaction: number; degradedRedactions: number };
  governance: { throttledCalls: number; budgetExhaustions: number; rateLimitEvents: number; circuitBreaks: number; openCircuits: number; budgetsNearLimit: number };
  security: { bySeverity: Record<string, number>; topAlerts: Array<{ action: string; count: number }>; failedSignIns: number; accessDenials: number };
}
export type SeriesMetric =
  | 'tokens' | 'invocations' | 'throttled' | 'failures' | 'latency_p95' | 'ttft_p95' | 'redaction_p95'
  | 'entities_masked' | 'workflow_runs' | 'workflow_failures' | 'tool_calls' | 'tool_denials'
  | 'security_events' | 'rag_queries';
export interface Timeseries { metric: SeriesMetric; interval: 'hour' | 'day'; from: ISODate; to: ISODate; points: Array<{ at: ISODate; value: number | null }> }
export type TopDimension = 'agents' | 'models' | 'members' | 'api_keys';
export interface TopEntry { key: string | null; label: string | null; invocations: number; tokens: number; throttled: number }
export interface SecurityEvent {
  id: UUID; at: ISODate; action: string; severity: 'WARNING' | 'CRITICAL'; status: string; actorType: string;
  actorLabel: string | null; resourceType: string | null; resourceId: string | null; errorCode: string | null;
  ipAddress: string | null; requestId: string | null;
}

// ── Quotas and circuits ─────────────────────────────────────────────────────

export type QuotaScope = 'ORGANIZATION' | 'MEMBER' | 'AGENT' | 'API_KEY';
export type QuotaPeriod = 'MINUTE' | 'DAY' | 'MONTH';
export interface Quota {
  id: UUID;
  scope: QuotaScope;
  subjectId: UUID | null;         // user id (MEMBER), agent id or API key id
  period: QuotaPeriod;
  tokenLimit: number;
  enforcement: 'HARD' | 'SOFT';
  alertThreshold: number;         // percent
  managedBy: 'WORKSPACE' | 'PLATFORM';
  label: string | null;
  usage: { used: number; reserved: number; remaining: number; percent: number; periodStart: ISODate; resetsAt: ISODate } | null;
  rate: { available: number | null } | null;
}
export interface CreateQuotaInput {
  scope: QuotaScope; subjectId?: UUID; period: QuotaPeriod; tokenLimit: number;
  enforcement?: 'HARD' | 'SOFT'; alertThreshold?: number; label?: string;
}
export interface UpdateQuotaInput { tokenLimit?: number; enforcement?: 'HARD' | 'SOFT'; alertThreshold?: number; label?: string | null }
export interface QuotaHistoryEntry { periodStart: ISODate; tokensUsed: number; requests: number; rejected: number; alertedAt: ISODate | null; exhaustedAt: ISODate | null }
export interface AgentCircuit { agentId: UUID; state: 'closed' | 'open'; reason?: 'RUNAWAY_SPEND' | 'REPEATED_FAILURES'; openedAt?: ISODate; retryAt?: ISODate }

// ── Personal data ───────────────────────────────────────────────────────────

export interface PersonalDataExport {
  format: 'daiap-personal-data/v1';
  generatedAt: ISODate;
  notice: string;
  account: Record<string, unknown>;
  memberships: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  workflowRuns: Array<Record<string, unknown>>;
  apiKeys: Array<Record<string, unknown>>;
  usage: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
  truncated: string[];
}
export interface EraseAccountInput { password: string; confirmation: 'ERASE MY ACCOUNT'; code?: string; recoveryCode?: string }
export interface ErasureOutcome {
  erased: true;
  workspacesDeleted: UUID[];
  conversationsShredded: number;
  workflowRunsShredded: number;
  apiKeysRevoked: number;
  membershipsEnded: number;
}
```

## 7. Complete endpoint register

All workspace paths are relative to `/api/v1/organizations/:organizationId`. Policies: D default, W workflow (30/60 s), E email (5/h), A auth. "Keys" = also accepts an API key.

| ID | Method | Path | Permission | Keys | Success | Policy | Payload |
|---|---|---|---|---|---|---|---|
| P5-API-01 | GET | `/tools` | tool:read | yes | 200 | D | Tool[] + pagination |
| P5-API-02 | POST | `/tools` | tool:create | no | 201 | D | Tool |
| P5-API-03 | GET | `/tools/executions` | tool:read + usage:read | yes | 200 | D | ToolExecution[] + pagination |
| P5-API-04 | GET | `/tools/:toolId` | tool:read | yes | 200 | D | Tool |
| P5-API-05 | PATCH | `/tools/:toolId` | tool:update | no | 200 | D | Tool |
| P5-API-06 | DELETE | `/tools/:toolId` | tool:delete | no | 200 | D | `{deleted: true}` |
| P5-API-07 | POST | `/tools/:toolId/test` | tool:update + tool:execute | no | 200 | D | ToolTestResult |
| P5-API-08 | GET | `/workflows` | workflow:read | yes | 200 | D | WorkflowSummary[] + pagination |
| P5-API-09 | GET | `/workflows/node-types` | workflow:read | yes | 200 | D | `{nodeTypes: NodeTypeDescriptor[]}` |
| P5-API-10 | POST | `/workflows/validate` | workflow:create \| workflow:update | no | 200 | D | ValidationReport |
| P5-API-11 | POST | `/workflows` | workflow:create | no | 201 | D | Workflow |
| P5-API-12 | GET | `/workflows/:workflowId` | workflow:read | yes | 200 | D | Workflow |
| P5-API-13 | PATCH | `/workflows/:workflowId` | workflow:update | no | 200 | D | Workflow |
| P5-API-14 | PUT | `/workflows/:workflowId/definition` | workflow:update | no | 200 | D | Workflow |
| P5-API-15 | GET | `/workflows/:workflowId/versions` | workflow:read | yes | 200 | D | WorkflowVersion[] + pagination |
| P5-API-16 | GET | `/workflows/:workflowId/versions/:version` | workflow:read | yes | 200 | D | WorkflowVersion |
| P5-API-17 | POST | `/workflows/:workflowId/versions/:version/restore` | workflow:update | no | **201** | D | Workflow |
| P5-API-18 | POST | `/workflows/:workflowId/publish` | workflow:publish | no | 200 | D | Workflow |
| P5-API-19 | POST | `/workflows/:workflowId/archive` | workflow:publish | no | 200 | D | Workflow |
| P5-API-20 | DELETE | `/workflows/:workflowId` | workflow:delete | no | 200 | D | `{deleted: true}` |
| P5-API-21 | POST | `/workflows/:workflowId/runs` | workflow:execute | yes | **202** | W | Run |
| P5-API-22 | GET | `/workflow-runs` | workflow:read (+read_all for `scope=all`) | yes | 200 | D | Run[] + pagination |
| P5-API-23 | GET | `/workflow-runs/:runId` | workflow:read | yes | 200 | D | RunDetail |
| P5-API-24 | GET | `/workflow-runs/:runId/content` | workflow:read (+pii:reveal for `reveal`) | yes | 200 | D | ContentView |
| P5-API-25 | GET | `/workflow-runs/:runId/steps/:stepId/content` | workflow:read (+pii:reveal) | yes | 200 | D | ContentView |
| P5-API-26 | GET | `/workflow-runs/:runId/trace` | workflow:read + audit:read | no | 200 | D | RunTrace |
| P5-API-27 | POST | `/workflow-runs/:runId/cancel` | workflow:execute (+ workflow:update for others' runs) | yes | 200 | D | Run |
| P5-API-28 | POST | `/workflow-runs/:runId/resume` | workflow:execute (+ workflow:update for others' runs) | yes | 200 | D | Run |
| P5-API-29 | GET | `/workflow-runs/approvals` | workflow:approve | no | 200 | D | ApprovalItem[] |
| P5-API-30 | POST | `/workflow-runs/:runId/steps/:stepId/approval` | workflow:approve | no | 200 | D | Run |
| P5-API-31 | GET | `/workflow-runs/dead-letters` | workflow:update | no | 200 | D | DeadLetter[] + pagination |
| P5-API-32 | DELETE | `/workflow-runs/:runId` | workflow:read (own) / workflow:delete | yes | 200 | D | `{deleted: true}` |
| P5-API-33 | GET | `/audit-logs` | audit:read | no | 200 | D | AuditLog[] + pagination |
| P5-API-34 | GET | `/audit-logs/statistics` | audit:read | no | 200 | D | AuditStatistics |
| P5-API-35 | GET | `/audit-logs/verify` | audit:verify | no | 200 | D | ChainVerification |
| P5-API-36 | GET | `/audit-logs/export` | audit:export | no | 200 NDJSON | D | file |
| P5-API-37 | GET | `/audit-logs/archives` | audit:read | no | 200 | D | AuditArchive[] |
| P5-API-38 | GET | `/audit-logs/archives/:sequence` | audit:export | no | 200 NDJSON | D | file |
| P5-API-39 | GET | `/analytics/overview` | usage:read | yes | 200 | D | AnalyticsOverview |
| P5-API-40 | GET | `/analytics/timeseries` | usage:read | yes | 200 | D | Timeseries |
| P5-API-41 | GET | `/analytics/top` | usage:read (+quota:manage for members/api_keys) | yes | 200 | D | TopEntry[] |
| P5-API-42 | GET | `/analytics/security-events` | audit:read \| security:read | no | 200 | D | SecurityEvent[] |
| P5-API-43 | GET | `/quotas` | usage:read \| quota:manage | no | 200 | D | Quota[] |
| P5-API-44 | GET | `/quotas/me` | usage:read \| llm:invoke \| agent:execute | yes | 200 | D | Quota[] |
| P5-API-45 | POST | `/quotas` | quota:manage | no | 201 | D | Quota |
| P5-API-46 | PATCH | `/quotas/:quotaId` | quota:manage | no | 200 | D | Quota |
| P5-API-47 | DELETE | `/quotas/:quotaId` | quota:manage | no | 200 | D | `{deleted: true}` |
| P5-API-48 | GET | `/quotas/:quotaId/history` | usage:read \| quota:manage | no | 200 | D | QuotaHistoryEntry[] |
| P5-API-49 | GET | `/circuits` | usage:read \| quota:manage \| agent:read | no | 200 | D | AgentCircuit[] (open only) |
| P5-API-50 | GET | `/circuits/agents/:agentId` | usage:read \| quota:manage \| agent:read | no | 200 | D | AgentCircuit |
| P5-API-51 | DELETE | `/circuits/agents/:agentId` | quota:manage \| agent:update | no | 200 | D | `{reset: true, wasOpen}` |
| P5-API-52 | GET | `/api/v1/auth/me/export` | signed in | no | 200 JSON file | E | PersonalDataExport |
| P5-API-53 | DELETE | `/api/v1/auth/me` | signed in | no | 200 | A | ErasureOutcome |

Socket.IO messages (path `/realtime`), all acknowledged:

| ID | Direction | Name | Payload → ack / data |
|---|---|---|---|
| P5-RT-01 | handshake | `auth` | `{token, organizationId}` or `{apiKey}` → `ready` or `connect_error {data: {code}}` |
| P5-RT-02 | server → client | `ready` | `{organizationId, rooms, expiresAt, serverTime}` |
| P5-RT-03 | client → server | `subscribe` | `{runId, lastEventId?}` → `{ok, runId, replayed, events}` |
| P5-RT-04 | client → server | `unsubscribe` | `{runId}` → `{ok, runId}` |
| P5-RT-05 | client → server | `resume` | `{lastEventId}` → `{ok, replayed, events}` |
| P5-RT-06 | client → server | `auth:refresh` | `{token}` → `{ok, expiresAt}` |
| P5-RT-07 | server → client | `event` | RealtimeEvent |
| P5-RT-08 | server → client | `notification` | NotificationEvent |
| P5-RT-09 | server → client | `auth:expired`, `auth:revoked`, `error` | `{code}`; the socket closes |


## 8. Detailed endpoint contracts

Common headers, validation and envelopes from section 2 apply to every operation. Errors listed are in addition to the common 401, 403 `PERMISSION_DENIED`, 404 `ORGANIZATION_NOT_FOUND` (non-members, verified on every area), 422 and 429. "Verified" means produced in the live run; samples are trimmed with `…` and contain synthetic data only.

### Tools

#### P5-API-01 — List tools

`GET /tools?page=1&limit=20&kind=HTTP&search=echo` → **200**, `data: Tool[]`, `meta.pagination`. Built-ins first (always four on this deployment, the same ids everywhere), then the workspace's HTTP tools by name; `search` matches name or display name; `kind` filters (verified: `BUILTIN`, `HTTP` empty before any was defined, `search=calc`). 422 for an unknown `kind` or `limit` above 100 (verified). API keys with `tool:read` may list (verified). Built-in sample:

```json
{
 "id": "b7c95b5c-b839-57cd-a4e0-9ab9aeabcd10",
 "kind": "BUILTIN",
 "name": "calculator",
 "displayName": "Calculator",
 "description": "Evaluates an arithmetic expression exactly. Use it for any calculation instead of working it out yourself. Supports + - * / % ^, parentheses, sqrt, abs, round(x…",
 "parameters": {
  "type": "object",
  "properties": {
   "expression": {
    "type": "string",
    "minLength": 1,
    "maxLength": 500,
    "description": "The expression to evaluate. Numbers without thousands separators."
   }
  },
  "required": [
   "expression"
  ],
  "additionalProperties": false
 },
 "dataPolicy": {
  "maxClassification": "RESTRICTED",
  "minIntegrity": "EXTERNAL",
  "piiArguments": "unmask",
  "sideEffects": false
 },
 "resultIntegrity": "TRUSTED",
 "requiresApproval": false,
 "requiredPermissions": [],
 "timeoutMs": 2000,
 "version": 1,
 "digest": "af72965930a9db1782fe113019bb43f78451d7f3b2a2908ed4e5bec9701bea50",
 "enabled": true,
 "available": true
}
```

#### P5-API-02 — Define an HTTP tool

`POST /tools` → **201**, `data: Tool` (version 1).

```json
{"name":"echo_lookup","displayName":"Echo lookup","description":"Echoes a query string back from a public test service.",
 "parameters":{"type":"object","properties":{"q":{"type":"string","minLength":1,"maxLength":200}},"required":["q"],"additionalProperties":false},
 "http":{"method":"GET","url":"https://postman-echo.com/get","query":{"q":"{{q}}"},"auth":{"type":"none"},"responsePath":"/args"}}
```

Verified response:

```json
{
 "id": "fca923c7-1600-4036-bb6f-5613e901b30e",
 "kind": "HTTP",
 "name": "echo_lookup",
 "displayName": "Echo lookup",
 "description": "Echoes a query string back from a public test service.",
 "parameters": {
  "type": "object",
  "required": [
   "q"
  ],
  "properties": {
   "q": {
    "type": "string",
    "maxLength": 200,
    "minLength": 1,
    "description": "Text to echo."
   }
  },
  "additionalProperties": false
 },
 "dataPolicy": {
  "sideEffects": false,
  "minIntegrity": "EXTERNAL",
  "piiArguments": "deny",
  "maxClassification": "PUBLIC"
 },
 "resultIntegrity": "EXTERNAL",
 "requiresApproval": false,
 "requiredPermissions": [],
 "timeoutMs": 15000,
 "version": 1,
 "digest": "a73d40f4649487f1a9f9949dfa0f8a2a55d4d4553d6853256dcddffa837c47d4",
 "enabled": true,
 "available": true,
 "http": {
  "url": "https://postman-echo.com/get",
  "auth": {
   "type": "none"
  },
  "query": {
   "q": "{{q}}"
  },
  "method": "GET",
  "responsePath": "/args"
 },
 "hasSecret": false,
 "createdAt": "2026-10-07T00:02:41.396Z",
 "updatedAt": "2026-10-07T00:02:41.396Z"
}
```

Errors, all verified: **409 `TOOL_NAME_TAKEN`** (an existing tool, or a built-in name); **422 `TOOL_DEFINITION_INVALID`** with `details.issues [{path, message}]` — host not on the allowlist (`/http/url`), a template naming an undeclared parameter (`/http/query/q`), a forbidden header, `http://`, a template in the host, an unsupported schema keyword (`/parameters/…`); **422 `VALIDATION_FAILED`** — an invalid name, missing required fields (all four named, P5-G01), `null` for a non-clearable field (P5-G02); **403** for a Member; **401 `AUTH_SCHEME_NOT_ALLOWED`** for an API key. Sample refusal:

```json
{
 "code": "TOOL_DEFINITION_INVALID",
 "message": "The tool definition is not valid.",
 "details": {
  "issues": [
   {
    "path": "/http/url",
    "message": "example.com is not on the platform egress allowlist (TOOL_HTTP_ALLOWED_HOSTS). Ask the platform operator to add it."
   }
  ]
 }
}
```

After success, refresh the list. The secret never comes back (`hasSecret: true`, verified).

#### P5-API-03 — The tool ledger

`GET /tools/executions?toolId=<id>&runId=<id>&page=1&limit=20` → **200**, `data: ToolExecution[]` newest first, `meta.pagination`. Needs `tool:read` **and** `usage:read` (a Viewer got 403, verified; an API key with both scopes may read). Verified: every outcome (`SUCCEEDED`, `DENIED`, `FAILED`, `TIMED_OUT`), denial reasons `ARGUMENTS`, `RECIPIENT`, `NOT_GRANTED`, `PII`, `DISABLED`; no argument or result text anywhere; filters by an HTTP tool id, a built-in id and a run id; a malformed id → **422** (P5-G03). Sample:

```json
[
 {
  "id": "1d8e871e-9c37-4eb9-8a9b-0f677fd09a8f",
  "createdAt": "2026-10-07T00:03:50.800Z",
  "completedAt": "2026-10-07T00:03:51.050Z",
  "toolName": "unknown",
  "toolId": null,
  "toolVersion": null,
  "status": "DENIED",
  "denialReason": "NOT_GRANTED",
  "errorCode": "TOOL_NOT_GRANTED",
  "agentId": null,
  "conversationId": null,
  "workflowRunId": null,
  "workflowStepId": null,
  "durationMs": 0,
  "resultBytes": 0,
  "contextClassification": "PUBLIC",
  "contextIntegrity": "TRUSTED",
  "sideEffects": false,
  "argumentsDigest": "c1dd68ef8f091545ce1b47dc482b6111784b0df5abd690492f3b641b0c808bf8"
 },
 {
  "id": "f73abd07-e69e-440e-8cd9-d3eed3f9db7d",
  "createdAt": "2026-10-07T00:03:33.511Z",
  "completedAt": "2026-10-07T00:03:34.332Z",
  "toolName": "echo_submit",
  "toolId": "526702e3-b5fc-47d3-a9f7-539500d46d41",
  "toolVersion": 3,
  "status": "FAILED",
  "denialReason": null,
  "errorCode": "TOOL_EXECUTION_FAILED",
  "agentId": null,
  "conversationId": null,
  "workflowRunId": null,
  "workflowStepId": null,
  "durationMs": 572,
  "resultBytes": 0,
  "contextClassification": "PUBLIC",
  "contextIntegrity": "TRUSTED",
  "sideEffects": true,
  "argumentsDigest": "bc1d79b6be80f1016ef7703b7b0e18a0885e7b8f2b94bb6520a3b640d90ec89d"
 }
]
```

#### P5-API-04 — Read a tool

`GET /tools/:toolId` → **200**, `data: Tool` (HTTP tools add `http`, `hasSecret`, `createdAt`, `updatedAt`). Unknown, deleted, another tenant's or malformed id → **404 `TOOL_NOT_FOUND`** (verified; there is no 400 on this route).

#### P5-API-05 — Edit a tool

`PATCH /tools/:toolId` → **200**, `data: Tool`.

```json
{"expectedVersion":1,"description":"Echoes a query string back; used by the Phase 5 checks."}
```

Verified: a behaviour change bumps `version` and `digest` (1 → 2); a display-name change keeps both; `enabled: false` keeps the version and makes tests deny `TOOL_DISABLED`; a partial `dataPolicy` changes only the field sent (and is audited as a weakening); a new credential bumps the version; `secret: null` removes it. Errors: **409 `RESOURCE_CONFLICT`** `{expectedVersion, currentVersion}`; **409 `TOOL_DEFINITION_INVALID`** for a built-in; **404 `TOOL_NOT_FOUND`**; **422** for `null` on non-clearable fields; **403** for a Member (all verified).

#### P5-API-06 — Delete a tool

`DELETE /tools/:toolId` → **200** `{deleted: true}`. A soft delete: the credential is destroyed, agents stop being offered the tool, the ledger keeps its history, the name is free again at once (all verified). A second delete, or a built-in id: **404 `TOOL_NOT_FOUND`** (verified). Workflow versions that reference it become invalid at their next validation or publish.

#### P5-API-07 — Test a tool

`POST /tools/:toolId/test` `{"arguments": {...}}` → **200**, `data: ToolTestResult` — whatever the outcome (section 4.1.5). Verified outcomes: calculator `ok` "35"; schema violation `denied TOOL_ARGUMENTS_INVALID`; `current_datetime` ok; `knowledge_search` ok with workspace passages; `send_email` ok to a verified member (live `agent_email` notification and a delivered email), `denied TOOL_INFORMATION_FLOW_BLOCKED` to an unverified member or a stranger; HTTP `GET` ok with the JSON at `responsePath`; personal data in the arguments `denied TOOL_PII_BLOCKED`; past the timeout `error TOOL_TIMEOUT`; upstream 500 `error TOOL_EXECUTION_FAILED`; a gated `POST` ok (a test counts as approved); disabled `denied TOOL_DISABLED`; deleted or unknown id `denied TOOL_NOT_GRANTED`. **403** without `tool:update` + `tool:execute` (a Member, verified); **422** when `arguments` is not an object (verified).

```json
{
 "status": "ok",
 "executionId": "635daf86-ae25-4ab5-9f02-d877208834bb",
 "durationMs": 988,
 "content": "{\"q\":\"hello phase five\"}",
 "truncated": false
}
```

```json
{
 "status": "denied",
 "executionId": "9d1edc57-8788-4485-8d35-ed87932fac78",
 "durationMs": 513,
 "code": "TOOL_PII_BLOCKED",
 "message": "The request would send personal data (EMAIL_ADDRESS) to postman-echo.com, which this tool is not permitted to receive."
}
```

### Workflow definitions

#### P5-API-08 — List workflows

`GET /workflows?status=ACTIVE&search=routing&page=1&limit=20` → **200**, `data: WorkflowSummary[]` (no graphs), last updated first, `meta.pagination` (verified, including `status` and `search` filters, 422 for an unknown status, and an API key with `workflow:read`).

#### P5-API-09 — The node palette

`GET /workflows/node-types` → **200**, `data: {nodeTypes: NodeTypeDescriptor[]}` — eight types with `label`, `description`, `outputs` (handles; `rule:<id>` = one per condition rule), `produces`, `multiple`, `fields [{name, type, required, description, options?}]` (verified for a Viewer). Static per deployment. Trigger entry:

```json
{
 "type": "trigger",
 "label": "Trigger",
 "description": "Where a run starts. Its output is the run input.",
 "outputs": [
  "out"
 ],
 "produces": "json",
 "multiple": false,
 "fields": [
  {
   "name": "inputSchema",
   "type": "json-schema",
   "required": false,
   "description": "The run input’s shape. Default: { \"input\": string }."
  }
 ]
}
```

#### P5-API-10 — Validate

`POST /workflows/validate` `{"graph": {...}}` → **200**, `data: ValidationReport` — never saves. Needs `workflow:create` or `workflow:update` (a Member got 403, verified). Fifteen invalid graphs were verified to report their codes (section 4.2.2); a dead end produced a warning with `valid: true`. Sample issues:

```json
[
 {
  "code": "TRIGGER_MISSING",
  "message": "A workflow has exactly one trigger node."
 },
 {
  "code": "TRIGGER_MULTIPLE",
  "message": "A workflow has exactly one trigger node."
 },
 {
  "code": "OUTPUT_MISSING",
  "message": "A workflow needs at least one output node."
 },
 "…"
]
```

#### P5-API-11 — Create a workflow

`POST /workflows` → **201**, `data: Workflow` (DRAFT, version 1).

```json
{"name":"Deterministic Routing","description":"Doubles an amount and routes it.","graph":{…},"settings":{"maxSteps":20}}
```

Only `name` is required; the default graph is trigger → output (verified). An invalid graph is accepted as a draft with `definition.valid: false` (verified). Errors: **409 `WORKFLOW_NAME_TAKEN`** (ignoring case, verified); **422** for `null` settings fields (verified, P5-G02); **403** for a Member; **401** for an API key (verified). The new workflow (abridged):

```json
{
 "id": "b9e03cd0-fa65-4c13-90ff-be9a209c0a71",
 "name": "Starter Flow",
 "description": null,
 "status": "DRAFT",
 "currentVersion": 1,
 "publishedVersion": null,
 "createdById": "de252911-3ba9-4590-8399-5b4dbeba6960",
 "publishedAt": null,
 "lastRunAt": null,
 "createdAt": "2026-10-07T00:04:27.430Z",
 "updatedAt": "2026-10-07T00:04:27.430Z",
 "definition": {
  "version": 1,
  "graph": {
   "edges": [
    {
     "id": "trigger-output",
     "source": "trigger",
     "target": "output"
    }
   ],
   "nodes": [
    {
     "id": "trigger",
     "data": {},
     "type": "trigger",
     "position": {
      "x": 0,
      "y": 0
     }
    },
    {
     "id": "output",
     "data": {},
     "type": "output",
     "position": {
      "x": 320,
      "y": 0
     }
    }
   ],
   "schemaVersion": 1
  },
  "settings": {},
  "digest": "b50bfab9fda6cc4d3ce54cf750c9df23697bc9c7a8409ac7c8b5212a2bef6e2b",
  "valid": true,
  "validation": {
   "valid": true,
   "errors": [],
   "warnings": [],
   "stepBound": 2
  },
  "changeNote": "Created.",
  "restoredFromVersion": null,
  "createdById": "de252911-3ba9-4590-8399-5b4dbeba6960",
  "createdAt": "2026-10-07T00:04:27.430Z",
  "isCurrent": true,
  "isPublished": false
 }
}
```

#### P5-API-12 — Read a workflow

`GET /workflows/:workflowId` → **200**, `data: Workflow` with `definition` = the **current** (latest saved) version. Unknown, deleted or another tenant's → **404 `WORKFLOW_NOT_FOUND`**; malformed → **400** (verified).

#### P5-API-13 — Rename

`PATCH /workflows/:workflowId` `{"name": "...", "description": "..."|null}` → **200**. No version is created (verified); `description: null` clears it; `{}` is a no-op; `name: null` is **422** naming `name` (P5-G02); a taken name (ignoring case) is **409** (all verified).

#### P5-API-14 — Save the canvas

`PUT /workflows/:workflowId/definition` → **200**, `data: Workflow`.

```json
{"graph":{…},"expectedVersion":1,"changeNote":"Clearer small-amount wording.","settings":{"maxSteps":20}}
```

Verified: identical graph → no new version; a change → version N+1 with the change note; unknown properties dropped from a valid graph; an invalid graph → a new invalid version; stale `expectedVersion` → **409 `WORKFLOW_VERSION_CONFLICT`** `{expectedVersion, currentVersion}`; `null` fields → **422**; a Member → **403**. Omitting `settings` keeps the current settings.

#### P5-API-15 — Version history

`GET /workflows/:workflowId/versions?page=1&limit=20` → **200**, `data: WorkflowVersion[]` newest first, each with its full graph and report (heavy: page it). Verified: `[3, 2, 1]` with `isCurrent` on 3.

#### P5-API-16 — One version

`GET /workflows/:workflowId/versions/:version` → **200**, `data: WorkflowVersion`. Immutable: cache indefinitely. **404 `WORKFLOW_VERSION_NOT_FOUND`**; non-numeric → **400** (verified).

#### P5-API-17 — Restore

`POST /workflows/:workflowId/versions/:version/restore` `{"changeNote": "..."}` → **201** (P5-G17), `data: Workflow` with the new current version, `restoredFromVersion` = N and the same digest as N (verified). Restoring the current version is **422** "That version is already the current one." (verified); unknown version **404**; a Member **403** (verified).

#### P5-API-18 — Publish

`POST /workflows/:workflowId/publish` `{"version": 2}` (default: current) → **200**, `data: Workflow` with `status: "ACTIVE"`, `publishedVersion`, `publishedAt`. The version must be valid now (**422 `WORKFLOW_INVALID`** with `details.errors`, verified for an invalid current version). Publishing an archived workflow re-activates it; publishing an older version rolls back (both verified). Members: **403** (`workflow:publish`, verified).

#### P5-API-19 — Archive

`POST /workflows/:workflowId/archive` → **200**, `status: "ARCHIVED"`; idempotent (verified). New runs: **409 `WORKFLOW_NOT_ACTIVE`**; editors' test runs still work (verified).

#### P5-API-20 — Delete

`DELETE /workflows/:workflowId` → **200** `{deleted: true}`. Soft delete; **its active runs are cancelled** (verified: a run waiting for approval became CANCELLED and stayed readable); afterwards read and delete are **404** (verified). Members: **403** (`workflow:delete`, verified).

### Runs

#### P5-API-21 — Start a run

`POST /workflows/:workflowId/runs` → **202**, `data: Run` (`status: "RUNNING"`), steps execute in the background.

```json
{"input":{"amount":30,"note":"Small order"},"idempotencyKey":"0b6f1f0e-8f3a-4b6e-9a51-6c2d1c7e9a10"}
```

Verified response:

```json
{
 "id": "2c095542-bc65-45a9-8df8-12ba80cadd2b",
 "workflowId": "96242cda-24eb-4c5a-a796-613272da6109",
 "workflowVersion": 4,
 "status": "RUNNING",
 "trigger": "MANUAL",
 "initiatorUserId": "542a9a60-8e6e-44f3-aff3-503f608445e3",
 "initiatorApiKeyId": null,
 "classification": "PUBLIC",
 "integrity": "TRUSTED",
 "maxSteps": 20,
 "stepsScheduled": 2,
 "maxTokens": 200000,
 "tokensUsed": 0,
 "toolCalls": 0,
 "errorCode": null,
 "errorStepId": null,
 "createdAt": "2026-10-07T00:05:27.602Z",
 "startedAt": "2026-10-07T00:05:27.852Z",
 "completedAt": null,
 "deadlineAt": "2026-10-07T00:35:27.852Z"
}
```

Verified: `trigger: "MANUAL"` for a person, `"API"` with `initiatorApiKeyId` for an API key; pinned to the published version; idempotent replay `duplicate: true` (and across members, P5-G09); test runs of other versions with `workflow:update` (403 without; 422 `WORKFLOW_INVALID` for an invalid version); archived and draft workflows **409 `WORKFLOW_NOT_ACTIVE`**; input refused **422 `WORKFLOW_INPUT_INVALID`** `{issues}` (a wrong type and an extra field); unknown workflow **404**; a Viewer **403**; `version: null` **422** (P5-G02); the 21st active run in a workspace **429 `WORKFLOW_CONCURRENCY_LIMIT`** with `Retry-After: 30`:

```json
{
 "error": {
  "code": "WORKFLOW_CONCURRENCY_LIMIT",
  "message": "This workspace already has the maximum number of workflow runs in progress.",
  "details": {
   "active": 20,
   "limit": 20
  }
 },
 "retryAfter": "30"
}
```

#### P5-API-22 — List runs

`GET /workflow-runs?scope=mine|all&status=FAILED&workflowId=<uuid>&page=1&limit=20` → **200**, `data: Run[]` newest first (no steps). `scope=mine` (default) is your runs (an API key: its runs); `scope=all` needs `workflow:read_all` (403 for a Member). Filters verified; a malformed `workflowId` is **422** (P5-G03).

#### P5-API-23 — A run and its steps

`GET /workflow-runs/:runId` → **200**, `data: RunDetail` — metadata only. Someone else's without `workflow:read_all`, deleted, unknown or another tenant's → **404 `WORKFLOW_RUN_NOT_FOUND`**; malformed → **400** (verified). Step sequence of the verified routing run: `start#0:SUCCEEDED[out]` → `calc#0:SUCCEEDED[out]` → `route#0:SUCCEEDED[else]` → `small#0:SUCCEEDED[out]` → `big#0:SKIPPED`; of the loop: `start#0:SUCCEEDED[out]` → `inc#0:SUCCEEDED[out]` → `check#0:SUCCEEDED[again]` → `inc#1:SUCCEEDED[out]` → `check#1:SUCCEEDED[again]` → `inc#2:SUCCEEDED[out]` → `check#2:SUCCEEDED[else]` → `out#0:SUCCEEDED[out]`; of the supervisor team: `start#0:SUCCEEDED[out]` → `lead#0:SUCCEEDED[worker:w1]` → `w1#0:SUCCEEDED[out]` → `lead#1:SUCCEEDED[worker:w2]` → `w2#1:SUCCEEDED[out]` → `lead#2:SUCCEEDED[done]` → `out#0:SUCCEEDED[out]`. A step (abridged):

```json
{
 "id": "a2602b21-4133-52db-897d-7ac17a282836",
 "nodeId": "calc",
 "nodeType": "tool",
 "iteration": 0,
 "status": "SUCCEEDED",
 "handles": [
  "out"
 ],
 "predecessors": [
  "start#0"
 ],
 "attempt": 1,
 "maxAttempts": 3,
 "classification": "PUBLIC",
 "integrity": "TRUSTED",
 "agentId": null,
 "agentVersion": null,
 "toolId": "b7c95b5c-b839-57cd-a4e0-9ab9aeabcd10",
 "toolVersion": 1,
 "model": null,
 "promptTokens": 0,
 "completionTokens": 0,
 "toolCalls": [
  {
   "tool": "calculator",
   "status": "ok",
   "durationMs": 77,
   "executionId": "7ffa12ca-ebad-50f3-891d-897c5a844e42"
  }
 ],
 "errorCode": null,
 "failureClass": null,
 "deadLettered": false,
 "approval": null,
 "inputBytes": 37,
 "outputBytes": 12,
 "startedAt": "2026-10-06T23:37:11.736Z",
 "completedAt": "2026-10-06T23:37:13.641Z",
 "durationMs": 1265,
 "createdAt": "2026-10-06T23:37:09.836Z"
}
```

#### P5-API-24 — Run content

`GET /workflow-runs/:runId/content?reveal=false` → **200**, `data: ContentView` (section 3.3). Verified: own run VISIBLE with the input and `{"small": "Small amount: 60"}`; a supervisor MASKED; reveal **403** without `pii:reveal` (even on your own run); the owner's reveal VISIBLE; an uncleared supervisor WITHHELD `CLEARANCE`; a deleted run **404**. Masked sample:

```json
{
 "contentState": "MASKED",
 "input": {
  "input": "Refund [EMAIL_ADDRESS_1] for invoice 77"
 },
 "output": null,
 "classification": "PUBLIC"
}
```

#### P5-API-25 — Step content

`GET /workflow-runs/:runId/steps/:stepId/content?reveal=false` → **200**, `data: ContentView` for one step (verified: a tool step's arguments `"30 * 2"` and result `60`; a retrieval step's passages). Unknown step **404 `WORKFLOW_STEP_NOT_FOUND`**, malformed **400** (verified).

#### P5-API-26 — Trace

`GET /workflow-runs/:runId/trace` → **200**, `data: RunTrace` rebuilt from the audit chain alone; `complete: true` and no `problems` for the verified approval run, and still available after the run was deleted (verified). Needs `audit:read` (403 for a Member); a run with no audit records **404** (verified).

```json
{
 "runId": "73d4526b-7d4a-4b80-a9ad-c95348fac431",
 "complete": true,
 "problems": [],
 "trace": "{ … steps, predecessors, versions, tool calls … }"
}
```

#### P5-API-27 — Cancel

`POST /workflow-runs/:runId/cancel` → **200**, `data: Run` `status: "CANCELLED"` (verified while waiting for approval; the waiting step CANCELLED; `run.cancelled` published). Finished → **409 `WORKFLOW_RUN_FINISHED`**; someone else's without read access → **404** (verified).

#### P5-API-28 — Resume

`POST /workflow-runs/:runId/resume` → **200**, `data: Run` `status: "RUNNING"` (verified twice: a failed run completed after its tool was fixed, with `run.resumed {stepsReset: 1}`; a timed-out run got a fresh deadline). CANCELLED or COMPLETED → **409 `WORKFLOW_RUN_NOT_RESUMABLE`** (verified).

#### P5-API-29 — The approval queue

`GET /workflow-runs/approvals` → **200**, `data: ApprovalItem[]` (≤100, oldest first). Bearer only (an API key got 401, verified); Members **403** (verified).

```json
{
 "runId": "73d4526b-7d4a-4b80-a9ad-c95348fac431",
 "stepId": "1362f85a-8704-5109-a6ce-24feece7d38f",
 "workflowId": "9d2dfc23-1c2c-437c-8dd4-29dd294aab22",
 "nodeId": "gate",
 "requestedAt": "2026-10-07T00:07:26.085Z",
 "expiresAt": "2026-10-08T00:07:26.085Z",
 "initiatorUserId": "542a9a60-8e6e-44f3-aff3-503f608445e3",
 "classification": "PUBLIC",
 "message": "Approve submitting: Pay invoice 42 for the Lahore office",
 "canDecide": true
}
```

#### P5-API-30 — Decide

`POST /workflow-runs/:runId/steps/:stepId/approval` `{"decision":"approve","comment":"Looks right."}` → **200**, `data: Run`. Verified: approve (the gated tool then ran), reject (the `rejected` branch ran), **403 `WORKFLOW_SELF_APPROVAL_FORBIDDEN`**, **403 `FORBIDDEN`** for an uncleared approver, **409 `WORKFLOW_APPROVAL_NOT_PENDING`** when already decided or cancelled, **422** for an unknown decision, **403** for a Member.

#### P5-API-31 — Dead letters

`GET /workflow-runs/dead-letters?page=1&limit=20` → **200**, `data: DeadLetter[]` newest first, metadata only (verified: the PII-blocked step and the failed upstream call). Needs `workflow:update` (403 for a Member, verified). A resumed step that later succeeds leaves the list.

```json
{
 "runId": "04743a33-bf34-4a82-a018-ae0288bb5361",
 "stepId": "b580953a-7687-5557-b2cb-111d12ff3988",
 "workflowId": "6438a958-a8a6-454d-82db-98e3a9c77071",
 "workflowVersion": 1,
 "nodeId": "call",
 "nodeType": "tool",
 "iteration": 0,
 "attempts": 1,
 "errorCode": "TOOL_EXECUTION_FAILED",
 "failureClass": "TRANSIENT",
 "deadLetteredAt": "2026-10-07T00:10:42.003Z",
 "runStatus": "FAILED"
}
```

#### P5-API-32 — Delete a run

`DELETE /workflow-runs/:runId` → **200** `{deleted: true}`. Your own finished run, or anyone's with `workflow:delete` (verified both); active → **409 `RESOURCE_CONFLICT`**; someone else's without read access → **404** (verified). Content is unrecoverable at once; the trace stays.

### Audit

#### P5-API-33 — Search

`GET /audit-logs?action=…&actionPrefix=tool.&severity=WARNING&status=…&actorType=…&actorId=<uuid>&resourceType=workflow_run&resourceId=<id>&requestId=<id>&ipAddress=…&from=…&to=…&page=1&limit=50` → **200**, `data: AuditLog[]` newest first, `meta.pagination`. Every filter verified; `action` must be a known action (**422**), `actorId` a UUID (**422**). Bearer only; `audit:read` (403 for a Member, verified). Actions seen in the run: `access.denied`, `agent.circuit_broken`, `agent.circuit_reset`, `agent.conversation.started`, `agent.invoked`, `llm.inference.completed`, `quota.created`, `quota.deleted`, `quota.exhausted`, `quota.rate_limited`, `quota.threshold_reached`, `quota.updated`, `tool.executed`, `workflow.approval.granted`, `workflow.approval.requested`, `workflow.created`, `workflow.deleted`, `workflow.execution.cancelled`, `workflow.execution.completed`, `workflow.execution.dead_lettered`, `workflow.execution.failed`, `workflow.execution.resumed`, `workflow.execution.started`, `workflow.execution.timed_out`, `workflow.published`, `workflow.run.deleted`, `workflow.step.completed`, `workflow.step.failed`.

#### P5-API-34 — Statistics

`GET /audit-logs/statistics` → **200**, `data: AuditStatistics` (`totalRecords` and `headSequence` are strings: bigints).

```json
{
 "totalRecords": "345",
 "headSequence": "345",
 "bySeverity": {
  "CRITICAL": 1,
  "INFO": 194,
  "NOTICE": 86,
  "WARNING": 64
 },
 "byStatus": {
  "DENIED": 39,
  "FAILURE": 28,
  "SUCCESS": 278
 },
 "topActions": [
  {
   "action": "workflow.step.completed",
   "count": 81
  },
  {
   "action": "access.denied",
   "count": 27
  },
  {
   "action": "workflow.execution.started",
   "count": 24
  },
  "…"
 ]
}
```

#### P5-API-35 — Verify the chain

`GET /audit-logs/verify?maxRecords=5` → **200**, `data: ChainVerification`. Verified: the whole chain valid; `maxRecords=5` checked 5; a non-numeric value checked everything (P5-G10); `audit:verify` required (403 for a Member). A broken chain answers 200 with `valid: false`, `brokenAtSequence` and `reason` — render it as an alarm, not an error.

```json
{
 "organizationId": "866df984-741c-40f1-8053-4fbdb4f51f3e",
 "valid": true,
 "recordsChecked": 346,
 "verifiedAt": "2026-10-07T00:16:50.966Z"
}
```

#### P5-API-36 — Export

`GET /audit-logs/export?from=…&to=…` → **200** `application/x-ndjson`, `Content-Disposition: attachment; filename="audit-log.ndjson"`; one stored record per line, oldest first, with `sequence`, `previousHash` and `hash` (line keys: `action`, `actorId`, `actorLabel`, `actorType`, `createdAt`, `durationMs`, `errorCode`, `errorMessage`, `hash`, `httpMethod`, `httpPath`, `httpStatus`, `id`, `ipAddress`, `metadata`, `organizationId`, `previousHash`, `requestId`, `resourceId`, `resourceLabel`, `resourceType`, `sequence`, `severity`, `status`, `userAgent`). Verified: every line links to the previous; a window narrows the export; `from=garbage` → **422** JSON envelope (P5-G04, P5-G05); `audit:export` required (403 for a Member). The export itself is audited.

#### P5-API-37 — Retention archives

`GET /audit-logs/archives` → **200**, `data: AuditArchive[]` — empty while retention is off (verified).

#### P5-API-38 — Download an archive

`GET /audit-logs/archives/:sequence` → **200** NDJSON (`audit-archive-<sequence>.ndjson`), checked against the anchor's digest before serving (source). Unknown or malformed sequence → **404 `RESOURCE_NOT_FOUND`**; `audit:export` required (verified). A digest mismatch is **409 `AUDIT_CHAIN_BROKEN`** (source).

### Analytics

#### P5-API-39 — Overview

`GET /analytics/overview?from=…&to=…` → **200**, `data: AnalyticsOverview` (verified for a Member and an API key with `usage:read`; 403 for a Viewer and for a key without it; 422 for `from` after `to` and for more than 400 days). Verified at the end of the run (abridged):

```json
{
 "from": "2026-09-07T00:17:13.792Z",
 "to": "2026-10-07T00:17:13.792Z",
 "activity": {
  "activeMembers": 2,
  "activeApiKeys": 0,
  "activeAgents": 3,
  "conversationsStarted": 1,
  "turns": 1
 },
 "workflows": {
  "runs": 24,
  "completed": 16,
  "failed": 5,
  "cancelled": 3,
  "timedOut": 0,
  "active": 0,
  "durationP50Ms": 14284,
  "durationP95Ms": 54195,
  "tokens": 888,
  "deadLetters": 5
 },
 "tools": {
  "calls": 35,
  "succeeded": 22,
  "failed": 2,
  "timedOut": 2,
  "denied": 9,
  "denialsByReason": {
   "ARGUMENTS": 1,
   "DISABLED": 1,
   "NOT_GRANTED": 2,
   "PERMISSION": 1,
   "PII": 2,
   "RECIPIENT": 2
  }
 },
 "knowledge": {
  "documentsByStatus": {
   "READY": 1
  },
  "storedBytes": 228,
  "retrievalQueries": 2,
  "withheldEvents": 0
 },
 "privacy": {
  "entitiesMasked": 0,
  "entitiesByType": {},
  "egressBlocked": 0,
  "refusedForRedaction": 0,
  "degradedRedactions": 0
 },
 "governance": {
  "throttledCalls": 3,
  "budgetExhaustions": 1,
  "rateLimitEvents": 1,
  "circuitBreaks": 2,
  "openCircuits": 0,
  "budgetsNearLimit": 0
 },
 "security": {
  "bySeverity": {
   "WARNING": 69,
   "CRITICAL": 1
  },
  "topAlerts": [
   {
    "action": "access.denied",
    "count": 32
   },
   {
    "action": "tool.execution.denied",
    "count": 9
   },
   {
    "action": "workflow.execution.dead_lettered",
    "count": 6
   },
   "…"
  ],
  "failedSignIns": 0,
  "accessDenials": 32
 },
 "inference": "{ … the Phase 4 UsageSummary … }"
}
```

#### P5-API-40 — Time series

`GET /analytics/timeseries?metric=tokens&interval=day&from=…&to=…` → **200**, `data: Timeseries` with every bucket (UTC). Metrics: `tokens`, `invocations`, `throttled`, `failures`, `latency_p95`, `ttft_p95`, `redaction_p95`, `entities_masked`, `workflow_runs`, `workflow_failures`, `tool_calls`, `tool_denials`, `security_events`, `rag_queries` (all fourteen verified). Default 30 days daily; hourly at most 14 days (**422**, verified); `metric` required (**422**, verified).

#### P5-API-41 — Top

`GET /analytics/top?dimension=agents|models|members|api_keys&limit=10` → **200**, `data: TopEntry[]` by tokens. `members` and `api_keys` need `quota:manage` too (403 for a Member, verified). `key` is the agent/user/key id or the model name; `label` the name (verified: the Circuit Probe agent ranked with its name).

```json
[
 {
  "key": "066b6039-527b-493e-a2e0-3516c23516a1",
  "label": "Circuit Probe",
  "invocations": 2,
  "tokens": 3893,
  "throttled": 1
 },
 {
  "key": "aacf563d-2e27-4dfb-88c8-e90aa8f80fd6",
  "label": "Sentiment Classifier",
  "invocations": 2,
  "tokens": 468,
  "throttled": 0
 },
 {
  "key": "74274f99-4077-4677-b6dc-36c35c58de85",
  "label": "Workflow Summarizer",
  "invocations": 2,
  "tokens": 420,
  "throttled": 0
 }
]
```

#### P5-API-42 — Security feed

`GET /analytics/security-events?limit=50&before=<at>` → **200**, `data: SecurityEvent[]` — WARNING and CRITICAL audit records, newest first; `before` pages strictly older (verified); `audit:read` or `security:read` (403 for a Member, verified); `limit` ≤200 (**422**, verified).

```json
[
 {
  "id": "81962f2d-e336-4f01-bc08-b7f3f1b228f4",
  "at": "2026-10-07T00:17:18.963Z",
  "action": "access.denied",
  "severity": "WARNING",
  "status": "DENIED",
  "actorType": "API_KEY",
  "actorLabel": "Runner 166926 (daiap_sk__bNttvGe)",
  "resourceType": "endpoint",
  "resourceId": "/api/v1/organizations/866df984-741c-40f1-8053-4fbdb4f51f3e/analytics/overview",
  "errorCode": null,
  "ipAddress": "127.0.0.1",
  "requestId": "f0f53e77-0a14-4d7f-a6de-9892676d6b4e"
 },
 {
  "id": "e8f45424-80bc-4592-8ac8-87066a9a19fe",
  "at": "2026-10-07T00:17:17.919Z",
  "action": "access.denied",
  "severity": "WARNING",
  "status": "DENIED",
  "actorType": "USER",
  "actorLabel": "PhaseFive Viewer",
  "resourceType": "endpoint",
  "resourceId": "/api/v1/organizations/866df984-741c-40f1-8053-4fbdb4f51f3e/analytics/overview",
  "errorCode": null,
  "ipAddress": "127.0.0.1",
  "requestId": "4044cc6d-df3e-4a76-8d44-d4bcac9d738d"
 }
]
```

### Quotas and circuits

#### P5-API-43 — Quotas

`GET /quotas` → **200**, `data: Quota[]` — platform rows and workspace rows with this period's consumption. Verified for a Member; 403 for a Viewer.

```json
[
 {
  "id": "4f072466-f009-4c2d-b70d-c871daec161f",
  "scope": "ORGANIZATION",
  "subjectId": null,
  "period": "MONTH",
  "tokenLimit": 2000000,
  "enforcement": "HARD",
  "alertThreshold": 80,
  "managedBy": "PLATFORM",
  "label": "Platform allowance (FREE plan)",
  "usage": {
   "used": 888,
   "reserved": 0,
   "remaining": 1999112,
   "percent": 0.04,
   "periodStart": "2026-10-01T00:00:00.000Z",
   "resetsAt": "2026-11-01T00:00:00.000Z"
  },
  "rate": null
 },
 {
  "id": "2fbed9b3-0a08-4732-b46e-feff79566274",
  "scope": "ORGANIZATION",
  "subjectId": null,
  "period": "MINUTE",
  "tokenLimit": 8000,
  "enforcement": "HARD",
  "alertThreshold": 80,
  "managedBy": "PLATFORM",
  "label": "Platform token rate",
  "usage": null,
  "rate": {
   "available": 8000
  }
 }
]
```

#### P5-API-44 — My quotas

`GET /quotas/me` → **200**, `data: Quota[]` — the workspace's and those set on you (or on this API key); AGENT quotas are not included. Verified: a member quota appeared after it was created; an API key with `usage:read` 200, without it 403; a Viewer 403.

#### P5-API-45 — Create a quota

`POST /quotas` → **201**, `data: Quota`.

```json
{"scope":"MEMBER","subjectId":"<user id>","period":"DAY","tokenLimit":40,"enforcement":"SOFT","alertThreshold":50,"label":"Member trial budget"}
```

Verified: created with `usage.used: 0`; a duplicate **409 `RESOURCE_CONFLICT`**; a subject outside the workspace **422**; MEMBER without `subjectId` **422**; `tokenLimit: 0` **422**; a Member **403**. A SOFT budget let a call through and sent `quota.threshold` to the managers and the member:

```json
{
 "type": "notification",
 "organizationId": "866df984-741c-40f1-8053-4fbdb4f51f3e",
 "data": {
  "kind": "quota.threshold",
  "quotaId": "607150ea-f6d5-47e7-8d8a-3f688dd5087e",
  "scope": "MEMBER",
  "period": "DAY",
  "limit": 40,
  "percent": 2272.5,
  "threshold": 50
 },
 "at": "2026-10-07T00:15:19.164Z",
 "id": "1791332118956-0",
 "receivedAt": 1791332119304
}
```

A MINUTE quota reports `rate.available` and `usage: null`; a 10-token workspace rate refused the next call **429 `TOKEN_RATE_LIMITED`** naming it (verified).

#### P5-API-46 — Change a quota

`PATCH /quotas/:quotaId` `{"enforcement":"HARD","tokenLimit":60}` → **200**. Verified: the HARD budget then refused a call **429 `QUOTA_EXCEEDED`** with `Retry-After` until the period reset:

```json
{
 "error": {
  "code": "QUOTA_EXCEEDED",
  "message": "The member token budget for this day is used up.",
  "details": {
   "quotaId": "607150ea-f6d5-47e7-8d8a-3f688dd5087e",
   "scope": "MEMBER",
   "period": "DAY",
   "limit": 60,
   "requested": 59,
   "managedBy": "WORKSPACE",
   "resetsAt": "2026-10-08T00:00:00.000Z",
   "retryAfterSeconds": 85477
  }
 },
 "retryAfter": "85477"
}
```

`label: null` clears the label; `null` elsewhere **422**; platform rows **403 `QUOTA_MANAGED_BY_PLATFORM`**; unknown **404 `QUOTA_NOT_FOUND`**; malformed **400** (all verified).

#### P5-API-47 — Remove a quota

`DELETE /quotas/:quotaId` → **200** `{deleted: true}` (audited as a weakening). Again → **404**; platform rows → **403** (verified).

#### P5-API-48 — Quota history

`GET /quotas/:quotaId/history?periods=12` → **200**, `data: QuotaHistoryEntry[]` newest first (verified: tokens used, a refusal, an alert). `periods` 1–36 (**422** above, verified); a removed quota **404** (verified).

```json
[
 {
  "periodStart": "2026-10-07T00:00:00.000Z",
  "tokensUsed": 909,
  "requests": 1,
  "rejected": 1,
  "alertedAt": "2026-10-07T00:15:18.104Z",
  "exhaustedAt": "2026-10-07T00:15:17.927Z"
 }
]
```

#### P5-API-49 — Open circuits

`GET /circuits` → **200**, `data: AgentCircuit[]` — **open ones only** (empty before, the probe agent after, verified).

```json
[
 {
  "agentId": "066b6039-527b-493e-a2e0-3516c23516a1",
  "state": "open",
  "reason": "RUNAWAY_SPEND",
  "openedAt": "2026-10-07T00:16:02.545Z",
  "retryAt": "2026-10-07T00:17:02.545Z"
 }
]
```

#### P5-API-50 — One agent's breaker

`GET /circuits/agents/:agentId` → **200**, `data: AgentCircuit` (`closed`, or `open` with `reason`, `openedAt`, `retryAt`). Unknown or another tenant's agent **404 `AGENT_NOT_FOUND`**; malformed **400** (verified). Visibility is not applied (P5-G14). The refusal a turn received while it was open:

```json
{
 "error": {
  "code": "AGENT_CIRCUIT_OPEN",
  "message": "This agent has been paused automatically after unusual activity. Try again later.",
  "details": {
   "agentId": "066b6039-527b-493e-a2e0-3516c23516a1",
   "organizationId": "866df984-741c-40f1-8053-4fbdb4f51f3e",
   "reason": "RUNAWAY_SPEND",
   "openedAt": "2026-10-07T00:16:02.545Z",
   "retryAfterSeconds": 56
  }
 },
 "retryAfter": "56"
}
```

#### P5-API-51 — Reset

`DELETE /circuits/agents/:agentId` → **200** `{reset: true, wasOpen: true|false}` (verified both); audited `agent.circuit_reset`. `quota:manage` or `agent:update` (a Member got 403, verified).

### Personal data

#### P5-API-52 — Download my data

`GET /api/v1/auth/me/export` (no workspace header) → **200** `application/json` file, `Content-Disposition: attachment; filename="personal-data-YYYY-MM-DD.json"`, `Cache-Control: no-store`, **no envelope** (verified). Sections and counts for the verified member:

```json
{
 "format": "daiap-personal-data/v1",
 "sections": {
  "memberships": 1,
  "devices": 1,
  "conversations": 1,
  "workflowRuns": 17,
  "apiKeys": 0,
  "usage": 1,
  "activity": 77
 },
 "truncated": [],
 "accountKeys": [
  "createdAt",
  "displayName",
  "email",
  "…"
 ]
}
```

The sixth export within an hour → **429 `RATE_LIMIT_EXCEEDED`** with `Retry-After` (verified); API keys → **401** (verified).

#### P5-API-53 — Erase my account

`DELETE /api/v1/auth/me` → **200**, `data: ErasureOutcome`.

```json
{"password":"…","code":"123456","confirmation":"ERASE MY ACCOUNT"}
```

Verified: an owner of a shared workspace **409 `ACCOUNT_ERASURE_BLOCKED`**:

```json
{
 "code": "ACCOUNT_ERASURE_BLOCKED",
 "message": "You still own workspaces that other people belong to. Transfer or delete them first.",
 "details": {
  "workspaces": [
   {
    "id": "866df984-741c-40f1-8053-4fbdb4f51f3e",
    "name": "Phase 5 verification p5-1791331166926",
    "otherMembers": 4
   }
  ]
 }
}
```

…a wrong phrase **422** (`confirmation`), a wrong password **401 `AUTH_PASSWORD_MISMATCH`**, MFA on and no code **401 `MFA_CODE_INVALID`**, a wrong code **401 `MFA_CODE_INVALID`**, `code: null` **422**; then success with a current TOTP code:

```json
{
 "erased": true,
 "workspacesDeleted": [
  "9a9a2b3b-17f8-409c-9c59-d270d460567f"
 ],
 "conversationsShredded": 1,
 "workflowRunsShredded": 21,
 "apiKeysRevoked": 0,
 "membershipsEnded": 1
}
```

Afterwards the old access token is refused, sign-in fails, the person's runs are gone for supervisors, and the farewell email arrived (all verified).


## 9. State, cache, real-time and concurrency

### 9.1 Query keys

Every key starts with the canonical workspace ID.

| Key | Source | Notes |
|---|---|---|
| `[ws, 'tools', filters]`, `[ws, 'tool', id]` | 01, 04 | built-in ids are the same in every workspace, but keep the workspace prefix |
| `[ws, 'tool-ledger', filters]` | 03 | |
| `[ws, 'node-types']` | 09 | stable per deployment: stale-time an hour |
| `[ws, 'workflows', filters]`, `[ws, 'workflow', id]` | 08, 12 | |
| `[ws, 'workflow', id, 'versions', page]`, `[ws, 'workflow', id, 'version', n]` | 15, 16 | versions are immutable: cache indefinitely |
| `[ws, 'runs', scope, filters]`, `[ws, 'run', id]` | 22, 23 | the run is merged with socket events (9.3) |
| `[ws, 'run', id, 'content']`, `[ws, 'run', id, 'step', stepId, 'content']` | 24, 25 | **never cache `reveal=true`**; drop on leaving the panel |
| `[ws, 'approvals']` | 29 | refetch on approval events and every 60 s |
| `[ws, 'dead-letters', page]`, `[ws, 'run', id, 'trace']` | 31, 26 | |
| `[ws, 'audit', filters]`, `[ws, 'audit', 'statistics']`, `[ws, 'audit', 'archives']` | 33, 34, 37 | |
| `[ws, 'analytics', kind, params]` | 39–42 | stale after 60 s |
| `[ws, 'quotas']`, `[ws, 'quotas', 'me']`, `[ws, 'quota', id, 'history']`, `[ws, 'circuits']`, `[ws, 'circuit', agentId]` | 43–50 | refetch on quota and circuit notifications |

Capture the workspace at dispatch time, drop responses whose workspace is no longer current, and on workspace switch, logout or erasure: abort requests, **close the socket**, and clear these caches.

### 9.2 The canvas is local state

The canvas holds unsaved edits that the server does not know about. Keep `{base: WorkflowVersion, draft: {nodes, edges, viewport}, dirty}` in a store; validate the draft (debounced); save with `expectedVersion: base.version`; replace `base` and `draft` from the response. Never let a background refetch of the workflow overwrite a dirty draft: show "A newer version exists" instead. Node ids are references in templates: keep them stable across drags, copies and undo.

### 9.3 Live run views

```text
open run view   → GET run (REST)           → view = runViewFrom(detail)
                → subscribe {runId, lastEventId: newest id you hold, else "0-0"}
                                            → fold ack.events, then live events (applyRunEvent)
terminal event  → refetch the run (authoritative), keep folding nothing older
reconnect/ready → resubscribe with lastEventId, resume, then refetch the run
silence         → run active and no event for 30 s → refetch the run over REST
leave           → unsubscribe
```

- Fold events **by id**, ignoring any at or below the newest applied (replays overlap live delivery; Appendix A dedupes).
- A step's identity is `nodeId#iteration`; events carry `iteration` in `data`.
- Events never carry content: fetch step content only when a panel opens.
- One socket per workspace for the whole app (a shared client), not one per screen; subscriptions are reference-counted by screen.
- Tabs: each tab opens its own socket (limit 10 per person). If you need fewer, share one through a `BroadcastChannel`/SharedWorker leader — optional.

### 9.4 Sensitive data

Run content, step content, approval messages, tool test results and audit metadata are sensitive: memory only, no persistence, no URL parameters, no analytics or error-monitoring payloads, no logging of tool-test arguments or results. The personal-data export is the user's own file; never keep a copy. On erasure success, wipe everything client-side.

### 9.5 Invalidate after mutations

| Mutation | Refresh or evict after known success |
|---|---|
| Tool create/update/delete | tool list, tool detail; agent editors that list grantable tools (Phase 4) |
| Tool test | tool ledger |
| Workflow create/rename/delete | workflow list; delete also evicts its versions and refreshes runs (cancelled) |
| Save definition, restore | workflow detail, versions |
| Publish, archive | workflow detail, list |
| Start run | runs list, workflow (`lastRunAt`) |
| Cancel, resume, approve/reject | the run, runs list, approvals |
| Delete run | evict run and content; runs list |
| Quota create/update/delete | quotas, my quotas, history |
| Circuit reset | circuits, circuit |
| Phase 2 role or membership changes | `/auth/me` capabilities; the socket will move rooms by itself |

## 10. Errors and recovery

| Status | Code | Phase 5 meaning | Required experience |
|---|---|---|---|
| 400 | `BAD_REQUEST` | malformed workflow/run/step/quota/agent id, non-numeric version | Treat as not found in navigation |
| 401 | `AUTH_SCHEME_NOT_ALLOWED` | an API key on a bearer-only route | Not reachable from the browser |
| 401 | `AUTH_PASSWORD_MISMATCH`, `MFA_CODE_INVALID` | erasure: wrong password or second factor | **Field error; not a session problem** |
| 403 | `PERMISSION_DENIED` | missing permission (`details.missingPermissions`), incl. `pii:reveal` on reveal, `workflow:update` for a test run | Explain the capability; refresh permissions |
| 403 | `WORKFLOW_SELF_APPROVAL_FORBIDDEN` | deciding your own run | "Someone else must approve this run" |
| 403 | `FORBIDDEN` | deciding a step you are not cleared for | "You are not cleared for this request" |
| 403 | `QUOTA_MANAGED_BY_PLATFORM` | editing or removing a platform quota | Read-only row |
| 403 | `ACCOUNT_ERASURE_DISABLED` | erasure switched off on this deployment | Explain; contact the operator |
| 404 | `TOOL_NOT_FOUND` | unknown, deleted, other tenant's or malformed tool id; deleting a built-in | Neutral not-found |
| 404 | `WORKFLOW_NOT_FOUND`, `WORKFLOW_VERSION_NOT_FOUND` | unknown/deleted workflow, missing version | Refresh |
| 404 | `WORKFLOW_RUN_NOT_FOUND` | unknown, deleted, other tenant's — **or someone else's run without `workflow:read_all`** | Neutral not-found; remove from caches |
| 404 | `WORKFLOW_STEP_NOT_FOUND` | unknown step of the run | Refresh the run |
| 404 | `QUOTA_NOT_FOUND`, `AGENT_NOT_FOUND`, `RESOURCE_NOT_FOUND` (archives) | as named | Refresh |
| 409 | `TOOL_NAME_TAKEN`, `WORKFLOW_NAME_TAKEN` | name collision (workflows ignore case) | Field error on name |
| 409 | `TOOL_DEFINITION_INVALID` | editing a built-in | Read-only |
| 409 | `RESOURCE_CONFLICT` | stale tool `expectedVersion`; duplicate quota; deleting an active run | Reload and reapply / "Cancel it first" |
| 409 | `WORKFLOW_VERSION_CONFLICT` | stale canvas `expectedVersion` | Reload theirs or save on top (9.2) |
| 409 | `WORKFLOW_NOT_ACTIVE` | starting a draft or archived workflow | "Publish it first" |
| 409 | `WORKFLOW_RUN_FINISHED`, `WORKFLOW_RUN_NOT_RESUMABLE` | cancel a finished run; resume a non-failed one | Refresh the run |
| 409 | `WORKFLOW_APPROVAL_NOT_PENDING` | decided, cancelled or expired | "Already decided or expired" |
| 409 | `ACCOUNT_ERASURE_BLOCKED` | you own workspaces with other members (`details.workspaces`) | Link each to "Transfer ownership" |
| 413 | `PAYLOAD_TOO_LARGE` | run input over 64 KB | Shorten |
| 422 | `VALIDATION_FAILED` | DTO failure (`details.fields`), `null` where not allowed, restore of the current version, analytics windows, subject not in the workspace | Map fields; keep input |
| 422 | `TOOL_DEFINITION_INVALID` | `details.issues[] {path, message}` | Map JSON pointers to fields |
| 422 | `WORKFLOW_INVALID` | publishing or running an invalid version (`details.errors`) | Show the report |
| 422 | `WORKFLOW_INPUT_INVALID` | run input breaks the trigger schema (`details.issues`) | Field errors on the run form |
| 429 | `RATE_LIMIT_EXCEEDED` | HTTP throttles (workflow starts, exports, erasure) | Countdown from `Retry-After` |
| 429 | `WORKFLOW_CONCURRENCY_LIMIT` | 20 active runs (`details.active`, `limit`), `Retry-After: 30` | "Too many runs in progress" with countdown |
| 429 | `QUOTA_EXCEEDED`, `TOKEN_RATE_LIMITED` | budgets and rates (section 4.7) | Countdown; link to governance for managers |
| 503 | `AGENT_CIRCUIT_OPEN` | agent paused (`details.reason`, `openedAt`, `retryAfterSeconds`) | "This agent is paused"; countdown; reset link for managers |
| 503 | `LLM_NOT_CONFIGURED` | starting a run with agent nodes on a deployment without a model | "Workflows with agents are not available here" |
| 502 | `LLM_REJECTED` | the model provider refused a call (Phase 4); observed live for a single prompt beyond the provider's per-request token ceiling (`details.status: 413`) | "This message is too large for the model"; manual retry with less text |

**Run and step error codes** (in `run.errorCode`, `step.errorCode`, events and dead letters, never as HTTP errors of these routes): `WORKFLOW_PRINCIPAL_REVOKED`, `WORKFLOW_TIMEOUT`, `WORKFLOW_STEP_TIMEOUT`, `WORKFLOW_STEP_LIMIT_EXCEEDED`, `WORKFLOW_TOKEN_BUDGET_EXCEEDED`, `WORKFLOW_LOOP_EXHAUSTED`, `WORKFLOW_NO_OUTPUT`, `WORKFLOW_OUTPUT_INVALID`, `WORKFLOW_ROUTING_FAILED`, `WORKFLOW_TEMPLATE_ERROR`, `WORKFLOW_DEPENDENCY_UNAVAILABLE`, every `TOOL_*` outcome code (section 4.1.3), and the Phase 4 model and governance codes (`LLM_*`, `QUOTA_EXCEEDED`, `TOKEN_RATE_LIMITED`, `AGENT_CIRCUIT_OPEN`, `PII_*`). Render them with Appendix A `runErrorText` and the failure class.

**Tool outcome codes** (in test results, the ledger, `step.toolCalls`, `tool.*` events): `TOOL_NOT_GRANTED`, `TOOL_DISABLED`, `PERMISSION_DENIED`, `TOOL_ARGUMENTS_INVALID`, `TOOL_APPROVAL_REQUIRED`, `TOOL_INFORMATION_FLOW_BLOCKED`, `TOOL_PII_BLOCKED`, `TOOL_EGRESS_BLOCKED`, `TOOL_CALL_LIMIT`, `TOOL_TIMEOUT`, `TOOL_EXECUTION_FAILED`, `PII_DETECTION_UNAVAILABLE`.

**Socket codes**: section 4.6. Recovery principles: preserve request IDs (HTTP) and event ids (socket) in support messages; never show stack traces, hostnames or configuration variable names to ordinary users (show the allowlist message to tool administrators only); keep the user's input on every failure; never loop retries.

## 11. Implementation sequence

1. Confirm the Phase 1–4 foundations. Extend the HTTP adapter with **download mode** (Appendix A `readDownload`) and **202 handling**.
2. Typed models (section 6), `phase5Capabilities`, query keys.
3. **The real-time client** (Appendix A `createRealtimeClient`): one per workspace, `auth:refresh` before expiry, close on switch/logout, reconnection with resubscribe + resume + REST refetch, the 30 s silence refetch. Build and test it before any live screen.
4. Tools: catalogue, detail, HTTP editor with issue mapping, test console, ledger (01–07).
5. Workflow definitions: directory, palette from node types, canvas with keyboard alternative, property panels, live validation, save/versions/restore, publish/archive/delete (08–20).
6. Runs: run dialog, run view with live overlay, content panels, cancel/resume/delete, my runs and everyone's (21–25, 27–28, 32).
7. Approvals inbox and decisions (29–30); dead letters and trace (31, 26).
8. Governance: quotas, history, circuits, notification toasts (43–51).
9. Command Centre (39–42) and audit (33–38).
10. Account data: export and erasure (52–53).
11. Failure states, in a disposable environment: stop the AI service during a run, exhaust a tiny quota, open a circuit with a large turn, time out an approval, revoke a key with its socket open, change a member's role during a waiting run, drop the network for 5 minutes with a run view open. Then the acceptance matrix (section 12) and the release gate (section 14).

These are work packages within Phase 5, not extra phases.


## 12. Acceptance checklist and demonstration

Every item starts unchecked. Check it only with evidence (fixture, frontend/backend commit, date, link). Use disposable workspaces with Owner/Administrator/Member/Viewer, one custom role with `workflow:approve` and `workflow:read_all` but no clearance, two tenants, a knowledge base with an INTERNAL document, an HTTP-tool allowlist, and real model calls. Never put revealed values, tokens, secrets or run content in evidence.

### Foundation

- [ ] P5-T01 Contextual permissions drive every control (`phase5Capabilities`); role names are never used for gating.
- [ ] P5-T02 Workspace header/path from one ID; switching workspaces closes the socket, aborts requests and never repaints stale runs, quotas or audit rows.
- [ ] P5-T03 Loading, empty, filtered-empty, forbidden, hidden-404, live and retryable states on every list, detail, canvas and run view.
- [ ] P5-T04 Download mode: audit export, archive and personal export saved with the server's filename; refusals shown as errors (status-based, not content-type-based).
- [ ] P5-T05 Keyboard, focus, polite live-region announcements, contrast, 360 px layout and reduced motion on every new screen; **the canvas is fully operable without a mouse**; no raw HTML from tool results, content, messages or audit metadata.

### Real-time

- [ ] P5-T06 One socket per workspace with `path: '/realtime'`, `transports: ['websocket']`, credentials only in `auth`; `ready` handled; refusal codes mapped (including the code-less transport error).
- [ ] P5-T07 `auth:refresh` before `ready.expiresAt` keeps the socket across token renewals; `auth:expired`, `auth:revoked` and the flood `error` close it without blind reconnection.
- [ ] P5-T08 Subscriptions per open run view (reference-counted), unsubscribed on leave; replay with `lastEventId`; events folded by id with no duplicates.
- [ ] P5-T09 After a network drop (≥5 minutes) or a hidden tab, the run view recovers by resubscribe + resume + REST refetch; an active run silent for 30 s is refetched.
- [ ] P5-T10 Notifications (`agent_email`, `quota.threshold`, `quota.exhausted`, `agent.circuit_opened`) shown as toasts, never as content; no durable inbox claimed.
- [ ] P5-T11 Rooms follow access: after a role change the inbox starts (or stops) receiving approval events without a reload.

### Tools (01–07)

- [ ] P5-T12 Catalogue with kind filter and search; built-ins read-only; `available`, `enabled` and data-policy badges.
- [ ] P5-T13 HTTP tool editor: all fields, schema subset enforced client-side, `TOOL_DEFINITION_INVALID` issues mapped by JSON pointer, allowlist refusal explained.
- [ ] P5-T14 Credential write-only: never displayed, "Credential set" with replace/remove (`null`).
- [ ] P5-T15 Data-policy loosening warned and confirmed; defaults explained.
- [ ] P5-T16 Edits send `expectedVersion`; 409 recovery; "creates version N+1" shown for behaviour changes only.
- [ ] P5-T17 Test console: 200 outcomes `ok`/`error`/`denied` rendered; side-effect and email warnings; results treated as sensitive.
- [ ] P5-T18 Ledger with tool and run filters; content-free columns; denial reasons readable.

### Workflow definitions (08–20)

- [ ] P5-T19 Palette and property panels from `node-types`; all eight node types configurable; numeric operands sent as numbers.
- [ ] P5-T20 Live validation (debounced) highlights nodes and edges; warnings separate; `stepBound` shown.
- [ ] P5-T21 Save with `expectedVersion`; invalid drafts saved and labelled; canvas reloaded from the normalised version; unsaved-change protection; 409 recovery.
- [ ] P5-T22 Versions: history, detail, restore (201) with confirmation, publish a chosen version; publish refusals list errors.
- [ ] P5-T23 Archive and un-archive by publishing; delete with the "runs are cancelled" warning.
- [ ] P5-T24 Templates autocomplete `input.*` and ancestor outputs; loops and supervisor teams buildable.

### Runs and approvals (21–32)

- [ ] P5-T25 Run dialog generated from the trigger schema; `WORKFLOW_INPUT_INVALID` issues mapped; idempotency key per submission; test runs only with `workflow:update`.
- [ ] P5-T26 Run view: canvas overlay, step timeline (iterations, attempts, tokens, tool calls, failure class), live and after reload.
- [ ] P5-T27 Run and step content with VISIBLE/MASKED/WITHHELD notices; reveal behind `pii:reveal` and a confirmation; never cached.
- [ ] P5-T28 Cancel, resume (FAILED/TIMED_OUT only) and delete (finished only) from `runActions`; 409s handled.
- [ ] P5-T29 Approval inbox: messages or "not cleared", `canDecide`, self-approval and clearance refusals, expiry countdowns, live refresh.
- [ ] P5-T30 Error routes, dead letters and the trace (complete/problems) rendered for supervisors.
- [ ] P5-T31 `WORKFLOW_CONCURRENCY_LIMIT`, `RATE_LIMIT_EXCEEDED` and governance refusals show countdowns, never loops.
- [ ] P5-T32 A run whose initiator lost access shows `WORKFLOW_PRINCIPAL_REVOKED` with an explanation.

### Governance, audit, analytics (33–51)

- [ ] P5-T33 Audit search with every filter, record detail, statistics; request-id lookup from an error toast.
- [ ] P5-T34 Verify chain with a clear valid/broken banner; export with a window; archives list (and download where retention is on).
- [ ] P5-T35 Command Centre: overview, time series (nulls as gaps), rankings gated by `quota:manage`, security feed with "Load older".
- [ ] P5-T36 Quotas: platform rows read-only, gauges, history, editor with weakening warnings; my quotas.
- [ ] P5-T37 Circuits: open list with countdowns, reset with the right permission; refusals in chat and runs explained.

### Personal data (52–53)

- [ ] P5-T38 Export downloads the JSON file; the 5-per-hour limit shows a countdown.
- [ ] P5-T39 Erasure: ownership pre-check with transfer links, password + second factor + phrase, field errors on 401, outcome shown, everything wiped and signed out.

### Sign-off

- [ ] P5-T40 Execute all 53 operations and the socket messages through the UI against a running backend; record sanitized evidence.
- [ ] P5-T41 No run content, revealed value, tool result, credential or audit metadata in storage, URLs, logs, telemetry or screenshots.
- [ ] P5-T42 Resolve or accept each section 13 decision.
- [ ] P5-T43 Complete the release gate in section 14; record frontend commit, backend commit, configuration and browser results; the owner accepts.

**Phase 5 demonstration:** define an HTTP tool and test it (show the PII refusal) → build a workflow on the canvas with a retrieval step, an approval and the gated tool, watch live validation, save and publish → as a Member, run it and watch steps light up live → as an Administrator, approve from the inbox (show an uncleared approver's withheld message) → open the run: masked content, reveal as the owner, the audit-derived trace → break and resume a run → show a dead letter → exhaust a tiny quota and open an agent circuit, then reset it → verify the audit chain and export it → walk the Command Centre → download my data. Then the full product demonstration in section 14.

## 13. Backend constraints and release decisions

Source-observed or verified behaviours the owner should decide on. Frontend mitigations are not server fixes; do not hide a gap behind a disabled button and call it resolved.

| ID | Behaviour | Decision / mitigation |
|---|---|---|
| P5-G01 | **Fixed during verification.** `POST /tools` did not enforce its required fields: `CreateToolDto` redeclares `displayName`, `description`, `parameters` and `http` from a base class whose `@IsOptional()` is inherited (class-validator keeps an inherited decorator unless the subclass declares one of the same kind, and evaluates conditions before `@IsDefined`). A body with only a name answered **500** (the registry dereferenced `http`/`parameters`); a missing or `null` display name answered 422 naming no field | Done: the four fields shadow the inherited marker (`ValidateIf(() => true)`) and add `@IsDefined()`. Verified live: 422 naming exactly the missing fields. Regression spec `src/modules/workflows/phase5-dto.spec.ts` |
| P5-G02 | **Fixed during verification.** The P4-G01 class of defect in every Phase 5 write body: `@IsOptional()` let `null` through for fields that cannot be cleared. Observed: `POST …/runs {"version": null}` → **500** (TypeORM refuses `null` in a lookup); `settings.runTimeoutMs: null` **stored as 0**, so **every run of that workflow timed out at once**, and `maxSteps: null` stored as 0; `expectedVersion: null` on tools and canvases → spurious 409 conflicts; `PATCH /workflows/:id {"name": null}` → 422 naming no field; `timeoutMs: null` silently reset a tool's timeout | Done: 40 fields across `tool.dto.ts`, `workflow.dto.ts`, `quota.dto.ts` and the erasure body use `@IsOptionalNotNull()` (`http.body` also `@NotEquals(null)`); clearable fields (workflow `description`, tool `secret`, quota `label`) keep `null`. Verified live for every body; spec as P5-G01 (7 of its 9 applicable tests fail on `69a9ba9`) |
| P5-G03 | **Fixed during verification.** `GET /tools/executions?toolId=abc` (or `runId=…`) reached PostgreSQL's uuid cast: **500**. `GET /workflow-runs?workflowId=abc` silently ignored the filter and returned **unfiltered** runs | Done: both validated as UUIDs (`@IsUUID('all')` for tools, since built-in ids are v5) → 422. Verified live; spec as P5-G01 |
| P5-G04 | **Fixed during verification.** `GET /audit-logs/export?from=garbage` passed `new Date('garbage')` into the stream: **400 with PostgreSQL's raw error text** as the body | Done: `ExportAuditLogsQueryDto` validates `from`/`to` before the stream opens → 422 envelope. Verified live; spec as P5-G01 |
| P5-G05 | **Fixed during verification.** Download routes declare `Content-Type: application/x-ndjson` and an attachment disposition up front, and Express's `json()` keeps an existing content type: every error envelope from those routes went out labelled NDJSON, as an attachment | Done: the global exception filter removes `Content-Disposition` and sets `application/json` on every error envelope. Verified live; spec `src/common/filters/all-exceptions.filter.spec.ts` (fails on `69a9ba9`) |
| P5-G06 | **Fixed during verification — the most important finding.** The event bus's Redis **subscriber connection was dropped silently** after a few minutes without events (an idle TCP connection on the path to the managed Valkey); the server forgot the subscription, the client still read `ready`, and **no live Socket.IO event reached any browser** until the process restarted — while `/health` reported `eventBus: "subscribed"`. Events were still written to the replay stream, so `subscribe`/`resume` replays worked. Proven: both the development and the verification instance had **zero** server-side subscriptions while healthy; a controlled experiment lost an idle subscriber after a 4-minute silence (a 3-minute one survived), while a subscriber that pinged every 30 s kept receiving | Done: the subscriber now PINGs every 30 s (keeps the path warm, detects a dead connection); an unanswered heartbeat forces a reconnect, after which ioredis resubscribes; `isSubscribed` (and so `/health`) requires a recent heartbeat. Spec `src/shared/events/event-bus.service.spec.ts` (4 of 5 fail on `69a9ba9`). Verified live: events delivered end to end after the fix. **Frontend:** still refetch active runs after 30 s of silence (section 9.3) |
| P5-G07 | A browser origin outside `CORS_ORIGINS`, and real-time disabled, are refused at the engine level before authentication: the client sees a bare transport error with **no code**; the documented `REALTIME_ORIGIN_NOT_ALLOWED` / `REALTIME_DISABLED` never reach a browser (verified) | Accept (defence in depth). Treat a code-less `connect_error` as "cannot reach live updates" and fall back to polling; the backend contract document was corrected |
| P5-G08 | `send_email` delivers only to **ACTIVE (email-verified)** members, and refuses others with the same message as a stranger ("does not belong to a member", verified) | Decide whether unverified members should receive agent email; the message should say "not a verified member". UI: explain in the tool's description |
| P5-G09 | Run idempotency keys are unique per **workflow**, not per initiator: a second member reusing a key gets the first member's run back (`duplicate: true`, its id, initiator, status), though they cannot read it (verified) | Low risk with random keys. Backend could scope the unique index to the initiator (a migration). Frontend: always a fresh UUID per submission |
| P5-G10 | `GET /audit-logs/verify?maxRecords=` is not validated: a non-numeric value is ignored and the whole chain is checked (verified) | Accept, or validate; the UI sends integers only |
| P5-G11 | `reveal=true` on **your own** run needs `pii:reveal` (403 otherwise, verified), unlike Phase 4 conversations, where it is ignored | Accept or align; the UI never offers reveal on your own run (`runActions.reveal`) |
| P5-G12 | The run trace needs `audit:read` but not run visibility: any audit reader can rebuild any run's trace (metadata only) | Accept (auditors see everything metadata-level) |
| P5-G13 | Approval messages are shown **unmasked** to cleared approvers, even in someone else's run (verified: an email address in the message), whereas supervised run content is masked | Decide: mask messages for non-initiators, or tell builders not to template personal data into approval messages |
| P5-G14 | Circuit lookups (`GET/DELETE …/circuits/agents/:id`) check only that the agent exists in the workspace, not that the caller can see it: a Member can confirm a hidden draft's id | Accept (ids are random) or apply agent visibility |
| P5-G15 | `usage:read` (Members by default) shows workspace-wide analytics and quotas; `tool:read` (Members and Viewers) shows every HTTP tool's URL, headers and data policy — never its credential | Accept, or narrow the Member and Viewer roles (Phase 2) |
| P5-G16 | Testing an unknown or deleted tool id answers **200** `denied` `TOOL_NOT_GRANTED` (not 404) and writes a ledger row named `unknown` (verified) | Accept; the UI only tests tools it listed |
| P5-G17 | Restoring a workflow version answers **201**; restoring an agent version (Phase 4) answers 200 | Accept; treat 2xx as success |
| P5-G18 | Resuming a run resets its deadline to the platform `WORKFLOW_RUN_TIMEOUT`, ignoring the workflow's lower `settings.runTimeoutMs` (verified: a 2 s workflow resumed with a 30 min deadline) | Decide; the UI shows the run's `deadlineAt` |
| P5-G19 | An **invalid** canvas is stored exactly as sent (unknown properties kept); only valid graphs are normalised | Accept; always reload from the saved version |
| P5-G20 | **HTTP tools are disabled on the development deployment**: `TOOL_HTTP_ALLOWED_HOSTS` is empty, so creation is refused at `/http/url` | Release decision: set the allowlist to the integrations the demo needs (section 14) |
| P5-G21 | An audit export can be checked offline for **links** (nothing removed or reordered), not for content: hashes are HMACs keyed by `AUDIT_HASH_SECRET` | Accept; content integrity is `verify`. Say so on the export screen |
| P5-G22 | `GET …/analytics/security-events` accepts `to` but ignores it | Use `before` for paging |
| P5-G23 | Unverified live: archive download (retention off), `REPEATED_FAILURES` circuits, `WORKFLOW_TOKEN_BUDGET_EXCEEDED`, `llm` supervisor routing, `step.retrying` and `tool.denied` events, `run.timed_out` event delivery (the run refreshed tokens before expiry), `REDACTION_UNAVAILABLE` in runs, `ACCOUNT_ERASURE_DISABLED`, `LLM_NOT_CONFIGURED` on run start | Implement per the source contract; test in a disposable environment before release |
| P5-G24 | Real-time ordering and replay limits: a run's first `step.queued` can precede `run.started`; replay is capped (200) before the room filter with no "more" flag; notifications have no REST store | Fold by id; reconcile with REST after any gap (section 9.3) |
| P5-G25 | Erasure keeps the audit log (evidence) and pseudonymous usage/tool ledgers; it deletes workspaces only the person belongs to | Accept; state it on the erasure screen |
| P5-G26 | The static [graph contract](../contracts/workflow-graph-v1.md) listed retrieval and supervisor without an `error` handle; the validator and `node-types` accept it | Corrected in the contract document; build from `node-types` |
| P5-G27 | Graph validation accepts a tool node whose tool `requiresApproval` with no approval node before it (verified: `valid: true`, no warning); the step is then denied `TOOL_APPROVAL_REQUIRED` at run time | Backend could report it as a validation error; the canvas warns meanwhile (section 4.4) |

For each row record the decision owner, intended behaviour, backend issue/commit if changed, evidence and date. An unresolved security-relevant row blocks a claim of production readiness.

## 14. Release, deployment and the final demonstration

Phase 5 is the last phase: it is accepted only when the **whole product** — Phases 1–5 — works together in a production-like deployment and the demonstration is reproducible. This section is the release gate (roadmap work package D, P5.15–P5.20).

### 14.1 Production configuration (frontend)

| Item | Requirement |
|---|---|
| API origin | `https://<api-host>`; `/api/v1` for HTTP, `/realtime` for Socket.IO on the same origin |
| Frontend origin | listed in the backend's `CORS_ORIGINS` (exact scheme, host, port; no trailing slash) — this also governs sockets (P5-G07) |
| Cookies | the refresh cookie needs `COOKIE_SECURE=true`; with frontend and API on different sites, `COOKIE_SAME_SITE=none` and HTTPS on both; `REFRESH_TOKEN_COOKIE_DOMAIN` only for a shared parent domain |
| Mail links | `FRONTEND_URL` on the backend = the frontend origin; the frontend serves `/auth/verify-email`, `/auth/reset-password`, `/invitations/accept` (Phase 1) |
| Route rewrites | the SPA host rewrites unknown paths to `index.html` (deep links, mail links) |
| Environment | public variables only: API origin, realtime path, app name. **No secrets, tokens or API keys in the bundle or the repository** |
| Proxy | WebSocket upgrades allowed; idle timeout above the 25 s Socket.IO ping |
| Builds | production build, typecheck and tests pass; source maps not public (or uploaded privately) |

### 14.2 Backend readiness to confirm with the backend owner

| Check | Evidence to record |
|---|---|
| `GET /health/ready` 200 and `GET /health` all `up` — including `realtime.eventBus: "subscribed"` (now heartbeat-backed, P5-G06) and `workflow_engine.workersEnabled` | the JSON, dated |
| Migrations applied and seed run (permissions, RLS policies) | migration list, seed output |
| Queue workers running (in the API process or a separate worker with the same environment) | `workflow_engine.workersEnabled: true`, a run completing |
| AI service reachable (`ai_service`, `pii_detector` up) | health JSON |
| Model endpoint allowlisted (`LLM_ALLOWED_MODELS`) and the token rate sized for the demo | a direct-chat call |
| `TOOL_HTTP_ALLOWED_HOSTS` set for the demo integrations (P5-G20) | a tool test |
| Mail transport for the audience (Ethereal for rehearsal, a real provider for a live demo) | an invitation received |
| `METRICS_TOKEN` set; `/metrics` not exposed publicly without it | 401 without the token |
| The six P5-G fixes and their specs committed and deployed | backend commit |

### 14.3 Cross-phase journeys to re-run (P5.15)

1. Register → verify email → create a workspace → enable MFA → sign out → MFA sign-in (Phase 1).
2. Invite a colleague → accept → custom role → API key issue and revoke → IP rule with safe recovery → transfer ownership (Phase 2).
3. Restricted knowledge base → upload → processing → retrieval → a member without the grant sees nothing (Phase 3).
4. Agent with knowledge → publish → streamed grounded answer with citations → stop → supervision masked → reveal as owner (Phase 4).
5. Tool → workflow with approval → live run → approval → trace → audit verify and export → quota and circuit → my data export (Phase 5).
6. **Tenant isolation** across all of the above with a second workspace and a non-member: lists, ids, sockets (no events cross tenants, verified in the live run).
7. Erasure of a disposable account at the end.

### 14.4 Quality gates (P5.17)

Accessibility (keyboard-only pass of every screen including the canvas, screen-reader pass of the run view and inbox, contrast), responsiveness (360 px, tablet, desktop), performance (first load budget, canvas with 50 nodes stays responsive, run view with 200 events), supported browsers (latest Chrome, Edge, Firefox, Safari; record versions).

### 14.5 Demonstration script (P5.19)

Prepare fixtures with synthetic data only (fictional names, `example.invalid`/`acme.test` addresses), a rehearsal environment, and screenshots without credentials. Script, ~20 minutes:

1. **Identity and workspace** (2 min): sign in with MFA; workspace switcher; permissions-aware navigation.
2. **Administration** (2 min): members, a custom role, an API key shown once.
3. **Knowledge and privacy** (3 min): upload, processing, a retrieval with citations; a restricted base invisible to a member; the privacy report.
4. **Agents** (4 min): build an agent, preview its masked prompt, publish; a member's streamed answer with citations; stop; supervision masked; reveal as owner.
5. **Orchestration** (5 min): a tool test with the PII refusal; a workflow with retrieval, approval and a gated tool; live validation; publish; a member's run lighting up live; approval from the inbox; masked run content; the trace.
6. **Governance** (3 min): a tiny quota refusing a call; an agent circuit opening and its reset; the audit chain verified and exported; the Command Centre.
7. **Personal data** (1 min): download my data; the erasure screen (do not erase the demo owner).
8. **Failure recovery** (as time allows): resume a failed run; a network drop with the run view recovering; an approval timeout.

### 14.6 Final gate (P5.20)

- [ ] Frontend production build, typecheck, lint and tests pass; commit recorded.
- [ ] Backend commit with the P5-G fixes recorded; backend unit suite and typecheck pass.
- [ ] Every Phase 1–5 acceptance list has evidence or a recorded deferral (receiving owner, rationale).
- [ ] Section 13 decisions recorded.
- [ ] Release configuration verified (14.1, 14.2) with dated evidence.
- [ ] Demonstration rehearsed end to end on the release environment.
- [ ] Known issues triaged; operating notes written (how to restart workers, rotate secrets, read `/health`).
- [ ] The owner records acceptance in the roadmap's delivery register.

## 15. Source map and delivery record

**Live verification:** [report](PHASE_5_LIVE_VERIFICATION.md), [results](PHASE_5_LIVE_RESULTS.json), [opt-in harness](../../scripts/verify-phase5-live.cjs).

| Area | Primary sources |
|---|---|
| Tools | [controller](../../src/modules/tools/tools.controller.ts), [DTO](../../src/modules/tools/dto/tool.dto.ts), [registry](../../src/modules/tools/tool-registry.service.ts), [executor](../../src/modules/tools/tool-executor.service.ts), [definition rules](../../src/modules/tools/domain/tool-definition.ts), [schema subset](../../src/modules/tools/domain/json-schema.ts), [information flow](../../src/modules/tools/domain/information-flow.ts), [HTTP runner](../../src/modules/tools/http/http-tool.runner.ts), [built-ins](../../src/modules/tools/builtins/) |
| Workflow definitions | [controller](../../src/modules/workflows/workflows.controller.ts), [DTO](../../src/modules/workflows/dto/workflow.dto.ts), [service](../../src/modules/workflows/workflows.service.ts), [graph](../../src/modules/workflows/domain/graph.ts), [validation](../../src/modules/workflows/domain/graph-validation.ts), [node catalogue](../../src/modules/workflows/domain/node-catalogue.ts), [templates](../../src/modules/workflows/domain/templates.ts), [contract](../contracts/workflow-graph-v1.md) |
| Runs | [controller](../../src/modules/workflows/workflow-runs.controller.ts), [service](../../src/modules/workflows/workflow-runs.service.ts), [engine](../../src/modules/workflows/engine/workflow-engine.service.ts), [step executor](../../src/modules/workflows/engine/step-executor.service.ts), [scheduler](../../src/modules/workflows/domain/scheduler.ts), [maintenance sweep](../../src/modules/workflows/engine/workflow-maintenance.service.ts), [run principal](../../src/modules/workflows/run-principal.service.ts), [trace](../../src/modules/workflows/domain/trace.ts) |
| Real-time | [gateway](../../src/modules/realtime/realtime.gateway.ts), [authentication](../../src/modules/realtime/realtime-auth.service.ts), [routing](../../src/modules/realtime/realtime-routing.ts), [adapter](../../src/modules/realtime/realtime-io.adapter.ts), [event bus](../../src/shared/events/event-bus.service.ts), [events](../../src/shared/events/realtime-event.ts), [contract](../contracts/realtime-v1.md) |
| Audit | [controller](../../src/modules/audit/audit.controller.ts), [DTO](../../src/modules/audit/dto/audit.dto.ts), [service](../../src/modules/audit/audit.service.ts), [retention](../../src/modules/audit/audit-retention.service.ts) |
| Analytics | [controller](../../src/modules/analytics/analytics.controller.ts), [DTO](../../src/modules/analytics/dto/analytics.dto.ts), [service](../../src/modules/analytics/analytics.service.ts) |
| Quotas and circuits | [controller](../../src/modules/quotas/quotas.controller.ts), [DTO](../../src/modules/quotas/dto/quota.dto.ts), [management](../../src/modules/quotas/quota-management.service.ts), [quota model](../../src/modules/quotas/domain/quota-model.ts), [governor](../../src/modules/quotas/governor.service.ts), [agent circuit](../../src/modules/quotas/agent-circuit.service.ts) |
| Personal data | [controller](../../src/modules/lifecycle/personal-data.controller.ts), [service](../../src/modules/lifecycle/personal-data.service.ts) |
| Permissions and roles | [catalogue and system roles](../../src/common/constants/permissions.constants.ts) |
| Design rationale | [ADR 0004: orchestration, tools and real-time](../adr/0004-orchestration-tools-realtime.md) |
| Configuration defaults | [environment schema](../../src/config/env.validation.ts), [throttle policies](../../src/config/throttle.config.ts), [tools](../../src/config/tools.config.ts), [real-time](../../src/config/realtime.config.ts), [cloud setup](../CLOUD_SETUP.md) |

| Delivery field | Current record |
|---|---|
| Specification | Revision 1; 53 operations + Socket.IO; 43 acceptance checks; 27 decision records; release gate |
| Backend source baseline | `69a9ba9` plus the P5-G01–G06 fixes and their specs (in the working tree) |
| Live API evidence | 783 checks, 783 passed, all 53 operations and the socket channel, real model calls, real outbound HTTP, real email, MFA, erasure |
| Appendix A | Type-checked with the repository's TypeScript 6.0.3 (`strict`, DOM); 29 assertions against a live backend (section 16) |
| Frontend implementation commit | Not supplied |
| Owner acceptance | Not yet recorded |

Phase 5 — and the product — is implemented only when working client code exists, every applicable acceptance check has evidence, section 13 decisions are recorded, the release gate in section 14 is complete, and the owner accepts.


## Appendix A — TypeScript helpers

Framework-neutral helpers implementing sections 3, 4, 9 and 10. Save the section 6 types as `phase5-types.ts` and this file beside it as `phase5-helpers.ts`; the only dependency is `socket.io-client` 4.x (for its `Socket` type). Both files were compiled with the repository's TypeScript 6.0.3 (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, DOM lib).

A separate script then exercised them against the **live backend** (29 assertions, all passed): `phase5Capabilities` on a real owner's permission list; `fromGraph` → `toGraph` on a stored graph, re-saved with **no new version** (the mapping is lossless); `sourceHandles` and `templateReferences` on real nodes; `issuesByElement` on two real validation reports; `createRealtimeClient` connected to the real socket, subscribed to a real run, delivered every event exactly once across replay and live delivery, and `runViewFrom` + `applyRunEvent` folded those events into **exactly the REST step statuses and handles**; old events ignored; a second run delivered without duplicates; `close()` reported; `readDownload` on the real audit export (filename `audit-log.ndjson`), a refused export (typed 422 failure with request id) and the personal-data file (dated name); `checkExportLinks` on the real export (linked) and with a line removed (broken); `filenameFrom` with RFC 5987; `quotaGauge` on the real platform rows; `approvalControls`, `runActions`, `runErrorText`, `compareEventIds`.

The real-time client covers the rules in sections 4.6 and 9.3: one socket per workspace, `auth:refresh` a minute before `ready.expiresAt`, resubscribe + `resume` after every `ready`, id-based de-duplication, a final `onClosed` for revocation, expiry, floods and refused handshakes (a code-less `connect_error` is left to Socket.IO's reconnection). Add the 30-second silence refetch in the run view itself, where you know whether the run is active.

```ts
import type { Socket } from 'socket.io-client';
import type {
  ApprovalItem,
  AuditExportLine,
  GraphEdge,
  GraphIssue,
  GraphNode,
  NotificationEvent,
  Quota,
  ReadyPayload,
  RealtimeEvent,
  RefreshAck,
  ResumeAck,
  Run,
  RunDetail,
  RunStatus,
  Step,
  StepStatus,
  SubscribeAck,
  ValidationReport,
  WorkflowGraph,
} from './phase5-types';

// ── Capabilities (section 3) ────────────────────────────────────────────────

/** `permissions` is the expanded list from contextual GET /auth/me (no wildcards). */
export function phase5Capabilities(permissions: readonly string[]) {
  const has = (key: string) => permissions.includes(key);
  return {
    readTools: has('tool:read'),
    createTools: has('tool:create'),
    editTools: has('tool:update'),
    deleteTools: has('tool:delete'),
    /** Testing needs both: it edits nothing, but it runs the tool for real. */
    testTools: has('tool:update') && has('tool:execute'),
    readToolLedger: has('tool:read') && has('usage:read'),
    readWorkflows: has('workflow:read'),
    createWorkflows: has('workflow:create'),
    editWorkflows: has('workflow:update'),
    validateWorkflows: has('workflow:create') || has('workflow:update'),
    publishWorkflows: has('workflow:publish'),
    deleteWorkflows: has('workflow:delete'),
    runWorkflows: has('workflow:execute'),
    /** Run a version other than the published one (a test run). */
    testRunWorkflows: has('workflow:execute') && has('workflow:update'),
    superviseRuns: has('workflow:read_all'),
    approve: has('workflow:approve'),
    readDeadLetters: has('workflow:update'),
    readTrace: has('workflow:read') && has('audit:read'),
    revealPersonalData: has('pii:reveal'),
    readAudit: has('audit:read'),
    exportAudit: has('audit:export'),
    verifyAudit: has('audit:verify'),
    readAnalytics: has('usage:read'),
    rankPeople: has('usage:read') && has('quota:manage'),
    readSecurityFeed: has('audit:read') || has('security:read'),
    readQuotas: has('usage:read') || has('quota:manage'),
    readOwnQuotas: has('usage:read') || has('llm:invoke') || has('agent:execute'),
    manageQuotas: has('quota:manage'),
    readCircuits: has('usage:read') || has('quota:manage') || has('agent:read'),
    resetCircuits: has('quota:manage') || has('agent:update'),
  };
}
export type Phase5Capabilities = ReturnType<typeof phase5Capabilities>;

const ACTIVE: ReadonlySet<RunStatus> = new Set(['QUEUED', 'RUNNING', 'WAITING_APPROVAL']);
export const isRunActive = (status: RunStatus): boolean => ACTIVE.has(status);

/** What the current person may do with one run. The server re-checks everything. */
export function runActions(run: Pick<Run, 'status' | 'initiatorUserId'>, me: { userId: string }, can: Phase5Capabilities) {
  const own = run.initiatorUserId === me.userId;
  const control = (own && can.runWorkflows) || can.editWorkflows;
  return {
    cancel: control && isRunActive(run.status),
    resume: control && (run.status === 'FAILED' || run.status === 'TIMED_OUT'),
    delete: (own || can.deleteWorkflows) && !isRunActive(run.status),
    reveal: !own && can.revealPersonalData,
    trace: can.readTrace,
  };
}

/** Whether to show Approve/Reject on an approval-queue row. */
export function approvalControls(item: ApprovalItem): { show: boolean; why: string | null } {
  if (item.canDecide) return { show: true, why: null };
  if (item.message === null) return { show: false, why: 'You are not cleared for the information in this request.' };
  return { show: false, why: 'You started this run, so someone else must decide.' };
}

// ── The canvas (section 4.2): React Flow state ⇄ the graph contract ─────────

export interface FlowNodeLike { id: string; type?: string; position: { x: number; y: number }; data: unknown; label?: string }
export interface FlowEdgeLike { id: string; source: string; target: string; sourceHandle?: string | null; data?: unknown }

/**
 * The PUT body's `graph` from React Flow state. Only contract fields are sent
 * (the server drops the rest anyway); reload the canvas from the saved version.
 */
export function toGraph(nodes: readonly FlowNodeLike[], edges: readonly FlowEdgeLike[], viewport?: { x: number; y: number; zoom: number }): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      ...(node.label ? { label: node.label } : {}),
      data: node.data ?? {},
    })) as GraphNode[],
    edges: edges.map((edge) => {
      const out: GraphEdge = { id: edge.id, source: edge.source, target: edge.target };
      if (edge.sourceHandle && edge.sourceHandle !== 'out') out.sourceHandle = edge.sourceHandle;
      const loop = (edge.data as GraphEdge['data'] | undefined)?.loop;
      if (loop) out.data = { loop };
      return out;
    }),
    ...(viewport ? { viewport } : {}),
  };
}

/** React Flow state from a stored version's graph. */
export function fromGraph(graph: WorkflowGraph): { nodes: FlowNodeLike[]; edges: FlowEdgeLike[]; viewport: { x: number; y: number; zoom: number } } {
  return {
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      type: node.type,
      position: node.position ?? { x: index * 240, y: 0 },
      data: node.data,
      ...(node.label ? { label: node.label } : {}),
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? 'out',
      ...(edge.data ? { data: edge.data } : {}),
    })),
    viewport: graph.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}

/**
 * The source handles a node offers, for its edge sockets — as the validator
 * accepts them (and as GET …/node-types `outputs` lists them).
 */
export function sourceHandles(node: GraphNode): string[] {
  switch (node.type) {
    case 'trigger':
      return ['out'];
    case 'agent':
    case 'tool':
    case 'retrieval':
      return ['out', 'error'];
    case 'condition':
      return [...node.data.rules.map((rule) => rule.id), 'else'];
    case 'supervisor':
      return ['worker', 'done', 'error'];
    case 'approval':
      return ['approved', 'rejected'];
    case 'output':
      return [];
  }
}

/** Groups a validation report by canvas element, for red outlines and tooltips. */
export function issuesByElement(report: Pick<ValidationReport, 'errors' | 'warnings'>) {
  const nodes = new Map<string, GraphIssue[]>();
  const edges = new Map<string, GraphIssue[]>();
  const graph: GraphIssue[] = [];
  for (const issue of [...report.errors, ...report.warnings]) {
    if (issue.nodeId) nodes.set(issue.nodeId, [...(nodes.get(issue.nodeId) ?? []), issue]);
    else if (issue.edgeId) edges.set(issue.edgeId, [...(edges.get(issue.edgeId) ?? []), issue]);
    else graph.push(issue);
  }
  return { nodes, edges, graph };
}

/** The `{{…}}` references in a template, for autocompletion and highlighting. */
export function templateReferences(template: string): Array<{ path: string; optional: boolean; node: string | null }> {
  const found: Array<{ path: string; optional: boolean; node: string | null }> = [];
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const raw = match[1];
    const optional = raw.endsWith('?');
    const path = optional ? raw.slice(0, -1).trim() : raw;
    const node = /^nodes\.([A-Za-z0-9_-]+)\./.exec(path)?.[1] ?? null;
    found.push({ path, optional, node });
  }
  return found;
}

// ── Run view: REST snapshot + live events (sections 4.3 and 9) ──────────────

export interface RunView {
  run: Run;
  /** Keyed "nodeId#iteration". */
  steps: Map<string, Pick<Step, 'nodeId' | 'iteration' | 'status' | 'handles'> & Partial<Step>>;
  /** Newest event applied (stream id), to dedupe and to resume from. */
  lastEventId: string | null;
}

export const stepKey = (nodeId: string, iteration: number): string => `${nodeId}#${iteration}`;

/** Stream ids are "<ms>-<seq>": compare numerically, never as strings of different length. */
export function compareEventIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt);
  const [bm, bs] = b.split('-').map(BigInt);
  return am === bm ? (as === bs ? 0 : as < bs ? -1 : 1) : am < bm ? -1 : 1;
}

export function runViewFrom(detail: RunDetail, lastEventId: string | null = null): RunView {
  return {
    run: { ...detail },
    steps: new Map(detail.steps.map((step) => [stepKey(step.nodeId, step.iteration), { ...step }])),
    lastEventId,
  };
}

const STEP_STATUS: Partial<Record<RealtimeEvent['type'], StepStatus>> = {
  'step.queued': 'QUEUED',
  'step.started': 'RUNNING',
  'step.retrying': 'QUEUED',
  'step.completed': 'SUCCEEDED',
  'step.failed': 'FAILED',
  'step.skipped': 'SKIPPED',
  'step.waiting_approval': 'WAITING_APPROVAL',
};
const RUN_STATUS: Partial<Record<RealtimeEvent['type'], RunStatus>> = {
  'run.started': 'RUNNING',
  'run.resumed': 'RUNNING',
  'run.completed': 'COMPLETED',
  'run.failed': 'FAILED',
  'run.cancelled': 'CANCELLED',
  'run.timed_out': 'TIMED_OUT',
};

/**
 * Folds one event into the view. Pure. Events at or before `lastEventId` are
 * ignored (replays overlap live delivery); a terminal run status is never
 * reopened except by run.resumed. Events are hints: refetch the run when it
 * finishes, and whenever `needsRefetch` says the view cannot be trusted.
 */
export function applyRunEvent(view: RunView, event: RealtimeEvent): RunView {
  if (event.runId !== view.run.id) return view;
  if (view.lastEventId && compareEventIds(event.id, view.lastEventId) <= 0) return view;
  const next: RunView = { run: { ...view.run }, steps: new Map(view.steps), lastEventId: event.id };

  const runStatus = RUN_STATUS[event.type];
  if (runStatus && (event.type === 'run.resumed' || isRunActive(view.run.status))) {
    next.run.status = runStatus;
    if (typeof event.data.tokensUsed === 'number') next.run.tokensUsed = event.data.tokensUsed;
    if (typeof event.data.errorCode === 'string') next.run.errorCode = event.data.errorCode;
  }
  if (event.type === 'step.waiting_approval') next.run.status = 'WAITING_APPROVAL';
  if (event.type === 'approval.decided' && view.run.status === 'WAITING_APPROVAL') next.run.status = 'RUNNING';

  const stepStatus = STEP_STATUS[event.type];
  if (stepStatus && event.nodeId !== undefined && typeof event.data.iteration === 'number') {
    const key = stepKey(event.nodeId, event.data.iteration);
    const previous = next.steps.get(key);
    const handles = Array.isArray(event.data.handles) ? (event.data.handles as string[]) : previous?.handles ?? [];
    next.steps.set(key, {
      ...previous,
      nodeId: event.nodeId,
      iteration: event.data.iteration,
      status: stepStatus,
      handles,
      ...(event.stepId ? { id: event.stepId } : {}),
      ...(typeof event.data.durationMs === 'number' ? { durationMs: event.data.durationMs } : {}),
      ...(typeof event.data.errorCode === 'string' ? { errorCode: event.data.errorCode } : {}),
    });
  }
  return next;
}

/** True when the run reached a final state: refetch the detail for the authoritative view. */
export const needsRefetch = (event: RealtimeEvent): boolean =>
  event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled' ||
  event.type === 'run.timed_out' || event.type === 'run.resumed';

// ── The real-time client (section 4.6) ──────────────────────────────────────

export interface RealtimeHandlers {
  onReady?(ready: ReadyPayload): void;
  onEvent?(event: RealtimeEvent): void;
  onNotification?(event: NotificationEvent): void;
  /** The socket closed for good: revoked, expired without refresh, refused, or rate limited. */
  onClosed?(reason: { code: string | null; message: string; retryable: boolean }): void;
}

export interface RealtimeClient {
  readonly lastEventId: string | null;
  subscribe(runId: string): Promise<SubscribeAck>;
  unsubscribe(runId: string): Promise<void>;
  close(): void;
}

/**
 * One socket per workspace. Socket.IO's own reconnection handles network
 * drops; after each (re)connect this client resubscribes and replays what was
 * missed with `lastEventId`. The access token is pushed with `auth:refresh`
 * a minute before `ready.expiresAt`. A server-initiated close (revoked, expired,
 * flood) is final: the caller decides whether to start a new client.
 */
export function createRealtimeClient(options: {
  connect: (auth: { token: string; organizationId: string }) => Socket;
  organizationId: string;
  /** Returns a valid access token, refreshing over HTTP when needed (the Phase 1 session). */
  getToken: () => Promise<string>;
  handlers: RealtimeHandlers;
  ackTimeoutMs?: number;
}): RealtimeClient {
  const ackTimeout = options.ackTimeoutMs ?? 10_000;
  const subscriptions = new Set<string>();
  const seen = new Set<string>();
  let lastEventId: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let socket: Socket | null = null;

  const emit = <T>(event: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, code: 'ACK_TIMEOUT', message: 'No acknowledgement.' } as T), ackTimeout);
      socket?.emit(event, payload, (ack: T) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });

  const deliver = (event: RealtimeEvent | NotificationEvent) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 5_000) seen.clear();
    if (!lastEventId || compareEventIds(event.id, lastEventId) > 0) lastEventId = event.id;
    if (event.type === 'notification') options.handlers.onNotification?.(event);
    else options.handlers.onEvent?.(event);
  };

  const finish = (code: string | null, message: string, retryable: boolean) => {
    if (closed) return;
    closed = true;
    clearTimeout(refreshTimer);
    socket?.close();
    options.handlers.onClosed?.({ code, message, retryable });
  };

  const scheduleRefresh = (expiresAt: number | null) => {
    clearTimeout(refreshTimer);
    if (expiresAt === null) return;
    const inMs = Math.max(5_000, expiresAt - Date.now() - 60_000);
    refreshTimer = setTimeout(() => {
      void (async () => {
        const ack = await emit<RefreshAck>('auth:refresh', { token: await options.getToken() });
        if (ack.ok) scheduleRefresh(ack.expiresAt);
      })();
    }, inMs);
  };

  void (async () => {
    socket = options.connect({ token: await options.getToken(), organizationId: options.organizationId });
    socket.on('ready', (ready: ReadyPayload) => {
      options.handlers.onReady?.(ready);
      scheduleRefresh(ready.expiresAt);
      // After any (re)connect: resubscribe, replaying what was missed.
      void (async () => {
        for (const runId of subscriptions) {
          const ack = await emit<SubscribeAck>('subscribe', { runId, ...(lastEventId ? { lastEventId } : {}) });
          if (ack.ok) ack.events.forEach(deliver);
        }
        if (lastEventId) {
          const resumed = await emit<ResumeAck>('resume', { lastEventId });
          if (resumed.ok) resumed.events.forEach(deliver);
        }
      })();
    });
    socket.on('event', deliver);
    socket.on('notification', deliver);
    socket.on('auth:revoked', (data: { code: string }) => finish(data.code, 'Access to this workspace changed.', false));
    socket.on('auth:expired', (data: { code: string }) => finish(data.code, 'The session expired.', true));
    socket.on('error', (data: { code?: string }) => finish(data?.code ?? null, 'Too many messages.', true));
    socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      // A refused handshake carries a code; a bare transport error (no code) is
      // the network, the origin check, or REALTIME_ENABLED=false.
      const code = error.data?.code ?? null;
      if (code) finish(code, error.message, code.startsWith('AUTH_TOKEN'));
    });
    socket.on('disconnect', (reason: string) => {
      if (reason === 'io server disconnect') finish(null, 'The server closed the connection.', true);
    });
  })();

  return {
    get lastEventId() {
      return lastEventId;
    },
    async subscribe(runId) {
      subscriptions.add(runId);
      const ack = await emit<SubscribeAck>('subscribe', { runId, lastEventId: lastEventId ?? '0-0' });
      if (ack.ok) ack.events.forEach(deliver);
      else subscriptions.delete(runId);
      return ack;
    },
    async unsubscribe(runId) {
      subscriptions.delete(runId);
      await emit('unsubscribe', { runId });
    },
    close() {
      finish(null, 'Closed by the app.', false);
    },
  };
}

// ── Downloads (audit export, archives, personal data) ───────────────────────

export interface DownloadResult { ok: true; blob: Blob; filename: string }
export interface DownloadFailure { ok: false; status: number; code: string; message: string; retryAfterSeconds?: number; requestId?: string }

/** The filename from Content-Disposition (CORS exposes it), with a fallback. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (star) return decodeURIComponent(star);
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? fallback;
}

/**
 * Reads a download response. Branches on the status, never on the content
 * type: an error is a JSON envelope (older servers labelled it NDJSON).
 */
export async function readDownload(response: Response, fallbackName: string): Promise<DownloadResult | DownloadFailure> {
  if (response.ok) {
    return { ok: true, blob: await response.blob(), filename: filenameFrom(response.headers.get('content-disposition'), fallbackName) };
  }
  const text = await response.text();
  let envelope: { error?: { code?: string; message?: string }; meta?: { requestId?: string } } = {};
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    /* not JSON: keep the generic failure */
  }
  const retry = Number(response.headers.get('retry-after'));
  return {
    ok: false,
    status: response.status,
    code: envelope.error?.code ?? 'UNEXPECTED_RESPONSE',
    message: envelope.error?.message ?? 'The download failed.',
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
    ...(envelope.meta?.requestId ? { requestId: envelope.meta.requestId } : {}),
  };
}

/**
 * The offline check an export allows: every line follows the previous one
 * (consecutive sequence, previousHash = previous hash). Recomputing each hash
 * needs the server's AUDIT_HASH_SECRET, so content integrity is what
 * GET …/audit-logs/verify establishes; this proves nothing was removed or
 * reordered within the file.
 */
export function checkExportLinks(ndjson: string): { lines: number; linked: boolean; brokenAt: string | null } {
  const records = ndjson.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as AuditExportLine);
  for (let i = 1; i < records.length; i += 1) {
    const previous = records[i - 1];
    const record = records[i];
    if (BigInt(record.sequence) !== BigInt(previous.sequence) + 1n || record.previousHash !== previous.hash) {
      return { lines: records.length, linked: false, brokenAt: record.sequence };
    }
  }
  return { lines: records.length, linked: true, brokenAt: null };
}

// ── Quotas (section 4.7) ────────────────────────────────────────────────────

export function quotaGauge(quota: Quota): { label: string; percent: number | null; tone: 'ok' | 'warning' | 'danger' } {
  if (quota.usage) {
    const percent = quota.usage.percent;
    const tone = percent >= 100 ? 'danger' : percent >= quota.alertThreshold ? 'warning' : 'ok';
    return { label: `${quota.usage.used.toLocaleString()} of ${quota.tokenLimit.toLocaleString()} tokens`, percent, tone };
  }
  const available = quota.rate?.available;
  return {
    label: available === null || available === undefined ? `${quota.tokenLimit.toLocaleString()} tokens per minute` : `${available.toLocaleString()} of ${quota.tokenLimit.toLocaleString()} tokens available this minute`,
    percent: available === null || available === undefined ? null : Math.round((1 - available / quota.tokenLimit) * 100),
    tone: 'ok',
  };
}

// ── Errors (section 10) ─────────────────────────────────────────────────────

const RUN_ERROR_TEXT: Readonly<Record<string, string>> = {
  WORKFLOW_PRINCIPAL_REVOKED: 'Stopped: the person who started this run no longer has permission to run it.',
  WORKFLOW_TIMEOUT: 'Stopped: the run passed its time limit. You can resume it.',
  WORKFLOW_STEP_LIMIT_EXCEEDED: 'Stopped: the run reached its step limit.',
  WORKFLOW_TOKEN_BUDGET_EXCEEDED: 'Stopped: the run used its token budget.',
  WORKFLOW_LOOP_EXHAUSTED: 'Stopped: a loop ran out of iterations.',
  WORKFLOW_NO_OUTPUT: 'Finished without reaching an output.',
  WORKFLOW_TEMPLATE_ERROR: 'A step referred to a value that was not there.',
  TOOL_PII_BLOCKED: 'Stopped to protect personal data: a tool may not receive it.',
  TOOL_EGRESS_BLOCKED: 'Stopped: the tool would have sent data it may not send.',
  TOOL_TIMEOUT: 'A tool did not answer in time.',
  TOOL_EXECUTION_FAILED: 'A tool failed.',
  AGENT_CIRCUIT_OPEN: 'An agent in this run is paused after unusual activity.',
  QUOTA_EXCEEDED: 'The token budget for this period is used up.',
};
export const runErrorText = (code: string | null): string | null =>
  code === null ? null : RUN_ERROR_TEXT[code] ?? 'The run failed.';
```
