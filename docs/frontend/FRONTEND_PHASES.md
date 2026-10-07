# Frontend Delivery — Five Phases & Master Checklist

**Revision 7 · 7 October 2026 · backend baseline `69a9ba9` + P5-G01–G06 fixes**
**Product:** AgentVault / Distributed AI Agent Management Platform
**Active handoff:** [Phase 5 — Tools, Workflow Orchestration, Governance & Release](PHASE_5_TOOLS_ORCHESTRATION_GOVERNANCE_RELEASE.md) (the final phase)

> This is the authoritative frontend delivery plan. It replaces the old nine-phase roadmap. Deliver exactly five sequential phases. Advance after review and acceptance, or an explicit owner request to prepare the next handoff. Owner-requested progression does not establish unverified implementation acceptance. Historical backend phase numbers do not control frontend delivery order.

## How to use this document

The roadmap defines scope, dependencies and acceptance; the Phase 1–5 documents define implementation contracts. Check a task only when evidence exists. A finished specification is not a finished frontend. Do not infer implementation progress from the presence of old documents.

The obsolete frontend handoffs and connection guide have been removed. This directory contains only the current five-phase roadmap, the Phase 1–5 handoffs and the Phase 2–5 live verification evidence. All five handoffs now exist. The owner requested Phase 2, 3, 4 and 5 progression; Phase 1–4 browser acceptance evidence remains unverified, and Phase 5 ends with the product release gate.

Status vocabulary: **Not started**, **In progress**, **Ready for review**, **Accepted**, **Blocked**. Record blockers separately from ordinary unfinished work. The owner accepts each phase after the frontend engineer supplies evidence and a demo. No automatic advancement.

## Delivery map

| Phase | Name | User-visible outcome | Dependency |
|---|---|---|---|
| 1 | Identity, Secure Sessions & Workspace Entry | Register/sign in/MFA/recover, join/create/select workspaces, manage account/devices, permission-aware shell | API, database, cookie/CORS configuration, mail delivery |
| 2 | Workspace Administration & Access Control | Administer members/invitations/roles, workspace policies, API keys, ownership and network restrictions | Accepted Phase 1; role-aware fixtures and mail |
| 3 | Knowledge, Document Vault & Privacy | Manage knowledge collections, upload/process/download documents, control grants, inspect retrieval and PII policy/results | Accepted Phase 2; storage, queues/workers, vector store, AI/PII service |
| 4 | Agents, Models & Conversational AI | Configure/publish/version agents, model policy, prompt preview, conversations and streaming answers with citations | Accepted Phase 3; inference provider, retrieval/privacy dependencies |
| 5 | Tools, Workflow Orchestration, Governance & Release | Build/run/approve workflows and tools, realtime status, audit/analytics/quotas/circuits, personal data, complete release/demo | Accepted Phase 4; workflow workers, realtime, full deployment dependencies |

This orders identity before administration, grants before restricted knowledge, knowledge/privacy before RAG agents, and agents/tools before orchestration. Phase 5 is deliberately the largest milestone and is divided into internal work packages below; these are not extra phases.

### Scope choices that avoid dependency gaps

- MFA is fully in Phase 1, because existing users and workspaces may require it immediately.
- Invitation preview/acceptance is in Phase 1; creating/managing invitations is Phase 2. Use backend-created test invitations until that UI exists.
- Own membership and contextual permissions are Phase 1. Team directory, permission catalogue and role editor are Phase 2.
- Privacy policy/analysis/reporting is Phase 3 alongside knowledge. Phase 4 reuses it for agent/model UX.
- Personal-data export/erasure is Phase 5 after ownership transfer, conversations and workflow content exist. Do not advertise an unfinished privacy-action button in Phase 1.
- Health probes are integrated once in Phase 1 diagnostics and reused later. An operator health dashboard can be Phase 5; users should not see infrastructure dumps by default.
- Socket.IO integration belongs to Phase 5. Phase 3 document status can use bounded, visibility-aware polling until realtime is delivered; REST remains the recovery source of truth.
- HTTP tool integrations are Phase 5. Do not imply tool execution is available from a Phase 4 agent UI before its supported backend contract is documented.

## Cross-phase engineering requirements

