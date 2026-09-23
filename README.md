# Distributed AI Agent Management Platform — Backend

Backend for a multi-tenant SaaS platform that lets organizations create, deploy
and manage custom AI agents against their own private data, using locally hosted
LLMs and an active PII redaction layer so that sensitive enterprise information
never leaves the organization's control.

Final Year Project · Department of Computer Science, Air University Islamabad
Mohammad Mehran Chaudhary (232433) · Ahmad Hanbal (231653) · Ameer Abdullah (233087)
Supervisor: Ms. Maryam Wardah · Co-Supervisor: Mr. Qaiser Manzoor

---

## Status

**Phase 1 of 5 is implemented** — foundation, identity, multi-tenancy, RBAC and
the tamper-evident audit log. See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
for the full five-phase plan and what each phase delivers.

| Check | Result |
|-------|--------|
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm test` | 184 tests, 7 suites, passing |
| `npm audit` | 0 vulnerabilities |
| Live database run | **not yet verified** — see below |

### Outstanding verification

The migration, seed and live HTTP paths have not been exercised against a real
PostgreSQL instance yet. They compile and are unit-tested, but that is not the
same as having run. Follow the setup below and report anything that breaks —
first-run issues in a schema this size are expected and are quick to fix.

---

## Requirements

| | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.11 | Developed on 22.14 |
| PostgreSQL | ≥ 13 | Needs `gen_random_uuid()`; 17+ recommended |
| Redis | ≥ 6 | |

Docker Compose is provided for both, if you would rather not install them.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start PostgreSQL and Redis

Either use the provided stack:

```bash
docker compose up -d
```

…or point the `.env` in the next step at instances you already have running.

### 3. Create your configuration

```bash
cp .env.example .env
```

Then generate real signing and encryption secrets:

```bash
npm run generate:secrets -- --write
```

This fills in `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`,
`AUDIT_HASH_SECRET`, `PASSWORD_PEPPER` and `COOKIE_SECRET` with 32 bytes of
CSPRNG output each. It never overwrites a value that is already set, because
rotating `AUDIT_HASH_SECRET` invalidates every existing audit record and rotating
`PASSWORD_PEPPER` locks every user out.

Now edit `.env` and set your database credentials:

```ini
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=<your password>
DB_NAME=ai_agent_platform
```

`.env.example` documents every variable, including the ones later phases will
need.

### 4. Create the database

```bash
createdb ai_agent_platform
```

Or, if you are using the Docker stack, it already exists.

### 5. Run migrations and seed

```bash
npm run migration:run
npm run seed
```

The seed synchronises the permission catalogue — required, since
`@RequirePermissions('agent:create')` cannot work if the key does not exist in
the database — and provisions a platform administrator if you set
`PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`.

For a workspace pre-populated with five accounts and two custom roles that
demonstrate the RBAC model, set `SEED_DEMO_DATA=true` before seeding.

### 6. Run

```bash
npm run start:dev
```

| | |
|---|---|
| API | http://localhost:3000/api/v1 |
| Swagger UI | http://localhost:3000/docs |
| OpenAPI JSON | http://localhost:3000/docs-json |
| Health | http://localhost:3000/health |

The OpenAPI document is the contract for the React frontend — generate the client
from `/docs-json` rather than hand-writing request types.

---

## Quick tour

```bash
# Register. Returns an access token and sets an httpOnly refresh cookie.
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery-7","firstName":"Your","lastName":"Name"}'

# Create a workspace. Seeds its four built-in roles and makes you the owner.
curl -X POST http://localhost:3000/api/v1/organizations \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acme Corporation"}'

# Everything workspace-scoped needs the workspace, by id or slug.
curl http://localhost:3000/api/v1/organizations/acme-corporation/members \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'X-Organization-Id: acme-corporation'

