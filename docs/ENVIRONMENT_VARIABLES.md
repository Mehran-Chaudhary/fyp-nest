# Complete backend environment-variable reference

Audited against `src/config/env.validation.ts` on 28–29 September 2026. **319 schema variables**. Read [the setup guide](ENVIRONMENT.md) first. Defaults here are the schema defaults, not credentials from your `.env`. An empty default does not mean the corresponding feature will work without provider credentials. “Omit” means no schema default. `*` marks one of the **56 keys missing from `.env.example`**.

All settings belong on the NestJS API and, when used, its worker, except hosting port/topology differences explained in the guide. Python-side `DAIAP_SIGNING_SECRET` is a separate implementation convention. The tables enumerate accepted knobs; they do not imply every knob is fully wired into runtime behavior.

Types/constraints are taken from Joi. Duration expressions use milliseconds for bare numbers; prefer explicit units. The full source link for each row contains conditional validation and comments. Secret values are deliberately not shown.

## Application

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`NODE_ENV`](../src/config/env.validation.ts#L95) | development | string: development, test, staging, production | Runtime mode; staging and production require explicit core secrets and prohibit unsafe HTTP-tool options. |
| [`APP_NAME`](../src/config/env.validation.ts#L98) | Distributed AI Agent Management Platform | string | Human-readable product name used in logs, Swagger and mail templates. |
| [`PORT`](../src/config/env.validation.ts#L104) * | omit | number; port | Hosting-injected listener port; APP_PORT overrides it. |
| [`APP_PORT`](../src/config/env.validation.ts#L105) | PORT or 3000 | number; port | API listener port; when omitted uses PORT, otherwise 3000. |
| [`APP_HOST`](../src/config/env.validation.ts#L110) | 0.0.0.0 | string | Listen address: 0.0.0.0 for a hosted/container process; not your public URL. |
| [`APP_GLOBAL_PREFIX`](../src/config/env.validation.ts#L112) | api | string | Mounted in front of every route, e.g. `/api/v1/auth/login`. |
| [`APP_API_VERSION`](../src/config/env.validation.ts#L113) | 1 | string | Default URI version; controllers currently explicitly declare version 1, so changing this alone does not version the whole API. |
| [`APP_URL`](../src/config/env.validation.ts#L115) | http://localhost:3000 | string; uri | Public API base URL used by Swagger server selection. Email action links use FRONTEND_URL. |
| [`FRONTEND_URL`](../src/config/env.validation.ts#L117) | http://localhost:5173 | string; uri | Public base URL of the React frontend. Used for invitation / reset links. |
| [`APP_SHUTDOWN_TIMEOUT`](../src/config/env.validation.ts#L119) | 10s | duration | Configured value; no explicit hard shutdown timer was found in bootstrap. |
| [`REQUEST_TIMEOUT`](../src/config/env.validation.ts#L121) | 30s | duration | Default HTTP request timeout; upload, retrieval and inference routes use their own specialized budgets. |
| [`JSON_BODY_LIMIT`](../src/config/env.validation.ts#L122) | 2mb | string | Configured value; bootstrap does not explicitly apply it as an Express parser limit in this checkout. |

## Logging and Swagger

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`LOG_LEVEL`](../src/config/env.validation.ts#L127) | info | string: fatal, error, warn, info, debug, trace, silent | Minimum log severity; debug for investigation, info for ordinary hosted operation. |
| [`LOG_PRETTY`](../src/config/env.validation.ts#L131) | false | boolean | Human readable coloured logs. Should be false wherever logs are shipped. |
| [`LOG_HTTP_REQUESTS`](../src/config/env.validation.ts#L133) | true | boolean | Emit a log line per HTTP request. |
| [`SWAGGER_ENABLED`](../src/config/env.validation.ts#L134) | true | boolean | Enable the interactive API documentation and generated OpenAPI endpoint. |
| [`SWAGGER_PATH`](../src/config/env.validation.ts#L135) | docs | string | Swagger UI route outside the API prefix, normally /docs. |
| [`SWAGGER_JSON_PATH`](../src/config/env.validation.ts#L137) | docs-json | string | Serves the raw OpenAPI JSON, which the frontend generates its client from. |

## PostgreSQL and row-level security

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`DB_HOST`](../src/config/env.validation.ts#L142) | localhost | string | PostgreSQL hostname only, copied from the provider direct/session connection; localhost for host-based Docker development. |
| [`DB_PORT`](../src/config/env.validation.ts#L143) | 5432 | number; port | PostgreSQL TCP port; use the provider port or mapped local Docker port. |
| [`DB_USERNAME`](../src/config/env.validation.ts#L144) | postgres | string | PostgreSQL login role, not your provider dashboard email. |
| [`DB_PASSWORD`](../src/config/env.validation.ts#L145) | postgres | string | Password of the database login role. Changing dotenv does not change an initialized server password. |
| [`DB_NAME`](../src/config/env.validation.ts#L146) | ai_agent_platform | string | Existing target database; migrations create its tables, not the database itself. |
| [`DB_SCHEMA`](../src/config/env.validation.ts#L147) | public | string | Database schema; keep public for the verified default migration layout. |
| [`DB_SSL`](../src/config/env.validation.ts#L148) | false | boolean | Enable PostgreSQL TLS for managed remote services; false for the supplied local Docker service. |
| [`DB_SSL_REJECT_UNAUTHORIZED`](../src/config/env.validation.ts#L149) | true | boolean | Verify database server certificate; retain true and provide a CA when necessary. |
| [`DB_SSL_CA`](../src/config/env.validation.ts#L151) | empty | string | PEM contents (not a path) of a CA to trust, for managed Postgres providers. |
| [`DB_LOGGING`](../src/config/env.validation.ts#L152) | false | boolean | SQL query logging; normally false to reduce volume and exposure of query details. |
| [`DB_SYNCHRONIZE`](../src/config/env.validation.ts#L157) | false | boolean | Keep false. Migrations own schema; runtime only force-disables this in production. |
| [`DB_MIGRATIONS_RUN`](../src/config/env.validation.ts#L159) | false | boolean | Run pending migrations automatically on boot. Convenient in Docker. |
| [`DB_POOL_MAX`](../src/config/env.validation.ts#L160) | 20 | number; integer; min 1; max 200 | Maximum pooled database connections per process; budget for all API and worker replicas. |
| [`DB_POOL_IDLE_TIMEOUT`](../src/config/env.validation.ts#L161) | 30s | duration | How long an idle pooled database connection is retained. |
| [`DB_CONNECTION_TIMEOUT`](../src/config/env.validation.ts#L162) | 10s | duration | Time budget for establishing a database connection. |
| [`DB_STATEMENT_TIMEOUT`](../src/config/env.validation.ts#L163) | 30s | duration | Server-side statement time budget; protects against excessively long SQL. |
| [`DB_ROW_LEVEL_SECURITY`](../src/config/env.validation.ts#L170) * | true | boolean | Phase 5: bind every pooled connection to the workspace of the request (or job) using it, so PostgreSQL row-level security is a third, independent tenancy layer beneath the guards and the repository filters. Needs a session-mode connection (a direct connection, not a transaction pooler). |
| [`DB_RLS_ROLE`](../src/config/env.validation.ts#L177) * | empty | string | Optional role assumed with `SET ROLE` on every new connection. Only for providers whose login role bypasses RLS (a superuser, or a role with BYPASSRLS such as Supabase's `postgres`): the migration creates `daiap_rls`, a role that cannot. |

## Redis

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`REDIS_URL`](../src/config/env.validation.ts#L186) | empty | string | When set, takes precedence over the discrete REDIS_* settings below. |
| [`REDIS_HOST`](../src/config/env.validation.ts#L187) | localhost | string | Redis hostname when REDIS_URL is not provided. |
| [`REDIS_PORT`](../src/config/env.validation.ts#L188) | 6379 | number; port | Redis TCP port when using discrete connection settings. |
| [`REDIS_USERNAME`](../src/config/env.validation.ts#L189) | empty | string | Redis ACL username from provider; often default; optional for local Redis. |
| [`REDIS_PASSWORD`](../src/config/env.validation.ts#L190) | empty | string | Redis authentication password; blank for the supplied local service. |
| [`REDIS_DB`](../src/config/env.validation.ts#L191) | 0 | number; integer; min 0; max 15 | Logical database index for discrete connection settings; provider must support the index. |
| [`REDIS_TLS`](../src/config/env.validation.ts#L196) | false | boolean | TLS for the Redis connection. The proposal calls for "TLS-secured message brokers" for inter-agent communication; this is the switch that enables it. |
| [`REDIS_TLS_REJECT_UNAUTHORIZED`](../src/config/env.validation.ts#L197) | true | boolean | Verify Redis server certificate; keep true. |
| [`REDIS_TLS_CA`](../src/config/env.validation.ts#L198) | empty | string | Actual CA PEM text when Redis requires a custom trusted certificate. |
| [`REDIS_KEY_PREFIX`](../src/config/env.validation.ts#L199) | daiap: | string | Namespace application keys; use a unique value for dev/test/prod and keep its trailing colon. |
| [`REDIS_CONNECT_TIMEOUT`](../src/config/env.validation.ts#L200) | 10s | duration | Time budget for opening the Redis connection. |
| [`REDIS_MAX_RETRIES_PER_REQUEST`](../src/config/env.validation.ts#L202) | 3 | number; integer; min 0; max 20 | Fail fast rather than queueing commands when Redis is unreachable. |

## JWT

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`JWT_ACCESS_SECRET`](../src/config/env.validation.ts#L31) | insecure dev fallback; generate your own | string; min 32 | Generate; signing secret for access tokens. Required in staging/production. Keep distinct from refresh secret. |
| [`JWT_REFRESH_SECRET`](../src/config/env.validation.ts#L32) | insecure dev fallback; generate your own | string; min 32 | Generate; signing secret for refresh tokens. Required in staging/production. |
| [`JWT_ACCESS_TTL`](../src/config/env.validation.ts#L210) | 15m | duration | Short by design. Revocation latency is bounded by this value. |
| [`JWT_REFRESH_TTL`](../src/config/env.validation.ts#L211) | 30d | duration | Refresh-session/token lifetime; access tokens retain their separate shorter lifetime. |
| [`JWT_ISSUER`](../src/config/env.validation.ts#L212) | daiap | string | Expected token issuer; keep consistent across replicas and verifiers. |
| [`JWT_AUDIENCE`](../src/config/env.validation.ts#L213) | daiap-api | string | Expected token audience; keep consistent across replicas and verifiers. |
| [`JWT_ALGORITHM`](../src/config/env.validation.ts#L214) | HS256 | string: HS256, HS384, HS512 | Symmetric JWT signing algorithm; must match all token issuers/verifiers. |
| [`JWT_CLOCK_TOLERANCE`](../src/config/env.validation.ts#L216) | 5 | number; integer; min 0; max 300 | Tolerance for clock drift between this service and any token verifier. |

## Security and authentication

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`PASSWORD_HASH_ALGORITHM`](../src/config/env.validation.ts#L221) | argon2id | string: argon2id, scrypt | Use argon2id normally; scrypt is the implemented alternative. This does not remove the installed Argon2 dependency. |
| [`ARGON2_MEMORY_COST`](../src/config/env.validation.ts#L223) | 65536 | number; integer; min 8192; max 1048576 | Argon2 memory cost in KiB. 65536 KiB = 64 MiB, the OWASP baseline. |
| [`ARGON2_TIME_COST`](../src/config/env.validation.ts#L224) | 3 | number; integer; min 2; max 10 | Argon2 iterations per hash; larger values increase sign-in CPU cost. |
| [`ARGON2_PARALLELISM`](../src/config/env.validation.ts#L225) | 4 | number; integer; min 1; max 16 | Argon2 parallel lanes; tune with actual host capacity. |
| [`PASSWORD_MIN_LENGTH`](../src/config/env.validation.ts#L226) | 12 | number; integer; min 8; max 128 | Minimum accepted new-password length; keep strong enough for the deployment. |
| [`PASSWORD_MAX_LENGTH`](../src/config/env.validation.ts#L227) | 128 | number; integer; min 64; max 1024 | Maximum accepted new-password length. |
| [`PASSWORD_REQUIRE_UPPERCASE`](../src/config/env.validation.ts#L228) | true | boolean | Require at least one uppercase character in new passwords. |
| [`PASSWORD_REQUIRE_LOWERCASE`](../src/config/env.validation.ts#L229) | true | boolean | Require at least one lowercase character in new passwords. |
| [`PASSWORD_REQUIRE_NUMBER`](../src/config/env.validation.ts#L230) | true | boolean | Require at least one digit in new passwords. |
| [`PASSWORD_REQUIRE_SYMBOL`](../src/config/env.validation.ts#L231) | false | boolean | Whether new passwords must contain a symbol. |
| [`PASSWORD_PEPPER`](../src/config/env.validation.ts#L237) | empty | string | Optional server-side pepper mixed into every password hash. Because it lives outside the database, a stolen dump alone is not enough to mount an offline attack. Changing it invalidates every stored password, so rotate with care. |
| [`ENCRYPTION_KEY`](../src/config/env.validation.ts#L33) | insecure dev fallback; generate your own | string; min 32 | Generate before creating data; master key for encrypted values and wrapped data keys. Preserve for existing data. |
| [`AUDIT_HASH_SECRET`](../src/config/env.validation.ts#L34) | insecure dev fallback; generate your own | string; min 32 | Generate before creating audit data; preserve to verify existing hash chains. |
| [`MAX_FAILED_LOGIN_ATTEMPTS`](../src/config/env.validation.ts#L244) | 5 | number; integer; min 3; max 50 | Failed attempts within the configured window before account lockout. |
| [`ACCOUNT_LOCKOUT_DURATION`](../src/config/env.validation.ts#L245) | 15m | duration | How long an account remains locked after the failure threshold. |
| [`LOGIN_ATTEMPT_WINDOW`](../src/config/env.validation.ts#L247) | 15m | duration | Sliding window over which failed sign-in attempts accumulate. |
| [`EMAIL_VERIFICATION_TTL`](../src/config/env.validation.ts#L249) | 24h | duration | Lifetime of email verification action tokens. |
| [`PASSWORD_RESET_TTL`](../src/config/env.validation.ts#L250) | 1h | duration | Lifetime of password reset action tokens. |
| [`INVITATION_TTL`](../src/config/env.validation.ts#L251) | 7d | duration | Lifetime of workspace invitation tokens. |
| [`REQUIRE_EMAIL_VERIFICATION`](../src/config/env.validation.ts#L253) | false | boolean | Require a verified email address before a user may do anything meaningful. |
| [`API_KEY_PREFIX`](../src/config/env.validation.ts#L255) | daiap_sk | string | Public identifying prefix on issued application API keys, not a provider credential. |
| [`API_KEY_DEFAULT_TTL`](../src/config/env.validation.ts#L256) | 365d | duration | Default expiry for newly issued workspace API keys. |
| [`REFRESH_TOKEN_COOKIE_ENABLED`](../src/config/env.validation.ts#L259) | true | boolean | httpOnly cookie carrying the refresh token, when cookie mode is enabled. |
| [`REFRESH_TOKEN_COOKIE_NAME`](../src/config/env.validation.ts#L260) | daiap_rt | string | Name of the HTTP-only refresh cookie; keep frontend/session behavior aligned. |
| [`REFRESH_TOKEN_COOKIE_DOMAIN`](../src/config/env.validation.ts#L261) | empty | string | Empty creates a host-only cookie; configure broader domain scope only deliberately. |
| [`COOKIE_SECURE`](../src/config/env.validation.ts#L262) | false | boolean | Require HTTPS for refresh cookies; true for HTTPS production, false for local HTTP. |
| [`COOKIE_SAME_SITE`](../src/config/env.validation.ts#L263) | lax | string: lax, strict, none | Browser same-site policy; choose lax/strict for suitable same-site deployments, none plus Secure when cross-site is required. |
| [`COOKIE_SECRET`](../src/config/env.validation.ts#L265) | empty | string | Signs cookies. Falls back to the access-token secret when unset. |
| [`CORS_ORIGINS`](../src/config/env.validation.ts#L268) | http://localhost:5173,http://localhost:3000 | string | Comma-separated origin list, or `*` to allow any origin (development only). |
| [`CORS_CREDENTIALS`](../src/config/env.validation.ts#L269) | true | boolean | Allow credentialed browser requests; pair with exact trusted origins and frontend credentials settings. |
| [`TRUST_PROXY`](../src/config/env.validation.ts#L275) | 1 | alternatives | Number of reverse proxies in front of the app. Required for correct client IP resolution, which the IP allowlist and rate limiter both depend on. |
| [`ENFORCE_IP_ALLOWLIST`](../src/config/env.validation.ts#L279) | true | boolean | Master switch for per-workspace IP allowlisting (proposal module 6.1). |
| [`HELMET_ENABLED`](../src/config/env.validation.ts#L280) | true | boolean | Enable HTTP security-header middleware. |
| [`HSTS_MAX_AGE`](../src/config/env.validation.ts#L282) | 15552000 | number; integer; min 0 | Strict-Transport-Security max-age. Only meaningful behind HTTPS. |

## MFA

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`MFA_ISSUER`](../src/config/env.validation.ts#L286) * | DAIAP | string; max 64 | The account label authenticator apps show next to the six-digit code. |
| [`MFA_CHALLENGE_TTL`](../src/config/env.validation.ts#L291) * | 5m | duration | How long the second step of a sign-in may take once the password was right. |
| [`MFA_MAX_ATTEMPTS`](../src/config/env.validation.ts#L293) * | 5 | number; integer; min 1; max 20 | Wrong codes accepted per sign-in challenge before it is withdrawn. |
| [`MFA_RECOVERY_CODES`](../src/config/env.validation.ts#L295) * | 10 | number; integer; min 4; max 20 | Single-use recovery codes issued at enrolment. |
| [`MFA_REQUIRED_FOR_PLATFORM_ADMINS`](../src/config/env.validation.ts#L297) * | false | boolean | Platform administrators must hold an MFA-verified session to act as one. |

## Breached-password screening

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`PASSWORD_BREACH_CHECK`](../src/config/env.validation.ts#L306) * | enforce | string: off, warn, enforce | `enforce` refuses passwords found in known breaches, `warn` accepts them and records the fact, `off` never asks. Only the first five hex characters of the password's SHA-1 ever leave the platform (k-anonymity), and the lookup fails open: an outage of the range service never blocks a sign-up. |
| [`PASSWORD_BREACH_API_URL`](../src/config/env.validation.ts#L307) * | https://api.pwnedpasswords.com | string; uri | Base URL of the k-anonymity breached-password range service; not a database password endpoint. |
| [`PASSWORD_BREACH_TIMEOUT`](../src/config/env.validation.ts#L310) * | 3s | duration | Maximum wait for a breach lookup; service failure behavior is implemented by the breach checker. |
| [`PASSWORD_BREACH_MIN_OCCURRENCES`](../src/config/env.validation.ts#L312) * | 1 | number; integer; min 1; max 1000000 | Breach appearances at or above which a password is refused. |

## Request throttling

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`THROTTLE_ENABLED`](../src/config/env.validation.ts#L317) | true | boolean | Master HTTP rate-limit switch; leave enabled outside deliberately isolated tests. |
| [`THROTTLE_TTL`](../src/config/env.validation.ts#L319) | 60s | duration | Global default: requests per window, per principal. |
| [`THROTTLE_LIMIT`](../src/config/env.validation.ts#L320) | 120 | number; integer; min 1 | Maximum general requests per matching THROTTLE_TTL window. |
| [`THROTTLE_AUTH_TTL`](../src/config/env.validation.ts#L322) | 15m | duration | Deliberately tight bucket for credential-handling endpoints. |
| [`THROTTLE_AUTH_LIMIT`](../src/config/env.validation.ts#L323) | 10 | number; integer; min 1 | Maximum auth requests per matching THROTTLE_AUTH_TTL window. |
| [`THROTTLE_REFRESH_TTL`](../src/config/env.validation.ts#L325) | 15m | duration | Window for access token renewal (`POST /auth/refresh`), counted per session. |
| [`THROTTLE_REFRESH_LIMIT`](../src/config/env.validation.ts#L326) | 60 | number; integer; min 1 | Maximum token renewals per session per THROTTLE_REFRESH_TTL window. The web app renews on every page load. |
| [`THROTTLE_EMAIL_TTL`](../src/config/env.validation.ts#L328) | 1h | duration | Bucket for endpoints that send email, to prevent using us as a spam relay. |
| [`THROTTLE_EMAIL_LIMIT`](../src/config/env.validation.ts#L329) | 5 | number; integer; min 1 | Maximum email requests per matching THROTTLE_EMAIL_TTL window. |
| [`THROTTLE_UPLOAD_TTL`](../src/config/env.validation.ts#L331) | 1h | duration | Document uploads: each one costs storage, parsing and embedding compute. |
| [`THROTTLE_UPLOAD_LIMIT`](../src/config/env.validation.ts#L332) | 100 | number; integer; min 1 | Maximum upload requests per matching THROTTLE_UPLOAD_TTL window. |
| [`THROTTLE_RAG_TTL`](../src/config/env.validation.ts#L334) | 60s | duration | Retrieval queries: each one costs an embedding call and a vector search. |
| [`THROTTLE_RAG_LIMIT`](../src/config/env.validation.ts#L335) | 60 | number; integer; min 1 | Maximum rag requests per matching THROTTLE_RAG_TTL window. |
| [`THROTTLE_INFERENCE_TTL`](../src/config/env.validation.ts#L337) | 60s | duration | Agent turns and direct model calls: each holds a GPU slot for seconds. |
| [`THROTTLE_INFERENCE_LIMIT`](../src/config/env.validation.ts#L338) | 20 | number; integer; min 1 | Maximum inference requests per matching THROTTLE_INFERENCE_TTL window. |
| [`THROTTLE_PII_TTL`](../src/config/env.validation.ts#L340) | 60s | duration | PII analysis previews and redaction reports. |
| [`THROTTLE_PII_LIMIT`](../src/config/env.validation.ts#L341) | 30 | number; integer; min 1 | Maximum pii requests per matching THROTTLE_PII_TTL window. |
| [`THROTTLE_WORKFLOW_TTL`](../src/config/env.validation.ts#L343) | 60s | duration | Workflow run starts: each one can fan out into many model and tool calls. |
| [`THROTTLE_WORKFLOW_LIMIT`](../src/config/env.validation.ts#L344) | 30 | number; integer; min 1 | Maximum workflow requests per matching THROTTLE_WORKFLOW_TTL window. |

## Object storage and uploads

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`STORAGE_S3_BUCKET`](../src/config/env.validation.ts#L350) | empty | string | Name of an existing private S3 bucket; setting this enables the storage client. |
| [`STORAGE_S3_ENDPOINT`](../src/config/env.validation.ts#L352) | empty | string; uri | S3 API endpoint (not a public bucket/download URL). Empty uses AWS resolution. |
| [`STORAGE_S3_REGION`](../src/config/env.validation.ts#L353) | auto | string | Provider region; auto for R2. |
| [`STORAGE_S3_ACCESS_KEY_ID`](../src/config/env.validation.ts#L354) | empty | string | S3 access key from storage provider; when omitted SDK default credentials may apply. |
| [`STORAGE_S3_SECRET_ACCESS_KEY`](../src/config/env.validation.ts#L355) | empty | string | S3 secret access key; pair with access key ID. |
| [`STORAGE_S3_FORCE_PATH_STYLE`](../src/config/env.validation.ts#L357) | false | boolean | Path-style addressing. Required by MinIO and some B2 setups. |
| [`STORAGE_S3_SERVER_SIDE_ENCRYPTION`](../src/config/env.validation.ts#L359) | empty | string: empty, AES256, aws:kms | Provider-side encryption on top of the application-level encryption. |
| [`STORAGE_KEY_PREFIX`](../src/config/env.validation.ts#L363) | daiap/ | string | Prefix for every object key, so one bucket can serve several deployments. |
| [`UPLOAD_MAX_FILE_SIZE`](../src/config/env.validation.ts#L367) | 50mb | byte size | Maximum file bytes per upload, held in memory by this upload implementation. |
| [`UPLOAD_ALLOWED_TYPES`](../src/config/env.validation.ts#L369) | pdf,docx,txt,md | string | Comma-separated subset of: pdf, docx, txt, md. |
| [`UPLOAD_REQUEST_TIMEOUT`](../src/config/env.validation.ts#L373) | 120s | duration | Upload requests stream up to UPLOAD_MAX_FILE_SIZE, so they get a longer budget. |
| [`STORAGE_QUOTA_PER_ORGANIZATION`](../src/config/env.validation.ts#L375) | 1gb | byte size | Total document bytes one workspace may store. Zero means unlimited. |

## AI service and its TLS client

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`AI_SERVICE_URL`](../src/config/env.validation.ts#L380) | empty | string; uri | Root URL of the custom contract-compatible AI service; client appends /v1 routes. |
| [`AI_SERVICE_SIGNING_SECRET`](../src/config/env.validation.ts#L385) | empty | string | Generate and share with the AI implementation. Set explicitly when AI_SERVICE_URL is configured; use >=32 characters. |
| [`AI_SERVICE_KEY_ID`](../src/config/env.validation.ts#L403) | v1 | string | Identifies which secret signed a request, so the secret can be rotated. |
| [`AI_SERVICE_TLS_CERT`](../src/config/env.validation.ts#L412) * | empty | string | Phase 5 — mutual TLS to the AI service. The client certificate and key this backend presents (both or neither), the CA that signed the AI service's server certificate (when it is a private CA), and the name to verify on it when that differs from the URL's host. |
| [`AI_SERVICE_TLS_KEY`](../src/config/env.validation.ts#L413) * | empty | string | Client private-key PEM contents paired with the client certificate; keep secret. |
| [`AI_SERVICE_TLS_KEY_PASSPHRASE`](../src/config/env.validation.ts#L414) * | empty | string | Passphrase only when the client private key is encrypted. |
| [`AI_SERVICE_TLS_CA`](../src/config/env.validation.ts#L415) * | empty | string | Trusted server CA PEM for a private certificate authority; supports the client PEM decoder. |
| [`AI_SERVICE_TLS_SERVERNAME`](../src/config/env.validation.ts#L416) * | empty | string; hostname | Server certificate name to verify when it differs from the URL hostname. |
| [`AI_SERVICE_TIMEOUT`](../src/config/env.validation.ts#L417) | 30s | duration | Default AI call timeout; document parsing uses its separate longer budget. |
| [`AI_SERVICE_PARSE_TIMEOUT`](../src/config/env.validation.ts#L419) | 300s | duration | Parsing a long scanned PDF can legitimately take minutes. |
| [`AI_SERVICE_MAX_RETRIES`](../src/config/env.validation.ts#L420) | 2 | number; integer; min 0; max 5 | Retry count for retryable AI service failures. |
| [`AI_SERVICE_MAX_RESPONSE_SIZE`](../src/config/env.validation.ts#L421) | 64mb | byte size | Maximum accepted AI-service response bytes, including parse/embedding results. |
| [`AI_SERVICE_CIRCUIT_THRESHOLD`](../src/config/env.validation.ts#L422) | 5 | number; integer; min 1; max 100 | Consecutive dependency failures before the AI_SERVICE circuit opens. |
| [`AI_SERVICE_CIRCUIT_COOLDOWN`](../src/config/env.validation.ts#L423) | 30s | duration | Pause before probing recovery after the AI_SERVICE dependency circuit opens. |

## Qdrant and embeddings

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`QDRANT_URL`](../src/config/env.validation.ts#L428) | empty | string; uri | Cluster REST URL. Empty disables vector-store capability. |
| [`QDRANT_API_KEY`](../src/config/env.validation.ts#L429) | empty | string | Database API key from Qdrant, not its cloud-management key. |
| [`QDRANT_COLLECTION_PREFIX`](../src/config/env.validation.ts#L430) | daiap_ | string | Collection namespace; use separate dev/test/prod prefixes and do not change against existing data casually. |
| [`QDRANT_TENANCY`](../src/config/env.validation.ts#L440) | collection | string: collection, shared | `collection` — one collection per workspace: physical isolation at the vector layer. `shared` — one collection, partitioned by a tenant-indexed payload field: Qdrant's recommendation once workspaces number in the hundreds. The mandatory tenant filter applies in both modes. |
| [`QDRANT_TIMEOUT`](../src/config/env.validation.ts#L441) | 15s | duration | Qdrant request time budget. |
| [`QDRANT_QUANTIZATION`](../src/config/env.validation.ts#L443) | scalar | string: scalar, none | int8 scalar quantisation: ~4x less vector memory, with rescoring. |
| [`QDRANT_CIRCUIT_THRESHOLD`](../src/config/env.validation.ts#L444) | 5 | number; integer; min 1; max 100 | Consecutive dependency failures before the QDRANT circuit opens. |
| [`QDRANT_CIRCUIT_COOLDOWN`](../src/config/env.validation.ts#L445) | 20s | duration | Pause before probing recovery after the QDRANT dependency circuit opens. |
| [`EMBEDDING_MODEL`](../src/config/env.validation.ts#L446) | nomic-embed-text | string; max 128 | Exact model label sent to and expected back from the custom AI service. |
| [`EMBEDDING_DIMENSIONS`](../src/config/env.validation.ts#L447) | 768 | number; integer; min 8; max 8192 | Exact vector length returned by that model; must match collection configuration. |
| [`EMBEDDING_BATCH_SIZE`](../src/config/env.validation.ts#L448) | 32 | number; integer; min 1; max 512 | Number of texts per embedding batch; align with AI-service capacity. |

## Queues and ingestion

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`QUEUE_PREFIX`](../src/config/env.validation.ts#L454) | empty | string | Defaults to `${REDIS_KEY_PREFIX}bull`. |
| [`QUEUE_WORKERS_ENABLED`](../src/config/env.validation.ts#L463) | true | boolean | Whether this process consumes jobs. `true` suits a single-service deployment; set `false` on the API and run `npm run start:worker` separately to scale ingestion independently. |
| [`QUEUE_DRAIN_DELAY`](../src/config/env.validation.ts#L471) | 5s | duration; 1s to 5m | How long an idle worker waits on Redis before polling again. A new job wakes it at once, so this only sets idle traffic: measured ~600 commands/minute at 5s/30s and ~350 at 60s/120s. BullMQ still polls a queue holding a scheduled job at least every 10 seconds, so a per-command free tier (Upstash) cannot carry an always-on deployment. |
| [`QUEUE_STALLED_INTERVAL`](../src/config/env.validation.ts#L476) | 30s | duration; 5s to 10m | How often each worker checks for jobs whose worker died. The engines also sweep for stalled work in PostgreSQL. `120s` pairs with a `60s` drain delay. |
| [`INGESTION_CONCURRENCY`](../src/config/env.validation.ts#L477) | 2 | number; integer; min 1; max 32 | Concurrent document jobs per worker process. |
| [`INGESTION_MAX_ATTEMPTS`](../src/config/env.validation.ts#L478) | 5 | number; integer; min 1; max 20 | Maximum attempts for retryable document ingestion jobs. |
| [`INGESTION_BACKOFF_DELAY`](../src/config/env.validation.ts#L479) | 15s | duration | Initial delay between ingestion retries. |
| [`INGESTION_JOB_TIMEOUT`](../src/config/env.validation.ts#L480) | 30m | duration | Overall ingestion job time budget. |
| [`INGESTION_MAX_CHUNKS`](../src/config/env.validation.ts#L481) | 20000 | number; integer; min 1; max 200000 | Maximum chunks permitted for a single document. |
| [`CHUNK_SIZE_DEFAULT`](../src/config/env.validation.ts#L482) | 512 | number; integer; min 64; max 4096 | Default parser chunk length in embedding-model tokens. |
| [`CHUNK_OVERLAP_DEFAULT`](../src/config/env.validation.ts#L483) | 64 | number; integer; min 0; max 1024 | Default token overlap between chunks; keep below the selected chunk size. |
| [`MAINTENANCE_SWEEP_INTERVAL`](../src/config/env.validation.ts#L484) | 5m | duration | Interval for knowledge ingestion/cleanup maintenance sweeps. |
| [`INGESTION_STALL_THRESHOLD`](../src/config/env.validation.ts#L486) | 45m | duration | A document in-flight this long without progress is considered stalled. |
| [`ORGANIZATION_PURGE_GRACE`](../src/config/env.validation.ts#L488) | 7d | duration | Grace period before a deleted workspace's documents are destroyed. |

## Retrieval

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`RAG_DEFAULT_TOP_K`](../src/config/env.validation.ts#L493) | 8 | number; integer; min 1; max 100 | Default number of final retrieved passages. |
| [`RAG_MAX_TOP_K`](../src/config/env.validation.ts#L494) | 50 | number; integer; min 1; max 200 | Maximum allowed requested passage count. |
| [`RAG_SEARCH_MODE`](../src/config/env.validation.ts#L496) | hybrid | string: hybrid, dense | `hybrid` fuses dense and lexical (BM25) results; `dense` is vectors only. |
| [`RAG_CANDIDATE_MULTIPLIER`](../src/config/env.validation.ts#L498) | 4 | number; integer; min 1; max 20 | Candidates fetched per final result when reranking. |
| [`RAG_RERANK_ENABLED`](../src/config/env.validation.ts#L499) | false | boolean | Enable AI-service /v1/rerank; only enable when implemented and tested. |
| [`RAG_MAX_QUERY_LENGTH`](../src/config/env.validation.ts#L500) | 2000 | number; integer; min 16; max 16384 | Maximum retrieval query characters. |
| [`RAG_AUDIT_WITHHELD`](../src/config/env.validation.ts#L505) | true | boolean | Also record *what the access policy withheld* from each query — document ids only, never content — so an auditor can see the policy working. |
| [`RAG_WITHHELD_SCORE_THRESHOLD`](../src/config/env.validation.ts#L506) | 0.35 | number; min 0; max 1 | Relevance threshold used for withheld-result audit reporting. |
| [`RAG_REQUEST_TIMEOUT`](../src/config/env.validation.ts#L507) | 60s | duration | HTTP time budget for retrieval endpoints. |

## LLM gateway and its TLS client

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`LLM_PROVIDER`](../src/config/env.validation.ts#L514) | ollama | string: ollama, openai | `ollama`: Ollama's native API. `openai`: any OpenAI-compatible server. |
| [`LLM_BASE_URL`](../src/config/env.validation.ts#L515) | empty | string; uri | Ollama server root or compatible API base including its /v1 path. Empty disables inference. |
| [`LLM_API_KEY`](../src/config/env.validation.ts#L517) | empty | string | Bearer token for an authenticating proxy, Ollama Cloud or a hosted API. |
| [`LLM_DEFAULT_MODEL`](../src/config/env.validation.ts#L518) | llama3.1:8b | string; max 200 | Exact installed/provider model ID used absent narrower workspace/agent choice. |
| [`LLM_ALLOWED_MODELS`](../src/config/env.validation.ts#L520) | empty | string | Comma-separated platform allowlist. Empty: whatever the endpoint serves. |
| [`LLM_DEFAULT_CONTEXT_WINDOW`](../src/config/env.validation.ts#L521) | 8192 | number; integer; min 512; max 1048576 | Fallback model context capacity in tokens; coordinate with model and agent turn quota. |
| [`LLM_MAX_CONTEXT_WINDOW`](../src/config/env.validation.ts#L523) | 32768 | number; integer; min 512; max 1048576 | Ceiling on the context window requested from the model (bounds GPU memory). |
| [`LLM_DEFAULT_MAX_OUTPUT_TOKENS`](../src/config/env.validation.ts#L524) | 1024 | number; integer; min 16; max 65536 | Default requested generation length in tokens. |
| [`LLM_MAX_OUTPUT_TOKENS`](../src/config/env.validation.ts#L525) | 4096 | number; integer; min 16; max 65536 | Platform ceiling on generated tokens per call. |
| [`LLM_DEFAULT_TEMPERATURE`](../src/config/env.validation.ts#L526) | 0.3 | number; min 0; max 2 | Default generation randomness parameter; provider/model must support it. |
| [`LLM_FIRST_TOKEN_TIMEOUT`](../src/config/env.validation.ts#L528) | 120s | duration | Until the first token: generous, because it includes loading the model. |
| [`LLM_IDLE_TIMEOUT`](../src/config/env.validation.ts#L529) | 30s | duration | Maximum gap while waiting for more streamed model output. |
| [`LLM_MAX_DURATION`](../src/config/env.validation.ts#L530) | 240s | duration | Maximum generation duration; coordinate HTTP, workflow and quota reservation budgets. |
| [`LLM_REQUEST_TIMEOUT`](../src/config/env.validation.ts#L532) | 300s | duration | HTTP budget of the inference routes. Must exceed LLM_MAX_DURATION. |
| [`LLM_MAX_CONCURRENCY`](../src/config/env.validation.ts#L534) | 4 | number; integer; min 1; max 256 | Concurrent generations per process. One GPU serves only a few at once. |
| [`LLM_QUEUE_TIMEOUT`](../src/config/env.validation.ts#L535) | 30s | duration | Time a model request may wait for local concurrency capacity. |
| [`LLM_MAX_RETRIES`](../src/config/env.validation.ts#L536) | 1 | number; integer; min 0; max 5 | Retry count for retryable provider failures. |
| [`LLM_MAX_RESPONSE_SIZE`](../src/config/env.validation.ts#L537) | 4mb | byte size | Maximum model response bytes accepted by the gateway. |
| [`LLM_CIRCUIT_THRESHOLD`](../src/config/env.validation.ts#L538) | 5 | number; integer; min 1; max 100 | Consecutive dependency failures before the LLM circuit opens. |
| [`LLM_CIRCUIT_COOLDOWN`](../src/config/env.validation.ts#L539) | 30s | duration | Pause before probing recovery after the LLM dependency circuit opens. |
| [`LLM_KEEP_ALIVE`](../src/config/env.validation.ts#L541) | 30m | string | Ollama only: how long a model stays loaded after a request. |
| [`LLM_MAX_CLASSIFICATION`](../src/config/env.validation.ts#L548) | RESTRICTED | string: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED | The most sensitive classification whose masked content may be sent to this endpoint. RESTRICTED for a model you host; lower for a third party. |
| [`LLM_MODEL_CACHE_TTL`](../src/config/env.validation.ts#L551) | 60s | duration | Lifetime of cached provider model catalogue data. |
| [`LLM_TLS_CERT`](../src/config/env.validation.ts#L553) * | empty | string | Phase 5 — mutual TLS to a self-hosted model endpoint (a proxy that checks client certificates). |
| [`LLM_TLS_KEY`](../src/config/env.validation.ts#L554) * | empty | string | Client private-key PEM contents paired with the client certificate; keep secret. |
| [`LLM_TLS_KEY_PASSPHRASE`](../src/config/env.validation.ts#L555) * | empty | string | Passphrase only when the client private key is encrypted. |
| [`LLM_TLS_CA`](../src/config/env.validation.ts#L556) * | empty | string | Trusted server CA PEM for a private certificate authority; supports the client PEM decoder. |

## PII detection

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`PII_NER_PROVIDER`](../src/config/env.validation.ts#L566) | ai-service | string: ai-service, presidio, none | Where names and other free-text entities are detected. `ai-service`: the Python AI service's /v1/pii/analyze (HMAC-signed). `presidio`: a stock Presidio analyzer. `none`: validated pattern recognizers only. |
| [`PRESIDIO_ANALYZER_URL`](../src/config/env.validation.ts#L569) | empty | string; uri | Analyzer server root, required when PII_NER_PROVIDER=presidio; usually private infrastructure. |
| [`PRESIDIO_API_KEY`](../src/config/env.validation.ts#L570) | empty | string | Bearer credential for an authenticating analyzer proxy, if one is used. |
| [`PRESIDIO_CONCURRENCY`](../src/config/env.validation.ts#L571) | 4 | number; integer; min 1; max 32 | Maximum parallel analyzer requests. |
| [`PII_TIMEOUT`](../src/config/env.validation.ts#L572) | 10s | duration | Time budget for name/entity detection calls. |
| [`PII_DEFAULT_ENTITIES`](../src/config/env.validation.ts#L573) | PERSON,EMAIL_ADDRESS,PHONE_NUMBER,CREDIT_CARD,IBAN_CODE,US_SSN,PK_CNIC,IP_ADDRESS,SALARY,CREDENTIAL | string | Comma-separated default entity types to detect; saved workspace policies can differ. |
| [`PII_DEFAULT_ON_FAILURE`](../src/config/env.validation.ts#L579) | REFUSE | string: REFUSE, DEGRADE_TO_PATTERNS | REFUSE: fail closed. DEGRADE_TO_PATTERNS: continue with pattern recognizers only. |
| [`PII_SCORE_THRESHOLD`](../src/config/env.validation.ts#L582) | 0.5 | number; min 0; max 1 | Minimum accepted detector confidence score. |
| [`PII_LANGUAGE`](../src/config/env.validation.ts#L583) | en | string | Language code supplied to the NER detector; the selected model must support it. |
| [`PII_DETECTION_CACHE_TTL`](../src/config/env.validation.ts#L587) | 1h | duration | NER results cached by keyed fingerprint (never text). 0 disables. |
| [`PII_CIRCUIT_THRESHOLD`](../src/config/env.validation.ts#L588) | 5 | number; integer; min 1; max 100 | Consecutive dependency failures before the PII circuit opens. |
| [`PII_CIRCUIT_COOLDOWN`](../src/config/env.validation.ts#L589) | 30s | duration | Pause before probing recovery after the PII dependency circuit opens. |
| [`PII_MAX_ANALYZE_LENGTH`](../src/config/env.validation.ts#L590) | 20000 | number; integer; min 100; max 200000 | Maximum text characters for a PII analysis request. |

## Agent memory

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`AGENT_MEMORY_MAX_MESSAGES`](../src/config/env.validation.ts#L595) | 20 | number; integer; min 0; max 500 | Default number of historical messages available to a turn. |
| [`AGENT_MEMORY_MAX_MESSAGES_CEILING`](../src/config/env.validation.ts#L596) | 100 | number; integer; min 0; max 500 | Platform maximum for configurable agent message history. |
| [`AGENT_MEMORY_MAX_TOKENS`](../src/config/env.validation.ts#L597) | 3000 | number; integer; min 0; max 262144 | Token budget for conversation history supplied to a model. |
| [`AGENT_CONTEXT_MAX_TOKENS`](../src/config/env.validation.ts#L598) | 3000 | number; integer; min 0; max 262144 | Token budget for retrieved reference passages in an agent prompt. |
| [`AGENT_MAX_MESSAGE_LENGTH`](../src/config/env.validation.ts#L599) | 16000 | number; integer; min 100; max 100000 | Maximum user-message characters accepted by agent runtime. |

## Workflow engine

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`WORKFLOW_MAX_NODES`](../src/config/env.validation.ts#L605) | 50 | number; integer; min 2; max 500 | Maximum nodes in a workflow definition. |
| [`WORKFLOW_MAX_EDGES`](../src/config/env.validation.ts#L606) | 150 | number; integer; min 1; max 2000 | Maximum edges in a workflow definition. |
| [`WORKFLOW_MAX_STEPS`](../src/config/env.validation.ts#L608) | 100 | number; integer; min 2; max 10000 | Steps one run may schedule, loops included. The runaway-loop stop. |
| [`WORKFLOW_MAX_LOOP_ITERATIONS`](../src/config/env.validation.ts#L609) | 10 | number; integer; min 1; max 1000 | Maximum allowed workflow loop iterations. |
| [`WORKFLOW_MAX_SUPERVISOR_ROUNDS`](../src/config/env.validation.ts#L610) | 12 | number; integer; min 1; max 200 | Maximum supervisor-team rounds in a run. |
| [`WORKFLOW_MAX_INPUT_SIZE`](../src/config/env.validation.ts#L611) | 64kb | byte size | Maximum serialized run input bytes. |
| [`WORKFLOW_MAX_STEP_OUTPUT_SIZE`](../src/config/env.validation.ts#L612) | 256kb | byte size | Maximum serialized output bytes for a workflow step. |
| [`WORKFLOW_RUN_TIMEOUT`](../src/config/env.validation.ts#L613) | 30m | duration | Overall workflow run time budget. |
| [`WORKFLOW_STEP_TIMEOUT`](../src/config/env.validation.ts#L615) | 10m | duration | One step may make several model calls (tool use), so this exceeds LLM_MAX_DURATION. |
| [`WORKFLOW_STEP_MAX_ATTEMPTS`](../src/config/env.validation.ts#L616) | 3 | number; integer; min 1; max 10 | Maximum attempts for a retryable workflow step. |
| [`WORKFLOW_STEP_BACKOFF`](../src/config/env.validation.ts#L617) | 10s | duration | Initial retry delay for a workflow step. |
| [`WORKFLOW_STEP_BACKOFF_MAX`](../src/config/env.validation.ts#L618) | 5m | duration | Maximum retry backoff delay. |
| [`WORKFLOW_CONCURRENCY`](../src/config/env.validation.ts#L619) | 4 | number; integer; min 1; max 64 | Concurrent workflow steps per worker process. |
| [`WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG`](../src/config/env.validation.ts#L620) | 20 | number; integer; min 1; max 10000 | Maximum concurrent active runs per workspace. |
| [`WORKFLOW_MAX_TOKENS_PER_RUN`](../src/config/env.validation.ts#L621) | 200000 | number; integer; min 1000; max 100000000 | Generation token ceiling per workflow run. |
| [`WORKFLOW_HEARTBEAT_INTERVAL`](../src/config/env.validation.ts#L626) | 15s | duration | How often running workflow work records liveness. |
| [`WORKFLOW_STALL_THRESHOLD`](../src/config/env.validation.ts#L627) | 2m | duration | Time without progress/heartbeat before work is considered stalled. |
| [`WORKFLOW_SWEEP_INTERVAL`](../src/config/env.validation.ts#L628) | 1m | duration | Interval for workflow recovery/maintenance sweeps. |
| [`WORKFLOW_APPROVAL_TIMEOUT`](../src/config/env.validation.ts#L629) | 24h | duration | Default approval-node waiting budget, also bounded by applicable run behavior. |
| [`WORKFLOW_RUN_RETENTION`](../src/config/env.validation.ts#L631) | 90d | duration | 0 keeps finished runs forever. |

## Tools and outbound HTTP

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`TOOLS_ENABLED`](../src/config/env.validation.ts#L636) | true | boolean | Platform-wide tool-execution switch. |
| [`TOOLS_DISABLED_BUILTINS`](../src/config/env.validation.ts#L638) | empty | string | Comma-separated built-in tool names to switch off platform-wide. |
| [`TOOL_MAX_ITERATIONS`](../src/config/env.validation.ts#L642) | 8 | number; integer; min 1; max 32 | Maximum model/tool loop iterations. |
| [`TOOL_DEFAULT_ITERATIONS`](../src/config/env.validation.ts#L643) | 4 | number; integer; min 1; max 32 | Default model/tool loop iteration budget. |
| [`TOOL_DEFAULT_TIMEOUT`](../src/config/env.validation.ts#L644) | 15s | duration | Default tool call time budget. |
| [`TOOL_MAX_TIMEOUT`](../src/config/env.validation.ts#L645) | 60s | duration | Maximum tool timeout, which must fit inside workflow step timeout. |
| [`TOOL_MAX_RESULT_SIZE`](../src/config/env.validation.ts#L646) | 32kb | byte size | Maximum stored/accepted tool result bytes. |
| [`TOOL_RESULT_MAX_TOKENS`](../src/config/env.validation.ts#L647) | 1500 | number; integer; min 64; max 32768 | Token budget for tool results supplied back to the model. |
| [`TOOL_MAX_CALLS_PER_RUN`](../src/config/env.validation.ts#L648) | 50 | number; integer; min 1; max 10000 | Maximum tool calls in one workflow run. |
| [`TOOL_HTTP_ALLOWED_HOSTS`](../src/config/env.validation.ts#L653) | empty | string | Hosts HTTP tools may call: `api.example.com` or `*.example.com`, comma separated. Empty disables outbound HTTP tools altogether. |
| [`TOOL_HTTP_ALLOW_PRIVATE_NETWORKS`](../src/config/env.validation.ts#L658) | false | boolean | Never in production: lets HTTP tools reach private and loopback addresses. |
| [`TOOL_HTTP_ALLOW_INSECURE`](../src/config/env.validation.ts#L660) | false | boolean | Never in production: lets HTTP tools use plain http://. |
| [`TOOL_HTTP_MAX_RESPONSE_SIZE`](../src/config/env.validation.ts#L661) | 256kb | byte size | Maximum accepted response bytes from an HTTP tool. |
| [`TOOL_EMAIL_ENABLED`](../src/config/env.validation.ts#L662) | true | boolean | Enable the email tool; real delivery still requires working SMTP and appropriate tool authorization. |
| [`TOOL_EMAIL_MAX_PER_RUN`](../src/config/env.validation.ts#L663) | 5 | number; integer; min 0; max 100 | Maximum email tool sends per run. |

## Socket.IO

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`REALTIME_ENABLED`](../src/config/env.validation.ts#L668) | true | boolean | Enable the Socket.IO gateway. |
| [`REALTIME_PATH`](../src/config/env.validation.ts#L669) | /realtime | string | Socket.IO handshake/transport path, normally /realtime, outside REST API prefix. |
| [`REALTIME_TRANSPORTS`](../src/config/env.validation.ts#L673) | websocket | string | `websocket` (no sticky sessions needed) or `websocket,polling`. |
| [`REALTIME_MAX_CONNECTIONS_PER_USER`](../src/config/env.validation.ts#L676) | 10 | number; integer; min 1; max 1000 | Concurrent socket ceiling per user. |
| [`REALTIME_MAX_HANDSHAKES_PER_MINUTE`](../src/config/env.validation.ts#L677) | 60 | number; integer; min 1; max 10000 | Rate limit for connection handshakes. |
| [`REALTIME_REVALIDATE_INTERVAL`](../src/config/env.validation.ts#L678) | 60s | duration | Interval for rechecking live socket authorization/membership. |
| [`REALTIME_REPLAY_MAX`](../src/config/env.validation.ts#L679) | 200 | number; integer; min 0; max 5000 | Maximum events replayed on a permitted subscription/reconnection. |
| [`REALTIME_STREAM_MAXLEN`](../src/config/env.validation.ts#L680) | 1000 | number; integer; min 10; max 100000 | Maximum retained entries in a realtime Redis stream. |
| [`REALTIME_STREAM_TTL`](../src/config/env.validation.ts#L681) | 24h | duration | Expiry for retained realtime event streams. |
| [`REALTIME_PING_INTERVAL`](../src/config/env.validation.ts#L682) | 25s | duration | Socket.IO ping interval. |
| [`REALTIME_PING_TIMEOUT`](../src/config/env.validation.ts#L683) | 20s | duration | Socket.IO pong/connection timeout. |
| [`REALTIME_MAX_MESSAGE_SIZE`](../src/config/env.validation.ts#L684) | 4kb | byte size | Maximum incoming Socket.IO message bytes. |

## Token quotas

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`QUOTA_ENFORCEMENT_ENABLED`](../src/config/env.validation.ts#L691) * | true | boolean | Enforce workspace/agent token budgets at the generation gateway. |
| [`QUOTA_FREE_MONTHLY_TOKENS`](../src/config/env.validation.ts#L696) * | 2000000 | number; integer; min 0 | The platform's monthly token allowance per workspace, by plan. 0 means unlimited. Workspaces may set stricter budgets of their own, never looser. |
| [`QUOTA_PRO_MONTHLY_TOKENS`](../src/config/env.validation.ts#L697) * | 20000000 | number; integer; min 0 | Default monthly token allowance for Pro workspaces; zero means unlimited. |
| [`QUOTA_ENTERPRISE_MONTHLY_TOKENS`](../src/config/env.validation.ts#L698) * | 0 | number; integer; min 0 | Default monthly token allowance for Enterprise workspaces; zero means unlimited. |
| [`QUOTA_TOKENS_PER_MINUTE`](../src/config/env.validation.ts#L700) * | 100000 | number; integer; min 0 | Tokens per minute one workspace may spend (a token bucket). 0 disables the rate. |
| [`QUOTA_ALERT_THRESHOLD`](../src/config/env.validation.ts#L702) * | 80 | number; integer; min 1; max 100 | Percentage of a budget at which administrators are alerted, once per period. |
| [`QUOTA_RESERVATION_TTL`](../src/config/env.validation.ts#L704) * | 10m | duration | How long a reservation outlives a crashed call before the sweep releases it. |
| [`QUOTA_CACHE_TTL`](../src/config/env.validation.ts#L706) * | 30s | duration | How long a workspace's quota definitions are cached per process. |

## Agent spending and circuit breakers

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`AGENT_MAX_TOKENS_PER_TURN`](../src/config/env.validation.ts#L710) * | 60000 | number; integer; min 0; max 100000000 | Tokens one conversation turn may spend across its tool-loop iterations. 0 = no limit. |
| [`AGENT_MAX_TOKENS_PER_CONVERSATION`](../src/config/env.validation.ts#L712) * | 1000000 | number; integer; min 0; max 1000000000 | Tokens one conversation may spend over its lifetime. 0 = no limit. |
| [`AGENT_CIRCUIT_ENABLED`](../src/config/env.validation.ts#L718) * | true | boolean | The per-agent breaker: opens on runaway spend or repeated agent-caused failures. |
| [`AGENT_CIRCUIT_WINDOW`](../src/config/env.validation.ts#L719) * | 60s | duration | Rolling interval for agent spend/failure circuit evaluation. |
| [`AGENT_CIRCUIT_MAX_TOKENS`](../src/config/env.validation.ts#L721) * | 250000 | number; integer; min 0 | Tokens one agent may spend within the window before its circuit opens. 0 = off. |
| [`AGENT_CIRCUIT_FAILURE_THRESHOLD`](../src/config/env.validation.ts#L723) * | 5 | number; integer; min 0; max 1000 | Consecutive agent-caused failures that open the circuit. 0 = off. |
| [`AGENT_CIRCUIT_COOLDOWN`](../src/config/env.validation.ts#L724) * | 5m | duration | Delay before an opened agent circuit can recover. |

## Metrics, worker probes and tracing

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`METRICS_ENABLED`](../src/config/env.validation.ts#L729) * | true | boolean | Expose the Prometheus metrics handler. |
| [`METRICS_PATH`](../src/config/env.validation.ts#L730) * | /metrics | string | Raw metrics HTTP route, independent of REST prefix/version. |
| [`METRICS_TOKEN`](../src/config/env.validation.ts#L737) * | empty | string; min 24 | Bearer token a scraper must present. Required to scrape outside development: without it the endpoint answers 401 in production. |
| [`WORKER_HTTP_PORT`](../src/config/env.validation.ts#L743) * | 0 | number; port | The dedicated worker has no API port. Set this to serve /health/live, /health/ready and /metrics from it (for a platform health check or a scraper). 0 disables. |
| [`OTEL_EXPORTER_OTLP_ENDPOINT`](../src/config/env.validation.ts#L749) * | omit | string; uri | Standard OpenTelemetry variables, read by the SDK before the application starts (see src/observability/tracing.ts). Validated here so a typo fails the boot instead of silently disabling tracing. |
| [`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`](../src/config/env.validation.ts#L750) * | omit | string; uri | Full OTLP HTTP trace-ingestion endpoint; takes precedence over the generic endpoint. |
| [`OTEL_EXPORTER_OTLP_HEADERS`](../src/config/env.validation.ts#L751) * | omit | string | Collector authentication headers in the SDK-required format; keep credentials secret. |
| [`OTEL_SERVICE_NAME`](../src/config/env.validation.ts#L752) * | omit | string | Service label reported to the tracing collector. |
| [`OTEL_SDK_DISABLED`](../src/config/env.validation.ts#L753) * | omit | boolean | Explicitly disable OpenTelemetry even if an endpoint is configured. |
| [`OTEL_TRACES_SAMPLER`](../src/config/env.validation.ts#L754) * | omit | string: always_on, always_off, traceidratio, parentbased_always_on, parentbased_always_off, parentbased_traceidratio | SDK trace-sampling strategy from the allowed values. |
| [`OTEL_TRACES_SAMPLER_ARG`](../src/config/env.validation.ts#L764) * | omit | number; min 0; max 1 | Sampling ratio from 0 to 1 for compatible ratio-based samplers. |

## Retention and data lifecycle

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`LIFECYCLE_SWEEP_INTERVAL`](../src/config/env.validation.ts#L770) * | 6h | duration | How often the lifecycle sweep runs (one sweep at a time, cluster-wide). |
| [`AUDIT_RETENTION`](../src/config/env.validation.ts#L777) * | 0 | duration | Audit records older than this are archived (encrypted, to object storage) and pruned, leaving a signed anchor so the remaining chain still verifies. 0 keeps the audit log forever. A workspace may choose its own period (settings.auditRetentionDays), never below AUDIT_RETENTION_MIN. |
| [`AUDIT_RETENTION_MIN`](../src/config/env.validation.ts#L778) * | 30d | duration | Minimum permitted nonzero audit retention, including workspace overrides. |
| [`AUDIT_ARCHIVE_BEFORE_PRUNE`](../src/config/env.validation.ts#L780) * | true | boolean | Refuse to prune what could not first be archived. |
| [`SESSION_RETENTION`](../src/config/env.validation.ts#L782) * | 30d | duration | Expired or revoked sessions are deleted this long after they ended. |
| [`USAGE_RETENTION`](../src/config/env.validation.ts#L784) * | 0 | duration | The usage and tool ledgers (content-free). 0 keeps them forever. |
| [`CONVERSATION_RETENTION`](../src/config/env.validation.ts#L786) * | 0 | duration | Conversations idle this long are crypto-shredded and deleted. 0 keeps them. |
| [`ACCOUNT_ERASURE_ENABLED`](../src/config/env.validation.ts#L788) * | true | boolean | Self-service account erasure (the right to be forgotten). |
| [`DATA_EXPORT_MAX_ITEMS`](../src/config/env.validation.ts#L790) * | 20000 | number; integer; min 100; max 1000000 | Most messages, runs and records one personal-data export includes per kind. |

## Email

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`MAIL_TRANSPORT`](../src/config/env.validation.ts#L796) | log | string: log, smtp | `log` prints messages to the console; nothing is sent. Ideal for development. |
| [`MAIL_FROM_NAME`](../src/config/env.validation.ts#L797) | AI Agent Platform | string | Display name in outgoing messages. |
| [`MAIL_FROM_ADDRESS`](../src/config/env.validation.ts#L802) | no-reply@localhost | string; email | Sender email address; use a provider-verified sender/domain for production SMTP. |
| [`MAIL_REPLY_TO`](../src/config/env.validation.ts#L805) | empty | string | Optional reply-to email address. |
| [`SMTP_HOST`](../src/config/env.validation.ts#L806) | empty | string | SMTP server hostname from the chosen provider, not an HTTPS API URL. |
| [`SMTP_PORT`](../src/config/env.validation.ts#L813) | 587 | number; port | Provider SMTP TCP port; coordinate with implicit TLS versus STARTTLS. |
| [`SMTP_SECURE`](../src/config/env.validation.ts#L815) | false | boolean | True for implicit TLS on port 465; false for STARTTLS on 587. |
| [`SMTP_USERNAME`](../src/config/env.validation.ts#L816) | empty | string | SMTP login supplied by provider; may differ from account email/API credential. |
| [`SMTP_PASSWORD`](../src/config/env.validation.ts#L817) | empty | string | Provider SMTP password/credential, not the app user's password. |
| [`SMTP_REJECT_UNAUTHORIZED`](../src/config/env.validation.ts#L818) | true | boolean | Verify SMTP server certificate; keep true. |

## Seeding and workspace limits

| Variable | Default | Type / allowed values | Purpose / setup note |
|---|---|---|---|
| [`PLATFORM_ADMIN_EMAIL`](../src/config/env.validation.ts#L824) | empty | string; email | When both are set, `npm run seed` provisions a platform administrator. |
| [`PLATFORM_ADMIN_PASSWORD`](../src/config/env.validation.ts#L825) | empty | string | One-time bootstrap password meeting the app policy; does not reset existing accounts on reseed. |
| [`PLATFORM_ADMIN_NAME`](../src/config/env.validation.ts#L826) | Platform Administrator | string | Display name for a newly created bootstrap administrator. |
| [`SEED_DEMO_DATA`](../src/config/env.validation.ts#L828) | false | boolean | Seeds a demo workspace with sample members and roles. Never in production. |
| [`MAX_OWNED_ORGANIZATIONS`](../src/config/env.validation.ts#L830) | 5 | number; integer; min 1; max 100 | Ceiling on workspaces a single non-admin user may own. |
| [`MAX_MEMBERS_PER_ORGANIZATION`](../src/config/env.validation.ts#L832) | 0 | number; integer; min 0 | Ceiling on members per workspace. Zero means unlimited. |

## Additional non-schema variables

| Variable | Where / meaning |
|---|---|
| `KNOWLEDGE_E2E` | Set `true` only when intentionally running knowledge E2E on disposable infrastructure. |
| `AGENTS_E2E` | Set `true` for the named agents suite. |
| `WORKFLOWS_E2E` | Set `true` for the named workflows suite. |
| `DAIAP_PROCESS_ROLE` | Internal: worker bootstrap sets `worker`; do not manually relabel the API. |
| `OTEL_RESOURCE_ATTRIBUTES` | Standard OpenTelemetry SDK setting; mentioned by tracing bootstrap, not declared in the application schema. Optional SDK-level configuration. |
| `DAIAP_SIGNING_SECRET` | Python contract example only: same value as backend AI_SERVICE_SIGNING_SECRET. Actual Python implementation determines its environment variable name. |

`process.env.SECRET` occurs in a test fixture, not as a deployment credential. `DATABASE_URL` is not read by the database builders. Unknown environment keys are allowed, so misspelled names may be silently ignored: use these exact names.

## Cross-field rules checked at startup

- LLM_REQUEST_TIMEOUT >= LLM_MAX_DURATION + 10s; LLM_FIRST_TOKEN_TIMEOUT <= LLM_MAX_DURATION.
- PRESIDIO_ANALYZER_URL must be nonempty when PII_NER_PROVIDER=presidio.
- WORKFLOW_STEP_TIMEOUT >= LLM_MAX_DURATION + 30s; WORKFLOW_RUN_TIMEOUT >= WORKFLOW_STEP_TIMEOUT.
- WORKFLOW_STALL_THRESHOLD >= 3 × WORKFLOW_HEARTBEAT_INTERVAL.
- WORKFLOW_STEP_BACKOFF <= WORKFLOW_STEP_BACKOFF_MAX.
- TOOL_DEFAULT_TIMEOUT <= TOOL_MAX_TIMEOUT < WORKFLOW_STEP_TIMEOUT.
- TOOL_DEFAULT_ITERATIONS <= TOOL_MAX_ITERATIONS.
- TOOL_HTTP_ALLOW_PRIVATE_NETWORKS and TOOL_HTTP_ALLOW_INSECURE must be false in staging/production.
- QUOTA_RESERVATION_TTL >= LLM_QUEUE_TIMEOUT + LLM_MAX_DURATION + 30s.
- AGENT_MAX_TOKENS_PER_TURN is zero (unlimited) or >= LLM_DEFAULT_CONTEXT_WINDOW.
- When both are nonzero, AGENT_MAX_TOKENS_PER_CONVERSATION >= AGENT_MAX_TOKENS_PER_TURN.
- AUDIT_RETENTION is zero (keep forever) or >= AUDIT_RETENTION_MIN.
- LIFECYCLE_SWEEP_INTERVAL >= 1m.
- Nonzero WORKER_HTTP_PORT must differ from APP_PORT.
- AI_SERVICE_TLS and LLM_TLS client certificate/key pairs must be valid and provided together; an HTTP URL cannot be used with a client certificate.

The schema does not prove provider credentials, reachable services, schema migrations, SMTP delivery, model support or working queues. Follow the functional tests in the setup guide.