- One shared HTTP adapter preserves envelope metadata, validation details, request IDs and response type. Raw files and SSE in later phases need explicit response modes rather than forcing JSON parsing.
- Cookie refresh has same-tab and cross-tab coordination. Access tokens stay in memory; no secrets in analytics, logs, committed fixtures or public environment variables.
- One explicit workspace source builds path and header; tenant IDs belong in cache keys. Stale requests must not repaint another workspace.
- Use effective permissions for each control; still handle server denial. Do not assume role labels confer fixed permissions.
- Every screen includes loading, empty, pending mutation and recovery states. Forms retain recoverable input and support keyboard/mobile layouts.
- No fabricated production data, placeholder metrics presented as live, or guessed endpoints. Label planned destinations clearly.
- Destructive actions need clear user intent and exact scope. Do not assume DELETE means hard deletion; document actual backend lifecycle when its phase is specified.
- Streaming, realtime reconnects, background processing and ambiguous mutation outcomes require explicit state models and bounded recovery, not silent infinite retries.
- Revalidate API schema against controllers, services, DTOs and guards at each new handoff. Swagger alone can miss response unions and service-side errors.
- Store accepted frontend commit, backend baseline, test evidence and known limitations at every gate.

## Phase 1 checklist — Identity, Secure Sessions & Workspace Entry

**Detailed contract:** [Phase 1 handoff](PHASE_1_FOUNDATION_AUTH_WORKSPACE.md).
**Scope:** 26 product operations and 3 health diagnostics.

- [ ] P1.01 Configure frontend origin, API base, CORS/cookie behavior and exact mail callback routes.
- [ ] P1.02 Build visual tokens, shared components, route layouts and accessible forms.
- [ ] P1.03 Implement typed envelopes, errors, field validation, pagination and request-ID reporting.
- [ ] P1.04 Implement in-memory session state, coordinated refresh, cross-tab logout and race protection.
- [ ] P1.05 Complete registration/login and conditional MFA challenge sign-in.
- [ ] P1.06 Complete verification/resend and forgot/reset-password flows with token lifecycle handling.
- [ ] P1.07 Complete profile/password/MFA enrollment/disable/recovery codes and device management.
- [ ] P1.08 Complete workspace pagination/create/select/switch and permission-aware shell.
- [ ] P1.09 Complete invitation preview/acceptance through registration/login/MFA/verification.
- [ ] P1.10 Complete workspace restriction screens and global-account escape paths.
- [ ] P1.11 Execute P1-T01–P1-T48; attach real cookie/email/auth/workspace evidence.
- [ ] P1.12 Review demo and accept gate before commissioning Phase 2 handoff.

**Demo:** new user to verified workspace; MFA user login; invited member joins; two-tab renewal; A→B workspace isolation; password/device actions.

**Exit gate:** real backend integration demonstrated, refresh race tests pass, no cross-workspace stale content, recovery flows usable, frontend build/typecheck and relevant tests pass, owner accepts.

**Current integration finding:** API liveness and schema were reachable, CORS preflight passed, but readiness returned 503 on 5 October 2026 around 11:51 Asia/Karachi. It is not proof of an application-code failure, but dependency readiness must be resolved or explicitly recorded before integrated acceptance. No authenticated mutation was performed during documentation.

## Phase 2 checklist — Workspace Administration & Access Control

**Detailed handoff:** [Phase 2 contract](PHASE_2_WORKSPACE_ADMINISTRATION.md), revision 3: all 30 operations, 68 acceptance checks (P2-T01–P2-T68), and 12 constraint/decision records (P2-G01–P2-G12). Source verification and a live API run are complete: [66 passing checks across all 30 operations](PHASE_2_LIVE_VERIFICATION.md). Client implementation and browser acceptance remain unverified.

- [ ] P2.01 Revalidate all Phase 2 endpoints, DTOs, permissions, role-priority rules and owner-only rules.
- [ ] P2.02 Workspace profile/settings, ingestion defaults, audit retention, email-domain restrictions.
- [ ] P2.03 Workspace MFA/verified-email requirements with correct permissions and self-lockout protections.
- [ ] P2.04 Member directory with supported pagination/search/filter/sort; member details and workspace-local profile.
- [ ] P2.05 Assign complete role sets, suspend/reactivate/remove members, leave workspace, protect last owner.
- [ ] P2.06 Invitation list/create/resend/revoke and integration with Phase 1 recipient flow.
- [ ] P2.07 Permission catalogue and role list/create/edit/delete/recompute; prevent privilege escalation in UX and handle server enforcement.
- [ ] P2.08 API-key scope catalogue, issue/list/revoke, one-time secret display and safe copying.
- [ ] P2.09 IP-rule add/remove/list and enforcement, with explicit self-lockout error recovery.
- [ ] P2.10 Transfer ownership and archive workspace with deliberate confirmation, cache cleanup and navigation recovery.
- [ ] P2.11 Verify owner/admin/limited/custom-role scenarios and stale permission changes.
- [ ] P2.12 Accept demo/gate; record evidence and constraints before Phase 3 handoff.

