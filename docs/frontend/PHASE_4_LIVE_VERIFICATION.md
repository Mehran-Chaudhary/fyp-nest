# Phase 4 live API verification

**Date:** 6 October 2026, Asia/Karachi. **Backend source baseline:** `42ab352` plus the P4-G01 `null`-validation fix (in the working tree, not yet committed).

This report supplements the [Phase 4 handoff](PHASE_4_AGENTS_MODELS_CONVERSATIONAL_AI.md). The owner asked for every Phase 4 endpoint to be tested and proven. The tests sent real HTTP requests to `http://localhost:3000`, with the backend running as `npm run start:dev`, made real calls to the configured language model, and used disposable fixtures. Apart from P4-G01, no backend behaviour was changed.

**Result of the final run: 461 checks, 459 passed, 2 failed (both wrong harness expectations, explained under Run history); all 25 Phase 4 operations exercised, with real model calls, streaming, a client disconnect, a tool call, a token-rate burst and an AI-service outage and recovery.** Completed at 2026-10-06T08:25:48.342Z (UTC). Machine-readable evidence: [PHASE_4_LIVE_RESULTS.json](PHASE_4_LIVE_RESULTS.json).

## Environment

| Dependency | What served it | Health at start |
|---|---|---|
| Language model | Groq's OpenAI-compatible API, model `qwen/qwen3.8-27b` (platform allowlist of one; endpoint ceiling `LLM_MAX_CLASSIFICATION=INTERNAL`; `LLM_MAX_CONCURRENCY=1`; workspace token rate 8,000/min) | up |
| PostgreSQL | Supabase (session pooler), row-level security enforced under `daiap_rls` | up |
| Queues and workers | Aiven Valkey; ingestion workers inside the backend process | degraded (slow Valkey ping; workers running) |
| Object storage and vector store | Cloudflare R2, Qdrant Cloud | up, up |
| AI service | The project's `ai-service/` on `127.0.0.1:8000`: EmbeddingGemma 300M int8, jina reranker, Presidio + spaCy + bert-base-NER | up (masking detector up) |
| Mail | Ethereal SMTP test inbox | used for invitations |

## Coverage by operation

Each row counts the recorded requests to that operation and the outcomes observed. Polling and reconciliation reads are not recorded as checks. 228 further checks assert response shapes, stored state, label and masking decisions, stream framing and timing facts.

