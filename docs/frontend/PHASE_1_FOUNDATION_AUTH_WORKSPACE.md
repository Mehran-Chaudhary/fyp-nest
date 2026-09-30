# Frontend Phase 1: Foundation, Authentication & Workspace Shell

**Status:** ready to implement
**Roadmap:** [`FRONTEND_PHASES.md`](FRONTEND_PHASES.md), Phase 1 of 9
**Backend:** this repository (NestJS). Every request and response shape in this
document was checked against a running instance of the backend on 2026-09-30,
**including the backend fixes made that day** (§14 lists what changed; if you started
from an earlier copy of this document, read §14 first).
**Design:** mockup screens 1 (Sign In) and 2 (the shell around the Command Centre) in
`doc/Updated_FYP_Proposal_Distributed_AI_Agents (2).docx`, section 13.

---

## Contents

1. [What Phase 1 delivers](#1-what-phase-1-delivers)
2. [Tech stack and project setup](#2-tech-stack-and-project-setup)
3. [How the backend talks: conventions every call follows](#3-how-the-backend-talks-conventions-every-call-follows)
4. [Authentication and token handling (read this before writing any code)](#4-authentication-and-token-handling-read-this-before-writing-any-code)
5. [Workspaces and permissions in the frontend](#5-workspaces-and-permissions-in-the-frontend)
6. [Routes and guards](#6-routes-and-guards)
7. [Screens](#7-screens)
8. [Endpoint reference](#8-endpoint-reference)
9. [Error codes Phase 1 must handle](#9-error-codes-phase-1-must-handle)
10. [Client-side validation rules](#10-client-side-validation-rules)
11. [State, caching and query keys](#11-state-caching-and-query-keys)
12. [Visual design](#12-visual-design)
13. [Local development against the backend](#13-local-development-against-the-backend)
14. [Backend fixes of 2026-09-30 (what changed for the frontend)](#14-backend-fixes-of-2026-09-30-what-changed-for-the-frontend)
15. [Definition of done](#15-definition-of-done)
16. [Appendix A: TypeScript types](#appendix-a-typescript-types)
17. [Appendix B: reference implementation of the API client and token manager](#appendix-b-reference-implementation-of-the-api-client-and-token-manager)

---

## 1. What Phase 1 delivers

At the end of Phase 1 a person can:

- create an account, sign in (including a two-step verification code when enabled)
  and sign out;
- recover a forgotten password and verify their email address from the links the
  backend emails;
- create a workspace, see the workspaces they belong to, switch between them, and
  land in the AgentVault app shell;
- see only the navigation their role allows (the sections themselves are
  placeholders until later phases);
- manage their own account: profile, password, two-step verification, signed-in
  devices, "sign out everywhere", download their personal data, and erase their
  account.

Phase 1 also builds the foundation every later phase reuses: the API client, the
token manager, error handling, the permission helper, route guards, the layout, and
the theme.

**Not in Phase 1** (later phases, but the routes and navigation slots are reserved
now): team, invitations, roles and workspace settings (Phase 2), documents
(Phase 3), agents (Phase 4), chat (Phase 5), workflows (Phases 6–7), dashboard data
and audit logs (Phase 8).

**Do not build** the "Microsoft SSO" and "SAML / LDAP" buttons, the "Trusted by …"
logos, or the "SOC2 / ISO 27001 / GDPR Ready" badges shown in mockup 1. The backend
has no SSO, and the compliance badges would be claims the project has not earned.
The global search box and the notification bell in mockup 2 also have no backend yet
(Phase 7/8), so leave them out or render them disabled.

---

## 2. Tech stack and project setup

### 2.1 Recommended stack

The API contract does not depend on these choices, but the reference code in this
document assumes them.

| Concern | Choice |
|---|---|
| Build | Vite + React 18+ + TypeScript (`strict: true`) |
| Routing | React Router (v6.4+ data routers, or v7) |
| Server state | TanStack Query v5 |
| Client state (session) | Zustand, or a small React context |
| UI | Tailwind CSS + shadcn/ui (Radix primitives), `lucide-react` icons (the mockups use this icon set) |
| Forms | React Hook Form + Zod |
| Toasts | `sonner` |
| QR code (MFA setup) | `qrcode.react` |
| Dates | `date-fns` |
| Tests | Vitest + React Testing Library + MSW (Playwright arrives in Phase 9) |
| Later phases | `@xyflow/react` (Phase 6), `socket.io-client` (Phase 7), `recharts` (Phase 8) |

### 2.2 Folder structure

```
src/
  app/                 router, providers, layouts (PublicLayout, AppShell, AccountLayout)
  lib/
    api/               client.ts, errors.ts, types.ts (envelope), token-manager.ts
    auth/              session store, useSession(), restoreSession()
    permissions/       expand.ts (wildcard logic), useCan(), nav config
    storage.ts         safe localStorage wrapper (try/catch)
  features/
    auth/              SignInPage, MfaStep, SignUpPage, ForgotPasswordPage,
                       ResetPasswordPage, VerifyEmailPage
    workspaces/        WorkspacesPage, CreateWorkspacePage, WorkspaceSwitcher,
                       WorkspaceGate, workspace error states
    shell/             Sidebar, Topbar, UserMenu, ComingSoon placeholder, HomePage
    account/           ProfilePage, SecurityPage (+ MFA dialogs), PrivacyPage
    invitations/       AcceptInvitationPlaceholder (real page in Phase 2)
  components/ui/       shadcn components
  styles/              tailwind.css, theme tokens
```

### 2.3 Environment variables

| Variable | Development value | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | `/api/v1` | Prefix for every API call. Keep it relative (`/api/v1`) and let the dev proxy forward it. |
| `VITE_APP_NAME` | `AgentVault` | Product name in the UI |

### 2.4 Dev server and proxy (important)

Serve the frontend on **port 5173** (`strictPort: true`). The backend's emails link
to `FRONTEND_URL`, which defaults to `http://localhost:5173`, and CORS allows that
origin.

Proxy `/api` and `/health` to the backend **without rewriting the path**. The refresh
cookie is scoped to `Path=/api/v1/auth`. If the browser calls `/api/v1/auth/refresh`
on the frontend's own origin, the cookie is sent, and production can be deployed the
same way.

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
```

Calling the backend directly (`VITE_API_BASE_URL=http://localhost:3000/api/v1`)
also works in development: CORS allows `http://localhost:5173` with credentials, and
`localhost:5173 → localhost:3000` counts as same-site for the `SameSite=Lax` cookie.
The proxy is still recommended because it is what production must look like (see
§3.9).

---

## 3. How the backend talks: conventions every call follows

### 3.1 Base URL

- API: `{origin}/api/v1/...`, for example `/api/v1/auth/login`.
- Health probes are **not** under the prefix: `/health`, `/health/live`,
  `/health/ready`.
- Swagger UI for browsing: `http://localhost:3000/docs`. This document is the source
  of truth for Phase 1.

### 3.2 The response envelope

Every JSON response has one of these shapes.

**Success**

```json
{
  "success": true,
  "data": { "...": "the payload" },
  "meta": {
    "requestId": "b726bf87-a089-4c3d-a402-82c54c8c471e",
    "timestamp": "2026-09-29T20:34:24.741Z",
    "durationMs": 395
  }
}
```

**Success, paginated list:** `data` is the array itself and the pagination is in
`meta.pagination`.

```json
{
  "success": true,
  "data": [ { "...": "item" } ],
  "meta": {
    "requestId": "…", "timestamp": "…", "durationMs": 28,
    "pagination": {
      "page": 1, "limit": 20, "totalItems": 2, "totalPages": 1,
      "hasPreviousPage": false, "hasNextPage": false
    }
  }
}
```

**Failure**

```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You lack the permissions required for this action.",
    "details": { "missingPermissions": ["workspace:update"] }
  },
  "meta": {
    "requestId": "0b01ea95-ed6e-4660-a6f8-50f21968375c",
    "timestamp": "2026-09-29T20:34:26.828Z",
    "path": "/api/v1/organizations/acme-corp",
    "durationMs": 35
  }
}
```

Rules:

- **Branch on `error.code`, never on `message`.** Codes are stable; messages may
  change. The `message` is safe to show to users.
- `details` is optional and its shape depends on the code (documented per code in
  §9).
- A handler that returns nothing still returns `"data": null`.
- Two responses in Phase 1 are **not** enveloped: `GET /auth/me/export` (a file
  download) and 204 CORS preflights.
- An unknown route returns `404` with code `RESOURCE_NOT_FOUND`.

### 3.3 Validation errors (422)

When the request body or query fails validation, the server answers `422` with code
`VALIDATION_FAILED` and a map of messages per field:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "One or more fields failed validation.",
    "details": {
      "fields": {
        "email": ["email must be a valid email address"],
        "password": ["Password must be at least 12 characters long. Password must contain an uppercase letter."],
        "extra": ["property extra should not exist"]
      }
    }
  },
  "meta": { "…": "…" }
}
```

`details.fields` is `Record<string, string[]>`, keyed by the **property path** in the
request: `email`, `newPassword`, nested fields as `settings.defaultChunkSize`, array
items as `items.0.name`. A field the server does not accept is reported under its
own name (`extra` above); that is a frontend bug, so also log it to the console.

Map each key to the form field with the same name, and show any key that matches no
field as a form-level error. All password-policy failures for a field arrive as one
joined message under that field.

### 3.4 Request headers the client sends

| Header | When | Value |
|---|---|---|
| `Authorization` | every authenticated call | `Bearer <accessToken>` |
| `Content-Type` | calls with a JSON body | `application/json` |
| `X-Organization-Id` | every **workspace-scoped** call (`/organizations/:id/...`) | the active workspace's **UUID**. The server also accepts the slug, but send the UUID. |
| `X-Request-Id` | optional | your own correlation id (`[A-Za-z0-9._:-]`, ≤128 chars). If absent the server generates one. |

**Never let the header and the path disagree.** On routes like
`/organizations/:organizationId/...` the server resolves the workspace from the
`X-Organization-Id` header first and **ignores the path parameter**. If the header
names workspace A and the path names workspace B, the request acts on A, or returns
`404 ORGANIZATION_NOT_FOUND` if you are not a member of A (verified). Build
workspace URLs and the header from the same variable.

Always use `credentials: 'include'` on fetch. It is required on `/auth/*` so the
refresh cookie travels, and harmless elsewhere.

### 3.5 Response headers the client can read

CORS exposes these (verified):

| Header | Use |
|---|---|
| `x-request-id` | Same as `meta.requestId`. Show it in error toasts ("Reference: 3f0f7ab8") so bug reports can be traced to the server log. |
| `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` | Budget of the current throttle bucket (`reset` is a Unix time in seconds) |
| `retry-after` | Seconds to wait, on `429` |
| `content-disposition` | The filename of downloads (`GET /auth/me/export`) |

### 3.6 Rate limits

The server uses named throttle policies. Defaults:

| Policy | Limit | Counted per | Used by (Phase 1) |
|---|---|---|---|
| `default` | 120 requests / 60 s | signed-in user; source IP when signed out | everything not listed below |
| `refresh` | 60 requests / 15 min | session (the refresh cookie's); source IP without a valid cookie | `refresh` |
| `auth` | 10 requests / 15 min | source IP **and** email when the body names one (`register`, `login`); the signed-in user (`change-password`, `mfa/setup`, `mfa/enable`, `mfa/disable`, `mfa/recovery-codes`, `DELETE /auth/me`); source IP otherwise (`mfa/verify`, `verify-email`, `reset-password`) | credential endpoints |
| `email` | 5 requests / 1 hour | source IP and email (`resend-verification`, `forgot-password`); the signed-in user (`GET /auth/me/export`) | endpoints that send email or files |

The limiter identifies a signed-in caller from the access token's signature (cheaply,
before authentication), so colleagues behind one office IP do not share a budget.
**Failed requests count too.** Verified: 16 consecutive refreshes of one session all
succeed; one user exhausting their `auth` budget does not affect another user on the
same IP.

Consequences for the frontend:

1. **Every page reload costs one `refresh`** (the access token lives in memory), from
   a budget of 60 per 15 minutes per session. That is plenty for normal use; still
   share tokens between tabs and skip the boot refresh when the browser has no
   session (§4), which avoids needless refreshes.
2. **A `429` on refresh is not a sign-out.** Keep the user's state, show "Too many
   requests, try again in N minutes", and retry after `Retry-After`. Do not wipe the
   session.

The error body for `429`:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded for this endpoint (10 requests per 900s). Try again in 900s.",
    "details": { "retryAfterSeconds": 900 }
  },
  "meta": { "…": "…" }
}
```

### 3.7 Timeouts

The server abandons a request after 30 s and answers `408 REQUEST_TIMEOUT`. Give the
client a slightly longer abort timeout (35 s) so the server's answer arrives first.

### 3.8 The refresh cookie

| Property | Value |
|---|---|
| Name | `daiap_rt` |
| Flags | `HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=2592000` (30 days); `Secure` in production |
| Set by | `register`, `login`, `mfa/verify`, `refresh` (a new cookie on every rotation) |
| Cleared by | `logout`, `logout-all`, `reset-password` |

JavaScript cannot read the cookie (HttpOnly). That is intended: the frontend never
touches the refresh token. Because the cookie is enabled, the refresh token is
**absent from response bodies** (`tokens.refreshToken` is not there).

### 3.9 Production note (Phase 9, but do not paint yourself into a corner)

`SameSite=Lax` means the browser only sends the cookie to the API when the frontend
and API are the **same site**. Either:

- serve the API under the frontend's domain with a reverse proxy or rewrite (`/api/*`
  → backend). This is the recommended option and matches the dev proxy; or
- change the backend to `COOKIE_SAME_SITE=none` + `COOKIE_SECURE=true` and set
  `CORS_ORIGINS` / `FRONTEND_URL` to the frontend origin.

So: keep `VITE_API_BASE_URL` configurable, and never hard-code `localhost`.

---

## 4. Authentication and token handling (read this before writing any code)

This is the part of Phase 1 where mistakes are expensive. The backend treats some
harmless-looking client behaviour as an attack and responds by signing the user out
of **every device** and emailing them a security alert.

### 4.1 The model

| Token | Lifetime | Where it lives | How to get a new one |
|---|---|---|---|
| Access token (JWT) | 15 min (`expiresIn: 900`) | **In memory only.** Not localStorage, not sessionStorage. | `POST /auth/refresh` |
| Refresh token | 30 days, **rotated on every use** | httpOnly cookie `daiap_rt`, managed by the browser | Comes back with every login and refresh |

Permissions are **not** in the token. They are resolved per request on the server,
so a role change takes effect immediately (§5).

### 4.2 The rule that must never be broken: one refresh at a time, across all tabs

Refresh tokens rotate. When a refresh token is used, the old one is marked spent. If
a spent token is presented again, the backend concludes the token was stolen:

- `401 AUTH_REFRESH_TOKEN_REUSED`
- **every session of the user is revoked** (all devices)
- the user receives a "Suspicious sign-in activity" email

**Two concurrent `POST /auth/refresh` calls carrying the same cookie trigger this.**
This was verified: two parallel refreshes gave one `200` and one
`401 AUTH_REFRESH_TOKEN_REUSED`. Common ways to cause it by accident:

- **React 18 StrictMode** runs effects twice in development. A `useEffect(() =>
  refresh(), [])` fires two refreshes at once.
- Several queries fail with `401` at the same moment and each one refreshes.
- Two tabs wake up together and each one refreshes.

Required design (reference code in Appendix B):

1. **Single-flight within a tab.** A module-level `inFlight` promise, not component
   state. Every caller awaits the same promise.
2. **Cross-tab lock.** Wrap the refresh in
   `navigator.locks.request('agentvault:refresh', …)` (Web Locks API, supported in
   all current browsers).
3. **Share the result between tabs.** Use a `BroadcastChannel('agentvault:auth')`:
   the tab that refreshed broadcasts `{ type: 'token', accessToken, expiresAt }`.
   A tab waiting for the lock checks, once it gets the lock, whether a new token
   arrived in the meantime, and uses it instead of refreshing again.
4. **Share at boot.** A new tab first asks the others (`{ type: 'token-request' }`,
   wait ~150 ms) and refreshes only if nobody answers. This also saves refresh
   budget (§3.6).
5. **Share sign-out.** Signing out in one tab broadcasts `{ type: 'signed-out' }` and
   every tab clears its state.

### 4.3 When to refresh

- **On demand, before a request:** if the in-memory token expires within 30 s,
  refresh first, then send the request. Use no background timer. Timers make idle
  tabs spend the refresh budget for nothing.
- **Reactively, on `401`,** but only for these codes: `AUTH_TOKEN_EXPIRED`,
  `AUTH_TOKEN_REVOKED`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_MISSING`. Refresh once,
  retry the original request once. If the retry fails with `401` again, sign out.
- Compute `expiresAt` on the client as `Date.now() + expiresIn * 1000` when the token
  arrives, so a skewed client clock does not matter. `mfa/enable` returns only
  `expiresIn`.

**Never refresh on other `401` codes.** Several endpoints use `401` for wrong input:
`AUTH_INVALID_CREDENTIALS` (sign in), `AUTH_PASSWORD_MISMATCH` (change password, MFA
setup, erase), `MFA_CODE_INVALID`, `MFA_CHALLENGE_INVALID`, `TOKEN_NOT_FOUND`,
`TOKEN_EXPIRED`, `TOKEN_ALREADY_USED` (email links). Treating those as "session
expired" would sign a user out for mistyping a password.

### 4.4 What a failed refresh means

| Refresh result | Meaning | Do |
|---|---|---|
| `200` | New access token; the browser stored the new cookie | Install the token, broadcast it |
| `401 AUTH_TOKEN_MISSING` | No cookie: never signed in, or signed out | Go to sign-in quietly |
| `401 AUTH_REFRESH_TOKEN_INVALID`, `AUTH_TOKEN_REVOKED`, `AUTH_TOKEN_EXPIRED` | Session ended (signed out elsewhere, password changed or reset, device revoked, 30 days passed) | Sign out; sign-in page with "Your session has ended. Please sign in again." |
| `401 AUTH_REFRESH_TOKEN_REUSED` | Reuse detected; every session is revoked | Sign out; sign-in page with a **security notice**: "For your protection you were signed out of all devices. Check your email." |
| `401 ACCOUNT_SUSPENDED` | Account suspended, deactivated or locked | Sign out; show the message |
| `429 RATE_LIMIT_EXCEEDED` | Throttled (§3.6) | **Do not sign out.** Show a blocking "Too many requests, retrying in mm:ss" screen and retry after `Retry-After` |
| `5xx` / network error | Server trouble | **Do not sign out.** Show a "Can't reach AgentVault" banner, retry with backoff |

### 4.5 App boot (session restore)

```
1. If localStorage 'av.hasSession' !== '1' → treat as signed out (no network call).
   (Set it to '1' after any successful sign-in; remove it on sign-out. It holds no
   secret; it only avoids spending a rate-limited refresh for visitors who were
   never signed in.)
2. Ask other tabs for a token (BroadcastChannel, 150 ms). If one answers, use it.
3. Otherwise POST /auth/refresh (under the cross-tab lock).
4. Success → GET /auth/me → session is "authenticated"; route the user (§6.3).
   Failure → handle per §4.4.
```

While this runs, render a full-screen splash (logo + spinner), not the sign-in page.
A flash of the sign-in form before redirecting looks broken.

### 4.6 Sign-out

1. `POST /auth/logout` with the Bearer token, `credentials: 'include'`, body `{}`.
   This revokes this browser's session family and clears the cookie. If the access
   token is already expired, try one refresh first. If that fails, skip the call.
2. Whatever the result: clear the in-memory token, `queryClient.clear()`, remove
   `av.hasSession`, broadcast `signed-out`, navigate to `/auth/sign-in`.

All tabs share one cookie, and therefore one session family. Signing out in one tab
ends the session for every tab, which is why the broadcast matters.

### 4.7 Events that change the token outside refresh

| Event | What the server did | What the client must do |
|---|---|---|
| **Change password** succeeds | Kept this device's session (because the cookie was sent) but invalidated **every access token issued before now**, including the one in memory | Call `expireAccessToken()` (Appendix B) so nothing else uses the dead token, then `await refreshAccessToken()`. The refreshed token works immediately (verified), and the refresh broadcasts it to the other tabs. |
| **MFA enable** succeeds | Signed out every other device; this session is now MFA-verified | Replace the in-memory token with `data.accessToken` (`expiresAt = now + expiresIn*1000`) and broadcast it |
| **Reset password** succeeds | Revoked every session and cleared the cookie | If this browser was signed in, run the sign-out cleanup locally (no API call) |
| **Erase account** succeeds | Account anonymised, all sessions revoked | Local sign-out cleanup, then show a goodbye page |
| **Logout-all** succeeds | Every session revoked, including this one | Local sign-out cleanup |

### 4.8 Two-step verification (MFA) at sign-in

`POST /auth/login` has **two** possible success shapes, both `200`:

```jsonc
// A: signed in
{ "user": { … }, "tokens": { "accessToken": "…", "tokenType": "Bearer",
  "expiresIn": 900, "expiresAt": "…", "refreshExpiresIn": 2592000 } }

// B: password correct, second factor needed (no cookie set, no tokens)
{ "mfaRequired": true,
  "challenge": { "token": "eyJ…", "expiresAt": "2026-09-29T20:40:02.388Z",
                 "methods": ["totp", "recovery_code"] } }
```

Discriminate on `"mfaRequired" in data`. On B, keep `challenge.token` **in memory**
(component state), show the code step, and finish with `POST /auth/mfa/verify`. The
challenge lasts 5 minutes, is single-use, and allows 5 wrong codes. Each wrong code
also counts towards the account lockout, just like a wrong password.

---

## 5. Workspaces and permissions in the frontend

### 5.1 Concepts

- A **workspace** (backend name: *organization*) is a tenant. A user can belong to
  many. Everything from Phase 2 on is inside one workspace.
- Each workspace has an immutable **slug** (for example `acme-corp`) and a **UUID**.
  The frontend URL uses the slug (`/w/acme-corp/...`); API calls use the UUID.
- The user's workspaces come from `GET /auth/me` → `memberships[]` (up to 100) or
  `GET /organizations` (paginated, with more detail). Only **active** memberships are
  listed.
- **Built-in roles** in every workspace: `owner` (priority 100, `*:*`), `admin` (80),
  `member` (50, the default for invitees), `viewer` (20). Workspaces can add custom
  roles (Phase 2). The demo workspace has `hr-manager` (60) and
  `compliance-auditor` (55).
- **Permissions** are `resource:action` keys, 64 in total. `GET /permissions` returns
  the full catalogue. Roles grant them, with wildcards: `*:*` grants everything,
  `agent:*` grants every `agent:…` key.

### 5.2 Getting the current user's permissions in a workspace

`GET /auth/me` with `X-Organization-Id: <workspace id>` (E7) returns
`permissions`, the caller's effective permissions in that workspace with wildcards
already expanded into concrete keys, and `activeOrganizationId`.

```
loadWorkspacePermissions(workspaceId):
  me = GET /auth/me   (header X-Organization-Id: workspaceId)
  return new Set(me.permissions)
```

Naming a workspace sends this call through every workspace check (membership,
suspension, IP allowlist, required MFA, required verified email). It fails with the
same codes as any workspace request (§9.2), which makes it the workspace gate's access
check too (§6.2).

Refetch permissions when the user enters a workspace, when any request returns
`403 PERMISSION_DENIED`, and on window focus (with a staleTime of about 60 s).
Permissions change the moment an admin edits a role, so treat them as server state.

### 5.3 The `can()` helper

```ts
const can = useCan();               // bound to the active workspace
can('agent:create');                // boolean
can.any('audit:read', 'security:read');
```

Use it to hide navigation and **disable** (with a tooltip explaining the missing
permission) buttons. Handle `403 PERMISSION_DENIED` anyway: the server is the
authority, and `details.missingPermissions` says what was missing.

### 5.4 Navigation and the permission that shows each item

Build all items in Phase 1. Every item except Home shows a "Coming in Phase N"
placeholder page for now.

| Nav item (mockup label) | Route | Visible when | Built in |
|---|---|---|---|
| Dashboard | `/w/:slug` | always | Phase 1 (welcome page) → Phase 8 (Command Centre) |
| AI Agents | `/w/:slug/agents` | `agent:read` | Phase 4 |
| Workflows | `/w/:slug/workflows` | `workflow:read` | Phase 6 |
| Documents | `/w/:slug/documents` | `knowledgebase:read` or `document:read` | Phase 3 |
| Audit Logs | `/w/:slug/audit` | `audit:read` | Phase 8 |
| Team | `/w/:slug/team` | `member:read` | Phase 2 |
| Settings | `/w/:slug/settings` | `workspace:read` | Phase 2 |

For quick testing with the demo workspace: `employee@acme.test` (Member) should see
everything **except** Audit Logs; `auditor@acme.test` (Compliance Auditor) sees Audit
Logs; `owner@acme.test` sees all.

---

## 6. Routes and guards

### 6.1 Route table

| Route | Guard | Screen |
|---|---|---|
| `/auth/sign-in` (`?next=`, `?reason=`) | public-only (redirect if signed in) | §7.1, §7.2 |
| `/auth/sign-up` | public-only | §7.3 |
| `/auth/forgot-password` | public-only | §7.4 |
| `/auth/reset-password?token=` | public (**fixed path: the backend emails it**) | §7.5 |
| `/auth/verify-email?token=` | public, works signed in or out (**fixed path**) | §7.6 |
| `/invitations/accept?token=` | public (**fixed path**; placeholder until Phase 2) | §7.7 |
| `/workspaces` | authenticated | §7.8 |
| `/workspaces/new` | authenticated | §7.9 |
| `/w/:workspaceSlug/*` | authenticated + workspace gate | §7.10, §7.11 |
| `/account/profile` | authenticated | §7.12 |
| `/account/security` | authenticated | §7.13 |
| `/account/privacy` | authenticated | §7.14 |
| `/goodbye` | public | shown after account erasure |
| `/` | — | redirect per §6.3 |
| `*` | — | 404 page |

### 6.2 Guards

- **public-only:** while the session is restoring, show the splash. If
  authenticated, redirect to `next` or the default landing.
- **authenticated:** while restoring, show the splash. If unauthenticated, go to
  `/auth/sign-in?next=<current path and query>`. Only accept `next` values that
  start with `/` and not `//`, so the redirect cannot be abused to send users to
  another site.
- **workspace gate** (`/w/:workspaceSlug`):
  1. Find the membership in `me.memberships` by `organizationSlug`. If it is not
     there, refetch `/auth/me` once (the user may have just joined). If it is still
     missing, show the "Workspace not found" state (§7.11).
  2. Set the active workspace (`{ id, slug, name }`) in context and write
     `localStorage['av.lastWorkspace'] = slug`.
  3. Load permissions with `GET /auth/me` + `X-Organization-Id` (§5.2). This is also
     the access check: its error codes map to the §7.11 states.
  4. Load your membership, `GET /organizations/{id}/members/me` (E26): your roles
     and rank, for the Home page and for Phase 2. Render the shell.

### 6.3 Default landing after sign-in or at `/`

```
if valid `next` → go there
else if localStorage 'av.lastWorkspace' is in me.memberships → /w/{that slug}
else if me.memberships.length === 1 → /w/{that slug}
else if me.memberships.length === 0 → /workspaces/new
else → /workspaces
```

---

## 7. Screens

For every screen: a loading state, an error state (message + request id), disabled
submit buttons while a request is in flight, and success feedback. Password fields
have a show/hide toggle (as in the mockup).

### 7.1 Sign in: `/auth/sign-in`

**Layout (mockup 1):** two columns on desktop. Left: logo "AGENTVAULT / ENTERPRISE
PLATFORM", badge "SECURE AI INFRASTRUCTURE", headline "Your Private **AI Command**
Center" (gradient on "AI Command"), a subtitle, and three feature rows (100% Data
Sovereignty / Custom AI Agents / Enterprise RBAC). Right: a card with tabs **Sign
In | Create Account** (the tabs switch routes). The card says "Welcome back", with
fields **Work email** and **Password**, a "Forgot password?" link, and the primary
button "SIGN IN TO WORKSPACE →". On mobile, stack the columns and hide the left one.

**Behaviour:**

1. Submit → `POST /auth/login` (E2) `{ email, password }`.
2. Response A (tokens) → install the token, set `av.hasSession`, `GET /auth/me`,
   route per §6.3.
3. Response B (`mfaRequired`) → switch the card to the MFA step (§7.2).

**Errors:**

| Code | UI |
|---|---|
| `401 AUTH_INVALID_CREDENTIALS` | "Invalid email address or password." under the form. Keep the email, clear the password. This is the same message for unknown emails, by design. |
| `403 ACCOUNT_LOCKED` | "Too many failed attempts. Try again at {details.lockedUntil, local time}." Disable submit until then. Locking happens on the 5th consecutive failure, for 15 minutes (verified). |
| `403 ACCOUNT_SUSPENDED` / `ACCOUNT_DEACTIVATED` | Show the message; no retry |
| `422 VALIDATION_FAILED` | Inline field errors |
| `429 RATE_LIMIT_EXCEEDED` | "Too many sign-in attempts. Try again in {mm:ss}." with a countdown from `Retry-After` |

Show `?reason=` banners from the redirects in §4.4 above the form ("Your session has
ended", "signed out of all devices", "Password changed, sign in again", "Password
reset, sign in with your new password").

### 7.2 MFA step (inside the sign-in card)

- Title "Two-step verification". Explain "Enter the 6-digit code from your
  authenticator app." One input: `inputMode="numeric"`, `autocomplete="one-time-code"`,
  autofocus, accepts `123456` or `123 456`. Submit automatically on the 6th digit.
- Link "Use a recovery code instead" switches to a text input (format `xxxxx-xxxxx`).
- Show a countdown to `challenge.expiresAt`. When it expires, return to the password
  step with "This sign-in attempt expired. Sign in again."
- Submit → `POST /auth/mfa/verify` (E3) with `{ challengeToken, code }` **or**
  `{ challengeToken, recoveryCode }`. Never send both.

| Result | UI |
|---|---|
| `200` | Same as a normal sign-in. If a recovery code was used, `GET /auth/mfa` and warn if `recoveryCodesRemaining ≤ 3` ("Generate new recovery codes in Account → Security"). |
| `401 MFA_CODE_INVALID` | "That code is not valid." Clear the input, stay. (A TOTP code that was already used, for example the one used to enable MFA, is also refused: wait for the next code.) |
| `401 MFA_CHALLENGE_INVALID` | Back to the password step with the server's message (expired, used, or too many wrong codes) |
| `403 ACCOUNT_LOCKED` | As in §7.1 |

A "Back" link returns to the password step and discards the challenge.

### 7.3 Sign up: `/auth/sign-up`

- Fields: **First name**, **Last name**, **Work email**, **Password** (with a
  strength meter and the rule checklist from §10), **Confirm password** (client-only).
- Submit → `POST /auth/register` (E1). The user is **signed in immediately**
  (`201`, same shape as sign-in response A), with `status: "PENDING"` and
  `emailVerified: false`, and a verification email is sent.
- Then go to `/workspaces/new` (a new user has no workspace), with a toast "Check
  your inbox to verify your email."

| Code | UI |
|---|---|
| `409 ACCOUNT_ALREADY_EXISTS` | On the email field: "An account with this email already exists." + link "Sign in instead" |
| `422 VALIDATION_FAILED` | Inline, using the §3.3 mapping |
| `422 AUTH_PASSWORD_BREACHED` | On the password field: "This password has appeared in a known data breach ({details.occurrences} times). Choose a different one." |
| `429` | Countdown message |

### 7.4 Forgot password: `/auth/forgot-password`

- Field: **Email**. Submit → `POST /auth/forgot-password` (E11).
- **Always** show the same confirmation, whether or not the address exists (the
  server always answers `{ sent: true }`, by design): "If an account exists for
  {email}, we've sent a link to reset your password. The link expires in 1 hour."
- Link back to sign in. `429` (5 per hour per email) → countdown message.
- Requesting a new link invalidates the previous one.

### 7.5 Reset password: `/auth/reset-password?token=…`

- Missing `token` → show "This reset link is invalid" + link to request a new one.
- Fields: **New password** (meter + rules), **Confirm**. Submit →
  `POST /auth/reset-password` (E12) `{ token, password }`.
- `200 { reset: true }` → every session is revoked and the cookie is cleared. Run
  the local sign-out cleanup if this browser was signed in, then go to
  `/auth/sign-in?reason=password-reset`.

| Code | UI |
|---|---|
| `401 TOKEN_NOT_FOUND` / `TOKEN_EXPIRED` / `TOKEN_ALREADY_USED` | "This reset link is no longer valid." + button "Request a new link" (→ §7.4) |
| `422 VALIDATION_FAILED` / `AUTH_PASSWORD_BREACHED` | On the password field. A refused password leaves the link usable, so the user can try again. |

### 7.6 Verify email: `/auth/verify-email?token=…`

- Auto-submits on load: `POST /auth/verify-email` (E9) `{ token }`.
- **Guard against the StrictMode double call.** A second call returns
  `TOKEN_ALREADY_USED` and would show an error over a success. Deduplicate with a
  module-level `Map<token, Promise>` (or a `useRef` flag).
- `200 { verified: true }` → "Your email is verified." If signed in, invalidate the
  `me` query (it becomes `emailVerified: true`, `status: "ACTIVE"`) and offer
  "Continue to AgentVault". If signed out, offer "Sign in".
- `401 TOKEN_*` → "This verification link is no longer valid." + "Send a new link"
  (signed in: use `me.email`; signed out: ask for the email) →
  `POST /auth/resend-verification` (E10). Only the most recent link works.

**Unverified banner (global):** while `me.emailVerified === false`, show a slim
banner in the shell: "Please verify your email address. **Resend email**". Resend is
limited to 5 per hour; after sending, show "Sent. Check your inbox." for 60 s.

If the backend runs with `REQUIRE_EMAIL_VERIFICATION=true`, every authenticated call
of an unverified user fails with `403 ACCOUNT_EMAIL_NOT_VERIFIED`. On that code,
render a full-page "Verify your email to continue" screen with the resend button and
a "Sign out" link. A workspace can also require it (`settings.requireVerifiedEmail`,
set in Phase 2). Then only that workspace's requests fail, with
`details.requiredBy: "workspace"`, and the gate shows the §7.11 state instead.

### 7.7 Invitation link placeholder: `/invitations/accept?token=…`

Phase 2 builds the real page. For Phase 1: if signed out, send the user to
`/auth/sign-in?next=/invitations/accept?token=…` (URL-encode `next`). If signed in,
show "Invitations are coming soon" with a link to their workspaces. The point is
that the link does not hit a 404 and that the token survives sign-in.

### 7.8 Workspaces: `/workspaces`

- Data: `GET /organizations?page=1&limit=20` (E23), with pagination controls if
  `hasNextPage`.
- A card per workspace: name, slug, the user's role badge (the first entry of
  `roleSlugs`, with "Owner" when `isOwner`), member count, and joined date. Click →
  `/w/{slug}`.
- Button "Create workspace" → `/workspaces/new`.
- Empty state: "You're not in any workspace yet." + create button + hint "Or ask an
  admin to invite you."

### 7.9 Create workspace: `/workspaces/new`

- Fields: **Workspace name** (2–120), **URL** (optional slug, prefilled live from the
  name using the slugify rule in §10, editable, shown as `…/w/{slug}`),
  **Description** (optional, ≤2000).
- Submit → `POST /organizations` (E24). If the slug is taken, the server **appends a
  random suffix** instead of failing (`zara-labs` → `zara-labs-80b736`, verified), so
  always navigate using the **returned** slug.
- On `201`: invalidate `me` and the workspace list, then go to `/w/{slug}`. The
  creator becomes the Owner, and the workspace starts with the four built-in roles.

| Code | UI |
|---|---|
| `409 ORGANIZATION_SLUG_RESERVED` | On the URL field: "That URL is reserved." (`details.slug`). Reserved list in §10. |
| `403 ORGANIZATION_LIMIT_REACHED` | "You can own at most {details.limit} workspaces." Disable the form. |
| `422 VALIDATION_FAILED` | Inline |

### 7.10 App shell: `/w/:workspaceSlug/*`

**Layout (mockup 2):**

- **Sidebar (left, ~240 px):** logo "AGENTVAULT / ENTERPRISE"; a **workspace card**
  ("WORKSPACE / Acme Corp") that opens the **workspace switcher** (a popover listing
  `me.memberships` with a check on the active one, plus "Create workspace" and "All
  workspaces"); the navigation from §5.4 with icons (LayoutDashboard, Bot, GitBranch,
  Database, Shield, Users, Settings); the active item highlighted as in the mockup.
- **Top bar:** page title / breadcrumb on the left. On the right, the user menu:
  avatar with initials, `displayName`, `email`, and entries "Account settings" →
  `/account/profile`, "Switch workspace" → `/workspaces`, "Sign out".
- **Content:** routed pages. **Home** (`/w/:slug`) is a welcome page for Phase 1:
  "Welcome, {displayName}", the workspace name, the user's role, and a "Getting
  started" checklist with links to later sections (disabled with "coming soon").
- Section routes render a `ComingSoon` component: icon, section name, "Available in
  Phase N".
- Collapsible sidebar below 1024 px; drawer on mobile.

**Switching workspace:** navigate to `/w/{otherSlug}`. The gate (§6.2) does the
rest. Because every workspace query key contains the workspace id (§11), nothing
from the previous workspace can leak into the new one.

### 7.11 Workspace access states (rendered by the gate, inside a minimal shell)

| Condition | Title / body | Actions |
|---|---|---|
| Slug not in memberships, or `404 ORGANIZATION_NOT_FOUND` | "Workspace not found": "It doesn't exist or you don't have access." | Your workspaces |
| `403 ORGANIZATION_SUSPENDED` | "This workspace is suspended" + `details.reason` if present | Your workspaces |
| `403 MEMBERSHIP_SUSPENDED` | "Your access to this workspace is suspended" + `details.reason` | Your workspaces |
| `403 IP_NOT_ALLOWED` | "Your network isn't allowed": "This workspace only accepts connections from approved networks. Contact your administrator." | Your workspaces |
| `403 MFA_REQUIRED` (`details.requiredBy: "workspace"`) | "Two-step verification required": "{workspace} requires two-step verification." | "Set up two-step verification" → `/account/security?next=/w/{slug}`. If MFA is already on but this session is not verified (`GET /auth/mfa` → `sessionVerified: false`): "Sign in again" (sign out, then sign in with a code) |
| `403 ACCOUNT_EMAIL_NOT_VERIFIED` (`details.requiredBy: "workspace"`) | "Verify your email to use this workspace" | "Resend verification email" (E10); Your workspaces |

`MFA_REQUIRED` and `ACCOUNT_EMAIL_NOT_VERIFIED` can also arrive on any later request
(an admin enabled the requirement while the user was working). Handle them globally:
when a workspace-scoped request returns one, switch the gate to that state.

### 7.12 Account → Profile: `/account/profile`

**Account layout:** the same top bar; a left sub-nav **Profile / Security / Privacy &
data**; a "← Back to {last workspace}" link.

- Read-only: **Email** (cannot be changed), account status badge
  (`PENDING` = "Email not verified", `ACTIVE`), "Platform administrator" badge if
  `isPlatformAdmin`.
- Editable: **First name** (1–100), **Last name** (1–100), **Display name**
  (≤255; placeholder "{firstName} {lastName}"; an empty value means "use my full
  name").
- Save → `PATCH /auth/me` (E8) with **only the changed fields**. The response is only
  `{ id, displayName }`, so invalidate `me` afterwards.
- **Avatar URL** (optional, ≤2048): there is no upload endpoint, only a URL field.
  `GET /auth/me` returns it as `avatarUrl`. Show the image where set, initials
  otherwise (and if the image fails to load).

### 7.13 Account → Security: `/account/security`

Four cards.

**1. Password**: "Change password" dialog with **Current password**, **New
password** (meter + rules), **Confirm**.
→ `POST /auth/change-password` (E13) with `credentials: 'include'`. The cookie tells
the server which device to keep signed in.
On `200 { changed: true, revokedSessions: n }`: the access token in memory is now
dead. Call `expireAccessToken()` then `await refreshAccessToken()` (§4.7), and only
then close the dialog with the toast "Password changed. {n} other device(s) were
signed out."

| Code | UI |
|---|---|
| `401 AUTH_PASSWORD_MISMATCH` | On the current password field: "Current password is incorrect." (Do not refresh or sign out.) |
| `400 AUTH_PASSWORD_REUSED` | On the new password field: "Must differ from your current password." |
| `422 VALIDATION_FAILED` (key `newPassword`) / `AUTH_PASSWORD_BREACHED` | On the new password field |

**2. Two-step verification**: state from `GET /auth/mfa` (E16).

- **Off:** "Protect your account with an authenticator app." Button "Enable".
  Wizard in a dialog:
  1. **Confirm password** → `POST /auth/mfa/setup` (E17) `{ password }`.
     `401 AUTH_PASSWORD_MISMATCH` → field error. `409 MFA_ALREADY_ENABLED` → close
     and refetch.
  2. **Scan:** render `otpauthUri` as a QR code (`qrcode.react`, ~180 px, on a white
     background with padding so it scans in dark mode), plus "Can't scan? Enter this
     key": `secret` in groups of 4, with a copy button. Input for the 6-digit code →
     `POST /auth/mfa/enable` (E18) `{ code }`. `401 MFA_CODE_INVALID` → "Code not
     valid, check the time on your phone and try the next code."
     `409 MFA_NOT_ENROLLING` → restart at step 1. Cancelling at step 2 is safe:
     nothing is enabled until this call succeeds, and calling setup again replaces
     the pending secret.
  3. **Recovery codes:** show the 10 codes (`xxxxx-xxxxx`, monospace, 2 columns) with
     "Copy" and "Download .txt". Say: "Each code works once. Store them somewhere
     safe. They won't be shown again." Require a checkbox "I've saved my recovery
     codes" before "Done".
     **Install `data.accessToken` immediately when this response arrives** (§4.7),
     not when "Done" is clicked. Other devices were signed out, so tell the user.
- **On:** "Enabled on {enrolledAt}". "{recoveryCodesRemaining} recovery codes left"
  (warning style if ≤3). "This session: verified" when `sessionVerified`. Buttons:
  - "Generate new recovery codes" → dialog **Password** + **Authenticator code**
    (TOTP only, no recovery code) → `POST /auth/mfa/recovery-codes` (E20) → show the
    new codes as in step 3 (the old ones stop working).
  - "Disable" → dialog **Password** + (**Authenticator code** or "use a recovery
    code") → `POST /auth/mfa/disable` (E19) → `{ disabled: true }` → refetch.
    Warn first: "Workspaces that require two-step verification will stop letting you
    in."
  Errors: `401 AUTH_PASSWORD_MISMATCH` (password field), `401 MFA_CODE_INVALID`
  (code field), `409 MFA_NOT_ENABLED` (refetch).

**3. Devices**: `GET /auth/sessions` (E14). List: device label (for example "Chrome
on Windows"), IP, "Signed in {createdAt}", "Last active {lastUsedAt, relative}",
and a "This device" badge when `isCurrent`.

- Other devices: "Sign out" → confirm → `DELETE /auth/sessions/{id}` (E15) →
  `{ revoked: n }` → refetch. `404 AUTH_SESSION_NOT_FOUND` → refetch (it was already
  gone).
- The current device: **no revoke button** (use the normal Sign out). Revoking the
  current session through this endpoint leaves the in-memory access token working
  for up to 15 minutes and then fails confusingly at the next refresh.
- A revoked device stays usable until its access token expires (≤15 min), then it is
  signed out at its next refresh. Say so in the confirm text: "…will be signed out
  within 15 minutes."

**4. Sign out everywhere**: "Sign out of all devices, including this one." Confirm
→ `POST /auth/logout-all` (E6) → `{ revokedSessions }` → local sign-out cleanup →
`/auth/sign-in?reason=signed-out-everywhere`.

Honour `?next=` on this page: after MFA is enabled from the `MFA_REQUIRED` state
(§7.11), offer "Continue to {workspace}".

### 7.14 Account → Privacy & data: `/account/privacy`

**Download my data:** "A JSON copy of everything AgentVault holds about you, across
every workspace: profile, memberships, devices, your conversations and workflow runs,
API keys you issued, usage and activity." Button → `GET /auth/me/export` (E21):

- The response is the **raw file**, not an envelope. Fetch it with the Bearer token,
  read `res.blob()`, take the filename from `content-disposition`
  (`attachment; filename="personal-data-2026-09-29.json"`), and trigger the
  download with an object URL.
- Errors *are* enveloped JSON (check `res.ok` before calling `blob()`). Limited to
  5 per hour (`429`).

**Erase my account (danger zone):** explain that erasure is irreversible:
conversations and workflow runs are crypto-shredded, API keys revoked, memberships
ended, identity anonymised; workspaces owned alone are deleted. Dialog:

- **Password**; if MFA is on (from `GET /auth/mfa`): **Authenticator code** (or a
  recovery code); **Type `ERASE MY ACCOUNT`** (the confirm button stays disabled until
  it matches exactly, case-sensitive).
- → `DELETE /auth/me` (E22) with a JSON body.

| Result | UI |
|---|---|
| `200` | Local sign-out cleanup → `/goodbye` ("Your account has been erased. {workspacesDeleted.length} workspace(s) deleted.") |
| `409 ACCOUNT_ERASURE_BLOCKED` | "You own workspaces other people belong to. Transfer ownership or remove them first:" then list `details.workspaces[]` as `{name} ({otherMembers} other members)`. Ownership transfer arrives in Phase 2. |
| `403 ACCOUNT_ERASURE_DISABLED` | "Account erasure is disabled on this deployment." Hide the danger zone in future. |
| `401 AUTH_PASSWORD_MISMATCH` / `MFA_CODE_INVALID` | Field errors |
| `422 VALIDATION_FAILED` (`confirmation`) | Should not happen if the button is gated |

### 7.15 Global states

- **Splash** during session restore (§4.5).
- **Offline / server unreachable:** a top banner when fetch throws a network error or
  receives 502/503/504 from the proxy: "Can't reach AgentVault. Retrying…". Optional
  heartbeat: `GET /health/live` (E29) while the banner is shown.
- **Rate limited:** see §3.6 and §4.4.
- **404 page** for unknown frontend routes.
- **Error toasts** always include "Reference: {first 8 chars of requestId}" with
  copy-on-click of the full id.

---

## 8. Endpoint reference

Conventions for this section:

- Paths are relative to `/api/v1` unless they start with `/health`.
- "Auth: Bearer" means `Authorization: Bearer <accessToken>`.
- Response examples show `data` only; the envelope (§3.2) is always around it.
- All responses were captured from a running server (UUIDs and tokens shortened).

### Summary

| # | Method & path | Auth | Throttle | Used by |
|---|---|---|---|---|
| E1 | `POST /auth/register` | public | auth (IP + email) | Sign up |
| E2 | `POST /auth/login` | public | auth (IP + email) | Sign in |
| E3 | `POST /auth/mfa/verify` | public | auth (IP) | MFA step |
| E4 | `POST /auth/refresh` | cookie | refresh (session) | Token manager |
| E5 | `POST /auth/logout` | Bearer + cookie | default | Sign out |
| E6 | `POST /auth/logout-all` | Bearer | default | Security |
| E7 | `GET /auth/me` | Bearer (+ optional `X-Organization-Id`) | default | Session, shell, permissions |
| E8 | `PATCH /auth/me` | Bearer | default | Profile |
| E9 | `POST /auth/verify-email` | public | auth (IP) | Verify email |
| E10 | `POST /auth/resend-verification` | public | email (IP + email) | Banner, verify page |
| E11 | `POST /auth/forgot-password` | public | email (IP + email) | Forgot password |
| E12 | `POST /auth/reset-password` | public | auth (IP) | Reset password |
| E13 | `POST /auth/change-password` | Bearer + cookie | auth (user) | Security |
| E14 | `GET /auth/sessions` | Bearer | default | Security |
| E15 | `DELETE /auth/sessions/{sessionId}` | Bearer | default | Security |
| E16 | `GET /auth/mfa` | Bearer | default | Security, MFA step |
| E17 | `POST /auth/mfa/setup` | Bearer | auth (user) | MFA wizard |
| E18 | `POST /auth/mfa/enable` | Bearer | auth (user) | MFA wizard |
| E19 | `POST /auth/mfa/disable` | Bearer | auth (user) | Security |
| E20 | `POST /auth/mfa/recovery-codes` | Bearer | auth (user) | Security |
| E21 | `GET /auth/me/export` | Bearer | email (user) | Privacy |
| E22 | `DELETE /auth/me` | Bearer | auth (user) | Privacy |
| E23 | `GET /organizations` | Bearer | default | Workspaces page |
| E24 | `POST /organizations` | Bearer | default | Create workspace |
| E25 | `GET /organizations/{organizationId}` | Bearer + `X-Organization-Id` | default | Home (workspace details) |
| E26 | `GET /organizations/{organizationId}/members/me` | Bearer + `X-Organization-Id` | default | Your roles and rank |
| E27 | `GET /organizations/{organizationId}/roles` | Bearer + `X-Organization-Id` | default | Not needed in Phase 1 (roles screen, Phase 2) |
| E28 | `GET /permissions` | Bearer | default | Not needed in Phase 1 (role editor, Phase 2) |
| E29 | `GET /health/live` | public | default | Offline banner (optional) |

---

### E1. `POST /auth/register`: create an account

Signs the user in immediately and sends a verification email.

**Body**

| Field | Type | Rules |
|---|---|---|
| `email` | string | valid email, ≤320, trimmed |
| `password` | string | the password policy (§10) |
| `firstName` | string | non-empty, ≤100, trimmed |
| `lastName` | string | non-empty, ≤100, trimmed |

No other fields are allowed (`422`, keyed by the unknown field's name).

**201**: sets the `daiap_rt` cookie.

```json
{
  "user": {
    "id": "cd8d6853-3033-460c-ac68-d244ed2834be",
    "email": "fe.tester@example.com",
    "firstName": "Zara",
    "lastName": "Khan",
    "displayName": "Zara Khan",
    "emailVerified": false,
    "isPlatformAdmin": false,
    "status": "PENDING",
    "mfaEnabled": false
  },
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "expiresAt": "2026-09-29T20:49:24.000Z",
    "refreshExpiresIn": 2592000
  }
}
```

**Errors:** `409 ACCOUNT_ALREADY_EXISTS` · `422 VALIDATION_FAILED` · `422
AUTH_PASSWORD_BREACHED` (`details.occurrences`) · `429 RATE_LIMIT_EXCEEDED`.

---

### E2. `POST /auth/login`: sign in

**Body**

| Field | Type | Rules |
|---|---|---|
| `email` | string | valid email, ≤320 |
| `password` | string | non-empty, ≤1024. **Not** checked against the policy: old passwords must keep working |
| `organizationId` | uuid | optional and advisory. **Do not send it.** The workspace is chosen per request with `X-Organization-Id`. |

**200, response A (signed in):** same shape as E1's `201`, with the cookie set.
**200, response B (second factor needed):** no cookie.

```json
{
  "mfaRequired": true,
  "challenge": {
    "token": "eyJhbGciOiJIUzI1NiIs…",
    "expiresAt": "2026-09-29T20:40:02.388Z",
    "methods": ["totp", "recovery_code"]
  }
}
```

**Errors:** `401 AUTH_INVALID_CREDENTIALS` (wrong password *or* unknown email) ·
`403 ACCOUNT_LOCKED` (`details.lockedUntil`, ISO; returned from the 5th consecutive
failure and while locked, even with the right password) · `403 ACCOUNT_SUSPENDED` ·
`403 ACCOUNT_DEACTIVATED` · `422` · `429`.

Captured lockout sequence: attempts 1–4 → `401 AUTH_INVALID_CREDENTIALS`; attempt 5
→ `403 ACCOUNT_LOCKED { "lockedUntil": "2026-09-29T20:50:38.405Z" }` (15 minutes).

---

### E3. `POST /auth/mfa/verify`: finish sign-in with a code

**Body:** `challengeToken` (string, required, ≤2048) and **exactly one** of `code`
(six digits, regex `^\s*\d{3}\s?\d{3}\s*$`) or `recoveryCode` (string, ≤32).

**200:** same as E1 (`user` + `tokens`, cookie set). `user.mfaEnabled` is `true`.

**Errors:** `401 MFA_CODE_INVALID` (wrong or reused code; counts towards lockout) ·
`401 MFA_CHALLENGE_INVALID` (expired / already used / >5 wrong codes: message "Too
many wrong codes for this sign-in attempt. Sign in again.") · `403 ACCOUNT_LOCKED` ·
`403 ACCOUNT_SUSPENDED` · `422`.

---

### E4. `POST /auth/refresh`: rotate tokens

**Only the token manager calls this** (§4). `credentials: 'include'`, body `{}`. The
refresh token travels in the cookie (a body field `refreshToken` exists for
non-browser clients; do not use it).

**200**: sets a **new** `daiap_rt` cookie; the old one is now spent.

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "expiresAt": "2026-09-29T20:50:00.048Z",
  "refreshExpiresIn": 2592000
}
```

**Errors:** see §4.4. Captured: no cookie → `401 AUTH_TOKEN_MISSING` ("No refresh
token supplied…"); revoked session → `401 AUTH_TOKEN_REVOKED`; concurrent reuse →
`401 AUTH_REFRESH_TOKEN_REUSED`.

---

### E5. `POST /auth/logout`: sign out this browser

Bearer + `credentials: 'include'`, body `{}`.
**200** `{ "revokedSessions": 1 }`, and the cookie is cleared
(`daiap_rt=; Expires=Thu, 01 Jan 1970 …`). The presented access token is denylisted
immediately (`401 AUTH_TOKEN_REVOKED` afterwards, verified).
**Errors:** `401` if the access token is already invalid. The cleanup happens
anyway (§4.6).

---

### E6. `POST /auth/logout-all`: sign out every device

Bearer, no body. **200** `{ "revokedSessions": 2 }`, cookie cleared. Every access
token of the user stops working immediately.

---

### E7. `GET /auth/me`: the signed-in user

Bearer. Optional `X-Organization-Id` (UUID or slug) to also get your permissions in
that workspace. **200** without the header:

```json
{
  "id": "accef094-6999-46ea-aa1c-be644d08a724",
  "email": "employee@acme.test",
  "firstName": "Sara",
  "lastName": "Khan",
  "displayName": "Sara Khan",
  "emailVerified": true,
  "isPlatformAdmin": false,
  "status": "ACTIVE",
  "mfaEnabled": false,
  "avatarUrl": null,
  "memberships": [
    {
      "organizationId": "79b7a713-eaa2-47c0-b9d5-11e738780fe4",
      "organizationName": "Acme Corporation",
      "organizationSlug": "acme-corp",
      "roleSlugs": ["member"],
      "isOwner": false
    }
  ]
}
```

With `X-Organization-Id`, the same object plus:

```json
{
  "permissions": ["agent:execute", "agent:read", "clearance:internal", "conversation:delete", "…"],
  "activeOrganizationId": "79b7a713-eaa2-47c0-b9d5-11e738780fe4"
}
```

Notes:

- `displayName` is the chosen display name, else "first last", else the email.
- `status`: `PENDING` (email not verified yet), `ACTIVE`, `SUSPENDED`, `DEACTIVATED`.
- `memberships`: active memberships only, newest first, at most 100.
- `permissions`: concrete keys, sorted, wildcards expanded (the owner gets all 64).
- **Errors, only when a workspace is named:** the workspace access codes of §9.2
  (`404 ORGANIZATION_NOT_FOUND`, `403 MEMBERSHIP_SUSPENDED`, `IP_NOT_ALLOWED`,
  `MFA_REQUIRED`, `ACCOUNT_EMAIL_NOT_VERIFIED`, …).

---

### E8. `PATCH /auth/me`: update profile

Bearer. **Body** (all optional; send only the changed fields):

| Field | Rules |
|---|---|
| `firstName` | string, 1–100, trimmed |
| `lastName` | string, 1–100, trimmed |
| `displayName` | string, ≤255, trimmed. `""` falls back to the full name |
| `avatarUrl` | string, ≤2048; `""` removes it (see §7.12) |

`email` cannot be changed (`422` with key `email`).
**200** `{ "id": "…", "displayName": "Zara K." }`. Refetch E7 afterwards.

---

### E9. `POST /auth/verify-email`: confirm an address

Public. **Body** `{ "token": "<from the link>" }` (≤512).
**200** `{ "verified": true }`. The account becomes `ACTIVE` and `emailVerified`
becomes `true`.
**Errors:** `401 TOKEN_NOT_FOUND` · `401 TOKEN_EXPIRED` (links last 24 h) · `401
TOKEN_ALREADY_USED` (also returned for an older link after a newer one was sent).

---

### E10. `POST /auth/resend-verification`

Public. **Body** `{ "email": "…" }`. **200** `{ "sent": true }`, **always**,
whether or not the address exists or is already verified (anti-enumeration).
`429` after 5 per hour for that IP and email.

---

### E11. `POST /auth/forgot-password`

Public. **Body** `{ "email": "…" }`. **200** `{ "sent": true }`, **always**. The
link lasts 1 hour; a new request invalidates the previous link. `429` after 5 per
hour.

---

### E12. `POST /auth/reset-password`

Public. **Body** `{ "token": "…", "password": "<new, policy-checked>" }`.
**200** `{ "reset": true }`. **Every session is revoked** and the cookie cleared; a
"password changed" email is sent.
**Errors:** `401 TOKEN_NOT_FOUND` / `TOKEN_EXPIRED` / `TOKEN_ALREADY_USED` · `422
VALIDATION_FAILED` (key `password`) · `422 AUTH_PASSWORD_BREACHED` (the link stays
usable).

---

### E13. `POST /auth/change-password`

Bearer + `credentials: 'include'`. **Body**
`{ "currentPassword": "…", "newPassword": "…" }`.
**200** `{ "changed": true, "revokedSessions": 1 }`. Other devices are signed out,
this device's session is kept, and **the current access token stops working
immediately** (`401 AUTH_TOKEN_REVOKED`, verified). Follow §4.7: refresh right away;
the new token works at once.
**Errors** (checked in this order): `422 VALIDATION_FAILED` (new password vs policy)
· `401 AUTH_PASSWORD_MISMATCH` · `400 AUTH_PASSWORD_REUSED` · `422
AUTH_PASSWORD_BREACHED`.

---

### E14. `GET /auth/sessions`: signed-in devices

Bearer. **200**, one entry per device (rotations collapsed), newest first:

```json
[
  {
    "id": "0bcc1dbe-0031-46a7-825f-0799169b38ae",
    "deviceLabel": "Chrome on Windows",
    "ipAddress": "127.0.0.1",
    "createdAt": "2026-09-29T20:35:00.031Z",
    "lastUsedAt": "2026-09-29T20:35:00.033Z",
    "expiresAt": "2026-10-29T20:35:00.031Z",
    "isCurrent": true
  }
]
```

`deviceLabel` and `ipAddress` may be `null`. The label is derived from the
User-Agent: "Unknown browser on Unknown OS" for non-browsers.

---

### E15. `DELETE /auth/sessions/{sessionId}`: sign a device out

Bearer. `sessionId` must be a UUID v4 (else `400 BAD_REQUEST` "Validation failed
(uuid v 4 is expected)").
**200** `{ "revoked": 1 }`. **Errors:** `404 AUTH_SESSION_NOT_FOUND`.
The revoked device keeps working until its access token expires (≤15 min, verified),
then its refresh fails with `AUTH_TOKEN_REVOKED`.

---

### E16. `GET /auth/mfa`: two-step verification status

Bearer. **200**:

```json
{ "enabled": true, "enrolledAt": "2026-09-29T20:35:02.193Z",
  "recoveryCodesRemaining": 10, "sessionVerified": true }
```

`sessionVerified`: whether **this** session passed a second factor (needed for
workspaces that require MFA). When disabled: `enabled: false, enrolledAt: null,
recoveryCodesRemaining: 0`.

---

### E17. `POST /auth/mfa/setup`: start enrolment

Bearer. **Body** `{ "password": "…" }`. **200**:

```json
{
  "secret": "2H7HU4BW3COZVOY2TJ4ZOHXKM3RCQVUR",
  "otpauthUri": "otpauth://totp/DAIAP:zara%40example.com?secret=2H7H…&issuer=DAIAP&algorithm=SHA1&digits=6&period=30",
  "issuer": "DAIAP",
  "account": "zara@example.com"
}
```

Nothing is enabled yet. **Errors:** `401 AUTH_PASSWORD_MISMATCH` · `409
MFA_ALREADY_ENABLED`.

---

### E18. `POST /auth/mfa/enable`: confirm the first code

Bearer. **Body** `{ "code": "492039" }`. **200**:

```json
{
  "recoveryCodes": ["maf8v-tpmpr", "ynj6h-99ehf", "85t3z-x79xj", "xsexm-kzzv2", "rj8xr-zsf66",
                    "bmhce-j9kxh", "2458d-ght2p", "bc8qg-t7qrb", "emx9n-mnavk", "3mwve-ywam9"],
  "accessToken": "eyJhbGciOiJIUzI1NiIs…",
  "expiresIn": 900
}
```

Replace the in-memory token with `accessToken` (MFA-verified). Every other device is
signed out; a security email is sent. **Errors:** `401 MFA_CODE_INVALID` · `409
MFA_ALREADY_ENABLED` · `409 MFA_NOT_ENROLLING` (setup not started).

---

### E19. `POST /auth/mfa/disable`

Bearer. **Body** `{ "password": "…", "code": "123456" }` or
`{ "password": "…", "recoveryCode": "xxxxx-xxxxx" }`. **200** `{ "disabled": true }`.
**Errors:** `401 AUTH_PASSWORD_MISMATCH` · `401 MFA_CODE_INVALID` · `409
MFA_NOT_ENABLED`.

---

### E20. `POST /auth/mfa/recovery-codes`: replace recovery codes

Bearer. **Body** `{ "password": "…", "code": "123456" }` (authenticator code only).
**200** `{ "recoveryCodes": [ …10 codes… ] }`; the old codes stop working.
**Errors:** `401 AUTH_PASSWORD_MISMATCH` · `401 MFA_CODE_INVALID` · `409
MFA_NOT_ENABLED`.

---

### E21. `GET /auth/me/export`: download personal data

Bearer. **200 is a file, not an envelope:** `Content-Type: application/json`,
`Content-Disposition: attachment; filename="personal-data-2026-09-29.json"`,
`Cache-Control: no-store`. Top-level keys: `format, generatedAt, notice, account,
memberships, devices, conversations, workflowRuns, apiKeys, usage, activity,
truncated`. Errors are enveloped JSON. `429` after 5 per hour.

---

### E22. `DELETE /auth/me`: erase the account

Bearer. **JSON body** (yes, on a DELETE):

| Field | Rules |
|---|---|
| `password` | required |
| `code` / `recoveryCode` | one of them required **if** MFA is enabled |
| `confirmation` | must equal `ERASE MY ACCOUNT` exactly |

**200**:

```json
{ "erased": true, "workspacesDeleted": ["3281da6b-8212-4b25-836c-ddb7620165a1"],
  "conversationsShredded": 0, "workflowRunsShredded": 0,
  "apiKeysRevoked": 0, "membershipsEnded": 0 }
```

Afterwards every token of the user is revoked. **Errors:** `401
AUTH_PASSWORD_MISMATCH` · `401 MFA_CODE_INVALID` · `403 ACCOUNT_ERASURE_DISABLED` ·
`409 ACCOUNT_ERASURE_BLOCKED` with
`details.workspaces: [{ id, name, otherMembers }]` · `422 VALIDATION_FAILED`
(`"confirmation must be exactly \"ERASE MY ACCOUNT\"."`).

---

### E23. `GET /organizations`: my workspaces

Bearer; no `X-Organization-Id`. **Query:** `page` (≥1, default 1), `limit` (1–100,
default 20). There is no search on this endpoint.
**200** (paginated, newest membership first):

```json
[
  {
    "id": "79b7a713-eaa2-47c0-b9d5-11e738780fe4",
    "name": "Acme Corporation",
    "slug": "acme-corp",
    "description": "Demonstration workspace showcasing multi-tenant RBAC.",
    "logoUrl": null,
    "status": "ACTIVE",
    "plan": "FREE",
    "ownerId": "90f0f95b-c908-474f-aa65-3a0957d0020f",
    "settings": {},
    "ipAllowlistEnabled": false,
    "memberCount": 5,
    "createdAt": "2026-09-29T20:31:26.473Z",
    "roleSlugs": ["member"],
    "isOwner": false,
    "joinedAt": "2026-09-29T20:31:26.817Z"
  }
]
```

`meta.pagination` as in §3.2.

---

### E24. `POST /organizations`: create a workspace

Bearer; no `X-Organization-Id`. **Body:**

| Field | Rules |
|---|---|
| `name` | required, 2–120, trimmed |
| `slug` | optional, 2–60, regex `^[a-z0-9][a-z0-9-]*[a-z0-9]$`, not reserved. Derived from the name when omitted; a random suffix is added if taken. |
| `description` | optional, ≤2000 |

**201**: an `Organization` (the same object as E23 without `roleSlugs`, `isOwner`,
`joinedAt`), with `memberCount: 1`, `settings: {}`, `status: "ACTIVE"`,
`plan: "FREE"`.
**Errors:** `403 ORGANIZATION_LIMIT_REACHED` (`details: { limit, current }`, default
limit 5 owned workspaces) · `409 ORGANIZATION_SLUG_RESERVED` (`details.slug`) · `409
ORGANIZATION_SLUG_TAKEN` (rare: five random suffixes collided) · `422`.

---

### E25. `GET /organizations/{organizationId}`: workspace details

Bearer + `X-Organization-Id` (same UUID as the path). **Permission:
`workspace:read`**. **200:** an `Organization`. Use it for the Home page (name,
description, member count, `settings.requireMfa`). Call it only when
`can('workspace:read')`; otherwise use the membership data.
**Errors:** workspace access codes (§9.2) · `403 PERMISSION_DENIED`.

---

### E26. `GET /organizations/{organizationId}/members/me`: my membership

Bearer + `X-Organization-Id`. **No permission required.** Your roles and rank
(`highestRolePriority`) in the workspace. **200:**

```json
{
  "id": "95b8d7df-f3b8-4fd6-ab27-0f255e663104",
  "userId": "accef094-6999-46ea-aa1c-be644d08a724",
  "email": "employee@acme.test",
  "firstName": "Sara",
  "lastName": "Khan",
  "displayName": "Sara Khan",
  "avatarUrl": null,
  "title": "Operations Analyst",
  "status": "ACTIVE",
  "roles": [
    { "id": "246ba69f-af09-4eef-9e82-a8ceee18d406", "name": "Member",
      "slug": "member", "color": null, "priority": 50 }
  ],
  "highestRolePriority": 50,
  "isOwner": false,
  "joinedAt": "2026-09-29T20:31:26.817Z",
  "lastActiveAt": null,
  "createdAt": "2026-09-29T20:31:26.817Z"
}
```

`id` is the **membership** id, not the user id. `displayName` here may be a
workspace-specific name. `status`: `ACTIVE` | `SUSPENDED` | `REMOVED`.
**Errors:** workspace access codes (§9.2).

---

### E27. `GET /organizations/{organizationId}/roles`: roles (used from Phase 2)

Bearer + `X-Organization-Id`. **Permission: `role:read`.** **200** (sorted by
priority, descending):

```json
[
  { "id": "0f11d23d-…", "name": "Owner", "slug": "owner", "description": "…",
    "isSystem": true, "isDefault": false, "priority": 100, "color": null,
    "permissionKeys": ["*:*"], "createdAt": "…" },
  { "id": "c80992cd-…", "name": "Member", "slug": "member", "description": "…",
    "isSystem": true, "isDefault": true, "priority": 50, "color": null,
    "permissionKeys": ["workspace:read", "member:read", "role:read", "…"], "createdAt": "…" }
]
```

Phase 1 does not need it; Phase 2 uses it for the roles screen.

---

### E28. `GET /permissions`: permission catalogue

Bearer; no workspace. **200:**

```json
{
  "permissions": [
    { "key": "workspace:read", "resource": "workspace", "action": "read",
      "category": "workspace", "description": "View workspace details and settings.",
      "isDangerous": false, "phase": 1 }
  ],
  "byCategory": { "workspace": ["workspace:read", "workspace:update", "…"], "…": [] }
}
```

64 permissions; categories: `workspace, members, access_control, security,
observability, knowledge, clearance, agents, workflows, tools, privacy`. Cache for the
whole session (staleTime: Infinity).

---

### E29. `GET /health/live`: liveness (optional)

Public, **no `/api/v1` prefix**. **200** (enveloped):
`{ "status": "ok", "uptime": 111, "environment": "development", "timestamp": "…" }`.

---

## 9. Error codes Phase 1 must handle

### 9.1 Anywhere

| HTTP | Code | Handling |
|---|---|---|
| 401 | `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_REVOKED` | Token manager: refresh once and retry once (§4.3), then sign out |
| 401 | `ACCOUNT_SUSPENDED` | Returned for any token of an account that can no longer sign in. Sign out with the message. |
| 403 | `ACCOUNT_EMAIL_NOT_VERIFIED` | Deployment-wide requirement (no `details`): the "Verify your email" screen (§7.6). With `details.requiredBy: "workspace"`: see §9.2 |
| 400 | `BAD_REQUEST` | Client bug (for example a malformed UUID in the path). Generic toast. |
| 404 | `RESOURCE_NOT_FOUND` | Unknown API route: client bug. Generic toast. |
| 408 | `REQUEST_TIMEOUT` | "The request took too long. Try again." |
| 422 | `VALIDATION_FAILED` | Field errors (§3.3) |
| 429 | `RATE_LIMIT_EXCEEDED` | Countdown from `Retry-After` / `details.retryAfterSeconds`. Never a sign-out. |
| 500 | `INTERNAL_SERVER_ERROR` | "Something went wrong" + request id |
| 503 | `SERVICE_UNAVAILABLE` | "Temporarily unavailable" + retry |

### 9.2 On workspace-scoped requests (`X-Organization-Id` present)

| HTTP | Code | `details` | Handling |
|---|---|---|---|
| 400 | `ORGANIZATION_CONTEXT_REQUIRED` | — | Client bug: the header is missing |
| 404 | `ORGANIZATION_NOT_FOUND` | — | "Workspace not found" state (§7.11). Also returned when you are not a member. |
| 403 | `ORGANIZATION_SUSPENDED` | `{ reason? }` | §7.11 |
| 403 | `MEMBERSHIP_SUSPENDED` | `{ reason? }` | §7.11 |
| 403 | `IP_NOT_ALLOWED` | — | §7.11 |
| 403 | `MFA_REQUIRED` | `{ requiredBy: "workspace" \| "platform" }` | §7.11 |
| 403 | `ACCOUNT_EMAIL_NOT_VERIFIED` | `{ requiredBy: "workspace" }` | §7.11 |
| 403 | `PERMISSION_DENIED` | `{ missingPermissions: string[] }` | Toast "You don't have permission ({missing})"; refetch permissions |

### 9.3 Endpoint-specific codes in Phase 1

`ACCOUNT_ALREADY_EXISTS`, `AUTH_INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`,
`ACCOUNT_DEACTIVATED`, `AUTH_PASSWORD_MISMATCH`, `AUTH_PASSWORD_REUSED`,
`AUTH_PASSWORD_BREACHED`, `AUTH_REFRESH_TOKEN_INVALID`, `AUTH_REFRESH_TOKEN_REUSED`,
`AUTH_SESSION_NOT_FOUND`, `TOKEN_NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_ALREADY_USED`,
`MFA_CODE_INVALID`, `MFA_CHALLENGE_INVALID`, `MFA_ALREADY_ENABLED`,
`MFA_NOT_ENABLED`, `MFA_NOT_ENROLLING`, `ACCOUNT_ERASURE_BLOCKED`,
`ACCOUNT_ERASURE_DISABLED`, `ORGANIZATION_LIMIT_REACHED`,
`ORGANIZATION_SLUG_RESERVED`, `ORGANIZATION_SLUG_TAKEN`. Each is covered on its
screen in §7 and its endpoint in §8.

Swagger also lists `AUTH_PASSWORD_TOO_WEAK`. The server never sends it: weak
passwords come back as `422 VALIDATION_FAILED`.

Keep an `ErrorCode` union type (Appendix A) and a single `messageFor(error)` helper
that falls back to `error.message`.

---

## 10. Client-side validation rules

Mirror the server so users see problems before submitting. The server still
validates everything.

**Email:** a valid email, ≤320 characters, trimmed.

**Password policy** (sign-up, reset, change; defaults of this deployment):

| Rule | Message to show |
|---|---|
| length ≥ 12 | "At least 12 characters" |
| length ≤ 128 | "No more than 128 characters" |
| contains `[a-z]` | "A lowercase letter" |
| contains `[A-Z]` | "An uppercase letter" |
| contains a digit | "A number" |
| not in the common list (for example `password123`, `qwerty123`, `letmein`, `welcome123`, `admin123`, `changeme`) | "Not a common password" |
| no character repeated 4+ times in a row (`aaaa`) | "No long runs of the same character" |
| no ascending or descending run of 5 (`12345`, `abcde`, `edcba`, case-insensitive) | "No sequences like 12345 or abcde" |
| sign-up only: must not contain the first name, the last name, or the email's local part or any of its pieces (split on non-alphanumerics), for pieces of 3+ characters, case-insensitive | "Must not contain your name or email" |

A symbol is **not** required. Show the rules as a live checklist.

**Strength meter** (same scoring as the server, 0–4): +1 at length ≥12, +1 at ≥16,
+1 at ≥20, +1 if it uses ≥3 of the classes {lower, upper, digit, symbol}; 0 if
common; capped at 4.

**Breach check:** the server additionally rejects passwords found in known breaches
(Have I Been Pwned). The client cannot know this in advance; handle
`AUTH_PASSWORD_BREACHED`.

**Names:** first and last name required, ≤100. Display name ≤255.

**Workspace:** name 2–120; description ≤2000; slug 2–60 matching
`^[a-z0-9][a-z0-9-]*[a-z0-9]$`, and not one of: `admin, api, app, assets, auth,
billing, dashboard, docs, health, internal, login, logout, metrics, new, platform,
public, register, root, settings, signup, static, status, support, system, www`.

**Slug preview from the name** (same as the server): NFKD normalise, strip combining
marks, lowercase, replace runs of non `[a-z0-9]` with `-`, trim `-` at both ends, cut
to 60, trim a trailing `-`. If the result is shorter than 2 characters, leave the
slug empty and let the server generate one.

**Codes:** authenticator code `^\s*\d{3}\s?\d{3}\s*$`; recovery code ≤32 characters
(format `xxxxx-xxxxx`).

---

## 11. State, caching and query keys

**Session store (client state):** `status: 'restoring' | 'authenticated' |
'unauthenticated'`, plus a `signOutReason` for the sign-in banner. The access token
lives inside the token manager module, **not** in React state or devtools-visible
stores.

**Server state (TanStack Query):**

| Key | Source | Notes |
|---|---|---|
| `['me']` | E7 | staleTime 60 s; invalidate after profile, verify-email, workspace create |
| `['mfa']` | E16 | invalidate after every MFA action |
| `['sessions']` | E14 | |
| `['workspaces', page]` | E23 | |
| `['permission-catalogue']` | E28 | staleTime Infinity |
| `['ws', workspaceId, 'membership']` | E26 | the gate's access probe |
| `['ws', workspaceId, 'details']` | E25 | only if `workspace:read` |
| `['ws', workspaceId, 'permissions']` | §5.2 | staleTime 60 s; refetch on `PERMISSION_DENIED` |

**Every workspace-scoped key starts with `['ws', workspaceId]`.** Later phases must
follow the same rule, which keeps cached data from leaking between workspaces.

**On sign-out:** `queryClient.clear()`.

**Retries:** do not let TanStack Query retry `4xx` responses. Retry `5xx` and network
errors at most twice. Auth-related `401`s are handled by the token manager, not by
query retries.

**localStorage keys** (non-sensitive only; wrap every access in `try/catch`):
`av.hasSession` (`'1'`), `av.lastWorkspace` (slug), `av.sidebarCollapsed`. Never
store tokens.

---

## 12. Visual design

Take the look from the mockups: dark, high-contrast, with purple and teal accents.
The token values below are sampled from the mockups; tune them by eye.

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0A0A10` | page background (subtle grid pattern on the auth page) |
| `--surface` | `#12121A` | cards, sidebar |
| `--surface-2` | `#181824` | inputs, hovered rows |
| `--border` | `#23232F` | card and input borders |
| `--text` | `#F4F4F7` | primary text |
| `--text-muted` | `#8B8BA3` | labels, secondary text |
| `--primary` | `#7C5CFF` (gradient to `#6366F1`) | primary buttons ("Sign in to workspace"), focus rings, active tab |
| `--accent` | `#10D9A0` (gradient to `#22D3EE`) | logo, success, "+ New Agent" style buttons |
| `--warning` | `#F97316` | warnings (few recovery codes left) |
| `--danger` | `#EF4444` | destructive actions, errors |
| `--success` | `#10B981` | verified badges |
| Radius | 10–12 px on cards, 8 px on inputs and buttons | |
| Font | Inter (UI); JetBrains Mono (secrets, recovery codes, request ids) | |

Labels are small uppercase with letter-spacing ("WORK EMAIL", "PASSWORD"), as in the
mockups. Buttons are uppercase with an arrow on the primary auth action. Define the
colours as CSS variables so a light theme can be added later.

Accessibility: every input has a visible label, error text is linked with
`aria-describedby`, focus is visible, and dialogs trap focus (Radix does this).
Contrast of `--text-muted` on `--surface` must stay ≥4.5:1.

---

## 13. Local development against the backend

1. Run the backend as its README describes (`npm run start:dev`, port 3000).
   Seed the demo workspace with `SEED_DEMO_DATA=true npm run seed`.
2. In the **backend** `.env`, for development only:
   ```ini
   MAIL_TRANSPORT=log           # emails are printed to the backend console instead of sent
   FRONTEND_URL=http://localhost:5173
   ```
3. **Email links in development:** with `MAIL_TRANSPORT=log` the backend terminal
   prints a block titled `OUTBOUND EMAIL (not actually sent — MAIL_TRANSPORT=log)`
   containing the full link, for example
   `http://localhost:5173/auth/verify-email?token=…`. Open it in the browser to test
   §7.5 and §7.6.
4. **Demo accounts** (password `Demo-Workspace-2026!` for all), workspace
   `acme-corp`:

   | Email | Role | Good for testing |
   |---|---|---|
   | `owner@acme.test` | Owner | everything visible |
   | `admin@acme.test` | Administrator | nearly everything |
   | `hr@acme.test` | HR Manager (custom) | custom-role permissions |
   | `employee@acme.test` | Member | no Audit Logs |
   | `auditor@acme.test` | Compliance Auditor (custom) | Audit Logs visible, no Settings changes |

5. **Authenticator for MFA testing:** any TOTP app (Google Authenticator, Microsoft
   Authenticator, 1Password), or a browser TOTP extension.
6. Swagger UI at `http://localhost:3000/docs` is useful for poking at endpoints; the
   `persistAuthorization` option keeps your token between page loads.

---

## 14. Backend fixes of 2026-09-30 (what changed for the frontend)

Writing this specification uncovered five backend issues. All were fixed in the backend
on 2026-09-30 and re-verified against a running server. This document already
describes the fixed behaviour; the table is for anyone who started from an earlier
copy.

| # | Was | Now | Frontend impact |
|---|---|---|---|
| BF-1 | `GET /auth/me` never returned `permissions` or `activeOrganizationId` | Returned when `X-Organization-Id` is sent, with the full workspace checks | Load permissions from `/auth/me` (§5.2). The earlier fallback (members/me + roles + catalogue + client-side wildcard expansion) still works but can be deleted |
| BF-2 | Every rate-limit bucket was per IP; `refresh`, `change-password` and `mfa/*` shared 10 requests / 15 min per IP | Signed-in traffic is counted per user; `refresh` has its own policy, 60 / 15 min per session (§3.6) | None required. `THROTTLE_AUTH_LIMIT=200` is no longer needed in development |
| BF-3 | A refresh in the same second as a password change returned an already-revoked token | Tokens carry a millisecond issue time; an immediate refresh works | The 1.1 s delay is gone: after a password change, `expireAccessToken()` then `refreshAccessToken()` (§4.7) |
| BF-4 | Validation errors were keyed by the first word of the message (`Password`, `That`, `property`) | Keyed by property path (`password`, `newPassword`, `settings.defaultChunkSize`); unknown fields under their own name (§3.3) | Map keys to fields directly; the special cases can be deleted |
| BF-5 | `GET /auth/me` omitted `mfaEnabled` and `avatarUrl` | Both returned | `avatarUrl` can be shown (§7.12); `GET /auth/mfa` is still the source for `sessionVerified` |

## 15. Definition of done

Functional:

- [ ] Sign up → signed in → create workspace → lands in `/w/{slug}`, with the
      unverified-email banner visible.
- [ ] Verify-email link from the backend console → verified; the banner disappears.
      Opening the same link again shows "no longer valid" (not a crash). The page
      does not show an error in StrictMode.
- [ ] Sign in with a wrong password four times → error each time; the fifth time →
      locked message with the unlock time.
- [ ] Forgot password → link → reset → old sessions gone → sign in with the new
      password works; the old password fails.
- [ ] Enable MFA (QR scans in a real authenticator app), save recovery codes; sign
      out; sign in → code step → success. Sign in with a recovery code → success;
      the remaining count drops. Disable MFA.
- [ ] Change password: other devices signed out; this device **stays signed in**
      and keeps working, including a second tab of the same browser.
- [ ] Devices list shows the current device and at least one other browser; signing
      the other browser out works and it is signed out at its next refresh.
- [ ] Sign out everywhere works across two browsers.
- [ ] Workspace switcher lists every membership; switching changes the URL, the
      header and the data, with nothing from the previous workspace left on screen.
- [ ] Reloading `/w/{slug}/...` restores the session and returns to the same page.
- [ ] As `employee@acme.test`: Audit Logs hidden. As `auditor@acme.test`: Audit Logs
      visible. As `owner@acme.test`: everything visible.
- [ ] Visiting `/w/some-other-tenant` → "Workspace not found".
- [ ] Setting `requireMfa` on a workspace (via Swagger, as its owner with an
      MFA-verified session) → a member without MFA sees the "Two-step verification
      required" state.
- [ ] Download my data saves a `.json` file with the server's filename.
- [ ] Erase account: blocked when owning a shared workspace (lists them); succeeds
      otherwise and lands on `/goodbye`.

Resilience (these catch the expensive bugs):

- [ ] **StrictMode on:** a hard reload makes exactly **one** `POST /auth/refresh`
      (check the Network tab).
- [ ] **Two tabs:** open 3 tabs of the app and reload them all. The backend log shows
      **no** `AUTH_REFRESH_TOKEN_REUSED`, and no tab is signed out.
- [ ] Let a token expire (or shorten `JWT_ACCESS_TTL=1m` in the backend for the
      test) with several queries on screen: they all succeed after **one** refresh.
- [ ] Anonymous visit to `/auth/sign-in` makes **no** refresh call.
- [ ] A `401 AUTH_INVALID_CREDENTIALS` or `AUTH_PASSWORD_MISMATCH` never triggers a
      refresh or a sign-out.
- [ ] With the backend stopped: the offline banner shows, the user is not signed out,
      and everything recovers when it comes back.
- [ ] A forced `429` on refresh (backend `THROTTLE_REFRESH_LIMIT=1`): the
      "Too many requests" screen shows a countdown and does not sign the user out.
- [ ] No access or refresh token in localStorage, sessionStorage, the URL or console
      logs.
- [ ] Error toasts show the request id.

Quality:

- [ ] TypeScript strict, no `any` in the API layer; lint clean.
- [ ] Unit tests: the validation-error mapper, the password rule checker, the token
      manager's single-flight behaviour (MSW).
- [ ] Every screen in §7 has loading, error and empty states.
- [ ] Keyboard-only walkthrough of sign-in, MFA and the account pages works.

---

## Appendix A: TypeScript types

```ts
// ── Envelope ────────────────────────────────────────────────────────────────
export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  durationMs?: number;
  path?: string; // failures only
  pagination?: PaginationMeta;
}
export interface PaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}
export interface ApiSuccess<T> { success: true; data: T; meta: ResponseMeta }
export interface ApiFailure {
  success: false;
  error: { code: ErrorCode | string; message: string; details?: Record<string, unknown> };
  meta: ResponseMeta;
}
export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

// ── Auth ────────────────────────────────────────────────────────────────────
export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  status: UserStatus;
  mfaEnabled: boolean;
}
export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;        // seconds (900)
  expiresAt: string;        // ISO. Prefer Date.now() + expiresIn*1000
  refreshExpiresIn: number; // seconds (2592000)
  refreshToken?: string;    // absent when the cookie is enabled (default)
}
export interface AuthResponse { user: AuthUser; tokens: TokenPair }
export interface MfaChallenge {
  token: string;
  expiresAt: string;
  methods: Array<'totp' | 'recovery_code'>;
}
export interface MfaRequiredResponse { mfaRequired: true; challenge: MfaChallenge }
export type LoginResponse = AuthResponse | MfaRequiredResponse;
export const isMfaRequired = (r: LoginResponse): r is MfaRequiredResponse =>
  'mfaRequired' in r && r.mfaRequired === true;

export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  roleSlugs: string[];
  isOwner: boolean;
}
export interface CurrentUser extends AuthUser {
  avatarUrl: string | null;
  memberships: MembershipSummary[];
  permissions?: string[];        // present when X-Organization-Id is sent: concrete keys
  activeOrganizationId?: string; // present when X-Organization-Id is sent
}
export interface UpdateProfileRequest {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  avatarUrl?: string;
}
export interface Session {
  id: string;
  deviceLabel: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  isCurrent: boolean;
}
export interface MfaStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  sessionVerified: boolean;
}
export interface MfaSetup { secret: string; otpauthUri: string; issuer: string; account: string }
export interface MfaEnableResponse { recoveryCodes: string[]; accessToken?: string; expiresIn?: number }
export type SecondFactor = { code: string } | { recoveryCode: string };
export interface ErasureOutcome {
  erased: true;
  workspacesDeleted: string[];
  conversationsShredded: number;
  workflowRunsShredded: number;
  apiKeysRevoked: number;
  membershipsEnded: number;
}

// ── Workspaces ──────────────────────────────────────────────────────────────
export interface OrganizationSettings {
  defaultChunkSize?: number;
  defaultChunkOverlap?: number;
  auditRetentionDays?: number;
  requireMfa?: boolean;
  requireVerifiedEmail?: boolean;
  allowedEmailDomains?: string[];
}
export interface Organization {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  plan: 'FREE' | 'PRO' | 'ENTERPRISE';
  ownerId: string;
  settings: OrganizationSettings;
  ipAllowlistEnabled: boolean;
  memberCount: number;
  createdAt: string;
}
export interface OrganizationWithMembership extends Organization {
  roleSlugs: string[];
  isOwner: boolean;
  joinedAt: string | null;
}
export interface CreateOrganizationRequest { name: string; slug?: string; description?: string }

export interface MemberRole { id: string; name: string; slug: string; color: string | null; priority: number }
export interface Member {
  id: string; // membership id
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  avatarUrl: string | null;
  title: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  roles: MemberRole[];
  highestRolePriority: number;
  isOwner: boolean;
  joinedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
}
export interface Role {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isSystem: boolean;
  isDefault: boolean;
  priority: number;
  color: string | null;
  permissionKeys: string[];
  createdAt: string;
}
export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  category: string;
  description: string;
  isDangerous: boolean;
  phase: 1 | 2 | 3 | 4 | 5;
}
export interface PermissionCatalogue {
  permissions: PermissionDefinition[];
  byCategory: Record<string, string[]>;
}

// ── Error codes used in Phase 1 (full list: backend src/common/enums/error-code.enum.ts) ──
export type ErrorCode =
  | 'INTERNAL_SERVER_ERROR' | 'SERVICE_UNAVAILABLE' | 'BAD_REQUEST' | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND' | 'RESOURCE_CONFLICT' | 'REQUEST_TIMEOUT'
  | 'AUTH_INVALID_CREDENTIALS' | 'AUTH_TOKEN_MISSING' | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOKEN_EXPIRED' | 'AUTH_TOKEN_REVOKED' | 'AUTH_REFRESH_TOKEN_INVALID'
  | 'AUTH_REFRESH_TOKEN_REUSED' | 'AUTH_SESSION_NOT_FOUND' | 'AUTH_PASSWORD_MISMATCH'
  | 'AUTH_PASSWORD_REUSED' | 'AUTH_PASSWORD_BREACHED'
  | 'MFA_CODE_INVALID' | 'MFA_CHALLENGE_INVALID' | 'MFA_ALREADY_ENABLED'
  | 'MFA_NOT_ENABLED' | 'MFA_NOT_ENROLLING' | 'MFA_REQUIRED'
  | 'ACCOUNT_ALREADY_EXISTS' | 'ACCOUNT_EMAIL_NOT_VERIFIED' | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_DEACTIVATED' | 'ACCOUNT_LOCKED'
  | 'TOKEN_NOT_FOUND' | 'TOKEN_EXPIRED' | 'TOKEN_ALREADY_USED'
  | 'FORBIDDEN' | 'PERMISSION_DENIED'
  | 'ORGANIZATION_CONTEXT_REQUIRED' | 'ORGANIZATION_NOT_FOUND' | 'ORGANIZATION_SLUG_TAKEN'
  | 'ORGANIZATION_SLUG_RESERVED' | 'ORGANIZATION_SUSPENDED' | 'ORGANIZATION_LIMIT_REACHED'
  | 'IP_NOT_ALLOWED' | 'MEMBERSHIP_SUSPENDED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'ACCOUNT_ERASURE_BLOCKED' | 'ACCOUNT_ERASURE_DISABLED'
  | 'NETWORK_ERROR'; // client-side only: fetch threw
```

---

## Appendix B: reference implementation of the API client and token manager

This is working reference code, not pseudo-code. Adapt it to your structure, but keep
the behaviour.

### `lib/api/errors.ts`

```ts
import type { ErrorCode, ResponseMeta } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,              // 0 for network errors
    readonly code: ErrorCode | string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  /**
   * `details.fields` from a 422 (§3.3): one message per property path. Map keys to
   * form fields by name; show keys that match no field as a form-level error.
   */
  fieldErrors(): Record<string, string> {
    const fields = (this.details?.fields ?? {}) as Record<string, string[]>;
    return Object.fromEntries(
      Object.entries(fields).map(([path, messages]) => [path, messages.join(' ')]),
    );
  }
}

export const REFRESHABLE_401 = new Set([
  'AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_REVOKED', 'AUTH_TOKEN_INVALID', 'AUTH_TOKEN_MISSING',
]);

export async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; details?: Record<string, unknown> }; meta?: ResponseMeta }
    | null;
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  return new ApiError(
    res.status,
    body?.error?.code ?? (res.status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST'),
    body?.error?.message ?? res.statusText,
    body?.error?.details,
    body?.meta?.requestId ?? res.headers.get('x-request-id') ?? undefined,
    retryAfter,
  );
}
```

### `lib/api/token-manager.ts`

```ts
import { ApiError, toApiError } from './errors';

const API = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const LOCK = 'agentvault:refresh';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('agentvault:auth') : null;

type Msg =
  | { type: 'token'; accessToken: string; expiresAt: number }
  | { type: 'token-request' }
  | { type: 'signed-out'; reason?: string };

let accessToken: string | null = null;
let expiresAt = 0;
let generation = 0; // bumps whenever the token changes (here or in another tab)
let inFlight: Promise<string | null> | null = null;
let onSignedOut: ((reason?: string) => void) | null = null;

export function onSessionEnded(handler: (reason?: string) => void) { onSignedOut = handler; }

const fresh = (marginMs: number) => !!accessToken && expiresAt - Date.now() > marginMs;

export function installToken(token: string, expiresInSeconds: number, broadcast = true) {
  accessToken = token;
  expiresAt = Date.now() + expiresInSeconds * 1000;
  generation += 1;
  if (broadcast) channel?.postMessage({ type: 'token', accessToken: token, expiresAt } satisfies Msg);
}

export function endSession(reason?: string, broadcast = true) {
  accessToken = null;
  expiresAt = 0;
  generation += 1;
  try { localStorage.removeItem('av.hasSession'); } catch { /* storage unavailable */ }
  if (broadcast) channel?.postMessage({ type: 'signed-out', reason } satisfies Msg);
  onSignedOut?.(reason);
}

/**
 * After a successful change-password (§4.7): the token in memory is already dead,
 * so stop handing it out. Follow with refreshAccessToken().
 */
export function expireAccessToken() {
  expiresAt = 0;
}

channel?.addEventListener('message', (event: MessageEvent<Msg>) => {
  const msg = event.data;
  if (msg.type === 'token') {
    accessToken = msg.accessToken;
    expiresAt = msg.expiresAt;
    generation += 1;
  } else if (msg.type === 'signed-out') {
    endSession(msg.reason, false);
  } else if (msg.type === 'token-request' && fresh(60_000)) {
    channel.postMessage({ type: 'token', accessToken: accessToken!, expiresAt } satisfies Msg);
  }
});

function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request(LOCK, fn) as Promise<T>) : fn();
}

/** The only function that calls POST /auth/refresh. */
export function refreshAccessToken(): Promise<string | null> {
  if (inFlight) return inFlight;
  const seen = generation;
  inFlight = withCrossTabLock(async () => {
    // Another tab refreshed while this one waited for the lock: reuse its token.
    if (generation !== seen && fresh(30_000)) return accessToken;

    let res: Response;
    try {
      res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', "Can't reach AgentVault."); // keep the session
    }
    if (res.ok) {
      const { data } = await res.json();
      installToken(data.accessToken, data.expiresIn);
      return data.accessToken as string;
    }
    const error = await toApiError(res);
    if (res.status === 429 || res.status >= 500) throw error; // transient: never sign out
    endSession(error.code);                                   // §4.4
    return null;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

/** A token that is valid for at least 30 more seconds, or null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  if (fresh(30_000)) return accessToken;
  return refreshAccessToken();
}

/** App boot (§4.5). Returns true when a session exists. */
export async function restoreSession(): Promise<boolean> {
  let hasSession = false;
  try { hasSession = localStorage.getItem('av.hasSession') === '1'; } catch { hasSession = true; }
  if (!hasSession) return false;

  if (channel) {
    const shared = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 150);
      const listener = (e: MessageEvent<Msg>) => {
        if (e.data.type === 'token') { clearTimeout(timer); channel.removeEventListener('message', listener); resolve(true); }
      };
      channel.addEventListener('message', listener);
      channel.postMessage({ type: 'token-request' } satisfies Msg);
    });
    if (shared && fresh(30_000)) return true;
  }
  if (fresh(30_000)) return true; // a token may have arrived just after the 150 ms window
  return (await refreshAccessToken()) !== null;
}

/** Call after any successful sign-in (E1, E2 response A, E3). */
export function startSession(tokens: { accessToken: string; expiresIn: number }) {
  try { localStorage.setItem('av.hasSession', '1'); } catch { /* ignore */ }
  installToken(tokens.accessToken, tokens.expiresIn);
}
```

### `lib/api/client.ts`

```ts
import { ApiError, REFRESHABLE_401, toApiError } from './errors';
import { getAccessToken, refreshAccessToken, endSession } from './token-manager';

const API = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  workspaceId?: string;   // sets X-Organization-Id (§3.4)
  auth?: boolean;         // default true
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}, retried = false): Promise<{ data: T; meta: import('./types').ResponseMeta }> {
  const { method = 'GET', body, workspaceId, auth = true, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (workspaceId) headers['X-Organization-Id'] = workspaceId;
  if (auth) {
    const token = await getAccessToken();
    if (!token) throw new ApiError(401, 'AUTH_TOKEN_MISSING', 'Please sign in.');
    headers.Authorization = `Bearer ${token}`;
  }

  const timeout = AbortSignal.timeout(35_000);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', "Can't reach AgentVault. Check your connection.");
  }

  if (res.ok) {
    const json = await res.json();
    return { data: json.data as T, meta: json.meta };
  }

  const error = await toApiError(res);
  if (auth && res.status === 401 && REFRESHABLE_401.has(error.code)) {
    if (!retried && (await refreshAccessToken())) return request<T>(path, options, true);
    endSession(error.code);
  }
  throw error;
}
```

A workspace-scoped call then looks like this (header and path from the same
variable, §3.4):

```ts
export const getMyMembership = (workspaceId: string) =>
  request<Member>(`/organizations/${workspaceId}/members/me`, { workspaceId });
```

### `lib/permissions/expand.ts` (must match the server)

```ts
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*:*') return true;
  const g = parse(granted);
  const r = parse(required);
  if (!g || !r) return false;
  return (g.resource === '*' || g.resource === r.resource) && (g.action === '*' || g.action === r.action);
}

function parse(permission: string): { resource: string; action: string } | null {
  const i = permission.indexOf(':');            // the FIRST colon: 'pii:policy:read' → pii / policy:read
  if (i <= 0 || i === permission.length - 1) return null;
  return {
    resource: permission.slice(0, i).trim().toLowerCase(),
    action: permission.slice(i + 1).trim().toLowerCase(),
  };
}

export function expandPermissions(granted: Iterable<string>, catalogue: readonly string[]): string[] {
  const list = Array.from(granted);
  if (list.includes('*:*')) return [...catalogue];
  const out = new Set<string>();
  for (const p of list) {
    if (p.includes('*')) {
      for (const candidate of catalogue) if (permissionMatches(p, candidate)) out.add(candidate);
    } else {
      out.add(p);
    }
  }
  return Array.from(out).sort();
}
```

### Downloading the personal-data export (E21)

```ts
export async function downloadPersonalData() {
  const token = await getAccessToken();
  const res = await fetch(`${API}/auth/me/export`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: match?.[1] ?? 'personal-data.json' });
  a.click();
  URL.revokeObjectURL(url);
}
```