**Demo:** owner invites a colleague; colleague accepts; custom role limits actions; admin cannot exceed authority; revoke key; transfer ownership; demonstrate safe denial without disabling guards.

**Exit gate:** all administration actions follow actual permissions/priority/ownership, sensitive values display once, policy changes do not strand the current user without documented recovery, complete invitation lifecycle works.

## Phase 3 checklist — Knowledge, Document Vault & Privacy

**Detailed handoff:** [Phase 3 contract](PHASE_3_KNOWLEDGE_DOCUMENT_VAULT_PRIVACY.md), revision 1: all 23 operations, 42 acceptance checks (P3-T01–P3-T42), 12 decision records (P3-G01–P3-G12) and type-checked TypeScript helpers. The owner requested this handoff. Source verification and a live API run are complete: [401 checks across all 23 operations](PHASE_3_LIVE_VERIFICATION.md), against real storage, vector store, queues and AI service, including an AI outage and recovery. One backend defect found during verification was fixed (P3-G01). Client implementation and browser acceptance remain unverified.

- [ ] P3.01 Specify all knowledge/document/retrieval/privacy payloads, grants and content visibility rules.
- [ ] P3.02 Knowledge-base list/create/read/update/delete and grant management.
- [ ] P3.03 Upload with exact multipart contract and file limits; document processing states and retry recovery.
- [ ] P3.04 Document directory/detail/metadata updates, chunk inspection, download, reindex and deletion.
- [ ] P3.05 Bounded polling for background ingestion; cancel on navigation/workspace switch and stop at terminal state.
- [ ] P3.06 Retrieval query and access-scope explanation, meaningful empty results and citations/provenance.
- [ ] P3.07 Privacy policy/entity-type catalogue, analysis preview, per-document redaction report.
- [ ] P3.08 Verify restricted knowledge is absent from unauthorized users' documents, retrieval and previews.
- [ ] P3.09 Handle storage/vector/worker/AI failures as actionable states rather than permanent spinners.
- [ ] P3.10 Accessibility, large-file/progress/error behavior and genuine backend evidence.
- [ ] P3.11 Accept demo/gate before Phase 4 handoff.

**Demo:** create a restricted collection, upload a supported document, observe processing, inspect redaction/retrieval, confirm unauthorized member cannot access it, download and reindex with explicit status.

**Exit gate:** ingestion through retrieval works with real services, grants are respected, unmasked sensitive content is not accidentally exposed in logs/previews, failed processing has a recovery path.

## Phase 4 checklist — Agents, Models & Conversational AI

**Detailed handoff:** [Phase 4 contract](PHASE_4_AGENTS_MODELS_CONVERSATIONAL_AI.md), revision 1: all 25 operations, 42 acceptance checks (P4-T01–P4-T42), 16 decision records (P4-G01–P4-G16), the streaming wire contract and type-checked TypeScript helpers. The owner requested this handoff. Source verification and a live API run are complete: [461 checks across all 25 operations](PHASE_4_LIVE_VERIFICATION.md), with real model calls (Groq, `qwen/qwen3.8-27b`), retrieval, masking, streaming and cancellation, and an AI-service outage and recovery. One backend defect found during verification was fixed (P4-G01: `null` accepted for fields that cannot be cleared). Client implementation and browser acceptance remain unverified.

- [ ] P4.01 Specify agent/model/conversation contracts, version semantics, supported content and streaming events.
- [ ] P4.02 Agent directory/create/detail/edit/delete and knowledge/privacy configuration.
- [ ] P4.03 Publish/unpublish, versions, version detail and restore with explicit unsaved-change behavior.
- [ ] P4.04 Prompt preview with permission-aware content handling.
- [ ] P4.05 Model catalogue and workspace model-policy read/update; supported direct chat and direct streaming playground.
- [ ] P4.06 Conversation create/list/detail/update/delete, paginated message history and ordinary message submission.
- [ ] P4.07 POST-based streaming UI: incremental text, final result, citations, abort, network failure and partial-output recovery.
- [ ] P4.08 Correct user/workspace ownership, permission, model-unavailable, policy and budget-denied states.
- [ ] P4.09 Model usage view via existing LLM usage endpoint; richer analytics/quotas arrive in Phase 5.
- [ ] P4.10 Cross-workspace navigation safely cancels streams and removes partial sensitive content.
- [ ] P4.11 Accept real agent/RAG/streaming demo and gate before Phase 5 handoff.

**Demo:** configure/version/publish an agent, preview its prompt, ask it a document-grounded question, stream a response with provenance, reload history, and show cancellation/provider failure recovery.

**Exit gate:** live inference and grounded conversation work, streaming parser handles actual backend events, aborted/failed turns are understandable, no replayed turn or tenant-content leakage.

