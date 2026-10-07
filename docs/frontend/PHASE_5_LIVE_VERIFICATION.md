# Phase 5 live API verification

**Date:** 7 October 2026, Asia/Karachi. **Backend source baseline:** `69a9ba9` plus the P5-G01–P5-G06 fixes (in the working tree, not yet committed).

This report supplements the [Phase 5 handoff](PHASE_5_TOOLS_ORCHESTRATION_GOVERNANCE_RELEASE.md). The owner asked for every Phase 5 endpoint to be tested and proven, as the final phase. The tests sent real HTTP requests and opened real Socket.IO connections, made real model calls, real outbound HTTPS tool calls and real email deliveries, enrolled MFA with real TOTP codes, and used disposable fixtures. Six backend defects found during the work were fixed with regression tests; no other backend behaviour was changed.

**Result of the final run: 783 checks, 783 passed; all 53 Phase 5 operations exercised, plus 52/52 Socket.IO checks and 4/4 operator-diagnostic checks.** Completed at 2026-10-07T00:21:43.966Z (UTC). Machine-readable evidence: [PHASE_5_LIVE_RESULTS.json](PHASE_5_LIVE_RESULTS.json). Flow-control waits (token rate, model capacity): 0; transient dependency retries: 0.

## Environment

The run targeted a **dedicated instance of the same build** on `http://localhost:3100`, started from the working tree with the fixes, against the same cloud stack as the development backend (`npm run start:dev` on `:3000`, which another session was using). The development server was not stopped or reconfigured, but as a watch-mode server it **restarted itself each time a backend fix was saved** (a few times during the day; each restart took about a minute). The verification instance loaded the development `.env` and overrode only:

| Setting | Value | Why |
|---|---|---|
| `APP_PORT`, `APP_URL` | `3100` | a separate listener |
| `REDIS_KEY_PREFIX`, `QUEUE_PREFIX` | `daiap:p5v:`, `daiap_p5v_bull` | its own jobs, events, rate limits and breakers: never shared with the development server |
| `DB_POOL_MAX` | 5 | stays within Supabase's session pooler next to the development server's 8 |
| `TOOL_HTTP_ALLOWED_HOSTS` | `postman-echo.com,httpbin.org` | HTTP tools are disabled on the development `.env` (P5-G20); these public test services echo requests and return chosen statuses and delays |
| `WORKFLOW_SWEEP_INTERVAL` | 15 s (default 1 min) | approval and run timeouts resolve within the run |
| `AGENT_CIRCUIT_WINDOW`, `AGENT_CIRCUIT_MAX_TOKENS`, `AGENT_CIRCUIT_COOLDOWN` | 10 s, 2,500, 60 s | one oversized turn opens a breaker without minutes of traffic |

| Dependency | What served it | Health at start |
|---|---|---|
| Language model | Groq's OpenAI-compatible API, `qwen/qwen3.8-27b` (`LLM_MAX_CONCURRENCY=1`, workspace token rate 8,000/min) | up |
| PostgreSQL | Supabase (session pooler), row-level security enforced under `daiap_rls` | up |
| Queues, workers, pub/sub | Aiven Valkey; workflow and ingestion workers inside the instance | up; event bus subscribed (heartbeat-backed after P5-G06) |
| Object storage, vector store | Cloudflare R2, Qdrant Cloud | up |
| AI service | the project's `ai-service/` on `127.0.0.1:8000` (embeddings, reranking, Presidio + spaCy + bert-base-NER) | up |
| Mail | Ethereal SMTP test inbox, read over IMAP | invitations, verification, tool email, erasure farewell |
| Outbound HTTP | `postman-echo.com`, `httpbin.org` over HTTPS | reachable |

## Coverage by operation

Each row counts the recorded requests to that operation and the outcomes observed. Polling reads are not recorded. Further checks assert response shapes, stored state, labels, masking, socket rooms and events, notifications, emails and downloads.

