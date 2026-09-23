# ADR 0001 — Tenant isolation strategy

**Status:** Accepted · **Date:** 2026-09-23 · **Phase:** 1

---

## Context

Proposal module 6.2 states:

> Implement database schema separation to ensure data from one organization
> cannot be accessed by another.

The requirement is tenant isolation. "Schema separation" is one way to achieve
it, and the proposal names it — but it is a mechanism, not the goal. This record
sets out why a different mechanism was chosen and what replaces the guarantee
schema separation would have provided.

Three options were considered.

### A. Database per tenant

Each workspace gets its own PostgreSQL database.

*Strongest physical isolation — a query cannot cross a database boundary by
accident.* But every migration must run N times, and a failure partway through
leaves tenants on different schema versions. Each database needs its own
connection pool: at PostgreSQL's default 100 connections and even a modest pool
of 5, roughly twenty tenants exhaust the server. Cross-tenant platform
administration requires connecting to every database in turn.

### B. Schema per tenant

One database, one PostgreSQL schema per workspace, selected via `search_path`.

Lighter than option A and shares a connection pool. But `search_path` is
*connection* state, and connections are pooled and reused. A request that fails
to set it — or fails to reset it — inherits the previous request's tenant. That
failure is silent, intermittent, and reads as a correct query returning the
wrong tenant's rows. Migrations still multiply by tenant count, and TypeORM's
entity metadata is schema-bound, so dynamic schema switching fights the ORM.

### C. Shared schema with a tenant discriminator

One schema; every tenant-scoped table carries a non-nullable `organization_id`,
and every query filters on it.

Trivial migrations, one connection pool, straightforward cross-tenant
administration. The weakness is the obvious one: **isolation now depends on
every query remembering its filter.** One `find()` without an
`organizationId` and a tenant boundary is gone.

---

## The decision

**Option C — shared schema with a mandatory `organization_id` discriminator,
enforced at several independent layers.**

The reasoning hinges on which failure mode actually occurs in practice.

Options A and B defend against a *query that addresses the wrong database or
schema*. That is not a mistake developers make often — it is hard to do by
accident. The mistake that happens constantly, in every multi-tenant codebase, is
**a query that forgets its tenant filter**. Schema separation does not prevent
that at all: inside a tenant's schema, an unfiltered query over that tenant's
data is perfectly correct, and the bug only appears when the connection's
`search_path` is wrong — at which point the damage is identical.

So the options are not "safe" versus "unsafe". They defend against different
things, and option C's weakness is addressable by construction, while option B's
pooled-connection hazard is not.

The operational costs are also not symmetric. At the scale a platform like this
targets, option A caps tenant count on connection limits alone, and both A and B
turn every schema change into an N-way migration where partial failure leaves the
system in a state with no clean recovery.

---

## What replaces physical separation

Four independent layers. Each is sufficient on its own for the common case;
together they mean a single mistake is not a breach.

### Layer 1 — The organization-context guard

`OrganizationContextGuard` runs on every workspace-scoped request, before any
handler. It resolves the workspace from the `X-Organization-Id` header or the
route parameter, then proves the caller is an **active member** by reading the
database — never by trusting the token's `org` claim.

A non-member receives `ORGANIZATION_NOT_FOUND`, never a 403. Distinguishing
"exists but you may not see it" from "does not exist" would let anyone enumerate
the platform's tenants.

*Consequence:* a handler can never run against a workspace the caller has no
relationship with, regardless of what its queries do.

### Layer 2 — Resolved context, not caller input

Handlers take the workspace id from `request.organization.id`, populated by
layer 1. They never read it from a query parameter or body field.

This matters most on the audit endpoints, where a caller-supplied workspace id
would be the most damaging possible isolation failure — the audit log is a
summary of everything that has ever happened in a workspace.

### Layer 3 — Scoped lookups that 404 rather than 403

Every `findById` in a tenant-scoped service takes the workspace id as part of its
where clause:

```ts
this.roleRepository.findOne({ where: { id: roleId, organizationId } });
```

A role id belonging to another workspace reads as "not found". This is both the
isolation check and an anti-enumeration measure: a 403 would confirm the
resource exists.

### Layer 4 — Database constraints

- `organization_id` is `NOT NULL` on every tenant-scoped table, so a row cannot
  exist unattributed.
- Uniqueness is scoped to the tenant: `UNIQUE (organization_id, slug)` on roles,
  `UNIQUE (organization_id, user_id)` on memberships.
- Foreign keys cascade from `organizations`, so a deleted workspace cannot leave
  orphans pointing into it.
- The audit log's `(organization_id, sequence)` unique index gives each tenant an
  independent hash chain, verifiable and exportable in isolation.

### Deferred: PostgreSQL row-level security

RLS is planned for phase 5 as a fifth layer — policies keyed on
`current_setting('daiap.current_organization_id')`, making a missing filter fail
at the storage engine rather than merely being caught by review.

It is deferred rather than skipped because it needs a per-request session
variable set on a *pooled* connection, which is the same hazard that makes option
B unattractive. Doing it safely requires either a connection-per-request
interceptor or careful `SET LOCAL` handling inside every transaction, and
building that before the access patterns settled would have been premature. The
schema is designed so that adding it later is additive.

---

## Consequences

### Accepted

- **Isolation is a code property, not a physical one.** It is enforced by guards,
  scoped queries and constraints rather than by the storage layer. Review of new
  tenant-scoped repository methods is a standing obligation.
- **A platform administrator can query across tenants.** Necessary for
  operations, and the reason platform-admin access goes through an explicit,
  audited branch (`buildPlatformAdminContext`) rather than a synthesised
  membership.
- **No physical guarantee for compliance regimes that demand one.** A customer
  contractually requiring physical separation would need a dedicated deployment.
  That is a deployment-topology answer, not an application-architecture one.

### Gained

- Migrations run once.
- One connection pool; tenant count is bounded by data volume, not by
  `max_connections`.
- Cross-tenant analytics and administration are ordinary queries.
- New tenant-scoped tables need no per-tenant provisioning step.

### Worth noting

The **vector store takes the opposite decision.** Phase 2 uses one Qdrant
collection per workspace — physical separation — because the trade-offs invert
there: collections are cheap to create, there is no migration cost, and a
retrieval leak is the single most damaging failure this platform can have. The
right isolation mechanism depends on the store, and choosing differently in the
two places is deliberate rather than inconsistent.

---

## Notes for the report

The proposal's wording is satisfied in substance: data from one organization
cannot be accessed by another. The mechanism differs from the literal phrase
"database schema separation", and the reasoning above is the defence.

The strongest version of the argument is that **schema separation does not
actually prevent the failure it appears to prevent.** It defends against a
category of mistake that is rare, at significant operational cost, while leaving
the common mistake — a forgotten tenant filter — as dangerous as ever, and adding
a new one in the form of pooled connection state.
