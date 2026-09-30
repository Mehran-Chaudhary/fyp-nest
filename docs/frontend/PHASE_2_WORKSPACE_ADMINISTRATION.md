# Frontend Phase 2: Workspace Administration (Team, Roles, Invitations & Security)

**Status:** ready to implement
**Roadmap:** [`FRONTEND_PHASES.md`](FRONTEND_PHASES.md), Phase 2 of 9
**Builds on:** [`PHASE_1_FOUNDATION_AUTH_WORKSPACE.md`](PHASE_1_FOUNDATION_AUTH_WORKSPACE.md).
Everything in Phase 1 (API client, token manager, envelope, error handling, permission
loader, workspace gate, theme) is assumed and reused without being repeated here.
**Backend:** every request, response and error in this document was run against a
live instance of the backend on 2026-09-30 (≈120 calls, including the failure cases),
**including the backend fixes made that day** (§10 lists what changed; if you started
from an earlier copy of this document, read §10 first).
**Design:** the proposal has no mockups for these screens. Use the Phase 1 design
system (dark AgentVault theme, cards, tables, the same form style).

---

## Contents

1. [What Phase 2 delivers](#1-what-phase-2-delivers)
2. [Changes to Phase 1 code](#2-changes-to-phase-1-code)
3. [The access model you are building a UI for](#3-the-access-model-you-are-building-a-ui-for)
4. [Routes and navigation](#4-routes-and-navigation)
5. [Screens](#5-screens)
6. [Endpoint reference (E30–E59)](#6-endpoint-reference-e30e59)
7. [Error codes Phase 2 must handle](#7-error-codes-phase-2-must-handle)
8. [Client-side validation rules](#8-client-side-validation-rules)
9. [State, caching and invalidation](#9-state-caching-and-invalidation)
10. [Backend fixes of 2026-09-30 (what changed for the frontend)](#10-backend-fixes-of-2026-09-30-what-changed-for-the-frontend)
11. [Definition of done](#11-definition-of-done)
12. [Appendix A: TypeScript types](#appendix-a-typescript-types)
13. [Appendix B: helper code](#appendix-b-helper-code)

---

## 1. What Phase 2 delivers

Workspace owners and administrators can run their workspace:

- **Team:** browse, search and filter members; change a member's roles; edit their
  workspace title and display name; suspend, reactivate and remove members; leave a
  workspace yourself.
- **Invitations:** invite people by email into a role, see every invitation and its
  state, resend and revoke. Build the public **invitation landing page** that the
  invitation email links to.
- **Roles and permissions:** list roles; create, edit and delete custom roles (such
  as the proposal's "HR Manager") using the permission catalogue.
- **API keys:** issue machine credentials with limited scopes (for the Python AI
  service and integrations), show the secret once, and revoke keys.
- **Settings:** the workspace's name, description and logo; audit-log retention;
  document chunking defaults; requiring two-step verification or a verified email;
  allowed email domains for invitations; the IP allowlist; ownership transfer; and
  workspace deletion.

Everything is permission-aware (§3). The server enforces every rule; the UI's job is
to show only what can succeed and to explain refusals.

---

## 2. Changes to Phase 1 code

1. **Replace the `/invitations/accept` placeholder** with the real page (§5.4).
2. **Sign-up honours `?next=`.** Phase 1 sends a new account to `/workspaces/new`. If
   a valid `next` is present (same rules as sign-in: starts with `/`, not `//`), go
   there instead. This is how "Create account" on an invitation returns to the
   invitation.
3. **Sign-up shows an optional `?hint=`**: when present, show "Your invitation was
   sent to **{hint}**" above the form (the masked address from the invitation).
4. **Permission refresh after admin actions.** Several Phase 2 actions can change
   *your own* permissions: ownership transfer, editing a role you hold, deleting or
   leaving a workspace. After those, invalidate `['me']` and
   `['ws', workspaceId, 'permissions']` (§9).
5. **Nav items become real:** Team (`member:read`) and Settings (`workspace:read`)
   replace their "Coming in Phase 2" placeholders.

---

## 3. The access model you are building a UI for

Read this section before building any screen. Every refusal the server can send in
Phase 2 comes from one of these rules.

### 3.1 Roles, permissions and priority

- A member holds **one or more roles**. Their permissions are the union of their
  roles' permission keys (wildcards such as `member:*` expanded, §5.2 of Phase 1).
- Every role has a **priority** (0–100). A member's rank is the highest priority
  among their roles: `highestRolePriority` on every member object.
- Built-in roles, identical in every workspace, cannot be edited or deleted:

  | Role | slug | Priority | Notes |
  |---|---|---|---|
  | Owner | `owner` | 100 | `*:*` (everything). Exactly one member, the workspace's `ownerId`, should hold it. |
  | Administrator | `admin` | 80 | Everything except deleting or transferring the workspace, `clearance:restricted` and `pii:reveal` |
  | Member | `member` | 50 | **Default** role for invitations |
  | Viewer | `viewer` | 20 | Read-only |

- Custom roles have priority **0–99** (default **40**). The demo workspace has
  `hr-manager` (60) and `compliance-auditor` (55).

### 3.2 The two anti-escalation rules

Permissions alone would let an administrator take over the workspace (for example
by stripping the owner's roles). The server applies two further rules on top of the
route permission:

**Rule 1: rank.** You can only act on a member who ranks **strictly below** you, and
never on yourself.

- Applies to: change roles, suspend, reactivate, remove, and edit someone else's
  profile.
- On yourself → `400 CANNOT_MODIFY_SELF`. On an equal or higher rank →
  `403 FORBIDDEN` with `details: { yourPriority, targetPriority }`. (This is the
  generic `FORBIDDEN` code, not a dedicated one; branch on it together with the
  presence of `details.targetPriority`.)
- Consequence: **nobody can act on the owner** through these endpoints. The owner
  changes only through ownership transfer.

**Rule 2: you can only hand out what you hold.** You cannot grant, through any
path, a permission you don't hold yourself (unless you hold `*:*`):

| Action | What the server checks | Refusal |
|---|---|---|
| Invite into a role | role's priority **<** yours **and** you hold every permission of the role | `403 CANNOT_ESCALATE_PRIVILEGES` with `details.rolePriority/yourPriority` or `details.deniedPermissions` |
| Assign roles to a member | you hold every permission of every role assigned (**no priority check** on the role) | `403 CANNOT_ESCALATE_PRIVILEGES` + `details.deniedPermissions` |
| Create or edit a role | every permission you tick is one you hold; the role's priority **<** yours; to edit, the role's current priority **<** yours | `403 CANNOT_ESCALATE_PRIVILEGES` |
| Issue an API key | every scope is one you hold | `403 CANNOT_ESCALATE_PRIVILEGES` + `details.deniedScopes` |

Worked examples from the demo workspace (all verified):

- The Administrator (80) cannot invite into or assign **HR Manager**: it grants
  `clearance:restricted`, which admins don't hold.
- The HR Manager (60) has `member:invite`, but **cannot invite into Member or
  Viewer**: both include permissions HR lacks (`clearance:internal`, `tool:read`, …).
  The invite dialog must handle an empty role list (§5.3).
- The Administrator **can** rename or recolour the HR Manager role (60 < 80), but
  cannot change its permissions while it contains `clearance:restricted`.

### 3.3 The UI rules (compute these once, use them everywhere)

Helper code: Appendix B, `lib/rbac/rules.ts`.

```ts
myPriority    = membership.highestRolePriority           // from GET …/members/me (E26)
myPermissions = the expanded permission set              // Phase 1 §5.2

canActOn(target)      = target.id !== me.id && target.highestRolePriority < myPriority
grantableRoles(roles) = roles where slug !== 'owner'
                                 && priority < myPriority
                                 && every expanded permission of the role ∈ myPermissions
```

Use `grantableRoles` for **both** the invite dialog and role assignment. For
assignment the server skips the priority check, but assigning a role that ranks at
or above you would leave you unable to manage that member afterwards. Never offer
the Owner role: ownership moves only through transfer (§5.7).

### 3.4 Who can do what (route permission + extra rule)

| Action | Permission | Extra rule |
|---|---|---|
| See members / invitations | `member:read` | — |
| Invite, resend, revoke invitations | `member:invite` | invite: Rule 2 on the role |
| Change a member's roles | `role:assign` | Rule 1 on the member, Rule 2 on the roles |
| Suspend / reactivate | `member:update` | Rule 1; not the owner |
| Remove | `member:remove` | Rule 1; not the owner |
| Edit own workspace profile (title, display name) | — | — |
| Edit someone else's workspace profile | `member:update` | Rule 1 |
| Leave the workspace | — | not the owner |
| See roles | `role:read` | — |
| Create / edit / delete role | `role:create` / `role:update` / `role:delete` | Rule 2; built-in roles are read-only |
| Recompute permissions | `role:update` | — |
| See / create / revoke API keys | `apikey:read` / `apikey:create` / `apikey:revoke` | create: Rule 2 on scopes |
| See workspace settings | `workspace:read` | — |
| Edit name, description, logo, retention, chunking defaults, allowed domains | `workspace:update` | — |
| Require a verified email | `workspace:update` | your own email must be verified to turn it on |
| Require two-step verification | `workspace:update` **and** `security:update` | your own session must be MFA-verified to turn it on |
| See the IP allowlist | `security:read` | — |
| Change the IP allowlist or enforcement | `security:update` | the server refuses changes that would lock you out (§5.8.3) |
| Transfer ownership | `workspace:transfer` | **must be the owner** |
| Delete the workspace | `workspace:delete` | **must be the owner** |

---

## 4. Routes and navigation

| Route | Visible when | Screen |
|---|---|---|
| `/w/:slug/team` | `member:read` | §5.1 Members |
| `/w/:slug/team/members/:memberId` | `member:read` | §5.2 Member detail (a drawer over the list, with its own URL) |
| `/w/:slug/team/invitations` | `member:read` | §5.3 Invitations |
| `/w/:slug/team/roles` | `role:read` | §5.5 Roles |
| `/w/:slug/team/roles/new` | `role:create` | §5.6 Role editor |
| `/w/:slug/team/roles/:roleId` | `role:read` (read-only unless §5.6 allows editing) | §5.6 Role editor |
| `/w/:slug/settings` | `workspace:read` | §5.7 General |
| `/w/:slug/settings/security` | `workspace:read` | §5.8 Security |
| `/w/:slug/settings/api-keys` | `apikey:read` | §5.9 API keys |
| `/invitations/accept?token=` | public (**fixed path**: the backend emails it) | §5.4 Invitation landing page |

Team and Settings are pages with a tab bar. Hide the tabs the user cannot see.
Direct navigation to a hidden tab shows a "You don't have access to this section"
state (not a 404).

---

## 5. Screens

Conventions from Phase 1 apply: loading, empty and error states on every screen;
the request id in error toasts; destructive actions behind a confirmation dialog;
buttons disabled while their request is in flight.

### 5.1 Team → Members (`/w/:slug/team`)

**Header:** "Team" + member count (`organization.memberCount`: active members only),
button **Invite people** (if `member:invite`; opens the dialog of §5.3).

**Toolbar:**

- Search box (debounced 300 ms) → `search`. It matches first name, last name,
  email, and workspace display name.
- Status filter: **All** (default: active + suspended), **Active**, **Suspended**,
  **Removed** (people who were removed or left; read-only).
- Role filter: dropdown of roles (E27) → `roleId`.
- Sort: Name, Email, Joined, Status (`sortBy=name|email|joinedAt|status`, with
  `sortDirection`). Default: newest first (`createdAt DESC`).

**Table** (E37, 20 per page, pagination controls from `meta.pagination`):

| Column | Source |
|---|---|
| Member | initials avatar (or `avatarUrl` if set), `displayName`, `email` below |
| Title | `title` or "—" |
| Roles | chips, one per role: `name`, tinted with `color` (fall back to a neutral chip) |
| Status | `ACTIVE` → green "Active"; `SUSPENDED` → amber "Suspended"; `REMOVED` → grey "Removed" |
| Joined | `joinedAt`, relative ("3 days ago") with the full date on hover |
| Last active | `lastActiveAt`, relative, or "—" when null. Updated at most once a minute, on any request in this workspace |
| (actions) | kebab menu, §5.2 |

Badges: "Owner" next to the owner (`isOwner`); "You" on your own row. Rows of
removed members have no actions.

Clicking a row opens the member detail drawer.

### 5.2 Member detail (drawer: `/w/:slug/team/members/:memberId`)

Data: E38. A removed member (`status: "REMOVED"`) opens read-only: profile and
roles, no edit and no actions. Sections:

1. **Profile:** avatar, display name, full name, email, title, status, joined date.
   "Edit profile" opens inline fields **Display name** (≤120) and **Title** (≤120) →
   E39. An empty value clears the field; an empty display name falls back to the
   account name. Allowed when it is your own row, or when `member:update` and
   `canActOn`.
2. **Roles:** the member's current roles as chips. "Change roles" (needs
   `role:assign` and `canActOn`) opens a checklist:
   - roles in `grantableRoles` are selectable;
   - the server checks **every role in the submitted list**, including roles the
     member already holds. So a role the member holds but you cannot grant can be
     **removed but not kept** (verified: the admin cannot keep HR Manager on a member
     while adding Viewer, but can replace it with Viewer). Show such a role
     checked, with the note "You can't grant this role, so saving any change
     requires removing it." Allow unticking it but not re-ticking it, and keep
     **Save** disabled while it is still ticked;
   - at least one role must stay selected.

   Save → E40 with the full list (`roleIds` replaces the set). Show the response's
   new roles and rank.
3. **Actions** (each needs `canActOn`, and none is shown for the owner):
   - **Suspend** (`member:update`) → dialog with an optional **Reason** (≤255) and
     the notice "The member loses access immediately. **The reason is shown to
     them.**" → E41. (Verified: the suspended member receives
     `403 MEMBERSHIP_SUSPENDED` with `details.reason`.)
   - **Reactivate** (`member:update`, shown when `SUSPENDED`) → E42.
   - **Remove from workspace** (`member:remove`) → confirm: "…loses access
     immediately. API keys they created in this workspace are revoked. You can
     invite them again later." → E43 → toast "Removed. {revokedApiKeys} API key(s)
     revoked." → close the drawer and refresh the list.

Errors to map here: `400 CANNOT_MODIFY_SELF`, `403 FORBIDDEN` (with priorities),
`403 CANNOT_ESCALATE_PRIVILEGES`, `404 MEMBERSHIP_NOT_FOUND` (the member was just
removed: close the drawer and refresh), `404 ROLE_NOT_FOUND` (a role was deleted
meanwhile: refetch roles).

### 5.3 Team → Invitations (`/w/:slug/team/invitations`)

**Table** (E45, newest first, paginated): Email · Role · Status · Invited by ·
Sent (`lastSentAt`, plus "×{sendCount}" when above 1) · Expires · actions.

- **Status filter:** All / Pending / Expired / Accepted / Revoked.
- **Display status** is computed, not taken from `status` directly (Appendix B,
  `invitationStatus`). The server marks an invitation `EXPIRED` when it is opened
  after its expiry and on a periodic sweep (every 6 hours by default), so in between
  an expired one can still say `PENDING`: show **Expired** when `status ===
  'EXPIRED'` or `expiresAt < now`. (The "Expired" filter returns only those the
  server has already marked; that is acceptable.)
- **Actions** (`member:invite`):
  - **Resend** on Pending **and Expired** rows → E47. This issues a new link, voids
    the old one, and sets a new 7-day expiry; an expired invitation becomes Pending
    again. If a newer pending invitation exists for the same address, the server
    answers `409 INVITATION_ALREADY_PENDING`: refresh the list.
  - **Revoke** on Pending and Expired rows → confirm → E48. The link stops working
    at once.
  - Accepted and revoked rows have no actions.
- You cannot copy an invitation link: the token only exists in the email. In
  development, read it from the backend console (Phase 1 §13).

**Invite dialog** (button "Invite people"; `member:invite`):

- **Email** (valid email, ≤320). If the workspace has `settings.allowedEmailDomains`,
  show "Only addresses at: acme.test, example.com" and validate the domain
  client-side (case-insensitive, exact domain; subdomains do not match).
- **Role**: select from `grantableRoles`, defaulting to the workspace's default role
  (`isDefault: true`, normally Member) **if** it is grantable, otherwise the first
  grantable one. **If `grantableRoles` is empty**, replace the form with: "You can't
  invite anyone: every role here includes permissions you don't have. Ask an
  administrator." (This is the demo HR Manager's situation.)
- **Personal message** (optional, ≤1000): included in the email.
- The address of a **suspended** member cannot be invited (the server answers `409
  MEMBERSHIP_SUSPENDED`): suspensions are lifted with Reactivate.
- Submit → E46 → toast "Invitation sent to {email}" → refresh the list.

| Error | UI |
|---|---|
| `409 INVITATION_ALREADY_PENDING` (`details.invitationId`, `details.expiresAt`) | "An invitation is already pending for this address (expires {date})." + button **Resend it** (E47 with `details.invitationId`) |
| `409 MEMBERSHIP_ALREADY_EXISTS` | "{email} is already a member." |
| `409 MEMBERSHIP_SUSPENDED` | "{email} is a suspended member. Reactivate them from the Team list instead." + link |
| `400 BAD_REQUEST` with `details.allowedDomains` | "This workspace only accepts members from: {allowedDomains}." |
| `403 CANNOT_ESCALATE_PRIVILEGES` | "You can't invite into this role" + `details.deniedPermissions` (should not happen if the role list is built with `grantableRoles`) |
| `403 SEAT_LIMIT_REACHED` (`details.limit`, `details.current`) | "This workspace has reached its member limit ({limit})." |
| `404 ROLE_NOT_FOUND` | refetch roles |
| `422 VALIDATION_FAILED` | field errors |
| `429` | "Too many invitations to this address. Try again in {mm:ss}." (5 per hour per address) |

### 5.4 Invitation landing page (`/invitations/accept?token=…`)

Public page, the same split layout as sign-in (Phase 1 §7.1). The backend emails
this exact URL.

**Flow:**

1. **No `token` in the URL** → show "This invitation link is incomplete." without
   calling the server (the preview would answer `422 VALIDATION_FAILED`).
2. **Preview:** E49 `GET /invitations/preview?token=…`. This works signed in or out.
   Render: "**{inviterName}** invited you to join **{organizationName}** as
   **{roleName}**", "Sent to {email}" (masked, for example `in****@example.com`), and
   "Expires {expiresAt, relative}".
3. **Signed out:**
   - `requiresRegistration: true` → primary button **Create account** →
     `/auth/sign-up?next={this URL}&hint={masked email}`; secondary link "I already
     have an account" → `/auth/sign-in?next={this URL}`.
   - `requiresRegistration: false` → primary **Sign in to accept** →
     `/auth/sign-in?next={this URL}`.
   - URL-encode `next`: it contains `?token=`.
4. **Signed in:** show "Signed in as **{me.email}**".
   - Compute `maskEmail(me.email.toLowerCase())` (Appendix B). If it differs from
     the preview's `email`, show a warning **before** the user clicks: "This
     invitation was sent to {preview.email}, but you're signed in as {me.email}."
     with **Sign out and switch account** (Phase 1 sign-out, then back to this URL).
   - Button **Accept invitation** → E50 `{ token }` → `{ organizationId,
     organizationSlug, memberId }` → invalidate `['me']` → navigate to
     `/w/{organizationSlug}` with the toast "Welcome to {organizationName}".

**Errors** (from preview or accept):

| Code | Title / body | Actions |
|---|---|---|
| `404 INVITATION_NOT_FOUND` | "This invitation link isn't valid." "It may have been replaced by a newer invitation or revoked. Check your inbox for the latest email, or ask the person who invited you." | Go to AgentVault |
| `409 INVITATION_EXPIRED` | "This invitation has expired." "Ask {inviterName, if known} to resend it." | Go to AgentVault |
| `409 INVITATION_REVOKED` | "This invitation was withdrawn." | Go to AgentVault |
| `409 INVITATION_ALREADY_ACCEPTED` | "This invitation has already been used." If signed in and the workspace is in `me.memberships`: "Go to {workspace}". | Go to workspace / AgentVault |
| `401 INVITATION_EMAIL_MISMATCH` (accept) | "This invitation belongs to another email address." Sign in with the address it was sent to. | Sign out and switch account |
| `409 MEMBERSHIP_ALREADY_EXISTS` (accept) | "You're already a member of {organizationName}." | Go to workspace |
| `409 MEMBERSHIP_SUSPENDED` (accept) | "Your membership of {organizationName} is suspended." "Ask an administrator to reactivate it." | Go to AgentVault |

Notes:

- A **revoked** link answers `404 INVITATION_NOT_FOUND`, not `INVITATION_REVOKED`
  (the server overwrites the token when revoking, verified). `INVITATION_REVOKED`
  is rare in practice.
- `INVITATION_EMAIL_MISMATCH` is a **401 that is not a session problem**. It must
  not trigger a refresh or sign-out. Phase 1's token manager already only refreshes
  on the four token codes.
- Accepting does not require a verified email.
- Rate limits: preview and accept share Phase 1's per-IP `auth` bucket (10 per 15
  min, together with `refresh`). Call preview once per page load, not in a retry
  loop.
- Guard the page against React StrictMode double effects for the preview call, as
  for verify-email in Phase 1 (preview is read-only, so a duplicate is harmless but
  wastes rate budget). **Accept must only run on the button click**, never
  automatically.

### 5.5 Team → Roles (`/w/:slug/team/roles`)

Data: E27 (already sorted by priority descending) + the permission catalogue (E28).

List (cards or table): colour dot + **name**, `slug` (monospace, muted), "Built-in"
badge for `isSystem`, "Default for invitations" badge for `isDefault`, **priority**,
number of permissions (expanded count), and optionally the number of members
holding it (E37 with `roleId={id}&limit=1` → `meta.pagination.totalItems`; one
request per role, acceptable for ≤15 roles).

Actions:

- **New role** (`role:create`) → `/team/roles/new`.
- Row click → `/team/roles/:roleId` (editor or read-only view, §5.6).
- **Delete** (`role:delete`, custom roles with `priority < myPriority`) → confirm →
  E54. If members hold it, disable the button with "Assigned to N members.
  Reassign them first." On `409 ROLE_IN_USE` show `details.memberCount`.
- Overflow menu → **Recompute permissions** (`role:update`) → E55 → toast
  "Recomputed permissions for {membersRecomputed} members." This is a repair tool;
  put it behind a confirm that says so.

### 5.6 Role editor (`/w/:slug/team/roles/new` and `/:roleId`)

**Mode:**

- **Built-in role** (`isSystem`): read-only view with the permissions ticked and
  disabled. Button **Duplicate as custom role** opens `/new` prefilled (name "Copy of
  …", same permissions minus the ones you don't hold, priority `maxRolePriority`).
- **Custom role with `priority >= myPriority`**, or no `role:update`: read-only,
  with the note "This role ranks at or above yours."
- **Custom role you can edit:** editable (create needs `role:create`).

**Fields:**

| Field | Rules | Notes |
|---|---|---|
| Name | 2–60 characters | The slug is derived from the name **at creation** and never changes, even if the role is renamed. Names that give the same slug ("Support Agent" / "support agent") conflict: `409 ROLE_ALREADY_EXISTS`. |
| Description | ≤500 | optional |
| Colour | hex colour such as `#22d3ee` | a preset palette + custom picker |
| Priority | integer `0 … min(99, myPriority − 1)` | new-role default: `min(40, myPriority − 1)`. Explain: "Members with this role can only be managed by people who rank higher." |
| Permissions | see below | at least one |

**Permission grid** (from E28):

- One section per category, in this order with these labels: Workspace
  (`workspace`), Members (`members`), Access control (`access_control`), Security
  (`security`), Knowledge (`knowledge`), Document clearance (`clearance`), Agents
  (`agents`), Workflows (`workflows`), Tools (`tools`), Privacy (`privacy`), Audit &
  usage (`observability`).
- Each row: checkbox, `key` (monospace), `description`, and a "Sensitive" badge when
  `isDangerous`. Ignore the catalogue's `phase` field (every phase is live).
- **A checkbox is disabled unless the key is in `myPermissions`** (tooltip "You
  don't hold this permission, so you can't grant it").
- "Select all" per category ticks only the enabled rows.
- Clearance note under that section: "Reading documents: Restricted includes
  Confidential and Internal." When *granting*, the three keys are independent: to
  grant `clearance:internal` you must hold `clearance:internal` itself.
- **Existing roles with wildcards** (for example `document:*`, or the admin role's
  `member:*`) are shown expanded, with every covered key ticked.

**Saving:**

- Create → E52 with `permissionKeys` = the ticked concrete keys (sorted).
- Edit → E53 with **only the changed fields**. Include `permissionKeys` only if the
  permission selection changed. This matters: if the role contains a permission you
  don't hold (checked and disabled), sending `permissionKeys` is refused, while
  changing only name, colour, description or priority succeeds (verified).
  Therefore: **if the role contains any permission you don't hold, lock the whole
  permission grid** with the note "This role includes permissions you don't hold,
  so you can edit its details but not its permissions."
- Saving a change to `permissionKeys` or `priority` recomputes every holder's
  permissions immediately. Afterwards invalidate roles, members and **your own
  permissions** (you may hold this role).

| Error | UI |
|---|---|
| `409 ROLE_ALREADY_EXISTS` | on Name: "A role with this name already exists." |
| `403 CANNOT_ESCALATE_PRIVILEGES` | `details.deniedPermissions` → "You can't grant: …"; or `details.requestedPriority/yourPriority` → on Priority: "Must be below {yourPriority}" |
| `403 ROLE_IMMUTABLE` | "Built-in roles can't be changed." (switch to read-only) |
| `400 PERMISSION_NOT_FOUND` (`details.unknownPermissions`) | should not happen with the grid; generic error |
| `400 BAD_REQUEST` | "Role name must contain at least one letter or number." |
| `404 ROLE_NOT_FOUND` | deleted meanwhile: back to the list |
| `422 VALIDATION_FAILED` | field errors (permission-format errors arrive under `permissionKeys`) |

### 5.7 Settings → General (`/w/:slug/settings`)

Data: E25 (`GET /organizations/:id`). Read-only for users without
`workspace:update`.

**Card "Workspace"**

- **Name** (2–120), **Description** (≤2000), **Logo URL** (≤2048; show an image
  preview; an empty value removes the logo). There is no logo upload endpoint; this
  is a URL.
- Read-only: **URL** `…/w/{slug}` ("The workspace URL can't be changed"), **Workspace
  ID** (copy button), **Plan** (`plan` badge), **Created** date, **Members**
  (`memberCount`).
- Save → E30 with only the changed fields among `name` / `description` /
  `logoUrl`.

**Card "Data retention"**

- **Audit log retention**: "Keep forever" (the default: platform setting) or "Delete
  records older than N days" (30–3650).
- Explain: "Older audit records are archived to storage, then removed from the live
  log. The integrity chain is preserved."
- Save → E30 `{ settings: { auditRetentionDays: N } }`. "Keep forever" sends
  `auditRetentionDays: null`. Settings are a partial update: send only what changed.

**Card "Document processing"** (`workspace:update`)

- **Default chunk size** (64–4096 tokens) and **Default chunk overlap** (0–1024,
  smaller than the size), each with "Platform default" as an option (`null`).
- Explain: "Used for knowledge bases that don't set their own. Applies to documents
  processed or reindexed after the change."
- Save → E30 `{ settings: { defaultChunkSize, defaultChunkOverlap } }`. An overlap
  that is not below the effective size is refused with `422` on
  `settings.defaultChunkOverlap`.

**Card "Leave workspace"** (everyone except the owner): "You'll lose access
immediately. API keys you created here are revoked." → confirm → E44 →
invalidate `['me']`, drop every `['ws', id]` query, clear `av.lastWorkspace` if it
is this workspace → `/workspaces`. The owner sees instead: "You own this
workspace. Transfer ownership before you can leave."

**Card "Danger zone"** (visible only to the owner, `organization.ownerId === me.id`):

- **Transfer ownership:** select an **active** member other than yourself (from
  E37 `status=ACTIVE`); explain "{name} becomes the owner. You become an
  Administrator."; confirm by typing the workspace name; → E32 with
  `newOwnerUserId: member.userId`. **Use the member's `userId`, not its `id`**
  (the membership id is refused with `404 MEMBERSHIP_NOT_FOUND`, verified). After
  success, invalidate everything workspace-related and your permissions; the Danger
  zone disappears.
- **Delete workspace:** "Removes the workspace for everyone, immediately. Its
  documents and vectors are permanently destroyed after 7 days. The audit log is
  kept. This can't be undone from the app." Confirm by typing the workspace
  **slug** → E31 → `{ deleted: true }` → like Leave: drop the workspace from
  caches → `/workspaces`.

Errors: `403 PERMISSION_DENIED` (for example transfer/delete attempted by an
admin), `403 FORBIDDEN` "Only the current owner can transfer ownership." / "Only the
workspace owner can delete it.", `404 MEMBERSHIP_NOT_FOUND` (the chosen member is not
active any more), `400 BAD_REQUEST` "That member is already the owner.", `409
CANNOT_REMOVE_LAST_OWNER` (owner tried to leave).

### 5.8 Settings → Security (`/w/:slug/settings/security`)

#### 5.8.1 Two-step verification requirement

- Shows `settings.requireMfa` (on/off). The toggle needs `security:update` (and
  `workspace:update`, which the route checks first).
- **Turning it on** requires *your* session to be MFA-verified. Read
  `GET /auth/mfa` → `sessionVerified` (Phase 1 E16). If false, disable the toggle
  and show "Turn on two-step verification for your own account first" with a link to
  `/account/security?next=/w/{slug}/settings/security` (Phase 1 §7.13). The server
  otherwise answers `403 MFA_REQUIRED` "Verify your own session with two-step
  verification before requiring it of the workspace."
- Confirm dialog when enabling: "Members without two-step verification will be
  locked out of this workspace until they turn it on and sign in again." (They get
  Phase 1's `MFA_REQUIRED` state.)
- Save → E30 `{ settings: { requireMfa: true | false } }`.

#### 5.8.2 Allowed email domains

- Tag input of domains (≤20, each ≤253 characters). Normalise each entry to
  lowercase without a leading `@` before saving (the server stores what you send;
  it compares case-insensitively and ignores a leading `@`). Empty means "any
  domain".
- Explain: "Invitations can only be sent to these domains. Existing members are not
  affected." This is enforced when an invitation is **created** only.
- Save (`workspace:update`) → E30 `{ settings: { allowedEmailDomains: [...] } }`
  (`[]` or `null` removes the restriction).

#### 5.8.2b Verified email requirement

- Toggle "Require a verified email address" (`settings.requireVerifiedEmail`,
  `workspace:update`).
- **Turning it on** requires your own address to be verified (`me.emailVerified`);
  otherwise disable the toggle with "Verify your own email address first". The
  server otherwise answers `403 ACCOUNT_EMAIL_NOT_VERIFIED`.
- Confirm dialog: "Members who haven't verified their email will be locked out of
  this workspace until they do." (They get Phase 1's verify-email state.)
- Save → E30 `{ settings: { requireVerifiedEmail: true | false } }`.

#### 5.8.3 IP allowlist

Data: E33 (rules) and `organization.ipAllowlistEnabled` (E25). Visible with
`security:read`; changes need `security:update`.

- **Status line:** "IP restriction is **on**/**off**". Toggle → E36.
- **Your current address:** from `GET /auth/sessions` (Phase 1 E14), the `ipAddress`
  of the `isCurrent` session. This is the address as the server sees it; refetch
  it when this page opens. Show "Your address: 203.0.113.7 (matches rule
  'Office')" or "does not match any rule".
- **Rules table:** CIDR (monospace), Label, Added (`createdAt`), Last matched
  (`lastMatchedAt`, relative, "—" when null; recorded at most once a minute while
  enforcement is on), delete button. Don't show `isActive` (always true).
- **Add rule:** CIDR (a single address like `203.0.113.7` or a range like
  `203.0.113.0/24`, IPv4 or IPv6; validate with `isValidCidr`, Appendix B) + Label
  (≤120) → E34.

**Lockout guard.** Enabling enforcement with rules that exclude your own address
would lock **everyone, you included**, out of the workspace. The server refuses such
changes with `409 IP_ALLOWLIST_SELF_LOCKOUT` (`details.ip`: your address as it sees
it), both when enabling and when deleting a rule while enforcement is on. Check
first on the client as well, so the user sees the problem before submitting, with
`isIpAllowed` from Appendix B:

- **Before enabling enforcement:** if the current address matches no rule, block
  with "Your current address ({ip}) isn't on the allowlist. Add it first, or you'll
  lose access." Offer **Add my address** (adds `{ip}` for IPv4 as `{ip}/32`, for IPv6
  `/128`).
- **Before deleting a rule while enforcement is on:** if the remaining rules would
  not match the current address, block with the same explanation.
- If the current address is unknown (no current session row), require typing
  "I understand" to proceed.

Server refusals to handle: `409 IP_ALLOWLIST_SELF_LOCKOUT` (show the server's message
and an **Add my address** button using `details.ip`), `400 BAD_REQUEST` (invalid CIDR;
enabling with no rules), `409 RESOURCE_CONFLICT` "That range is already on the
allowlist." / "This is the last active rule and enforcement is enabled…", `404
RESOURCE_NOT_FOUND` (rule already gone).

### 5.9 Settings → API keys (`/w/:slug/settings/api-keys`)

Intro text: "API keys let services such as the AgentVault AI service call this
workspace's API. A key acts only in this workspace, only with its scopes, and never
with more than its creator could do."

**Table** (E57, newest first, not paginated). Toggle "Show revoked keys" (off by
default).

| Column | Source |
|---|---|
| Name | `name`, `description` below |
| Key | `prefix` + "…" in monospace (for example `daiap_sk_om6vGczB…`) |
| Scopes | chips (collapse after 3: "+4") |
| Status | `apiKeyStatus` (Appendix B): Active / Expired / Revoked |
| Expires | `expiresAt` |
| Last used | `lastUsedAt` (relative) + `lastUsedIp`, or "Never" |
| Uses | `usageCount` (**a string**, since it is a 64-bit counter) |
| Created by | match `createdById` to a member's `userId` (members list); if none, "Former member" |
| (actions) | Revoke (`apikey:revoke`, not on revoked keys) |

**Create key dialog** (`apikey:create`):

| Field | Rules |
|---|---|
| Name | required, ≤120 |
| Description | ≤500 |
| Scopes | checklist from E56 (18 scopes), labelled with the catalogue's descriptions; **disable scopes not in `myPermissions`**; at least one |
| Expiry | 30 days / 90 days / **1 year (default: omit `expiresAt`, the server applies 365 days)** / custom date (must be in the future). There is no "never". |
| Restrict to networks | optional list of addresses or CIDR ranges (≤20), validated with `isValidCidr` |

Submit → E58 → **show the secret once** in a dedicated dialog: the full
`plaintextKey` in monospace, **Copy**, **Download .txt**, the server's `warning`
text, and a usage example:

```bash
curl -H "X-API-Key: daiap_sk_…" \
  https://<api-host>/api/v1/organizations/<workspace-id>/agents
```

Closing the dialog requires ticking "I've stored this key". The secret cannot be
retrieved again.

Facts to put in the help text:

- The key sends the header `X-API-Key`. It is bound to this workspace: the workspace
  in the URL path is ignored (verified).
- A key restricted to networks answers `403 IP_NOT_ALLOWED` from anywhere else.
- Removing or leaving a member revokes every key they created.

**Revoke:** confirm with an optional **Reason** (≤255) → E59. Takes effect
immediately. Revoking twice is harmless (idempotent).

| Error | UI |
|---|---|
| `400 BAD_REQUEST` + `details.unsupportedScopes` | "These scopes can't be given to an API key: …" |
| `400 BAD_REQUEST` "Invalid IP range(s): …" | on the networks field |
| `403 CANNOT_ESCALATE_PRIVILEGES` + `details.deniedScopes` | "You can't grant: …" |
| `422 VALIDATION_FAILED` (`expiresAt`: "expiresAt must be in the future"; `scopes`: "an API key must have at least one scope") | field errors |
| `404 API_KEY_NOT_FOUND` | refresh the list |

---

## 6. Endpoint reference (E30–E59)

Conventions as in Phase 1 §8: paths relative to `/api/v1`; responses show `data` only
(the envelope wraps it); every workspace endpoint needs
`Authorization: Bearer …` and `X-Organization-Id: <workspace uuid>` equal to the
`{organizationId}` in the path. Abbreviation: `{ws}` = `/organizations/{organizationId}`.

### Summary

| # | Method & path | Permission | Throttle | Screen |
|---|---|---|---|---|
| E30 | `PATCH {ws}` | `workspace:update` (+ `security:update` for `settings.requireMfa`) | default | §5.7, §5.8 |
| E31 | `DELETE {ws}` | `workspace:delete` + owner | default | §5.7 |
| E32 | `POST {ws}/transfer-ownership` | `workspace:transfer` + owner | default | §5.7 |
| E33 | `GET {ws}/ip-rules` | `security:read` | default | §5.8 |
| E34 | `POST {ws}/ip-rules` | `security:update` | default | §5.8 |
| E35 | `DELETE {ws}/ip-rules/{ruleId}` | `security:update` | default | §5.8 |
| E36 | `PUT {ws}/ip-enforcement` | `security:update` | default | §5.8 |
| E37 | `GET {ws}/members` | `member:read` | default | §5.1 |
| E38 | `GET {ws}/members/{memberId}` | `member:read` | default | §5.2 |
| E39 | `PATCH {ws}/members/{memberId}` | none (rank rule for others) | default | §5.2 |
| E40 | `PUT {ws}/members/{memberId}/roles` | `role:assign` | default | §5.2 |
| E41 | `POST {ws}/members/{memberId}/suspend` | `member:update` | default | §5.2 |
| E42 | `POST {ws}/members/{memberId}/reactivate` | `member:update` | default | §5.2 |
| E43 | `DELETE {ws}/members/{memberId}` | `member:remove` | default | §5.2 |
| E44 | `POST {ws}/members/leave` | none | default | §5.7 |
| E45 | `GET {ws}/invitations` | `member:read` | default | §5.3 |
| E46 | `POST {ws}/invitations` | `member:invite` | email (IP + invited address) | §5.3 |
| E47 | `POST {ws}/invitations/{invitationId}/resend` | `member:invite` | email (user) | §5.3 |
| E48 | `DELETE {ws}/invitations/{invitationId}` | `member:invite` | default | §5.3 |
| E49 | `GET /invitations/preview?token=` | public | auth (IP) | §5.4 |
| E50 | `POST /invitations/accept` | Bearer, no workspace header | auth (IP) | §5.4 |
| E51 | `GET {ws}/roles/{roleId}` | `role:read` | default | §5.6 |
| E52 | `POST {ws}/roles` | `role:create` | default | §5.6 |
| E53 | `PATCH {ws}/roles/{roleId}` | `role:update` | default | §5.6 |
| E54 | `DELETE {ws}/roles/{roleId}` | `role:delete` | default | §5.5 |
| E55 | `POST {ws}/roles/recompute` | `role:update` | default | §5.5 |
| E56 | `GET {ws}/api-keys/scopes` | `apikey:read` | default | §5.9 |
| E57 | `GET {ws}/api-keys` | `apikey:read` | default | §5.9 |
| E58 | `POST {ws}/api-keys` | `apikey:create` | default | §5.9 |
| E59 | `DELETE {ws}/api-keys/{apiKeyId}` | `apikey:revoke` | default | §5.9 |

Reused from Phase 1: E14 `GET /auth/sessions` (current IP), E16 `GET /auth/mfa`
(`sessionVerified`), E25 `GET {ws}`, E26 `GET {ws}/members/me` (your rank), E27
`GET {ws}/roles`, E28 `GET /permissions`.

The **email** throttle is 5 requests per hour. For E46 the bucket is per IP *and*
invited address; E47 has no email in its body, so it counts per signed-in user,
shared with Phase 1's data export (E21). Path ids (`memberId`, `invitationId`, `roleId`,
`apiKeyId`, `ruleId`) must be UUID v4; anything else returns `400 BAD_REQUEST`
"Validation failed (uuid v 4 is expected)".

---

### E30. `PATCH {ws}`: update workspace

**Body** (all optional):

| Field | Rules |
|---|---|
| `name` | string 2–120 |
| `description` | string ≤2000 |
| `logoUrl` | string ≤2048; `""` removes the logo (becomes `null`) |
| `settings` | object, see below. **A partial update:** only the settings you send change; `null` clears one back to its default. |

`settings` fields:

| Field | Type / rules | Enforced by the backend? |
|---|---|---|
| `auditRetentionDays` | integer 30–3650, or `null` (keep forever / platform default) | yes |
| `requireMfa` | boolean. Present in the body ⇒ needs `security:update`; `true` ⇒ your session must be MFA-verified | yes |
| `allowedEmailDomains` | string[] (≤20, each ≤253) | yes, at invitation creation |
| `requireVerifiedEmail` | boolean. `true` ⇒ your own email must be verified | yes: unverified members get `403 ACCOUNT_EMAIL_NOT_VERIFIED` (`details.requiredBy: "workspace"`) |
| `defaultChunkSize` | integer 64–4096, or `null` | yes: ingestion default for knowledge bases without their own |
| `defaultChunkOverlap` | integer 0–1024, or `null`; must be smaller than the effective chunk size | yes, as above |

`slug`, `ownerId`, `plan` and unknown keys are refused (`422`, keyed by the field's
name, for example `slug` or `settings.bogus`).

**200:** the `Organization` (Phase 1 type), for example:

```json
{
  "id": "79b7a713-eaa2-47c0-b9d5-11e738780fe4",
  "name": "Acme Corporation",
  "slug": "acme-corp",
  "description": "Demo workspace (edited)",
  "logoUrl": "https://example.com/logo.png",
  "status": "ACTIVE",
  "plan": "FREE",
  "ownerId": "90f0f95b-c908-474f-aa65-3a0957d0020f",
  "settings": {
    "defaultChunkSize": 512,
    "defaultChunkOverlap": 64,
    "auditRetentionDays": 400,
    "allowedEmailDomains": ["acme.test", "example.com"]
  },
  "ipAllowlistEnabled": false,
  "memberCount": 5,
  "createdAt": "2026-09-29T20:31:26.473Z"
}
```

**Errors:** `403 PERMISSION_DENIED` (`workspace:update`, or `security:update` when
`requireMfa` is present) · `403 MFA_REQUIRED` ("Verify your own session with two-step
verification before requiring it of the workspace.") · `403
ACCOUNT_EMAIL_NOT_VERIFIED` ("Verify your own email address before requiring it of
the workspace.") · `422 VALIDATION_FAILED` (nested keys look like
`settings.defaultChunkSize`; an overlap that is too large gives the message "Chunk
overlap (300) must be smaller than chunk size (256)." and `details.fields:
{ "settings.defaultChunkOverlap": ["must be smaller than 256"] }`).

---

### E31. `DELETE {ws}`: delete workspace

No body. **200** `{ "deleted": true }`. The workspace and all memberships are
soft-deleted at once: it disappears from every member's list, and any further call
returns `404 ORGANIZATION_NOT_FOUND`. Knowledge data is destroyed after a 7-day grace
period.
**Errors:** `403 PERMISSION_DENIED` (`workspace:delete`) · `403 FORBIDDEN` "Only the
workspace owner can delete it." (a custom role holding `workspace:delete` is not
enough).

---

### E32. `POST {ws}/transfer-ownership`

**Body** `{ "newOwnerUserId": "<user id, uuid v4>" }`: the member's **`userId`**.
**200:** the `Organization` with the new `ownerId`. The new owner gets exactly the
Owner role; the previous owner gets exactly the Administrator role (verified).
**Errors:** `400 BAD_REQUEST` "That member is already the owner." · `403
PERMISSION_DENIED` (`workspace:transfer`) · `403 FORBIDDEN` "Only the current owner
can transfer ownership." · `404 MEMBERSHIP_NOT_FOUND` "The intended owner must be an
active member of this workspace." (also what you get when sending a membership id).

---

### E33. `GET {ws}/ip-rules`

**200** (newest first, not paginated):

```json
[
  { "id": "4dda9d9c-a82a-4299-9e0b-089a97bf752f", "cidr": "127.0.0.1/32",
    "label": "Loopback v4", "isActive": true, "lastMatchedAt": "2026-09-29T22:00:48.788Z",
    "createdAt": "2026-09-29T21:02:29.189Z" }
]
```

### E34. `POST {ws}/ip-rules`

**Body** `{ "cidr": "203.0.113.0/24", "label": "Head office VPN" }`: `cidr` ≤64,
required (address or range, IPv4/IPv6); `label` ≤120, optional.
**201:** the rule. **Errors:** `400 BAD_REQUEST` `"\"300.1.1.1/40\" is not a valid IP
address or CIDR range."` · `409 RESOURCE_CONFLICT` "That range is already on the
allowlist.".

### E35. `DELETE {ws}/ip-rules/{ruleId}`

**200** `{ "removed": true }`. **Errors:** `404 RESOURCE_NOT_FOUND` · `409
RESOURCE_CONFLICT` "This is the last active rule and enforcement is enabled. Disable
IP enforcement first, or add another rule." · `409 IP_ALLOWLIST_SELF_LOCKOUT` (the
remaining rules would not include your address) + `details.ip`.

### E36. `PUT {ws}/ip-enforcement`

**Body** `{ "enabled": true }`. **200:** the `Organization` (see
`ipAllowlistEnabled`). Takes effect on the very next request.
**Errors:** `400 BAD_REQUEST` "Add at least one allowed range before enabling IP
enforcement, otherwise every member would be locked out." · `409
IP_ALLOWLIST_SELF_LOCKOUT` "This change would block your own network address
(203.0.113.7) from the workspace. Add a rule that includes it first." +
`details.ip`.

---

### E37. `GET {ws}/members`

**Query:**

| Param | Values | Default |
|---|---|---|
| `page`, `limit` | ≥1; 1–100 | 1, 20 |
| `search` | ≤200 chars; first/last name, email, workspace display name (case-insensitive, contains) | — |
| `status` | `ACTIVE` \| `SUSPENDED` \| `REMOVED` (removed or left) | active + suspended |
| `roleId` | uuid v4 | — |
| `sortBy` | `createdAt` \| `joinedAt` \| `name` (first name) \| `email` \| `status` \| `lastActiveAt` (unknown values fall back to `createdAt`) | `createdAt` |
| `sortDirection` | `ASC` \| `DESC` | `DESC` |

**200:** paginated `Member[]` (Phase 1 type, see E26); every role of each member is
included even when filtering by `roleId`. Example item:

```json
{
  "id": "3e941da1-616f-457e-8727-e83578e4429f",
  "userId": "0e94a108-a766-424d-8827-5b799b8d9f34",
  "email": "hr@acme.test",
  "firstName": "Ameer",
  "lastName": "Abdullah",
  "displayName": "Ameer Abdullah",
  "avatarUrl": null,
  "title": "Head of People",
  "status": "ACTIVE",
  "roles": [ { "id": "18ec1cb4-605a-4cbe-ab3c-9856d169016b", "name": "HR Manager",
               "slug": "hr-manager", "color": "#0ea5e9", "priority": 60 } ],
  "highestRolePriority": 60,
  "isOwner": false,
  "joinedAt": "2026-09-29T20:31:26.741Z",
  "lastActiveAt": null,
  "createdAt": "2026-09-29T20:31:26.741Z"
}
```

### E38. `GET {ws}/members/{memberId}`

**200:** one `Member`, including a removed one (`status: "REMOVED"`, read-only: every
action on it answers `404`). **Errors:** `404 MEMBERSHIP_NOT_FOUND`.

### E39. `PATCH {ws}/members/{memberId}`: workspace profile

**Body** (optional fields): `displayName` (≤120), `title` (≤120). `""` clears
(becomes `null`; the display name then falls back to the account name).
**200:** the updated `Member`.
**Errors:** `403 PERMISSION_DENIED` (editing someone else without `member:update`) ·
`403 FORBIDDEN` "You cannot edit the profile of a member whose role ranks at or
above your own." + `details: { yourPriority, targetPriority }` · `404`. Editing
yourself never needs a permission.

### E40. `PUT {ws}/members/{memberId}/roles`

**Body** `{ "roleIds": ["<uuid>", …] }`: 1–20 role ids of this workspace. It
**replaces** the member's roles.
**200:** the updated `Member` (new `roles` and `highestRolePriority`).
**Errors:** `400 CANNOT_MODIFY_SELF` "You cannot change the roles of your own
membership." · `403 FORBIDDEN` (rank, with priorities) · `403
CANNOT_ESCALATE_PRIVILEGES` "That role grants permissions you do not hold, so you
cannot assign it: clearance:restricted." + `details.deniedPermissions` · `404
ROLE_NOT_FOUND` "One or more roles do not exist in this workspace." · `404
MEMBERSHIP_NOT_FOUND` · `422` (`roleIds: []` → "a member must hold at least one
role" on `roleIds`).

### E41. `POST {ws}/members/{memberId}/suspend`

**Body** `{ "reason": "Policy review" }` (optional, ≤255; send `{}` without one).
**200:** the `Member` with `status: "SUSPENDED"`. The member is refused on their next
request with `403 MEMBERSHIP_SUSPENDED` **and `details.reason`**, and the workspace
disappears from their `GET /auth/me` memberships. `memberCount` drops by one.
**Errors:** `400 CANNOT_MODIFY_SELF` · `403 FORBIDDEN` (rank; always for the owner) ·
`404`.

### E42. `POST {ws}/members/{memberId}/reactivate`

Body `{}`. **200:** the `Member` with `status: "ACTIVE"` (a no-op on an active
member). **Errors:** as E41.

### E43. `DELETE {ws}/members/{memberId}`

**200** `{ "removed": true, "revokedApiKeys": 1 }`. The member loses access
immediately (`404 ORGANIZATION_NOT_FOUND` for them), and every API key they created
in this workspace is revoked (verified). The membership then appears only under
`status=REMOVED`; inviting the same person again reuses it.
**Errors:** `400 CANNOT_MODIFY_SELF` · `403 FORBIDDEN` (rank) · `404`.

### E44. `POST {ws}/members/leave`

No body. **200** `{ "left": true }`. API keys you created here are revoked.
**Errors:** `409 CANNOT_REMOVE_LAST_OWNER` "This member owns the workspace. Transfer
ownership to someone else first." A suspended member cannot leave (they get
`MEMBERSHIP_SUSPENDED` like on every workspace call).

---

### E45. `GET {ws}/invitations`

**Query:** `page`, `limit`, `status` (`PENDING` | `ACCEPTED` | `REVOKED` |
`EXPIRED`; see §5.3 on when an expired invitation is marked). Newest first.
**200:** paginated `Invitation[]`:

```json
{
  "id": "8376db47-15be-4a4b-8c54-110cc83d62ca",
  "email": "invitee@example.com",
  "status": "PENDING",
  "role": { "id": "246ba69f-af09-4eef-9e82-a8ceee18d406", "name": "Member", "slug": "member" },
  "invitedBy": { "id": "f6a00af0-fd0c-4f73-9e23-1d31db20aecd", "name": "Ahmad Hanbal" },
  "expiresAt": "2026-10-06T21:02:31.246Z",
  "createdAt": "2026-09-29T21:02:31.248Z",
  "lastSentAt": "2026-09-29T21:02:31.246Z",
  "sendCount": 1
}
```

`email` keeps the case it was typed in. `role` / `invitedBy` can be `null` if the
role or user was deleted.

### E46. `POST {ws}/invitations`

**Body:** `email` (required, valid, ≤320), `roleId` (optional uuid; default: the
workspace's default role, Member), `message` (optional, ≤1000).
**201:** the `Invitation`. Invitations last **7 days**. The email contains
`{FRONTEND_URL}/invitations/accept?token=…`.
**Errors** (in the order the server checks them): `403 SEAT_LIMIT_REACHED`
(`details.limit/current`; only when the deployment sets a member limit) · `400
BAD_REQUEST` "This workspace only accepts members from: acme.test." +
`details.allowedDomains` · `404 ROLE_NOT_FOUND` · `403 CANNOT_ESCALATE_PRIVILEGES`
("You cannot invite someone as \"Administrator\", which ranks at or above your own
role." + `details.rolePriority/yourPriority`, or "…grants permissions you do not
hold…" + `details.deniedPermissions`) · `409 MEMBERSHIP_ALREADY_EXISTS` · `409
MEMBERSHIP_SUSPENDED` "This person is a suspended member of this workspace.
Reactivate them instead of inviting them." · `409 INVITATION_ALREADY_PENDING` +
`details.invitationId/expiresAt` · `422` · `429`.

### E47. `POST {ws}/invitations/{invitationId}/resend`

Body `{}`. **200:** the `Invitation` with a new `expiresAt` (+7 days), `lastSentAt`,
`status: "PENDING"` and `sendCount + 1`. The previous link stops working (it
previews as `404 INVITATION_NOT_FOUND`). Revives expired invitations, whether or not
the server has marked them `EXPIRED` yet.
**Errors:** `409 INVITATION_ALREADY_ACCEPTED` · `409 INVITATION_REVOKED` · `409
INVITATION_ALREADY_PENDING` (reviving an expired invitation while a newer one is
pending for the address) + `details.invitationId/expiresAt` · `404
INVITATION_NOT_FOUND` · `429` (5 per hour per signed-in user).

### E48. `DELETE {ws}/invitations/{invitationId}`

**200:** the `Invitation` with `status: "REVOKED"` (revoking again is harmless).
**Errors:** `409 INVITATION_ALREADY_ACCEPTED` "This invitation has already been
accepted. Remove the member instead." · `404`.

### E49. `GET /invitations/preview?token={token}`

Public (no Bearer needed; sending one is fine). A missing or empty `token` is
refused with `422 VALIDATION_FAILED` on `token`.
**200:**

```json
{
  "organizationName": "Acme Corporation",
  "organizationSlug": "acme-corp",
  "roleName": "Member",
  "inviterName": "Ahmad Hanbal",
  "email": "in**************@example.com",
  "expiresAt": "2026-10-06T21:02:31.246Z",
  "requiresRegistration": true
}
```

`email` is masked (Appendix B `maskEmail` reproduces it). `requiresRegistration` is
true when no account exists for the invited address.
**Errors:** `404 INVITATION_NOT_FOUND` (wrong, replaced or revoked link) · `409
INVITATION_EXPIRED` (the invitation is marked `EXPIRED` at that moment) · `409
INVITATION_ALREADY_ACCEPTED` · `409 INVITATION_REVOKED` (rare, see §5.4) · `422` (no
token).

### E50. `POST /invitations/accept`

Bearer; **do not send `X-Organization-Id`**. **Body** `{ "token": "…" }` (≤512).
**200:**

```json
{ "organizationId": "79b7a713-eaa2-47c0-b9d5-11e738780fe4",
  "organizationSlug": "acme-corp",
  "memberId": "03de6a55-1f61-4e41-9353-76e6a5871958" }
```

The membership is active immediately with the invitation's role.
**Errors:** `401 INVITATION_EMAIL_MISMATCH` (signed in as another address) · `404
INVITATION_NOT_FOUND` · `409 INVITATION_EXPIRED` / `INVITATION_REVOKED` /
`INVITATION_ALREADY_ACCEPTED` · `409 MEMBERSHIP_ALREADY_EXISTS` · `409
MEMBERSHIP_SUSPENDED` (your membership of that workspace is suspended: an invitation
cannot lift a suspension) · `401 AUTH_TOKEN_MISSING` (signed out).

---

### E51. `GET {ws}/roles/{roleId}`

**200:** one `Role` (Phase 1 type):

```json
{
  "id": "18ec1cb4-605a-4cbe-ab3c-9856d169016b",
  "name": "HR Manager",
  "slug": "hr-manager",
  "description": "Manages people and the HR knowledge base. Cannot alter platform security settings.",
  "isSystem": false,
  "isDefault": false,
  "priority": 60,
  "color": "#0ea5e9",
  "permissionKeys": ["workspace:read", "member:read", "member:invite", "role:read", "…", "clearance:restricted", "…"],
  "createdAt": "2026-09-29T20:31:26.562Z"
}
```

**Errors:** `404 ROLE_NOT_FOUND`.

### E52. `POST {ws}/roles`

**Body:**

| Field | Rules |
|---|---|
| `name` | required, 2–60, must contain a letter or digit |
| `description` | ≤500 |
| `permissionKeys` | 1–200 keys, each matching `^[a-z][a-z0-9_]*(:[a-z0-9_*]+)+$` or `*:*`; must exist in the catalogue (wildcards allowed) |
| `priority` | integer 0–99, **below yours**; default 40 |
| `color` | hex colour |

**201:** the `Role` (`isSystem: false`, `isDefault: false`, `slug` derived from the
name).
**Errors** (in order): `422` (format; a malformed permission on `permissionKeys`) · `400
PERMISSION_NOT_FOUND` "Unknown permission key(s): foo:bar." +
`details.unknownPermissions` · `403 CANNOT_ESCALATE_PRIVILEGES` "You cannot grant
permissions you do not hold yourself: clearance:restricted." +
`details.deniedPermissions` · `403 CANNOT_ESCALATE_PRIVILEGES` "You cannot create a
role with a priority equal to or above your own…" +
`details.requestedPriority/yourPriority` · `400 BAD_REQUEST` (name without letters or
digits) · `409 ROLE_ALREADY_EXISTS`. The name of a **deleted** role can be reused
(verified).

### E53. `PATCH {ws}/roles/{roleId}`

**Body:** any of `name`, `description`, `permissionKeys`, `priority`, `color` (same
rules as E52). The slug never changes. **200:** the `Role`.
**Errors:** `403 ROLE_IMMUTABLE` "\"Member\" is a built-in role and cannot be
modified. Create a custom role instead." · `403 CANNOT_ESCALATE_PRIVILEGES` "You cannot
modify a role whose priority is at or above your own." / "You cannot raise a role to
a priority at or above your own." / "You cannot grant permissions you do not hold
yourself: …" · `400 PERMISSION_NOT_FOUND` · `404 ROLE_NOT_FOUND` · `422`.

### E54. `DELETE {ws}/roles/{roleId}`

**200** `{ "deleted": true }`. **Errors:** `403 ROLE_IMMUTABLE` · `403
CANNOT_ESCALATE_PRIVILEGES` (the role ranks at or above you) · `409 ROLE_IN_USE`
"This role is assigned to 1 member(s). Reassign them before deleting it." +
`details.memberCount` · `404`.

### E55. `POST {ws}/roles/recompute`

Body `{}`. **200** `{ "membersRecomputed": 6 }`.

---

### E56. `GET {ws}/api-keys/scopes`

**200:**

```json
{ "scopes": ["rag:query", "document:read", "document:create", "document:reindex",
  "knowledgebase:read", "clearance:internal", "clearance:confidential", "agent:read",
  "agent:execute", "conversation:read", "conversation:delete", "llm:invoke",
  "workflow:read", "workflow:execute", "tool:read", "tool:execute", "usage:read",
  "pii:policy:read"] }
```

Administrative permissions, `clearance:restricted`, `pii:reveal` and the `*_all` read
permissions are never grantable to a key.

### E57. `GET {ws}/api-keys`

**200** (newest first, includes revoked keys, not paginated):

```json
[
  {
    "id": "aca02edc-54c7-42c9-b82f-73f676b57db7",
    "name": "Open key",
    "description": null,
    "prefix": "daiap_sk_jUCIWATs",
    "scopes": ["agent:read"],
    "createdById": "f6a00af0-fd0c-4f73-9e23-1d31db20aecd",
    "expiresAt": "2026-10-29T21:02:34.148Z",
    "revokedAt": null,
    "lastUsedAt": "2026-09-29T21:02:34.187Z",
    "lastUsedIp": "127.0.0.1",
    "usageCount": "1",
    "allowedIps": [],
    "createdAt": "2026-09-29T21:02:34.163Z"
  }
]
```

`createdById` is a **user** id. `usageCount` is a string. The revocation reason is not
returned.

### E58. `POST {ws}/api-keys`

**Body:**

| Field | Rules |
|---|---|
| `name` | required, ≤120 |
| `description` | ≤500 |
| `scopes` | 1–50 strings from E56, each one you hold (duplicates are removed) |
| `expiresAt` | ISO date-time in the future; omitted → 365 days from now |
| `allowedIps` | ≤20 addresses or CIDR ranges, each ≤64 |

**201:**

```json
{
  "apiKey": {
    "id": "4c40fe5a-13d1-401e-99c6-797bd2271043",
    "name": "Pinned key",
    "description": "Only from 10.x",
    "prefix": "daiap_sk_om6vGczB",
    "scopes": ["agent:read", "rag:query"],
    "createdById": "f6a00af0-fd0c-4f73-9e23-1d31db20aecd",
    "expiresAt": "2027-09-29T21:02:34.075Z",
    "revokedAt": null,
    "lastUsedAt": null,
    "lastUsedIp": null,
    "usageCount": "0",
    "allowedIps": ["10.0.0.0/8"],
    "createdAt": "2026-09-29T21:02:34.076Z"
  },
  "plaintextKey": "daiap_sk_om6vGczB7eV02pYD6DBGuII9YdsdxxX_6dN3RTZZx24",
  "warning": "Store this key now. It is shown once and cannot be retrieved again — the platform keeps only a cryptographic digest."
}
```

The secret is 52 characters: `daiap_sk_` + 43. **Errors:** `400 BAD_REQUEST` "These
scopes cannot be granted to an API key: member:read." +
`details.unsupportedScopes/supportedScopes` · `403 CANNOT_ESCALATE_PRIVILEGES` +
`details.deniedScopes` · `400 BAD_REQUEST` "Invalid IP range(s): nope." · `422`
(`expiresAt must be in the future`).

### E59. `DELETE {ws}/api-keys/{apiKeyId}`

**Body** (optional; a JSON body on a DELETE): `{ "reason": "Rotated" }` (≤255).
**200:** the key with `revokedAt` set. From then on the key is refused with `401
API_KEY_REVOKED`. Idempotent. **Errors:** `404 API_KEY_NOT_FOUND`.

---

## 7. Error codes Phase 2 must handle

On top of Phase 1 §9:

| HTTP | Code | Where | `details` | Handling |
|---|---|---|---|---|
| 400 | `CANNOT_MODIFY_SELF` | E39–E43 | — | Hide self-actions; toast if it happens |
| 403 | `FORBIDDEN` | E31, E32, E39–E43 | `yourPriority`, `targetPriority` (rank) | "You can't act on someone who ranks at or above you" / the server message |
| 403 | `CANNOT_ESCALATE_PRIVILEGES` | E40, E46, E52–E54, E58 | `deniedPermissions` \| `deniedScopes` \| `rolePriority`+`yourPriority` \| `requestedPriority`+`yourPriority` \| `rolePriority` | Explain which permission or rank blocks it |
| 403 | `ROLE_IMMUTABLE` | E53, E54 | — | Built-in role: read-only |
| 409 | `ROLE_ALREADY_EXISTS` | E52 | — | Name field |
| 409 | `ROLE_IN_USE` | E54 | `memberCount` | Explain; link to Members filtered by the role |
| 404 | `ROLE_NOT_FOUND` | E40, E46, E51–E54 | — | Refetch roles |
| 400 | `PERMISSION_NOT_FOUND` | E52, E53 | `unknownPermissions` | Generic (client bug) |
| 404 | `MEMBERSHIP_NOT_FOUND` | E32, E38–E43 | — | Refetch; close drawer |
| 409 | `MEMBERSHIP_ALREADY_EXISTS` | E46, E50 | — | "Already a member" |
| 409 | `MEMBERSHIP_SUSPENDED` | E46, E50 | — | Invite: "Reactivate them instead"; accept: "Ask an administrator to reactivate you" |
| 409 | `CANNOT_REMOVE_LAST_OWNER` | E44 (E40 for platform admins) | — | "Transfer ownership first" |
| 403 | `SEAT_LIMIT_REACHED` | E46 | `limit`, `current` | Explain |
| 404 | `INVITATION_NOT_FOUND` | E47–E50 | — | Landing page / refetch |
| 409 | `INVITATION_EXPIRED` | E49, E50 | — | Landing page |
| 409 | `INVITATION_REVOKED` | E47, E49, E50 | — | Landing page / refetch |
| 409 | `INVITATION_ALREADY_ACCEPTED` | E47–E50 | — | Landing page / refetch |
| 409 | `INVITATION_ALREADY_PENDING` | E46, E47 | `invitationId`, `expiresAt` | Offer Resend (E46); refresh the list (E47) |
| 401 | `INVITATION_EMAIL_MISMATCH` | E50 | — | Switch account (not a session error) |
| 404 | `API_KEY_NOT_FOUND` | E59 | — | Refetch |
| 401 | `API_KEY_REVOKED` / `API_KEY_EXPIRED` / `API_KEY_INVALID` | machine calls only | — | Not seen by the browser app |
| 403 | `MFA_REQUIRED` | E30 | — | "Verify your own session first" |
| 403 | `ACCOUNT_EMAIL_NOT_VERIFIED` | E30 | — | "Verify your own email first" |
| 409 | `IP_ALLOWLIST_SELF_LOCKOUT` | E35, E36 | `ip` | Show the message; offer **Add my address** |
| 400 | `BAD_REQUEST` | E32, E34, E36, E46, E52, E58 | sometimes `allowedDomains` / `unsupportedScopes` | Show `message` (these messages are written for users) |
| 409 | `RESOURCE_CONFLICT` | E34, E35 | — | Show `message` |
| 404 | `RESOURCE_NOT_FOUND` | E35 | — | Refetch rules |

Because the server's messages for `BAD_REQUEST`, `FORBIDDEN`, `RESOURCE_CONFLICT` and
`CANNOT_ESCALATE_PRIVILEGES` differ by situation, show `error.message` for these
codes rather than a fixed string.

---

## 8. Client-side validation rules

| Field | Rule |
|---|---|
| Workspace name | 2–120 |
| Workspace description | ≤2000 |
| Logo URL | ≤2048; recommend `https://` |
| Audit retention days | integer 30–3650, or "keep forever" (`null`) |
| Allowed email domains | ≤20 entries, each ≤253, lowercase, no leading `@`, no spaces |
| IP rule | `isValidCidr` (Appendix B; the server's own parser); label ≤120 |
| Member display name / title | ≤120 each |
| Suspension reason | ≤255 |
| Invitation email | valid email, ≤320; domain in `allowedEmailDomains` when set |
| Invitation message | ≤1000 |
| Role name | 2–60, at least one letter or digit |
| Role description | ≤500 |
| Role priority | integer 0 … `min(99, myPriority − 1)` |
| Role colour | hex, for example `#22d3ee` |
| Role permissions | ≥1, each held by you |
| API key name / description | ≤120 / ≤500 |
| API key scopes | ≥1, from E56, each held by you |
| API key expiry | in the future |
| API key networks | ≤20, each `isValidCidr`, ≤64 |
| API key revoke reason | ≤255 |
| Transfer ownership confirmation | typed workspace name matches exactly |
| Delete workspace confirmation | typed slug matches exactly |

---

## 9. State, caching and invalidation

Every key starts with `['ws', workspaceId]` (Phase 1 §11).

| Key | Source |
|---|---|
| `['ws', id, 'details']` | E25 (also set from the E30/E32/E36 responses) |
| `['ws', id, 'members', params]` | E37 |
| `['ws', id, 'member', memberId]` | E38 |
| `['ws', id, 'invitations', params]` | E45 |
| `['ws', id, 'roles']` | E27 |
| `['ws', id, 'role', roleId]` | E51 |
| `['ws', id, 'role-member-count', roleId]` | E37 `roleId=…&limit=1` |
| `['ws', id, 'api-keys']` | E57 |
| `['ws', id, 'api-key-scopes']` | E56 (staleTime Infinity) |
| `['ws', id, 'ip-rules']` | E33 |
| `['ws', id, 'membership']`, `['ws', id, 'permissions']` | Phase 1 |
| `['sessions']`, `['mfa']` | Phase 1 (current IP, `sessionVerified`) |

**After a mutation, invalidate:**

| Mutation | Invalidate |
|---|---|
| E30 update workspace | set `details` from the response |
| E31 delete, E44 leave | `['me']`, `['workspaces']`; **remove** all `['ws', id]` queries; navigate to `/workspaces` |
| E32 transfer | `details`, `members`, `member`, `membership`, `permissions`, `['me']` |
| E34–E36 IP rules / enforcement | `ip-rules`, `details` |
| E39–E43 member changes | `members`, `member`, `details` (member count), role member counts |
| E46–E48 invitations | `invitations` |
| E50 accept | `['me']`, `['workspaces']` |
| E52–E55 roles | `roles`, `role`, role member counts, `members`, `member`, **`membership`, `permissions`** |
| E58–E59 API keys | `api-keys` |

---

## 10. Backend fixes of 2026-09-30 (what changed for the frontend)

Writing this specification uncovered seven more backend issues (numbering continues
from Phase 1's BF-1…BF-5). All were fixed in the backend on 2026-09-30 and re-verified
against a running server. This document already describes the fixed behaviour; the
table is for anyone who started from an earlier copy.

| # | Was | Now | Frontend impact |
|---|---|---|---|
| BF-6 (security) | Saving any workspace `settings` replaced the whole object, silently turning off `requireMfa` and clearing `allowedEmailDomains` | A partial update: only the sent settings change; `null` clears one (E30). The same fix was applied to tool data policies (Phase 6) | Send only what changed. The earlier `buildSettingsPatch` helper still works but can be deleted |
| BF-7 | Editing another member's workspace profile checked rank only | Also requires `member:update` (`403 PERMISSION_DENIED`) | None (the UI already required it) |
| BF-8 | Re-inviting a suspended member and their acceptance reactivated them | Both refused with `409 MEMBERSHIP_SUSPENDED` | Handle the code (§5.3, §5.4); the client-side warning is optional |
| BF-9 | `GET /invitations/preview` without a token returned 500 | `422 VALIDATION_FAILED` on `token` | None |
| BF-10 | Resending an invitation the sweep had marked `EXPIRED` returned `INVITATION_REVOKED`; the expiry found at acceptance was not saved | Resend revives expired invitations (or `409 INVITATION_ALREADY_PENDING` if a newer one exists); preview and accept mark it `EXPIRED` | Offer Resend on expired rows (§5.3) |
| BF-11 (security) | IP enforcement could lock out everyone, including the admin enabling it, recoverable only in the database | Refused with `409 IP_ALLOWLIST_SELF_LOCKOUT` (`details.ip`) | Keep the client-side check for a better experience; handle the code (§5.8.3) |
| BF-12 | Chunking defaults and `requireVerifiedEmail` were stored but not applied; `lastMatchedAt` and `lastActiveAt` were never written; `status=REMOVED` returned nothing | All applied or recorded (E30, E33, E37, E38) | Build the Document processing card, the verified-email toggle, the Last active / Last matched columns and the Removed filter |
| BF-4 (more cases) | Validation keys `"a"`, `"each"`, `"an"`, `"property"` | Property paths: `roleIds`, `permissionKeys`, `scopes`, the unknown field's own name | Map keys to fields directly |

Also fixed: Swagger now lists `CANNOT_MODIFY_SELF` under `400`. Acting on a
higher-ranked member is still the generic `403 FORBIDDEN` with priorities in
`details` (by design).

## 11. Definition of done

Use the demo workspace (`acme-corp`, password `Demo-Workspace-2026!`) plus fresh
accounts.

**Members**
- [ ] As `admin@acme.test`: the list shows 5 members; search "khan" finds the
      employee; the Suspended filter works; sorting by name works; pagination
      appears with `limit` 2.
- [ ] The owner's row and your own row show no role, suspend or remove actions.
- [ ] Admin changes the employee to Viewer and back. HR Manager is not offered
      (admin lacks `clearance:restricted`).
- [ ] Admin opens the HR manager's roles: HR Manager is shown ticked with the "can't
      grant" note, and Save stays disabled until it is unticked.
- [ ] Suspend with a reason → the employee (another browser) sees the Phase 1
      "access suspended" state **with the reason**; the member count drops;
      reactivate restores access.
- [ ] Remove a member who created an API key → the toast says 1 key revoked; that
      key now fails; the member appears under the Removed filter, read-only.
- [ ] The Last active column fills in after a member uses the workspace.
- [ ] A non-owner leaves a workspace; the owner sees "Transfer ownership first".

**Invitations**
- [ ] Invite a new address → it appears as Pending; the link from the backend
      console opens the landing page with the masked address.
- [ ] Inviting the same address again offers "Resend it"; resend increases the
      send count and the old link then shows "isn't valid".
- [ ] Signed out → Create account (with the hint) → back on the landing page →
      Accept → lands in the workspace with the invited role.
- [ ] Signed in as a different account → the mismatch warning shows **before**
      clicking; accepting anyway shows the switch-account state without signing
      out.
- [ ] Revoke a pending invitation → its link shows "isn't valid".
- [ ] A backdated invitation (`UPDATE invitations SET expires_at = now() - interval
      '1 day'` on a dev database) shows **Expired**, and Resend revives it.
- [ ] Inviting a suspended member's address is refused with a link to Reactivate.
- [ ] As `hr@acme.test`: the invite dialog explains that no role is available.
- [ ] With allowed domains set to `acme.test`, a gmail address is rejected
      client-side and server-side.

**Roles**
- [ ] Built-in roles are read-only, with "Duplicate as custom role".
- [ ] Admin creates "Support Agent" (priority ≤79, permissions only from those
      admin holds; `clearance:restricted` disabled) and assigns it; the member's
      permissions change immediately.
- [ ] Admin opens HR Manager: can change its colour, but the permission grid is
      locked.
- [ ] Deleting a role in use is prevented with the member count; deleting an unused
      role works, and its name can be reused.

**API keys**
- [ ] Create a key: the secret is shown once, copyable and downloadable; the list
      shows the prefix, status Active, uses 0.
- [ ] Scopes you don't hold are disabled.
- [ ] `curl` with the key works; the list then shows last used and uses 1.
- [ ] Revoke with a reason → status Revoked; hidden unless "Show revoked" is on.

**Settings**
- [ ] Change name, description and logo; the sidebar workspace card updates.
- [ ] Set retention to 400 days, then allowed domains: **both survive**. Then as
      the owner with MFA: require MFA, change retention again → `requireMfa` is
      still true.
- [ ] Document processing: set a default chunk size of 256 and an overlap of 300 →
      refused on the overlap field; 256 / 32 saves.
- [ ] Require a verified email: disabled for an unverified owner; as a verified
      owner, turning it on locks an unverified member out with Phase 1's
      verify-email state.
- [ ] Require MFA without an MFA-verified session → the toggle is disabled with the
      link to Account → Security.
- [ ] IP allowlist: "Your address" shows; enabling without a matching rule is
      blocked client-side with **Add my address** (and, bypassing that check, the
      server answers `IP_ALLOWLIST_SELF_LOCKOUT`); after adding it, enabling works,
      the app keeps working and the rule shows a Last matched time; deleting that
      rule is refused while enforcement is on.
- [ ] Transfer ownership to an admin → you become Administrator and the Danger zone
      disappears; the new owner can delete the workspace → it disappears from
      everyone's switcher.

**Quality**
- [ ] Unit tests for `grantableRoles`, `canActOn`, `invitationStatus`,
      `apiKeyStatus`, `maskEmail`, `isIpAllowed` (cases in Appendix B).
- [ ] Every error code in §7 has a designed message.
- [ ] No tokens or API secrets in logs, URLs or storage.

---

## Appendix A: TypeScript types

Add to Phase 1's `lib/api/types.ts` (which already has `Organization`,
`OrganizationSettings`, `Member`, `MemberRole`, `Role`, `PermissionCatalogue`).

```ts
// ── Workspace ───────────────────────────────────────────────────────────────
export interface UpdateOrganizationRequest {
  name?: string;
  description?: string;
  logoUrl?: string;                   // '' removes the logo
  settings?: Partial<{ [K in keyof OrganizationSettings]: OrganizationSettings[K] | null }>; // partial; null clears
}
export interface TransferOwnershipRequest { newOwnerUserId: string } // a user id, not a membership id
export interface IpRule {
  id: string;
  cidr: string;
  label: string | null;
  isActive: boolean;                 // always true
  lastMatchedAt: string | null;      // recorded at most once a minute while enforcing
  createdAt: string;
}
export interface CreateIpRuleRequest { cidr: string; label?: string }

// ── Members ─────────────────────────────────────────────────────────────────
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
export interface ListMembersParams {
  page?: number;
  limit?: number;                    // ≤100
  search?: string;
  status?: MembershipStatus;
  roleId?: string;
  sortBy?: 'createdAt' | 'joinedAt' | 'name' | 'email' | 'status' | 'lastActiveAt';
  sortDirection?: 'ASC' | 'DESC';
}
export interface UpdateMemberProfileRequest { displayName?: string; title?: string } // '' clears
export interface SetMemberRolesRequest { roleIds: string[] }                         // 1–20, replaces
export interface SuspendMemberRequest { reason?: string }
export interface RemoveMemberResponse { removed: true; revokedApiKeys: number }

// ── Invitations ─────────────────────────────────────────────────────────────
export type InvitationStatusValue = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
export interface Invitation {
  id: string;
  email: string;
  status: InvitationStatusValue;
  role: { id: string; name: string; slug: string } | null;
  invitedBy: { id: string; name: string } | null;
  expiresAt: string;
  createdAt: string;
  lastSentAt: string | null;
  sendCount: number;
}
export interface CreateInvitationRequest { email: string; roleId?: string; message?: string }
export interface InvitationPreview {
  organizationName: string;
  organizationSlug: string;
  roleName: string;
  inviterName: string;
  email: string;                     // masked
  expiresAt: string;
  requiresRegistration: boolean;
}
export interface AcceptInvitationResponse { organizationId: string; organizationSlug: string; memberId: string }

// ── Roles ───────────────────────────────────────────────────────────────────
export interface CreateRoleRequest {
  name: string;
  description?: string;
  permissionKeys: string[];
  priority?: number;                 // 0–99, below yours; default 40
  color?: string;
}
export type UpdateRoleRequest = Partial<CreateRoleRequest>; // send only changed fields

// ── API keys ────────────────────────────────────────────────────────────────
export interface ApiKey {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scopes: string[];
  createdById: string;               // a user id
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  usageCount: string;                // a string (64-bit counter)
  allowedIps: string[];
  createdAt: string;
}
export interface CreateApiKeyRequest {
  name: string;
  description?: string;
  scopes: string[];
  expiresAt?: string;                // ISO, future; omit for 365 days
  allowedIps?: string[];
}
export interface CreatedApiKey { apiKey: ApiKey; plaintextKey: string; warning: string }

// ── Error codes added in Phase 2 ────────────────────────────────────────────
export type Phase2ErrorCode =
  | 'CANNOT_MODIFY_SELF' | 'CANNOT_ESCALATE_PRIVILEGES' | 'CANNOT_REMOVE_LAST_OWNER'
  | 'ROLE_NOT_FOUND' | 'ROLE_ALREADY_EXISTS' | 'ROLE_IMMUTABLE' | 'ROLE_IN_USE'
  | 'PERMISSION_NOT_FOUND' | 'MEMBERSHIP_NOT_FOUND' | 'MEMBERSHIP_ALREADY_EXISTS'
  | 'SEAT_LIMIT_REACHED' | 'MEMBERSHIP_SUSPENDED' | 'IP_ALLOWLIST_SELF_LOCKOUT'
  | 'INVITATION_NOT_FOUND' | 'INVITATION_EXPIRED'
  | 'INVITATION_ALREADY_ACCEPTED' | 'INVITATION_REVOKED' | 'INVITATION_EMAIL_MISMATCH'
  | 'INVITATION_ALREADY_PENDING' | 'API_KEY_NOT_FOUND' | 'API_KEY_INVALID'
  | 'API_KEY_EXPIRED' | 'API_KEY_REVOKED';
```

---

## Appendix B: helper code

Reference implementations. The access rules and the status helpers were checked
against the running server (they predict exactly what it
accepts and refuses). `ip.ts` and `maskEmail` are copied from the backend.

### `lib/rbac/rules.ts`

```ts
import { expandPermissions } from '../permissions/expand';
import type { Member, Role } from '../api/types';

type Ranked = Pick<Member, 'id' | 'highestRolePriority'>;

/** Rule 1 (§3.2): never yourself, only members ranked strictly below you. */
export function canActOn(me: Ranked, target: Ranked): boolean {
  return target.id !== me.id && target.highestRolePriority < me.highestRolePriority;
}

/** True when you hold every permission the role grants (wildcards expanded). */
export function holdsAllOf(
  role: Pick<Role, 'permissionKeys'>,
  myPermissions: ReadonlySet<string>,
  catalogue: readonly string[],
): boolean {
  return expandPermissions(role.permissionKeys, catalogue).every((key) => myPermissions.has(key));
}

/**
 * Roles you may invite someone into, and (by the UI's rule, §3.3) assign.
 * Rule 2: priority strictly below yours and every permission held by you.
 * The Owner role is never offered: ownership moves only by transfer.
 */
export function grantableRoles(
  roles: readonly Role[],
  myPriority: number,
  myPermissions: ReadonlySet<string>,
  catalogue: readonly string[],
): Role[] {
  return roles.filter(
    (role) =>
      role.slug !== 'owner' &&
      role.priority < myPriority &&
      holdsAllOf(role, myPermissions, catalogue),
  );
}

/** Highest priority you may give a role you create or edit. */
export const maxRolePriority = (myPriority: number): number => Math.min(99, myPriority - 1);

/** Whether the role editor is editable for this role (§5.6), given role:update / role:create. */
export function canEditRole(role: Pick<Role, 'isSystem' | 'priority'>, myPriority: number): boolean {
  return !role.isSystem && role.priority < myPriority;
}

/** Whether the permission grid may be changed: only if you hold everything the role grants. */
export function canEditRolePermissions(
  role: Pick<Role, 'isSystem' | 'priority' | 'permissionKeys'>,
  myPriority: number,
  myPermissions: ReadonlySet<string>,
  catalogue: readonly string[],
): boolean {
  return canEditRole(role, myPriority) && holdsAllOf(role, myPermissions, catalogue);
}
```

### `lib/workspace/status.ts`

```ts
import type { ApiKey, Invitation } from '../api/types';

export type InvitationDisplayStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

/** An expired invitation can still say PENDING until the server's sweep marks it: derive it from expiresAt too. */
export function invitationStatus(invitation: Pick<Invitation, 'status' | 'expiresAt'>, now = Date.now()): InvitationDisplayStatus {
  if (invitation.status === 'ACCEPTED') return 'accepted';
  if (invitation.status === 'REVOKED') return 'revoked';
  if (invitation.status === 'EXPIRED' || Date.parse(invitation.expiresAt) <= now) return 'expired';
  return 'pending';
}

/** Resend and Revoke are offered for pending and expired invitations. */
export const invitationActionable = (i: Pick<Invitation, 'status' | 'expiresAt'>, now = Date.now()) =>
  ['pending', 'expired'].includes(invitationStatus(i, now));

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export function apiKeyStatus(key: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now = Date.now()): ApiKeyStatus {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return 'expired';
  return 'active';
}
```

### `lib/workspace/mask-email.ts` (copied from the backend's `maskEmail`)

```ts
/** Reproduces the masking of GET /invitations/preview: 'invitee@x.com' → 'in*****@x.com'. */
export function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0) return '[REDACTED]';
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 2))}${domain}`;
}
// Compare maskEmail(me.email.toLowerCase()) with preview.email (the server masks the lowercased address).
```

### `lib/workspace/ip.ts` (copied from the backend's `src/common/utils/ip.util.ts`)

Copied rather than using a library, so the client-side lockout check gives exactly
the server's answer (IPv4-mapped IPv6, leading-zero rejection, bare addresses as /32 or /128).

```ts
interface ParsedIp { value: bigint; family: 'ipv4' | 'ipv6'; bits: number }

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseIp(input: string): ParsedIp | null {
  if (!input) return null;
  let address = input.trim();
  if (address.startsWith('[')) {
    const closing = address.indexOf(']');
    if (closing > 0) address = address.slice(1, closing);
  }
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  if (mapped) address = mapped[1];
  const v4 = parseIpv4(address);
  if (v4 !== null) return { value: v4, family: 'ipv4', bits: 32 };
  const v6 = parseIpv6(address);
  if (v6 !== null) return { value: v6, family: 'ipv6', bits: 128 };
  return null;
}

function parseIpv4(address: string): bigint | null {
  const match = IPV4_PATTERN.exec(address);
  if (!match) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (match[i].length > 1 && match[i].startsWith('0')) return null;
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(address: string): bigint | null {
  if (!address.includes(':')) return null;
  const doubleColonCount = (address.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;
  let head: string[];
  let tail: string[];
  if (doubleColonCount === 1) {
    const [left, right] = address.split('::');
    head = left ? left.split(':') : [];
    tail = right ? right.split(':') : [];
  } else {
    head = address.split(':');
    tail = [];
  }
  const expand = (groups: string[]): string[] | null => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    if (!last.includes('.')) return groups;
    const v4 = parseIpv4(last);
    if (v4 === null) return null;
    const high = (v4 >> 16n) & 0xffffn;
    const low = v4 & 0xffffn;
    return [...groups.slice(0, -1), high.toString(16), low.toString(16)];
  };
  const expandedHead = expand(head);
  const expandedTail = expand(tail);
  if (expandedHead === null || expandedTail === null) return null;
  const missing = 8 - (expandedHead.length + expandedTail.length);
  if (missing < 0) return null;
  if (doubleColonCount === 0 && missing !== 0) return null;
  const groups = [...expandedHead, ...Array.from({ length: missing }, () => '0'), ...expandedTail];
  let value = 0n;
  for (const group of groups) {
    if (group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIp(ip);
  if (!parsedIp) return false;
  const slashIndex = cidr.indexOf('/');
  const networkPart = slashIndex === -1 ? cidr : cidr.slice(0, slashIndex);
  const parsedNetwork = parseIp(networkPart);
  if (!parsedNetwork) return false;
  if (parsedNetwork.family !== parsedIp.family) return false;
  const prefixLength =
    slashIndex === -1 ? parsedNetwork.bits : Number.parseInt(cidr.slice(slashIndex + 1), 10);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > parsedIp.bits) return false;
  if (prefixLength === 0) return true;
  const hostBits = BigInt(parsedIp.bits - prefixLength);
  const mask = ((1n << BigInt(prefixLength)) - 1n) << hostBits;
  return (parsedIp.value & mask) === (parsedNetwork.value & mask);
}

/** Matches at least one rule. NOTE: unlike the server helper, an empty list returns false here. */
export function isIpAllowed(ip: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => isIpInCidr(ip, cidr));
}

export function isValidCidr(cidr: string): boolean {
  const trimmed = cidr.trim();
  const slashIndex = trimmed.indexOf('/');
  const networkPart = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex);
  const parsed = parseIp(networkPart);
  if (!parsed) return false;
  if (slashIndex === -1) return true;
  const prefixLength = Number.parseInt(trimmed.slice(slashIndex + 1), 10);
  return Number.isInteger(prefixLength) && prefixLength >= 0 && prefixLength <= parsed.bits;
}

/** §5.8.3: would this set of rules, with enforcement on, still let me in? */
export function wouldLockMeOut(currentIp: string | null, activeCidrs: readonly string[]): boolean | 'unknown' {
  if (!currentIp) return 'unknown';
  return !isIpAllowed(currentIp, activeCidrs);
}

/** The rule to add for "Add my address". */
export const hostRuleFor = (ip: string): string => (ip.includes(':') ? `${ip}/128` : `${ip}/32`);
```

Test cases to include (all agree with the server): `isIpInCidr('127.0.0.1',
'127.0.0.1/32') === true`; `isIpInCidr('::ffff:10.1.2.3', '10.0.0.0/8') === true`;
`isIpInCidr('10.1.2.3', '::/0') === false` (families differ);
`isValidCidr('300.1.1.1/40') === false`; `isValidCidr('010.0.0.1') === false`;
`maskEmail('invitee.x@example.com') === 'in*******@example.com'`;
`maskEmail('a@x.com') === 'a**@x.com'`.