# Verify the audit chain has not been tampered with.
curl http://localhost:3000/api/v1/organizations/acme-corporation/audit-logs/verify \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'X-Organization-Id: acme-corporation'
```

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Unit tests |
| `npm run test:cov` | Coverage |
| `npm run lint` | ESLint with `--fix` |
| `npm run migration:run` | Apply pending migrations |
| `npm run migration:revert` | Roll back the last migration |
| `npm run migration:generate -- src/database/migrations/Name` | Generate from entity changes |
| `npm run seed` | Sync permissions, provision admin, optional demo data |
| `npm run db:setup` | Migrate then seed |
| `npm run generate:secrets` | Print fresh secrets (`-- --write` to fill `.env`) |

---

## Architecture

```
src/
├── config/          Typed, Joi-validated configuration namespaces
├── common/          Cross-cutting: guards, decorators, filters, interceptors, utils
├── database/        Entities registry, data source, migrations, seeds
├── shared/          Infrastructure: crypto, redis, mail, logging, request context
└── modules/         Feature modules
    ├── auth/            Sign-in, token rotation, sessions, recovery
    ├── users/           Identities and one-time tokens
    ├── organizations/   Tenants, settings, IP allowlist
    ├── memberships/     Member directory and lifecycle
    ├── invitations/     Workspace invitations
    ├── rbac/            Roles, permissions, effective-permission materialisation
    ├── api-keys/        Machine credentials for service-to-service calls
    ├── audit/           Tamper-evident compliance log
    └── health/          Liveness and readiness probes
```

### Request pipeline

Four global guards run in a deliberate order — the order is a security property,
not a style choice:

1. **RateLimitGuard** — before anything expensive, so a rejected request does not
   pay for a JWT verification and a database lookup.
2. **AuthenticationGuard** — establishes *who*. Fails closed: a route with no
   `@Auth()` or `@Public()` requires a Bearer token.
3. **OrganizationContextGuard** — establishes *which tenant*, and proves
   membership against the database.
4. **PermissionsGuard** — establishes *may they*.

### Response shape

Every response uses one envelope, so the frontend has a single place to read a
correlation id and a single way to detect failure:

```jsonc
// success
{ "success": true, "data": { }, "meta": { "requestId": "…", "timestamp": "…" } }

// failure
{ "success": false,
  "error": { "code": "PERMISSION_DENIED", "message": "…", "details": { } },
  "meta": { "requestId": "…", "timestamp": "…", "path": "…" } }
```

Branch on `error.code`, never on `message`. Codes are stable; messages may be
reworded or localised. `meta.requestId` is also returned as `X-Request-Id` and
written into both the application log and the audit log, so one identifier links
a user's report to the exact server-side trace.

---

## Security notes

Worth knowing before changing anything in this codebase.

- **Routes are protected by default.** No `@Auth()` or `@Public()` means Bearer
  required. Forgetting to protect a new endpoint produces a 401 during
  development rather than a silent hole.
- **Permissions are not in the JWT.** They are resolved per request, so removing
  a member takes effect immediately rather than at token expiry.
- **Refresh tokens rotate, and reuse is detected.** Presenting an already-spent
  token revokes every session in that family and emails the account owner.
- **Nothing recoverable is stored.** Passwords are Argon2id; refresh tokens,
  invitations, reset links and API keys are stored only as HMAC digests.
- **The audit log is hash-chained** and protected by a PostgreSQL trigger that
  rejects UPDATE and DELETE. `/audit-logs/verify` recomputes the chain and names
  the exact sequence number where it breaks.
- **Two independent anti-escalation rules** in RBAC: you cannot grant a
  permission you do not hold, and you cannot act on a member who outranks you.
  The second is not redundant — `member:update` is exactly the permission an
  administrator legitimately has, and without role priority it would be a
  workspace-takeover primitive.
- **Redis fails open; PostgreSQL fails closed.** Caching and rate limiting
  degrade gracefully during a Redis outage; the authoritative checks
  (`users.tokens_valid_from`, membership status) always run against the database.

### Before deploying

```ini
NODE_ENV=production
COOKIE_SECURE=true
COOKIE_SAME_SITE=strict
CORS_ORIGINS=https://your-frontend.example.com   # never *
DB_SSL=true
REDIS_TLS=true
REQUIRE_EMAIL_VERIFICATION=true
MAIL_TRANSPORT=smtp
TRUST_PROXY=<number of proxies in front of the app>
```

All four secrets are **required** in production — the schema refuses to start
without them, and bootstrap throws if it detects a development default.

---

## Documentation

- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — the five-phase
  plan, what each delivers, exit criteria, risks
- [`docs/adr/0001-multi-tenancy.md`](docs/adr/0001-multi-tenancy.md) — why
  row-level tenancy rather than schema-per-tenant, and what replaces the
  guarantee

---

## Known environment notes

- **NestJS 12 ships as pure ESM.** Node 22 can `require()` it, so the compiled
  CommonJS build runs fine — but Jest's own runtime cannot below Node 24.9, which
  is why `jest.config.mjs` runs the suite in native ESM mode via
  `--experimental-vm-modules`.
- **`ora` is pinned via `overrides`** because the Nest CLI crashes on Node 22
  with an ESM require cycle otherwise.
