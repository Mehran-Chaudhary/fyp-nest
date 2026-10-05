# Phase 2 live API verification

**Date:** 5 October 2026, Asia/Karachi. **Backend source baseline:** `5b4efb7`.

This report supplements the [Phase 2 handoff](PHASE_2_WORKSPACE_ADMINISTRATION.md). The owner authorized live testing after starting the backend. Tests used `http://localhost:3000`, real HTTP requests, the running database/Redis and disposable fixtures. No backend application behavior was changed.

**Result: 66 checks passed, zero failures; all 30 Phase 2 operations exercised.** The complete run ended at 2026-10-05T14:55:30.108Z (UTC).

## Evidence and scope

The [machine-readable results](PHASE_2_LIVE_RESULTS.json) record each request label, method, path, expected/actual status, selected error code, duration and request ID. The [initial attempt](PHASE_2_LIVE_INITIAL_RESULTS.json) is retained separately: 16 checks passed before the harness's direct database connection failed to load the configured CA certificate. Its two workspaces were deleted and all three fixture sessions logged out. The harness was corrected to use `DB_SSL_CA`; certificate verification was not disabled to work around the error.

The running `/docs-json` returned HTTP 200, with 122 paths and all 30 Phase 2 operations present. Liveness and readiness returned 200; readiness reported PostgreSQL and Redis up. The earlier connection-refused observation is therefore historical, not a current blocker. One initial liveness request took approximately 23 seconds; subsequent run timings are preserved in the results.

## What these checks establish

The run exercises every Phase 2 operation through HTTP, covering settings, members, invitations, role catalogue/CRUD/recompute, API keys, IP rules/enforcement, ownership transfer, leaving and workspace deletion. Negative cases include authentication requirement, invalid overlap, unknown fields, insufficient workspace permission, immutable/in-use roles, unsupported key scope, suspended access, cross-tenant role lookup, revoked-invitation resend, invalid/duplicate IP rules, enforcement without rules and owner leaving.

Two explicit response-shape assertions verify that creation returns the one-time key and that list entries omit plaintext and preserve string `usageCount`. Other checks primarily assert status and selected error codes; they are not exhaustive structural assertions for every response field. Success on transfer followed by successful deletion using the new owner's session provides a functional ownership transition check. Successful suspended denial followed by reactivated access checks that membership state affects the guard.

## Fixture method and cleanup

- Accounts and workspaces were created through public authenticated flows with unique `p2-<timestamp>` identifiers. Account/invitation addresses used `example.invalid`; generated passwords and tokens were held in process memory and are absent from reports.
- Two membership fixtures and one successor membership were inserted directly into `organization_members`/`member_roles`, only within the newly created test workspace. The public recompute endpoint populated their derived permissions. This bypasses invitation redemption for setup; it does not establish mail delivery or acceptance correctness.
- Invitation create/resend exercised the configured Ethereal sending path, but inbox delivery was not independently inspected. HTTP success is not a delivery receipt.
- The disposable API key was explicitly revoked, the invitation revoked, network enforcement disabled and temporary IP rules removed. Membership leave/removal were exercised. Cleanup deleted the disposable workspaces through the API and logged out every fixture user's sessions.
- Across the initial and full runs, six synthetic user records remain for audit traceability. Four workspaces were soft-deleted through the supported API; related audit/soft-deleted records remain according to backend behavior. No hard deletion or modification of existing project users/workspaces was performed.

## What remains unverified

This is an API smoke/contract run, not the complete frontend acceptance suite. It does not verify browser rendering, accessibility, refresh races, clipboard behavior, secret persistence in a future client, SMTP inbox delivery/public invitation redemption, all permission/role combinations, seat/domain/MFA branches, machine-key downstream authorization after suspension, external/proxy network enforcement, failure injection or transaction atomicity. The source-observed P2-G02–P2-G12 decisions remain open unless separately resolved with evidence.

Keep the frontend checklist unchecked until the client is implemented and its corresponding tests are demonstrated. No frontend repository or running client was provided for this run.

## Reproduction

The [opt-in harness](../../scripts/verify-phase2-live.cjs) creates fresh fixtures and performs real writes. Run only against the intended development backend/database with `.env` matching the running server:

```powershell
node scripts/verify-phase2-live.cjs --run
```

Do not run it as an ordinary unit test or repeatedly to bypass rate limits. It uses the configured database connection for explicitly identified fixture inserts. It keeps secrets out of output, but intentionally retains synthetic users and audit history. An interrupted run can leave fixtures; consult recorded IDs and clean up only those fixtures. Each completed invocation overwrites the main results file, so archive evidence before a new run.