| Operation | Requests | Passed | Outcomes observed |
|---|---:|---:|---|
| P5-API-01 List tools | 8 | 8 | 200, 404 `ORGANIZATION_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P5-API-02 Define a tool | 19 | 19 | 201, 401 `AUTH_SCHEME_NOT_ALLOWED`, 403 `PERMISSION_DENIED`, 409 `TOOL_NAME_TAKEN`, 422 `TOOL_DEFINITION_INVALID`, 422 `VALIDATION_FAILED` |
| P5-API-03 Tool ledger | 7 | 7 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-04 Read a tool | 4 | 4 | 200, 404 `TOOL_NOT_FOUND` |
| P5-API-05 Edit a tool | 14 | 14 | 200, 403 `PERMISSION_DENIED`, 404 `TOOL_NOT_FOUND`, 409 `RESOURCE_CONFLICT`, 409 `TOOL_DEFINITION_INVALID`, 422 `VALIDATION_FAILED` |
| P5-API-06 Delete a tool | 5 | 5 | 200, 403 `PERMISSION_DENIED`, 404 `TOOL_NOT_FOUND` |
| P5-API-07 Test a tool | 18 | 18 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-08 List workflows | 5 | 5 | 200, 422 `VALIDATION_FAILED` |
| P5-API-09 Node palette | 2 | 2 | 200, 404 `ORGANIZATION_NOT_FOUND` |
| P5-API-10 Validate | 22 | 22 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-11 Create a workflow | 20 | 20 | 201, 401 `AUTH_SCHEME_NOT_ALLOWED`, 403 `PERMISSION_DENIED`, 409 `WORKFLOW_NAME_TAKEN`, 422 `VALIDATION_FAILED` |
| P5-API-12 Read a workflow | 4 | 4 | 200, 400 `BAD_REQUEST`, 404 `WORKFLOW_NOT_FOUND` |
| P5-API-13 Rename | 6 | 6 | 200, 403 `PERMISSION_DENIED`, 409 `WORKFLOW_NAME_TAKEN`, 422 `VALIDATION_FAILED` |
| P5-API-14 Save the canvas | 6 | 6 | 200, 403 `PERMISSION_DENIED`, 409 `WORKFLOW_VERSION_CONFLICT`, 422 `VALIDATION_FAILED` |
| P5-API-15 Version history | 2 | 2 | 200 |
| P5-API-16 One version | 4 | 4 | 200, 400 `BAD_REQUEST`, 404 `WORKFLOW_VERSION_NOT_FOUND` |
| P5-API-17 Restore a version | 4 | 4 | 201, 403 `PERMISSION_DENIED`, 404 `WORKFLOW_VERSION_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P5-API-18 Publish | 17 | 17 | 200, 403 `PERMISSION_DENIED`, 422 `WORKFLOW_INVALID` |
| P5-API-19 Archive | 3 | 3 | 200, 403 `PERMISSION_DENIED` |
| P5-API-20 Delete a workflow | 3 | 3 | 200, 403 `PERMISSION_DENIED`, 404 `WORKFLOW_NOT_FOUND` |
| P5-API-21 Start a run | 38 | 38 | 202, 403 `PERMISSION_DENIED`, 404 `WORKFLOW_NOT_FOUND`, 409 `WORKFLOW_NOT_ACTIVE`, 422 `VALIDATION_FAILED`, 422 `WORKFLOW_INPUT_INVALID`, 422 `WORKFLOW_INVALID`, 429 `WORKFLOW_CONCURRENCY_LIMIT` |
| P5-API-22 List runs | 7 | 7 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-23 Run detail | 8 | 8 | 200, 400 `BAD_REQUEST`, 404 `WORKFLOW_RUN_NOT_FOUND` |
| P5-API-24 Run content | 10 | 10 | 200, 403 `PERMISSION_DENIED`, 404 `WORKFLOW_RUN_NOT_FOUND` |
| P5-API-25 Step content | 4 | 4 | 200, 400 `BAD_REQUEST`, 404 `WORKFLOW_STEP_NOT_FOUND` |
| P5-API-26 Trace | 4 | 4 | 200, 403 `PERMISSION_DENIED`, 404 `WORKFLOW_RUN_NOT_FOUND` |
| P5-API-27 Cancel | 5 | 5 | 200, 403 `PERMISSION_DENIED`, 404 `WORKFLOW_RUN_NOT_FOUND`, 409 `WORKFLOW_RUN_FINISHED` |
| P5-API-28 Resume | 5 | 5 | 200, 403 `PERMISSION_DENIED`, 409 `WORKFLOW_RUN_NOT_RESUMABLE` |
| P5-API-29 Approval queue | 7 | 7 | 200, 401 `AUTH_SCHEME_NOT_ALLOWED`, 403 `PERMISSION_DENIED` |
| P5-API-30 Decide | 11 | 11 | 200, 403 `FORBIDDEN`, 403 `PERMISSION_DENIED`, 403 `WORKFLOW_SELF_APPROVAL_FORBIDDEN`, 409 `WORKFLOW_APPROVAL_NOT_PENDING`, 422 `VALIDATION_FAILED` |
| P5-API-31 Dead letters | 2 | 2 | 200, 403 `PERMISSION_DENIED` |
| P5-API-32 Delete a run | 4 | 4 | 200, 404 `WORKFLOW_RUN_NOT_FOUND`, 409 `RESOURCE_CONFLICT` |
| P5-API-33 Audit search | 19 | 19 | 200, 401 `AUTH_SCHEME_NOT_ALLOWED`, 403 `PERMISSION_DENIED`, 404 `ORGANIZATION_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P5-API-34 Audit statistics | 2 | 2 | 200, 403 `PERMISSION_DENIED` |
| P5-API-35 Verify chain | 4 | 4 | 200, 403 `PERMISSION_DENIED` |
| P5-API-36 Export | 4 | 4 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-37 Archives | 2 | 2 | 200, 403 `PERMISSION_DENIED` |
| P5-API-38 Archive download | 3 | 3 | 403 `PERMISSION_DENIED`, 404 `RESOURCE_NOT_FOUND` |
| P5-API-39 Analytics overview | 6 | 6 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-40 Time series | 17 | 17 | 200, 422 `VALIDATION_FAILED` |
| P5-API-41 Top | 7 | 7 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-42 Security feed | 4 | 4 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P5-API-43 Quotas | 2 | 2 | 200, 403 `PERMISSION_DENIED` |
| P5-API-44 My quotas | 5 | 5 | 200, 403 `PERMISSION_DENIED` |
| P5-API-45 Create quota | 7 | 7 | 201, 403 `PERMISSION_DENIED`, 409 `RESOURCE_CONFLICT`, 422 `VALIDATION_FAILED` |
| P5-API-46 Change quota | 6 | 6 | 200, 400 `BAD_REQUEST`, 403 `QUOTA_MANAGED_BY_PLATFORM`, 404 `QUOTA_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P5-API-47 Remove quota | 4 | 4 | 200, 403 `QUOTA_MANAGED_BY_PLATFORM`, 404 `QUOTA_NOT_FOUND` |
| P5-API-48 Quota history | 3 | 3 | 200, 404 `QUOTA_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P5-API-49 Open circuits | 3 | 3 | 200, 404 `ORGANIZATION_NOT_FOUND` |
| P5-API-50 One breaker | 4 | 4 | 200, 400 `BAD_REQUEST`, 404 `AGENT_NOT_FOUND` |
| P5-API-51 Reset breaker | 3 | 3 | 200, 403 `PERMISSION_DENIED` |
| P5-API-52 Export my data | 4 | 4 | 200, 401 `AUTH_SCHEME_NOT_ALLOWED`, 429 `RATE_LIMIT_EXCEEDED` |
| P5-API-53 Erase my account | 9 | 9 | 200, 401 `AUTH_INVALID_CREDENTIALS`, 401 `AUTH_PASSWORD_MISMATCH`, 401 `AUTH_TOKEN_REVOKED`, 401 `MFA_CODE_INVALID`, 409 `ACCOUNT_ERASURE_BLOCKED`, 422 `VALIDATION_FAILED` |

## What the checks establish

- **Tools.** The four built-ins with their policies; HTTP tools defined, versioned (behaviour vs display name), disabled, loosened (audited weakening), credential replaced and removed (never returned or echoed), deleted (name reusable) — and run for real: an HTTPS `GET` returning the JSON at `responsePath`, an approval-gated `POST`, a 1 s timeout against a 3 s endpoint, an upstream 500, and **personal data in the arguments refused before any request left**. Every definition refusal (allowlist, undeclared template, forbidden header, plain HTTP, templated host, unsupported schema keyword, missing fields, `null`). The ledger with every outcome and five denial reasons, content-free. `send_email` delivered a real email to a verified member, pushed a metadata-only notification to their socket, and refused an unverified member (P5-G08).
- **Workflow definitions.** The palette; fifteen invalid graphs each reporting its code with the node or edge; warnings; drafts; append-only versions (identical saves create none, invalid saves are kept, unknown properties dropped from valid graphs, conflicts on stale versions); restore as a copy with the same digest (201); publish refusals; archive and un-archive; delete cancelling an active run.
- **Runs.** A deterministic routing workflow (tool → condition → two outputs) with the untaken branch skipped and the run output keyed by output node; idempotent replays (also across members, P5-G09); test runs; input validation; API-key runs; an approval gate approved (the gated POST ran), rejected (the other branch ran), self-approval refused, cancelled while waiting; a run whose input held an email **masked for a supervisor, revealed for the owner, and refused at the tool's egress check** (FAILED, POLICY, dead-lettered, not retried); a retrieval-labelled approval (INTERNAL) **withheld from an approver without clearance**, whose open socket started receiving approval events the moment their role changed; a run that stopped with `WORKFLOW_PRINCIPAL_REVOKED` after its initiator was demoted; a failed run **resumed after its tool was fixed**; an error edge routing a timeout to a fallback; a bounded loop (fall-through and fail); the step ceiling; a run deadline swept to TIMED_OUT and resumed; an approval decided by its timeout policy; agent steps with real model calls, structured JSON output routing, and a two-worker supervisor team; the trace complete (and kept after deletion); dead letters; deletion; the 20-active-runs ceiling.
- **Real-time.** Handshakes and every refusal (including the code-less origin refusal, P5-G07); automatic rooms per role; subscriptions with replay; the full event sequence of a run, metadata only; supervisors receiving run events without step events; nothing crossing to a Viewer or another tenant; refused subscriptions (audited); `resume`; in-place `auth:refresh` across token renewals; a foreign token closing the socket; a revoked API key closing its socket; the flood limit; the 10-socket limit; notifications for email, quota thresholds and circuit openings.
- **Governance.** Platform and workspace quotas with live usage; a SOFT member budget alerting the managers and the member; HARD refusal `QUOTA_EXCEEDED` with the reset countdown; a 10-token workspace rate refusing with `TOKEN_RATE_LIMITED`; history with refusals and alerts; every quota refusal; an agent circuit opened by one oversized turn, refusing the next turn, listed, reset.
- **Audit and analytics.** Search with every filter (including the `x-request-id` of a response), statistics, chain verification, NDJSON export whose every line links to the previous one, the windowed export, refusals as JSON; the Command Centre overview reflecting the run's workflows, tools, governance and security; all fourteen time series; rankings; the security feed with cursor paging.
- **Personal data.** The export file (headers, sections, the member's own decrypted runs and conversation, nobody else's) and its hourly limit; erasure refused for an owner of a shared workspace, then with MFA: wrong phrase, wrong password, missing and wrong codes, and success — sole workspace deleted, 21 runs and a conversation shredded, memberships ended, the old token dead, sign-in refused, the farewell email delivered.
- **Isolation.** A non-member got 404 on every Phase 5 area; another tenant's ids were 404 inside its own workspace; its socket received no event or notification all run.

## Defects found and fixed

| ID | Defect | Fix and evidence |
|---|---|---|
| P5-G01 | `POST /tools` did not enforce its required fields: 500 for a body without `http` or `parameters`, 422 naming no field without a display name | Required fields shadow the inherited optional marker. 422 naming the fields, verified live |
| P5-G02 | `null` accepted on non-clearable Phase 5 fields: 500 on run start (`version: null`), `runTimeoutMs: null` stored as 0 (every run timed out at once), spurious 409 conflicts, 422 naming no field | 40 fields refuse `null` by name. Verified live for every body |
| P5-G03 | Malformed UUID filters: 500 on the tool ledger; silently unfiltered run lists | Validated as UUIDs → 422 |
| P5-G04 | `audit-logs/export?from=garbage` answered 400 with PostgreSQL's raw error text | Window validated before the stream → 422 |
| P5-G05 | Error envelopes from download routes labelled NDJSON with an attachment disposition | Errors always JSON, no disposition |
| P5-G06 | The event bus's Redis subscription was silently lost after a few minutes of quiet: **no live Socket.IO events at all**, while `/health` said "subscribed" | 30 s heartbeat with reconnect; honest health. Proven by experiment (below); events delivered end to end after the fix |

Regression specs: `src/modules/workflows/phase5-dto.spec.ts` (P5-G01–G04; 7 of its 9 applicable tests fail on `69a9ba9`), `src/common/filters/all-exceptions.filter.spec.ts` (P5-G05; fails on `69a9ba9`), `src/shared/events/event-bus.service.spec.ts` (P5-G06; 4 of 5 fail on `69a9ba9`). Full unit suite after the fixes: 44 suites, 769 tests, all passed; `tsc --noEmit` clean.

**The P5-G06 experiment.** Two Redis subscribers built exactly as the event bus builds its own (A), one of them also sending a PING every 30 s (B), connected to the same Aiven Valkey from this machine. A test message was published to each at widening intervals, and the server's subscriber count (`PUBSUB NUMSUB`) was read every minute from a separate connection:

| Minute | Silence before | A received | B received | Server counts A | A's client status |
|---:|---:|---|---|---:|---|
| 2 | 2 min | yes | yes | 1 | ready |
| 5 | 3 min | yes | yes | 1 | ready |
| 9 | 4 min | **no** | yes | 1 | ready |
| 14 | 5 min | no | yes | **0** | ready |
| 20 | 6 min | no | yes | 0 | ready |
| 27 | 7 min | no | yes | 0 | ready |

A's connection died silently between 3 and 4 minutes of silence; the server dropped the subscription minutes later; the client **never noticed** (no close, no reconnect) and never recovered. B received every message for 27 minutes. Before the fix, both the development and the verification instance showed **zero** server-side subscriptions on their event channels while `/health` reported them subscribed; a run's nine events were written to the replay stream (and `resume` returned them) but none was delivered live. After the fix the Appendix A test received every event of two runs live, exactly once.

## Fixture method and cleanup

- Six accounts registered through the public API (`p5-<timestamp>-<role>@example.invalid`, generated passwords held only in process memory): owner, administrator, member, viewer, outsider (second tenant) and eraser.
- The owner created the workspace, a custom "Flow Approver" role (`workflow:read`, `workflow:read_all`, `workflow:approve`, no clearance) and four invitations; each invitation was **read from the Ethereal inbox over IMAP** and accepted. The member verified their email through the real link. The eraser enrolled MFA with real TOTP codes. Roles were changed through the Phase 2 endpoint. No database rows were written directly.
- Knowledge: one base and one synthetic INTERNAL document (Phase 3 endpoints). Agents: three published agents (Phase 4 endpoints). API keys: three (Phase 2) — a runner (`workflow:read`, `workflow:execute`, `tool:execute`), a reader (`tool:read`, `usage:read`) and a bare runner without `tool:execute`; the runner was revoked during the run with its socket open.
- Cleanup through the API: active runs cancelled, the knowledge base deleted (content purged), keys revoked, both workspaces soft-deleted, every fixture session signed out; the eraser account was erased by the test itself. Synthetic accounts remain for audit traceability, as in Phases 2–4.

## Run history

Every attempt is recorded; none is hidden.

| Attempt | Outcome | Cause and resolution |
|---|---|---|
| Probes | 3 disposable accounts, cleaned up | Before the harness: defect probes that found P5-G01–G04 and the stored-zero settings (P5-G02), and the Socket.IO handshake behaviour. Each deleted its workspace and revoked its sessions |
| 1 | Stopped at its first health check | The harness required the queue to be `up`; it was `degraded` (a slow Valkey ping, workers running — as in Phase 4). Nothing was created. The precondition now accepts a degraded queue with running workers |
| 2 | 288/300, stopped at a fixture; cleaned up | Every tools check passed except two that were **wrong harness assumptions** (the pagination field is `totalItems`; `send_email` needs a verified recipient, now P5-G08 — the harness verifies the member's email first). It stopped because the harness wrote numeric comparisons with string operands (`"100"`), which the validator correctly refuses; the graphs now use numbers and the rule is documented. Restore answering 201 (P5-G17) and invalid drafts kept as sent (P5-G19) were found here. The cleanup ran normally |
| Probe | 1 account, cleaned up | Appendix A's live test found that **no live event arrived** after subscribing; a raw-socket probe and a pub/sub probe then showed zero subscribers on the event channel → P5-G06, the experiment above, the fix |
| 3 | 756/772, completed and cleaned up; all 53 operations | Every audit, analytics, socket-limit, personal-data, erasure and isolation check passed. The 16 failures were **harness expectations**, each traced and corrected: (1) the harness removed a tool's credential to test `secret: null` and never restored it, so the gated POST then failed `TOOL_EXECUTION_FAILED` "credential has not been configured" — correct behaviour, now asserted explicitly before the credential is restored (5 failures followed from it); (2) a Viewer cancelling or resuming gets 403 (route permission first), not 404; (3) an API key with only `workflow:*` scopes ran a workflow with a tool step, which was correctly denied — runs act with the initiator's scopes — now asserted with a separate bare key; (4) supervisor workers take the round as their iteration (`w2#1`); (5) a new budget starts from the subject's spend so far this period; (6) a full token bucket admits one call larger than the rate, so the refusal comes on the next call; (7) the circuit turn (repetitive English) tokenized to ~2,400 tokens, just under the 2,500 ceiling, so the breaker did not open (5 failures followed); it now uses token-dense text. A `quota.exhausted` notification was observed in passing |
| Probe | 1 account, cleaned up | Appendix A's live test re-run with the fix: 29/29 |
| 4 | 776/783, completed and cleaned up; all 53 operations | Every check passed except the agent-circuit chain (7): the new token-dense circuit turn overshot — about 8,600 prompt tokens, beyond Groq's free-tier per-request ceiling (8,000 tokens per minute) — and the provider refused it, surfacing live as **502 `LLM_REJECTED`** (`details.status: 413`), so no breaker opened. All corrections from attempt 3 were confirmed |
| Probe | 1 account, 2 model calls, cleaned up | Measured the filler's density: 0.86 prompt tokens per character; the circuit turn is now 4,400 characters (~3,900 tokens: above the 2,500 breaker ceiling, below the provider's limit) |
| 5 (final evidence) | 783/783, completed and cleaned up | **Every check passed**, all 53 operations and the socket channel. The agent breaker opened on the calibrated turn (`RUNAWAY_SPEND`), refused the next turn 503 `AGENT_CIRCUIT_OPEN`, notified the managers and was reset. In passing, two sockets whose tokens the harness did not refresh received `auth:expired` and were closed at expiry, and a SOFT budget produced both `quota.threshold` and `quota.exhausted` notifications. These are the results in the results file |