## Phase 5 checklist — Tools, Orchestration, Governance & Release

**Detailed handoff:** [Phase 5 contract](PHASE_5_TOOLS_ORCHESTRATION_GOVERNANCE_RELEASE.md), revision 1: all 53 operations and the Socket.IO channel, 43 acceptance checks (P5-T01–P5-T43), 27 decision records (P5-G01–P5-G27), the release gate and demonstration script (its section 14), and type-checked TypeScript helpers tested against the live backend. The owner requested this handoff. Source verification and a live run are complete: [783 checks, 783 passed, across all 53 operations and the socket channel](PHASE_5_LIVE_VERIFICATION.md), with real queues, model calls, outbound HTTPS tools, emails, MFA and account erasure. **Six backend defects were found and fixed** with regression specs (P5-G01–G06), including one that silently stopped all live Socket.IO events (P5-G06). Client implementation and browser acceptance remain unverified. The internal work packages below stay within one Phase 5 acceptance gate.

### Work package A — Tools and workflow design

- [ ] P5.01 Tool directory/create/detail/edit/delete, exact tool-schema validation, test execution and execution history.
- [ ] P5.02 Workflow directory/create/detail/edit/delete and node-type catalogue.
- [ ] P5.03 Canvas/definition editing, validate, version list/detail/restore, publish/archive.
- [ ] P5.04 Graph contract, allowed nodes/edges, unsaved changes and accessible alternatives to drag-only interaction.

### Work package B — Execution and realtime

- [ ] P5.05 Start runs, history/detail/content/step content/trace and deletion semantics.
- [ ] P5.06 Cancel/resume and distinct execution-state handling.
- [ ] P5.07 Approval inbox/decisions, dead-letter recovery and permission-aware actions.
- [ ] P5.08 Socket.IO authentication/subscription/reconnect/resynchronization based on realtime contract; no duplicate listeners or stale tenant subscriptions.
- [ ] P5.09 Live run/canvas status and notification UI reconciled with REST after missed events.

### Work package C — Governance and personal data

- [ ] P5.10 Audit list/filter/statistics/verification/export/archive list/download.
- [ ] P5.11 Analytics overview/time series/top/security events with real empty/error states.
- [ ] P5.12 Quota list/my quota/create/update/delete/history, agent circuit list/detail/reset.
- [ ] P5.13 Personal-data export as raw downloadable JSON and account erasure with ownership/MFA/confirmation requirements.
- [ ] P5.14 Operator-facing health/readiness diagnostics where authorized; no infrastructure secrets in user UI.

### Work package D — Release and FYP demonstration

- [ ] P5.15 Re-run cross-phase account/admin/document/agent/workflow journeys and tenant-isolation cases.
- [ ] P5.16 Production origins, HTTPS/cookies, route rewrites, environment documentation and secret-free deployment configuration.
- [ ] P5.17 Accessibility/responsiveness/performance and supported-browser checks across delivered screens.
- [ ] P5.18 Test clean deployment, migrations/seed prerequisites and worker/AI dependencies with backend owner; record actual readiness evidence.
- [ ] P5.19 Prepare realistic demo fixtures, demo script, failure-recovery demonstrations and screenshots without credentials.
- [ ] P5.20 Final build/typecheck/tests, issue triage, operating notes and project-owner acceptance.

**Demo:** configure/test a tool, compose/publish a workflow, execute it with realtime status and a human approval, inspect trace/audit/usage, demonstrate quota/circuit behavior, and walk through the complete product.

**Exit gate:** all five phases integrated, no undisclosed blocking issue, release configuration verified, documented demo reproducible, personal-data/destructive actions correctly gated, final acceptance recorded.

## Delivery and acceptance register

Do not check implementation as complete because this specification was written.

| Phase | Specification | Implementation status | Frontend commit/PR | Backend baseline | Evidence | Owner acceptance/date |
|---|---|---|---|---|---|---|
| 1 | Ready, revision 2 | Not verified | Pending | 877de76 | Pending P1-T01–48 | Pending |
| 2 | Ready, revision 3; owner requested progression | Not verified | Pending | 5b4efb7 | Live API 66/66; browser P2-T01–68 pending; see P2-G02–12 | Pending |
| 3 | Ready, revision 1; owner requested progression | Not verified | Pending | 979dfd5 + P3-G01 fix | Live API 401/401; browser P3-T01–42 pending; see P3-G02–12 | Pending |
| 4 | Ready, revision 1; owner requested progression | Not verified | Pending | 42ab352 + P4-G01 fix (committed in 69a9ba9) | Live API 459/461; browser P4-T01–42 pending; see P4-G02–16 | Pending |
| 5 | Ready, revision 1; owner requested progression | Not verified | Pending | 69a9ba9 + P5-G01–G06 fixes | Live API 783/783; browser P5-T01–43 and release gate pending; see P5-G07–27 | Pending |