| Operation | Requests | Passed | Outcomes observed |
|---|---:|---:|---|
| P4-API-01 List agents | 12 | 12 | 200, 404 `ORGANIZATION_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P4-API-02 Create agent | 18 | 18 | 201, 403 `PERMISSION_DENIED`, 404 `KNOWLEDGE_BASE_NOT_FOUND`, 404 `ROLE_NOT_FOUND`, 409 `AGENT_NAME_TAKEN`, 422 `LLM_MODEL_NOT_ALLOWED`, 422 `VALIDATION_FAILED` |
| P4-API-03 Read agent | 11 | 11 | 200, 400 `BAD_REQUEST`, 404 `AGENT_NOT_FOUND` |
| P4-API-04 Update agent | 15 | 15 | 200, 401 `AUTH_SCHEME_NOT_ALLOWED`, 403 `PERMISSION_DENIED`, 404 `KNOWLEDGE_BASE_NOT_FOUND`, 409 `AGENT_NAME_TAKEN`, 409 `AGENT_VERSION_CONFLICT`, 422 `LLM_MODEL_NOT_ALLOWED` |
| P4-API-05 Delete agent | 4 | 4 | 200, 403 `PERMISSION_DENIED`, 404 `AGENT_NOT_FOUND` |
| P4-API-06 Publish | 9 | 9 | 200, 403 `PERMISSION_DENIED` |
| P4-API-07 Unpublish | 3 | 3 | 200, 403 `PERMISSION_DENIED` |
| P4-API-08 Version history | 3 | 3 | 200, 404 `AGENT_NOT_FOUND` |
| P4-API-09 One version | 6 | 6 | 200, 400 `BAD_REQUEST`, 404 `AGENT_VERSION_NOT_FOUND` |
| P4-API-10 Restore version | 5 | 5 | 200, 403 `PERMISSION_DENIED`, 404 `AGENT_VERSION_NOT_FOUND`, 409 `AGENT_VERSION_CONFLICT`, 422 `VALIDATION_FAILED` |
| P4-API-11 Prompt preview | 8 | 8 | 200, 403 `PERMISSION_DENIED`, 404 `AGENT_NOT_FOUND`, 422 `VALIDATION_FAILED`, 503 `AI_SERVICE_UNAVAILABLE` |
| P4-API-12 List conversations | 7 | 7 | 200, 403 `PERMISSION_DENIED` |
| P4-API-13 Start conversation | 15 | 15 | 201, 403 `PERMISSION_DENIED`, 404 `AGENT_NOT_FOUND`, 409 `AGENT_UNAVAILABLE`, 422 `VALIDATION_FAILED` |
| P4-API-14 Read conversation | 11 | 11 | 200, 400 `BAD_REQUEST`, 404 `CONVERSATION_NOT_FOUND` |
| P4-API-15 Rename or archive | 6 | 6 | 200, 404 `CONVERSATION_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P4-API-16 Delete conversation | 6 | 6 | 200, 403 `PERMISSION_DENIED`, 404 `CONVERSATION_NOT_FOUND` |
| P4-API-17 Read messages | 16 | 16 | 200, 403 `PERMISSION_DENIED`, 404 `CONVERSATION_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P4-API-18 Send message | 21 | 21 | 200, 403 `PERMISSION_DENIED`, 404 `AGENT_NOT_FOUND`, 404 `CONVERSATION_NOT_FOUND`, 409 `AGENT_UNAVAILABLE`, 409 `CONVERSATION_ARCHIVED`, 409 `CONVERSATION_BUSY`, 409 `MESSAGE_DUPLICATE`, 422 `VALIDATION_FAILED`, 503 `PII_DETECTION_UNAVAILABLE` |
| P4-API-19 Stream a turn | 8 | 8 | 200 (client abort), 200 (stream), 200 `AI_SERVICE_UNAVAILABLE` (error event), 403 `PERMISSION_DENIED`, 409 `AGENT_UNAVAILABLE`, 409 `CONVERSATION_ARCHIVED`, 422 `VALIDATION_FAILED` |
| P4-API-20 Direct chat | 20 | 20 | 200, 403 `PERMISSION_DENIED`, 422 `LLM_CONTEXT_OVERFLOW`, 422 `LLM_MODEL_NOT_ALLOWED`, 422 `VALIDATION_FAILED`, 429 `TOKEN_RATE_LIMITED`, 503 `PII_DETECTION_UNAVAILABLE` |
| P4-API-21 Direct chat stream | 5 | 5 | 200 (client abort), 200 (stream), 200 `PII_DETECTION_UNAVAILABLE` (error event), 403 `PERMISSION_DENIED`, 422 `LLM_MODEL_NOT_ALLOWED` |
| P4-API-22 Model catalogue | 5 | 5 | 200, 404 `ORGANIZATION_NOT_FOUND` |
| P4-API-23 Model policy | 3 | 3 | 200 |
| P4-API-24 Change model policy | 11 | 11 | 200, 401 `AUTH_SCHEME_NOT_ALLOWED`, 403 `PERMISSION_DENIED`, 409 `RESOURCE_CONFLICT`, 422 `LLM_MODEL_NOT_ALLOWED`, 422 `VALIDATION_FAILED` |
| P4-API-25 Usage | 5 | 5 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |

## What the checks establish

- **Agents and versions.** Defaults, full configuration, case-insensitive name uniqueness, every create/update refusal (hidden base, unknown role, disallowed model, tools without `tool:read`, iteration cap, nested validation), the visibility rules (managers see drafts; Members see published agents they may use; RESTRICTED agents invisible to other roles and to API keys; creators see and use their own drafts but cannot edit or publish without `agent:update`), hidden-base counting and preservation, append-only versions (no version for identity, access or unchanged saves; `parameters` replaced; restore as a copy with the same digest), publish/unpublish idempotence and the effect on members, soft deletion with readable conversations and a reusable name.
- **Delegation and the endpoint ceiling.** The same agent searched one knowledge base for an Administrator and two for the author holding the HR grant; the HR-only figure reached only the author's prompt. The owner's direct search found the CONFIDENTIAL document; no agent prompt or answer included it, and every turn reported `effectiveClearance: INTERNAL`.
- **Prompt preview.** Masked messages (`[EMAIL_ADDRESS_1]` in place of a document's address), an empty egress scan, context accounting and retrieval summary, without a model call.
- **Turns.** Grounded answers with citations whose `cited` flag matches the answer text, live document titles, labels, masking counts, per-turn overrides, idempotency (`MESSAGE_DUPLICATE` pointing at the stored question), one turn at a time (`CONVERSATION_BUSY`), the full stream protocol (order, ids, deltas equal to the stored answer, no delta ending inside a placeholder), preflight refusals as JSON, a client disconnect leaving a CANCELLED message with its partial text and releasing the conversation, and a streamed tool call.
- **Labels and supervision.** Masked titles and messages for a supervisor, reveal refused without `pii:reveal` and allowed for the owner, and three withheld reasons: COMPARTMENT (Administrator reading the author's HR answer), CLEARANCE (an auditor role without clearance) and SOURCE_DELETED (after the cited document was deleted, even for the conversation's owner, and excluded from the next turn's memory). REDACTION_UNAVAILABLE was not produced; see the outage item.
- **Models, policy and governance.** The catalogue, the default and saved policy (versions 0 → 1 → 2, `expectedVersion` conflicts, `null` returning ceilings to the platform), refusals of models outside the allowlists, `LLM_CONTEXT_OVERFLOW` before any model call with a 512-token workspace ceiling, and the workspace token rate refusing concurrent calls with `TOKEN_RATE_LIMITED` and `Retry-After` (7 × 200, 2 × 429).
- **Direct chat and usage.** Masking of names and addresses in caller-written messages and restoration in the answer, the direct stream protocol, every validation refusal, a cancelled stream counted in the ledger, and usage totals, latency, masking overhead, by model and by agent, explicit and empty windows.
- **Outage and recovery.** With the AI service stopped: the turn stream opened (`meta`) and then failed with an `error` event `AI_SERVICE_UNAVAILABLE` (`status: 503`) and **stored nothing**; a turn with retrieval off failed with 503 `PII_DETECTION_UNAVAILABLE` under the REFUSE policy, as did direct chat (JSON) and its stream (an `error` event); the prompt preview answered 503; a conversation supervised before the outage came back masked, not withheld, because name-detection results are cached for an hour (the harness had expected `REDACTION_UNAVAILABLE` and `null` titles, the two failed checks; P4-G16); with `DEGRADE_TO_PATTERNS` a turn ran and its answer was marked `degraded`. After the restart, grounded turns worked again.
- **Isolation.** A non-member got 404 `ORGANIZATION_NOT_FOUND`; another tenant's ids were 404 inside its own workspace; the model policy stayed per workspace.

Selected observations used in the handoff are stored under `facts` and `traces` in the results file: the raw direct stream, event traces for streamed, aborted, tool and outage turns, the role permission lists, the token-rate burst, preview accounting and the model observations.

## Fixture method and cleanup

- Six accounts registered through the public API with `p4-<timestamp>-<role>@example.invalid` addresses and generated passwords held only in process memory.
- The owner created the workspace, a custom "Agent Author" role and four invitations. Each invitation email was **read from the Ethereal inbox over IMAP** and redeemed through `POST /invitations/accept`. No database rows were written directly.
- Knowledge fixtures went through the Phase 3 endpoints: two bases (one RESTRICTED, granted to the author) and five synthetic Markdown documents (PUBLIC, INTERNAL and CONFIDENTIAL; fictional names, `acme.test` addresses). Late in the run the viewer was moved to a "Conversation Auditor" role through the Phase 2 role-assignment endpoint, to read labels without clearance.
- One API key (Phase 2 endpoint) exercised machine ownership of a conversation.
- Cleanup through the API deleted both knowledge bases (purging stored files and vectors), revoked the API key, soft-deleted both workspaces and signed out every fixture session. Synthetic accounts remain for audit traceability, as in Phases 2–3.

## Run history

Every attempt is recorded; none is hidden.

| Attempt | Outcome | Cause and resolution |
|---|---|---|
| Probe | 2 model calls, cleaned up | A single disposable account checked the model catalogue, direct chat and the raw event stream before the harness was written. Its workspace was deleted and its sessions revoked. Three later single-account probes (the `null` probe for P4-G01 and the two turn reproductions after attempt 5) also cleaned up after themselves |
| 1 | Aborted during setup (21 checks, all passed) | The verification machine's `C:` drive reached 0 bytes free. The harness's console output could not be written and the process died before cleanup. Left behind: workspace `be41cb41-c6e8-47a5-ae88-20eea719e419` (owner and Administrator joined; two invitations unredeemed), a second empty tenant workspace, and six `p4-1791237…@example.invalid` accounts whose credentials existed only in the aborted process (INT-05). They hold no content |
| 2 | Aborted during setup (7 checks passed) | The backend process (`npm run start:dev`, PID 31000) exited between two registrations while `C:` was full; the watcher started a new one 3 minutes later. No source had changed. Left behind: four `p4-…@example.invalid` accounts with no workspace (INT-05). The harness now ignores console write failures and writes the AI-service log to a configurable directory (`P4_AI_LOG_DIR`) |
| 3 | Aborted at 114 checks (100 passed) | Caused by this verification: a dry run of the P4-G01 fix script edited the real DTO files instead of scratch copies, and the watch-mode backend restarted mid-run (03:36:41). Every failure was a transport error after the restart. Its cleanup could not reach the server, so its workspace `e1f12207-19d9-4150-a667-a87c9b6f9a58` (two knowledge bases, five synthetic documents) and second tenant `05590eed-df91-4605-ba14-d38d64a03927` remained were cleaned up afterwards through public flows only: a password reset for the fixture owner and outsider (the reset email read from the Ethereal inbox), sign-in, deletion of both knowledge bases (purging their documents) and both workspaces, and revocation of every session |
| 4 | Stopped at its first health check | The backend was not listening when the scheduled start came (the machine had been idle for hours under memory pressure; the watcher restarted the backend at 12:54). The harness refuses to start unless the model endpoint and AI service are up. Nothing was created |
| 5 | 254/283, stopped at the first agent turn | One harness assertion was wrong: it looked for the literal stipend amount in the author's prompt, but amounts are masked (`[SALARY_1]`) before the model sees them, which is correct. The harness now checks the unmasked wording of the HR-only passage and, separately, that the amount is masked. Then the backend process exited during the first agent turn (C: had ~250 MB free and the machine was short of memory) and every later request failed at the transport level. Two reproductions right after the restart, a plain turn and a grounded turn with retrieval, reranking and masking, both answered 200 and the backend stayed up, so the exit is attributed to the machine (INT-06), not to the turn path. Its fixtures (workspaces `c7503b9e-5046-4021-8806-8f49179c844e`, `c47001ea-5d4d-4e0f-a00b-c3e3cae2eaed`) were cleaned up afterwards through public flows only: a password reset for the fixture owner and outsider (the reset email read from the Ethereal inbox), sign-in, deletion of both knowledge bases (purging their documents) and both workspaces, and revocation of every session |
| 6 (final evidence) | 459/461, completed and cleaned up | All 25 operations, every contract check, streaming, the client disconnect, the tool call, the token-rate burst and the AI-service outage and recovery passed. The two failures were **wrong expectations in the harness**, not backend defects: it expected an already-supervised conversation and the supervisor's title list to be withheld while the AI service was down, but name-detection results are cached by fingerprint (never text) for `PII_DETECTION_CACHE_TTL` (1 h), so text analysed before the outage was masked correctly from the cache instead (P4-G16). The harness has since been corrected: it prepares a conversation with a never-analysed title and answer before the outage (expected: withheld with `REDACTION_UNAVAILABLE`, titles `null`) and checks the cached case separately. These are the results in the results file |
| 7 | Stopped during setup (15 checks passed) | The corrected harness was started for a clean confirmation. The backend began failing broadly: an invitation answered 500, and every cleanup call took up to 60 s and answered 500. By then `C:` had ~45 MB free and ~400 MB of RAM was free; afterwards the backend was restarting in a loop (INT-06). Left behind: two empty workspaces (`84d68ac0-8dd9-4b94-a916-54d8e603d893`, `68314368-27a9-4204-986b-7ad35813ee32`) and six accounts remain. Cleanup through the public password-reset flow is prepared but could not run while the backend was down (INT-05). **The corrected outage checks therefore remain to be run** once the machine has headroom: `node scripts/verify-phase4-live.cjs --run --inject-ai-outage` |



## What remains unverified

This is an API contract run, not frontend acceptance. It does not cover:

- browser rendering, accessibility, a real client's stream parser, Stop button, reconciliation, or cross-tab behaviour;
- model-endpoint failures: `LLM_TIMEOUT`, `LLM_UNAVAILABLE` and its circuit, `LLM_REJECTED`, `LLM_RESPONSE_INVALID`, a FAILED mid-stream answer, `LLM_MODEL_NOT_FOUND`, `LLM_NOT_CONFIGURED`;
- `PII_EGRESS_BLOCKED`, `QUOTA_EXCEEDED`, `AGENT_CIRCUIT_OPEN`, `AGENT_TOKEN_BUDGET_EXCEEDED`, `CONVERSATION_TOKEN_BUDGET_EXCEEDED`, `LLM_CONTEXT_OVERFLOW` inside a turn (it was produced on direct chat);
- the `thinking` stage (this model streams no reasoning), vector-store or storage outages during a turn, and platform-admin break-glass access;
- `REDACTION_UNAVAILABLE` and `null` supervision titles for never-analysed text during an outage: the corrected harness check exists but its run was cut short by the machine (attempt 7, INT-06). The final run observed the cached case instead (P4-G16).

Section 13 of the handoff lists the related decisions.

## Reproduction

The [opt-in harness](../../scripts/verify-phase4-live.cjs) creates fresh fixtures and performs real writes and real, metered model calls against the backend named by `.env` (`APP_PORT`) or `P4_BASE_URL`. It needs the backend's `.env` for the SMTP credentials of the Ethereal inbox, a reachable model endpoint, and the AI service. The outage option stops and restarts the AI service in `ai-service/` on port 8000 (Windows).

```powershell
node scripts/verify-phase4-live.cjs --run                      # main run, ~35 minutes
node scripts/verify-phase4-live.cjs --run --inject-ai-outage   # adds the AI-service outage and recovery
$env:P4_AI_LOG_DIR = 'D:\logs'                                 # optional: where the restarted AI service logs
```

Do not edit backend sources while it runs against a watch-mode server, which restarts on change. Keep free disk space on the system drive. Each run registers six accounts (the per-IP sign-up limit is 10 per 15 minutes), sends four invitation emails from its fresh owner account, makes about 25 model calls (paced by the workspace token rate), and overwrites the results file, so archive evidence first. Run it only against a development backend you are allowed to write to.