## What remains unverified

This is an API and socket contract run, not frontend acceptance. It does not cover:

- browser rendering, accessibility, the canvas, a real client's reconnection behaviour or cross-tab coordination;
- the items in P5-G23: archive download (retention off), `REPEATED_FAILURES` circuits, `WORKFLOW_TOKEN_BUDGET_EXCEEDED`, `llm` supervisor routing, `step.retrying` and `tool.denied` events, `REDACTION_UNAVAILABLE` in run content, `ACCOUNT_ERASURE_DISABLED`, `LLM_NOT_CONFIGURED` on run start;
- a production deployment (the release gate in section 14 of the handoff).

## Reproduction

The [opt-in harness](../../scripts/verify-phase5-live.cjs) creates fresh fixtures and performs real writes, real metered model calls, real outbound HTTPS requests to the allowlisted test services and real emails against the backend named by `P5_BASE_URL` (default `APP_PORT`). It needs the backend's `.env` (for the Ethereal inbox and `METRICS_TOKEN`), a reachable model endpoint and AI service, and the instance settings in the Environment section.

```powershell
$env:P5_BASE_URL = 'http://localhost:3100'
node scripts/verify-phase5-live.cjs --run          # about an hour (the final run took 62 minutes)
```

Do not edit backend sources while it runs against a watch-mode server. Each run registers six accounts (the per-IP sign-up limit is 10 per 15 minutes), sends invitation, verification and tool emails, makes about ten model calls, and overwrites the results file, so archive evidence first. Run it only against a development backend you are allowed to write to.