For each review, attach: running frontend URL, commit/PR, tested backend baseline, test names/results, demo evidence, browser support, unresolved issues and configuration notes without secrets. Reviewers record accepted/deferred/blocked explicitly. Any deferred item must have a receiving phase, rationale and owner; do not silently drop it.

| Issue ID | Finding | Owner | Status | Closure evidence |
|---|---|---|---|---|
| INT-01 | Earlier readiness/connection failures; later live checks succeeded | Backend/environment owner | Availability observation resolved for this run | Readiness 200, database/Redis up, real auth/workspace/admin checks in [live report](PHASE_2_LIVE_VERIFICATION.md) |
| INT-02 | MFA disable clears session-row assurance but existing JWTs retain claims until renewed/expired | Backend/security owner | Review if immediate assurance revocation is required | Agreed behavior and cross-client test |
| INT-03 | Frontend repository/framework/browser matrix not supplied in this workspace | Frontend engineer | Implementation choice pending | Version lockfile + browser/refresh coordination evidence |
| INT-04 | Interrupted Phase 3 verification attempts left fixtures behind:<br>• attempt 2, cut off by a watch-mode restart: two empty workspaces and six synthetic `example.invalid` accounts the harness can no longer sign in to;<br>• attempt 3: one soft-deleted workspace whose two remaining test bases still hold synthetic documents | Backend/environment owner | Open, harmless | IDs in the [Phase 3 live report](PHASE_3_LIVE_VERIFICATION.md). Attempt 3's content is removed by the organization purge after `ORGANIZATION_PURGE_GRACE` (7 days). Delete the rest if desired |
| INT-05 | Aborted Phase 4 verification attempts left synthetic fixtures behind (credentials existed only in the aborted processes):<br>• attempt 1: workspace `be41cb41-c6e8-47a5-ae88-20eea719e419` (no content), one empty second tenant, six accounts;<br>• attempt 2: four accounts, no workspace;<br>• attempt 3: **cleaned up** on 6 October (knowledge bases and workspaces deleted, sessions revoked); six accounts remain;<br>• attempt 5: **cleaned up** the same way; six accounts remain;<br>• attempt 7: empty workspaces `84d68ac0-8dd9-4b94-a916-54d8e603d893` and `68314368-27a9-4204-986b-7ad35813ee32`, six accounts | Backend/environment owner | Open, harmless (synthetic data only) | Details in the [Phase 4 live report](PHASE_4_LIVE_VERIFICATION.md). Attempt 7's two empty workspaces can be removed the same way (password reset via the Ethereal inbox); delete the rest if desired |
| INT-06 | *(Resolved 7 October: `C:` had 23 GB free and the Phase 5 live run completed; the Phase 4 confirmation run of P4-G16 was not repeated.)* The development machine's `C:` drive is full (0–50 MB free during the Phase 4 run; 13.5 GB `pagefile.sys`, 6.3 GB `hiberfil.sys`, ~1 GB of tool temp files) and RAM was often under 500 MB free. It aborted Phase 4 attempts 1, 2, 5 and 7; the dev backend exited repeatedly and at 17:14 on 6 October was restarting in a loop | Machine owner | Resolved for Phase 5 | Free several GB on `C:` (older Claude Code scratch folders under `%LOCALAPPDATA%\Temp\claude`, including stale scratch PostgreSQL clusters, are disposable), close unused memory-heavy apps, restart `npm run start:dev` |
| INT-07 | The development backend's event-bus subscription is lost after a few quiet minutes on this network path, so its Socket.IO clients get no live events while `/health` says "subscribed" (P5-G06). The fix is in the working tree; the watch-mode server picked it up on restart | Backend owner | Fixed in source; commit and deploy with Phase 5 | Spec `src/shared/events/event-bus.service.spec.ts`; `PUBSUB NUMSUB <prefix>events:live` equals the number of API instances |
| INT-08 | Phase 5 verification left synthetic `example.invalid` accounts (sessions revoked; their workspaces and knowledge bases deleted through the API; each run's eraser account erased by the test) from attempts 2–5, the defect probes and the Appendix A live tests | Backend/environment owner | Open, harmless (synthetic data only) | Fixture ids in the [Phase 5 report](PHASE_5_LIVE_VERIFICATION.md) and results file |

## Full HTTP scope ledger

The ledger below is derived from the live `/docs-json` snapshot retrieved during this review and assigns every method/path operation to exactly one primary phase. It is an allocation checklist, not a detailed contract for later phases. Check an operation only after its frontend integration/diagnostic use is verified. Shared APIs can be reused without moving ownership.

The schema has 122 distinct paths; a path with GET and POST counts as two operations. Root health routes are counted as Phase 1 diagnostics. OpenAPI paths use `{parameter}` notation, equivalent to Nest `:parameter` notation.

Socket.IO is not represented in this HTTP ledger and is explicitly assigned to Phase 5. Raw `/metrics` is an infrastructure endpoint registered outside Nest/OpenAPI; it uses operator credentials and is not a browser feature. Swagger assets and CORS OPTIONS are documentation/transport surfaces, not product endpoints. Python AI-service internal APIs are backend-to-backend; the frontend integrates through NestJS.

| Phase | HTTP operations |
|---|---|
| 1 | 29 |
| 2 | 30 |
| 3 | 23 |
| 4 | 25 |
| 5 | 53 |
| Total | 160 |

### Phase 1 operation checklist

- [ ] `POST /api/v1/auth/change-password`
- [ ] `POST /api/v1/auth/forgot-password`
- [ ] `POST /api/v1/auth/login`
- [ ] `POST /api/v1/auth/logout`
- [ ] `POST /api/v1/auth/logout-all`
- [ ] `GET /api/v1/auth/me`
- [ ] `PATCH /api/v1/auth/me`
- [ ] `GET /api/v1/auth/mfa`
- [ ] `POST /api/v1/auth/mfa/disable`
- [ ] `POST /api/v1/auth/mfa/enable`
- [ ] `POST /api/v1/auth/mfa/recovery-codes`
- [ ] `POST /api/v1/auth/mfa/setup`
- [ ] `POST /api/v1/auth/mfa/verify`
- [ ] `POST /api/v1/auth/refresh`
- [ ] `POST /api/v1/auth/register`
- [ ] `POST /api/v1/auth/resend-verification`
- [ ] `POST /api/v1/auth/reset-password`
- [ ] `GET /api/v1/auth/sessions`
- [ ] `DELETE /api/v1/auth/sessions/{sessionId}`
- [ ] `POST /api/v1/auth/verify-email`
- [ ] `POST /api/v1/invitations/accept`
- [ ] `GET /api/v1/invitations/preview`
- [ ] `GET /api/v1/organizations`
- [ ] `POST /api/v1/organizations`
- [ ] `GET /api/v1/organizations/{organizationId}`
- [ ] `GET /api/v1/organizations/{organizationId}/members/me`
- [ ] `GET /health`
- [ ] `GET /health/live`
- [ ] `GET /health/ready`

### Phase 2 operation checklist

- [ ] `DELETE /api/v1/organizations/{organizationId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}`
- [ ] `GET /api/v1/organizations/{organizationId}/api-keys`
- [ ] `POST /api/v1/organizations/{organizationId}/api-keys`
- [ ] `DELETE /api/v1/organizations/{organizationId}/api-keys/{apiKeyId}`
- [ ] `GET /api/v1/organizations/{organizationId}/api-keys/scopes`
- [ ] `GET /api/v1/organizations/{organizationId}/invitations`
- [ ] `POST /api/v1/organizations/{organizationId}/invitations`
- [ ] `DELETE /api/v1/organizations/{organizationId}/invitations/{invitationId}`
- [ ] `POST /api/v1/organizations/{organizationId}/invitations/{invitationId}/resend`
- [ ] `PUT /api/v1/organizations/{organizationId}/ip-enforcement`
- [ ] `GET /api/v1/organizations/{organizationId}/ip-rules`
- [ ] `POST /api/v1/organizations/{organizationId}/ip-rules`
- [ ] `DELETE /api/v1/organizations/{organizationId}/ip-rules/{ruleId}`
- [ ] `GET /api/v1/organizations/{organizationId}/members`
- [ ] `DELETE /api/v1/organizations/{organizationId}/members/{memberId}`
- [ ] `GET /api/v1/organizations/{organizationId}/members/{memberId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/members/{memberId}`
- [ ] `POST /api/v1/organizations/{organizationId}/members/{memberId}/reactivate`
- [ ] `PUT /api/v1/organizations/{organizationId}/members/{memberId}/roles`
- [ ] `POST /api/v1/organizations/{organizationId}/members/{memberId}/suspend`
- [ ] `POST /api/v1/organizations/{organizationId}/members/leave`
- [ ] `GET /api/v1/organizations/{organizationId}/roles`
- [ ] `POST /api/v1/organizations/{organizationId}/roles`
- [ ] `DELETE /api/v1/organizations/{organizationId}/roles/{roleId}`
- [ ] `GET /api/v1/organizations/{organizationId}/roles/{roleId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/roles/{roleId}`
- [ ] `POST /api/v1/organizations/{organizationId}/roles/recompute`
- [ ] `POST /api/v1/organizations/{organizationId}/transfer-ownership`
- [ ] `GET /api/v1/permissions`

### Phase 3 operation checklist

- [ ] `GET /api/v1/organizations/{organizationId}/documents`
- [ ] `DELETE /api/v1/organizations/{organizationId}/documents/{documentId}`
- [ ] `GET /api/v1/organizations/{organizationId}/documents/{documentId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/documents/{documentId}`
- [ ] `GET /api/v1/organizations/{organizationId}/documents/{documentId}/chunks`
- [ ] `GET /api/v1/organizations/{organizationId}/documents/{documentId}/download`
- [ ] `POST /api/v1/organizations/{organizationId}/documents/{documentId}/reindex`
- [ ] `GET /api/v1/organizations/{organizationId}/knowledge-bases`
- [ ] `POST /api/v1/organizations/{organizationId}/knowledge-bases`
- [ ] `DELETE /api/v1/organizations/{organizationId}/knowledge-bases/{knowledgeBaseId}`
- [ ] `GET /api/v1/organizations/{organizationId}/knowledge-bases/{knowledgeBaseId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/knowledge-bases/{knowledgeBaseId}`
- [ ] `POST /api/v1/organizations/{organizationId}/knowledge-bases/{knowledgeBaseId}/documents`
- [ ] `GET /api/v1/organizations/{organizationId}/knowledge-bases/{knowledgeBaseId}/grants`
- [ ] `PUT /api/v1/organizations/{organizationId}/knowledge-bases/{knowledgeBaseId}/grants`
- [ ] `DELETE /api/v1/organizations/{organizationId}/knowledge-bases/{knowledgeBaseId}/grants/{grantId}`
- [ ] `POST /api/v1/organizations/{organizationId}/pii/analyze`
- [ ] `GET /api/v1/organizations/{organizationId}/pii/documents/{documentId}/report`
- [ ] `GET /api/v1/organizations/{organizationId}/pii/entity-types`
- [ ] `GET /api/v1/organizations/{organizationId}/pii/policy`
- [ ] `PUT /api/v1/organizations/{organizationId}/pii/policy`
- [ ] `GET /api/v1/organizations/{organizationId}/rag/access-scope`
- [ ] `POST /api/v1/organizations/{organizationId}/rag/query`

### Phase 4 operation checklist

- [ ] `GET /api/v1/organizations/{organizationId}/agents`
- [ ] `POST /api/v1/organizations/{organizationId}/agents`
- [ ] `DELETE /api/v1/organizations/{organizationId}/agents/{agentId}`
- [ ] `GET /api/v1/organizations/{organizationId}/agents/{agentId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/agents/{agentId}`
- [ ] `POST /api/v1/organizations/{organizationId}/agents/{agentId}/prompt-preview`
- [ ] `POST /api/v1/organizations/{organizationId}/agents/{agentId}/publish`
- [ ] `POST /api/v1/organizations/{organizationId}/agents/{agentId}/unpublish`
- [ ] `GET /api/v1/organizations/{organizationId}/agents/{agentId}/versions`
- [ ] `GET /api/v1/organizations/{organizationId}/agents/{agentId}/versions/{version}`
- [ ] `POST /api/v1/organizations/{organizationId}/agents/{agentId}/versions/{version}/restore`
- [ ] `GET /api/v1/organizations/{organizationId}/conversations`
- [ ] `POST /api/v1/organizations/{organizationId}/conversations`
- [ ] `DELETE /api/v1/organizations/{organizationId}/conversations/{conversationId}`
- [ ] `GET /api/v1/organizations/{organizationId}/conversations/{conversationId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/conversations/{conversationId}`
- [ ] `GET /api/v1/organizations/{organizationId}/conversations/{conversationId}/messages`
- [ ] `POST /api/v1/organizations/{organizationId}/conversations/{conversationId}/messages`
- [ ] `POST /api/v1/organizations/{organizationId}/conversations/{conversationId}/messages/stream`
- [ ] `POST /api/v1/organizations/{organizationId}/llm/chat`
- [ ] `POST /api/v1/organizations/{organizationId}/llm/chat/stream`
- [ ] `GET /api/v1/organizations/{organizationId}/llm/models`
- [ ] `GET /api/v1/organizations/{organizationId}/llm/policy`
- [ ] `PUT /api/v1/organizations/{organizationId}/llm/policy`
- [ ] `GET /api/v1/organizations/{organizationId}/llm/usage`

### Phase 5 operation checklist

- [ ] `DELETE /api/v1/auth/me`
- [ ] `GET /api/v1/auth/me/export`
- [ ] `GET /api/v1/organizations/{organizationId}/analytics/overview`
- [ ] `GET /api/v1/organizations/{organizationId}/analytics/security-events`
- [ ] `GET /api/v1/organizations/{organizationId}/analytics/timeseries`
- [ ] `GET /api/v1/organizations/{organizationId}/analytics/top`
- [ ] `GET /api/v1/organizations/{organizationId}/audit-logs`
- [ ] `GET /api/v1/organizations/{organizationId}/audit-logs/archives`
- [ ] `GET /api/v1/organizations/{organizationId}/audit-logs/archives/{sequence}`
- [ ] `GET /api/v1/organizations/{organizationId}/audit-logs/export`
- [ ] `GET /api/v1/organizations/{organizationId}/audit-logs/statistics`
- [ ] `GET /api/v1/organizations/{organizationId}/audit-logs/verify`
- [ ] `GET /api/v1/organizations/{organizationId}/circuits`
- [ ] `DELETE /api/v1/organizations/{organizationId}/circuits/agents/{agentId}`
- [ ] `GET /api/v1/organizations/{organizationId}/circuits/agents/{agentId}`
- [ ] `GET /api/v1/organizations/{organizationId}/quotas`
- [ ] `POST /api/v1/organizations/{organizationId}/quotas`
- [ ] `DELETE /api/v1/organizations/{organizationId}/quotas/{quotaId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/quotas/{quotaId}`
- [ ] `GET /api/v1/organizations/{organizationId}/quotas/{quotaId}/history`
- [ ] `GET /api/v1/organizations/{organizationId}/quotas/me`
- [ ] `GET /api/v1/organizations/{organizationId}/tools`
- [ ] `POST /api/v1/organizations/{organizationId}/tools`
- [ ] `DELETE /api/v1/organizations/{organizationId}/tools/{toolId}`
- [ ] `GET /api/v1/organizations/{organizationId}/tools/{toolId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/tools/{toolId}`
- [ ] `POST /api/v1/organizations/{organizationId}/tools/{toolId}/test`
- [ ] `GET /api/v1/organizations/{organizationId}/tools/executions`
- [ ] `GET /api/v1/organizations/{organizationId}/workflow-runs`
- [ ] `DELETE /api/v1/organizations/{organizationId}/workflow-runs/{runId}`
- [ ] `GET /api/v1/organizations/{organizationId}/workflow-runs/{runId}`
- [ ] `POST /api/v1/organizations/{organizationId}/workflow-runs/{runId}/cancel`
- [ ] `GET /api/v1/organizations/{organizationId}/workflow-runs/{runId}/content`
- [ ] `POST /api/v1/organizations/{organizationId}/workflow-runs/{runId}/resume`
- [ ] `POST /api/v1/organizations/{organizationId}/workflow-runs/{runId}/steps/{stepId}/approval`
- [ ] `GET /api/v1/organizations/{organizationId}/workflow-runs/{runId}/steps/{stepId}/content`
- [ ] `GET /api/v1/organizations/{organizationId}/workflow-runs/{runId}/trace`
- [ ] `GET /api/v1/organizations/{organizationId}/workflow-runs/approvals`
- [ ] `GET /api/v1/organizations/{organizationId}/workflow-runs/dead-letters`
- [ ] `GET /api/v1/organizations/{organizationId}/workflows`
- [ ] `POST /api/v1/organizations/{organizationId}/workflows`
- [ ] `DELETE /api/v1/organizations/{organizationId}/workflows/{workflowId}`
- [ ] `GET /api/v1/organizations/{organizationId}/workflows/{workflowId}`
- [ ] `PATCH /api/v1/organizations/{organizationId}/workflows/{workflowId}`
- [ ] `POST /api/v1/organizations/{organizationId}/workflows/{workflowId}/archive`
- [ ] `PUT /api/v1/organizations/{organizationId}/workflows/{workflowId}/definition`
- [ ] `POST /api/v1/organizations/{organizationId}/workflows/{workflowId}/publish`
- [ ] `POST /api/v1/organizations/{organizationId}/workflows/{workflowId}/runs`
- [ ] `GET /api/v1/organizations/{organizationId}/workflows/{workflowId}/versions`
- [ ] `GET /api/v1/organizations/{organizationId}/workflows/{workflowId}/versions/{version}`
- [ ] `POST /api/v1/organizations/{organizationId}/workflows/{workflowId}/versions/{version}/restore`
- [ ] `GET /api/v1/organizations/{organizationId}/workflows/node-types`
- [ ] `POST /api/v1/organizations/{organizationId}/workflows/validate`
