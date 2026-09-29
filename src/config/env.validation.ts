import * as Joi from 'joi';
import { parseDuration } from '../common/utils/duration.util';
import { describeClientTlsProblems } from '../common/utils/pem.util';

/**
 * Authoritative environment variable contract.
 *
 * Every variable the platform reads is declared here, validated at boot, and
 * documented in `.env.example`. The process refuses to start when validation
 * fails. That is deliberate: a backend that boots with a missing JWT secret or a
 * mis-typed token lifetime is far more dangerous than one that does not boot.
 *
 * Security-relevant values (signing secrets, encryption keys) are *required* in
 * production. In development and test they fall back to clearly-marked insecure
 * defaults so a newcomer can clone the repository and run it, and the
 * application logs a prominent warning when it uses one.
 */

export const NODE_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Minimum entropy we accept for any signing or encryption secret. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Deterministic, obviously-fake secrets used only outside production.
 * They are intentionally self-describing so that one appearing in a staging or
 * production log is immediately recognisable as a misconfiguration.
 */
export const INSECURE_DEV_DEFAULTS = {
  JWT_ACCESS_SECRET: 'dev-only-insecure-access-secret-do-not-use-in-production',
  JWT_REFRESH_SECRET: 'dev-only-insecure-refresh-secret-do-not-use-in-production',
  ENCRYPTION_KEY: 'dev-only-insecure-encryption-key-do-not-use-in-prod',
  AUDIT_HASH_SECRET: 'dev-only-insecure-audit-chain-secret-do-not-use-in-prod',
} as const;

/**
 * Dev-only default for the AI service request-signing secret. Kept apart from
 * {@link INSECURE_DEV_DEFAULTS} because it applies only once `AI_SERVICE_URL` is
 * set, but reported by {@link findInsecureDefaults} all the same.
 */
export const INSECURE_AI_SIGNING_DEFAULT =
  'dev-only-insecure-ai-service-signing-secret-do-not-use';

/** A byte size such as `50mb`, `1gb`, `512kb` or a bare byte count. */
const byteSize = (defaultValue: string) =>
  Joi.string()
    .pattern(/^\d+(\.\d+)?\s*(b|kb|mb|gb|tb)?$/i)
    .default(defaultValue)
    .messages({
      'string.pattern.base': '{{#label}} must be a size such as 512kb, 50mb or 1gb.',
    });

/** A duration expression such as `15m`, `7d`, `500ms` or a bare millisecond count. */
const duration = (defaultValue: string) =>
  Joi.string()
    .pattern(/^\d+(\.\d+)?\s*(ms|s|m|h|d|w)?$/i)
    .default(defaultValue)
    .messages({
      'string.pattern.base':
        '{{#label}} must be a duration such as 500ms, 45s, 15m, 12h, 7d or 2w.',
    });

/**
 * Required in production, defaulted elsewhere.
 * `Joi.when` is evaluated against the sibling NODE_ENV key via `$env` context.
 */
const secret = (devDefault: string) =>
  Joi.string()
    .min(MIN_SECRET_LENGTH)
    .when('NODE_ENV', {
      is: Joi.valid('production', 'staging'),
      then: Joi.required().messages({
        'any.required':
          '{{#label}} must be set explicitly outside development. Generate one with `npm run generate:secrets`.',
      }),
      otherwise: Joi.string().default(devDefault),
    })
    .messages({
      'string.min': `{{#label}} must be at least ${MIN_SECRET_LENGTH} characters of high-entropy randomness.`,
    });

/**
 * PEM material supplied through the environment: the contents, never a path,
 * because a cloud service has no file system to put a key file on. Raw PEM
 * (real newlines or `\n` escapes) or the whole PEM base64-encoded — whichever
 * the hosting platform's variable editor handles — is accepted.
 */
const pem = () => Joi.string().allow('').default('');

export const envValidationSchema = Joi.object({
  // ───────────────────────────────────────────────────────────────────────────
  // Application
  // ───────────────────────────────────────────────────────────────────────────
  NODE_ENV: Joi.string()
    .valid(...NODE_ENVIRONMENTS)
    .default('development'),
  APP_NAME: Joi.string().default('Distributed AI Agent Management Platform'),
  /**
   * The port injected by the hosting platform (Render, Railway, Heroku, Cloud
   * Run). `APP_PORT` falls back to it, so the API listens where the platform's
   * router expects without anyone having to copy the value across.
   */
  PORT: Joi.number().port().optional(),
  APP_PORT: Joi.number()
    .port()
    .default((parent: Record<string, unknown>) =>
      parent.PORT !== undefined && parent.PORT !== '' ? Number(parent.PORT) : 3000,
    ),
  APP_HOST: Joi.string().default('0.0.0.0'),
  /** Mounted in front of every route, e.g. `/api/v1/auth/login`. */
  APP_GLOBAL_PREFIX: Joi.string().allow('').default('api'),
  APP_API_VERSION: Joi.string().default('1'),
  /** Public base URL of this API. Used to build links in outbound email. */
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  /** Public base URL of the React frontend. Used for invitation / reset links. */
  FRONTEND_URL: Joi.string().uri().default('http://localhost:5173'),
  /** Grace period for in-flight requests during a graceful shutdown. */
  APP_SHUTDOWN_TIMEOUT: duration('10s'),
  /** Hard ceiling on any single request. Long LLM calls get their own budget later. */
  REQUEST_TIMEOUT: duration('30s'),
  JSON_BODY_LIMIT: Joi.string().default('2mb'),

  // ───────────────────────────────────────────────────────────────────────────
  // Observability
  // ───────────────────────────────────────────────────────────────────────────
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  /** Human readable coloured logs. Should be false wherever logs are shipped. */
  LOG_PRETTY: Joi.boolean().default(false),
  /** Emit a log line per HTTP request. */
  LOG_HTTP_REQUESTS: Joi.boolean().default(true),
  SWAGGER_ENABLED: Joi.boolean().default(true),
  SWAGGER_PATH: Joi.string().default('docs'),
  /** Serves the raw OpenAPI JSON, which the frontend generates its client from. */
  SWAGGER_JSON_PATH: Joi.string().default('docs-json'),

  // ───────────────────────────────────────────────────────────────────────────
  // PostgreSQL
  // ───────────────────────────────────────────────────────────────────────────
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().default('postgres'),
  DB_PASSWORD: Joi.string().allow('').default('postgres'),
  DB_NAME: Joi.string().default('ai_agent_platform'),
  DB_SCHEMA: Joi.string().default('public'),
  DB_SSL: Joi.boolean().default(false),
  DB_SSL_REJECT_UNAUTHORIZED: Joi.boolean().default(true),
  /** PEM contents (not a path) of a CA to trust, for managed Postgres providers. */
  DB_SSL_CA: Joi.string().allow('').default(''),
  DB_LOGGING: Joi.boolean().default(false),
  /**
   * Never enable outside a throwaway database. Migrations are the only supported
   * way to evolve the schema; `synchronize` will silently drop columns.
   */
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  /** Run pending migrations automatically on boot. Convenient in Docker. */
  DB_MIGRATIONS_RUN: Joi.boolean().default(false),
  DB_POOL_MAX: Joi.number().integer().min(1).max(200).default(20),
  DB_POOL_IDLE_TIMEOUT: duration('30s'),
  DB_CONNECTION_TIMEOUT: duration('10s'),
  DB_STATEMENT_TIMEOUT: duration('30s'),
  /**
   * Phase 5: bind every pooled connection to the workspace of the request (or
   * job) using it, so PostgreSQL row-level security is a third, independent
   * tenancy layer beneath the guards and the repository filters. Needs a
   * session-mode connection (a direct connection, not a transaction pooler).
   */
  DB_ROW_LEVEL_SECURITY: Joi.boolean().default(true),
  /**
   * Optional role assumed with `SET ROLE` on every new connection. Only for
   * providers whose login role bypasses RLS (a superuser, or a role with
   * BYPASSRLS such as Supabase's `postgres`): the migration creates
   * `daiap_rls`, a role that cannot.
   */
  DB_RLS_ROLE: Joi.string()
    .pattern(/^[a-z_][a-z0-9_]{0,62}$/)
    .allow('')
    .default(''),

  // ───────────────────────────────────────────────────────────────────────────
  // Redis
  // ───────────────────────────────────────────────────────────────────────────
  /** When set, takes precedence over the discrete REDIS_* settings below. */
  REDIS_URL: Joi.string().allow('').default(''),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_USERNAME: Joi.string().allow('').default(''),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).max(15).default(0),
  /**
   * TLS for the Redis connection. The proposal calls for "TLS-secured message
   * brokers" for inter-agent communication; this is the switch that enables it.
   */
  REDIS_TLS: Joi.boolean().default(false),
  REDIS_TLS_REJECT_UNAUTHORIZED: Joi.boolean().default(true),
  REDIS_TLS_CA: Joi.string().allow('').default(''),
  REDIS_KEY_PREFIX: Joi.string().default('daiap:'),
  REDIS_CONNECT_TIMEOUT: duration('10s'),
  /** Fail fast rather than queueing commands when Redis is unreachable. */
  REDIS_MAX_RETRIES_PER_REQUEST: Joi.number().integer().min(0).max(20).default(3),

  // ───────────────────────────────────────────────────────────────────────────
  // JWT
  // ───────────────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: secret(INSECURE_DEV_DEFAULTS.JWT_ACCESS_SECRET),
  JWT_REFRESH_SECRET: secret(INSECURE_DEV_DEFAULTS.JWT_REFRESH_SECRET),
  /** Short by design. Revocation latency is bounded by this value. */
  JWT_ACCESS_TTL: duration('15m'),
  JWT_REFRESH_TTL: duration('30d'),
  JWT_ISSUER: Joi.string().default('daiap'),
  JWT_AUDIENCE: Joi.string().default('daiap-api'),
  JWT_ALGORITHM: Joi.string().valid('HS256', 'HS384', 'HS512').default('HS256'),
  /** Tolerance for clock drift between this service and any token verifier. */
  JWT_CLOCK_TOLERANCE: Joi.number().integer().min(0).max(300).default(5),

  // ───────────────────────────────────────────────────────────────────────────
  // Security
  // ───────────────────────────────────────────────────────────────────────────
  PASSWORD_HASH_ALGORITHM: Joi.string().valid('argon2id', 'scrypt').default('argon2id'),
  /** Argon2 memory cost in KiB. 65536 KiB = 64 MiB, the OWASP baseline. */
  ARGON2_MEMORY_COST: Joi.number().integer().min(8192).max(1048576).default(65536),
  ARGON2_TIME_COST: Joi.number().integer().min(2).max(10).default(3),
  ARGON2_PARALLELISM: Joi.number().integer().min(1).max(16).default(4),
  PASSWORD_MIN_LENGTH: Joi.number().integer().min(8).max(128).default(12),
  PASSWORD_MAX_LENGTH: Joi.number().integer().min(64).max(1024).default(128),
  PASSWORD_REQUIRE_UPPERCASE: Joi.boolean().default(true),
  PASSWORD_REQUIRE_LOWERCASE: Joi.boolean().default(true),
  PASSWORD_REQUIRE_NUMBER: Joi.boolean().default(true),
  PASSWORD_REQUIRE_SYMBOL: Joi.boolean().default(false),
  /**
   * Optional server-side pepper mixed into every password hash. Because it lives
   * outside the database, a stolen dump alone is not enough to mount an offline
   * attack. Changing it invalidates every stored password, so rotate with care.
   */
  PASSWORD_PEPPER: Joi.string().allow('').default(''),

  /** 32-byte key, base64 or hex encoded, for AES-256-GCM field encryption. */
  ENCRYPTION_KEY: secret(INSECURE_DEV_DEFAULTS.ENCRYPTION_KEY),
  /** HMAC key protecting the tamper-evident audit log hash chain. */
  AUDIT_HASH_SECRET: secret(INSECURE_DEV_DEFAULTS.AUDIT_HASH_SECRET),

  MAX_FAILED_LOGIN_ATTEMPTS: Joi.number().integer().min(3).max(50).default(5),
  ACCOUNT_LOCKOUT_DURATION: duration('15m'),
  /** Sliding window over which failed sign-in attempts accumulate. */
  LOGIN_ATTEMPT_WINDOW: duration('15m'),

  EMAIL_VERIFICATION_TTL: duration('24h'),
  PASSWORD_RESET_TTL: duration('1h'),
  INVITATION_TTL: duration('7d'),
  /** Require a verified email address before a user may do anything meaningful. */
  REQUIRE_EMAIL_VERIFICATION: Joi.boolean().default(false),

  API_KEY_PREFIX: Joi.string().default('daiap_sk'),
  API_KEY_DEFAULT_TTL: duration('365d'),

  /** httpOnly cookie carrying the refresh token, when cookie mode is enabled. */
  REFRESH_TOKEN_COOKIE_ENABLED: Joi.boolean().default(true),
  REFRESH_TOKEN_COOKIE_NAME: Joi.string().default('daiap_rt'),
  REFRESH_TOKEN_COOKIE_DOMAIN: Joi.string().allow('').default(''),
  COOKIE_SECURE: Joi.boolean().default(false),
  COOKIE_SAME_SITE: Joi.string().valid('lax', 'strict', 'none').default('lax'),
  /** Signs cookies. Falls back to the access-token secret when unset. */
  COOKIE_SECRET: Joi.string().allow('').default(''),

  /** Comma-separated origin list, or `*` to allow any origin (development only). */
  CORS_ORIGINS: Joi.string().default('http://localhost:5173,http://localhost:3000'),
  CORS_CREDENTIALS: Joi.boolean().default(true),

  /**
   * Number of reverse proxies in front of the app. Required for correct client
   * IP resolution, which the IP allowlist and rate limiter both depend on.
   */
  TRUST_PROXY: Joi.alternatives()
    .try(Joi.number().integer().min(0).max(10), Joi.boolean())
    .default(1),
  /** Master switch for per-workspace IP allowlisting (proposal module 6.1). */
  ENFORCE_IP_ALLOWLIST: Joi.boolean().default(true),
  HELMET_ENABLED: Joi.boolean().default(true),
  /** Strict-Transport-Security max-age. Only meaningful behind HTTPS. */
  HSTS_MAX_AGE: Joi.number().integer().min(0).default(15552000),

  // ── Phase 5: multi-factor authentication (TOTP, RFC 6238) ──────────────────
  /** The account label authenticator apps show next to the six-digit code. */
  MFA_ISSUER: Joi.string()
    .max(64)
    .pattern(/^[^:]+$/)
    .default('DAIAP'),
  /** How long the second step of a sign-in may take once the password was right. */
  MFA_CHALLENGE_TTL: duration('5m'),
  /** Wrong codes accepted per sign-in challenge before it is withdrawn. */
  MFA_MAX_ATTEMPTS: Joi.number().integer().min(1).max(20).default(5),
  /** Single-use recovery codes issued at enrolment. */
  MFA_RECOVERY_CODES: Joi.number().integer().min(4).max(20).default(10),
  /** Platform administrators must hold an MFA-verified session to act as one. */
  MFA_REQUIRED_FOR_PLATFORM_ADMINS: Joi.boolean().default(false),

  // ── Phase 5: breached-password screening (k-anonymity range API) ───────────
  /**
   * `enforce` refuses passwords found in known breaches, `warn` accepts them
   * and records the fact, `off` never asks. Only the first five hex characters
   * of the password's SHA-1 ever leave the platform (k-anonymity), and the
   * lookup fails open: an outage of the range service never blocks a sign-up.
   */
  PASSWORD_BREACH_CHECK: Joi.string().valid('off', 'warn', 'enforce').default('enforce'),
  PASSWORD_BREACH_API_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .default('https://api.pwnedpasswords.com'),
  PASSWORD_BREACH_TIMEOUT: duration('3s'),
  /** Breach appearances at or above which a password is refused. */
  PASSWORD_BREACH_MIN_OCCURRENCES: Joi.number().integer().min(1).max(1_000_000).default(1),

  // ───────────────────────────────────────────────────────────────────────────
  // Rate limiting (module 6.14 foundation)
  // ───────────────────────────────────────────────────────────────────────────
  THROTTLE_ENABLED: Joi.boolean().default(true),
  /** Global default: requests per window, per principal. */
  THROTTLE_TTL: duration('60s'),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),
  /** Deliberately tight bucket for credential-handling endpoints. */
  THROTTLE_AUTH_TTL: duration('15m'),
  THROTTLE_AUTH_LIMIT: Joi.number().integer().min(1).default(10),
  /** Bucket for endpoints that send email, to prevent using us as a spam relay. */
  THROTTLE_EMAIL_TTL: duration('1h'),
  THROTTLE_EMAIL_LIMIT: Joi.number().integer().min(1).default(5),
  /** Document uploads: each one costs storage, parsing and embedding compute. */
  THROTTLE_UPLOAD_TTL: duration('1h'),
  THROTTLE_UPLOAD_LIMIT: Joi.number().integer().min(1).default(100),
  /** Retrieval queries: each one costs an embedding call and a vector search. */
  THROTTLE_RAG_TTL: duration('60s'),
  THROTTLE_RAG_LIMIT: Joi.number().integer().min(1).default(60),
  /** Agent turns and direct model calls: each holds a GPU slot for seconds. */
  THROTTLE_INFERENCE_TTL: duration('60s'),
  THROTTLE_INFERENCE_LIMIT: Joi.number().integer().min(1).default(20),
  /** PII analysis previews and redaction reports. */
  THROTTLE_PII_TTL: duration('60s'),
  THROTTLE_PII_LIMIT: Joi.number().integer().min(1).default(30),
  /** Workflow run starts: each one can fan out into many model and tool calls. */
  THROTTLE_WORKFLOW_TTL: duration('60s'),
  THROTTLE_WORKFLOW_LIMIT: Joi.number().integer().min(1).default(30),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 — object storage (S3-compatible: AWS S3, Cloudflare R2, Backblaze
  // B2, Supabase Storage, MinIO). Uploads are refused until a bucket is set.
  // ───────────────────────────────────────────────────────────────────────────
  STORAGE_S3_BUCKET: Joi.string().allow('').default(''),
  /** Empty for AWS itself; the provider's S3 endpoint for everyone else. */
  STORAGE_S3_ENDPOINT: Joi.string().uri().allow('').default(''),
  STORAGE_S3_REGION: Joi.string().default('auto'),
  STORAGE_S3_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  STORAGE_S3_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  /** Path-style addressing. Required by MinIO and some B2 setups. */
  STORAGE_S3_FORCE_PATH_STYLE: Joi.boolean().default(false),
  /** Provider-side encryption on top of the application-level encryption. */
  STORAGE_S3_SERVER_SIDE_ENCRYPTION: Joi.string()
    .valid('', 'AES256', 'aws:kms')
    .default(''),
  /** Prefix for every object key, so one bucket can serve several deployments. */
  STORAGE_KEY_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9._/-]*$/)
    .allow('')
    .default('daiap/'),
  UPLOAD_MAX_FILE_SIZE: byteSize('50mb'),
  /** Comma-separated subset of: pdf, docx, txt, md. */
  UPLOAD_ALLOWED_TYPES: Joi.string()
    .pattern(/^\s*(pdf|docx|txt|md)(\s*,\s*(pdf|docx|txt|md))*\s*$/i)
    .default('pdf,docx,txt,md'),
  /** Upload requests stream up to UPLOAD_MAX_FILE_SIZE, so they get a longer budget. */
  UPLOAD_REQUEST_TIMEOUT: duration('120s'),
  /** Total document bytes one workspace may store. Zero means unlimited. */
  STORAGE_QUOTA_PER_ORGANIZATION: byteSize('1gb'),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 — the Python AI service (parsing, chunking, embedding, reranking)
  // ───────────────────────────────────────────────────────────────────────────
  AI_SERVICE_URL: Joi.string().uri().allow('').default(''),
  /**
   * HMAC key signing every request to the AI service. Required, and at least 32
   * characters, whenever AI_SERVICE_URL is set outside development.
   */
  AI_SERVICE_SIGNING_SECRET: Joi.string()
    .allow('')
    .when('AI_SERVICE_URL', {
      is: Joi.string().min(1),
      then: Joi.when('NODE_ENV', {
        is: Joi.valid('production', 'staging'),
        then: Joi.string().min(MIN_SECRET_LENGTH).required().messages({
          'any.required':
            '{{#label}} must be set when AI_SERVICE_URL is configured. Generate one with `npm run generate:secrets`.',
        }),
        otherwise: Joi.string().min(MIN_SECRET_LENGTH).default(INSECURE_AI_SIGNING_DEFAULT),
      }),
      otherwise: Joi.string().allow('').default(''),
    })
    .messages({
      'string.min': `{{#label}} must be at least ${MIN_SECRET_LENGTH} characters of high-entropy randomness.`,
    }),
  /** Identifies which secret signed a request, so the secret can be rotated. */
  AI_SERVICE_KEY_ID: Joi.string()
    .pattern(/^[A-Za-z0-9._-]{1,32}$/)
    .default('v1'),
  /**
   * Phase 5 — mutual TLS to the AI service. The client certificate and key
   * this backend presents (both or neither), the CA that signed the AI
   * service's server certificate (when it is a private CA), and the name to
   * verify on it when that differs from the URL's host.
   */
  AI_SERVICE_TLS_CERT: pem(),
  AI_SERVICE_TLS_KEY: pem(),
  AI_SERVICE_TLS_KEY_PASSPHRASE: Joi.string().allow('').default(''),
  AI_SERVICE_TLS_CA: pem(),
  AI_SERVICE_TLS_SERVERNAME: Joi.string().hostname().allow('').default(''),
  AI_SERVICE_TIMEOUT: duration('30s'),
  /** Parsing a long scanned PDF can legitimately take minutes. */
  AI_SERVICE_PARSE_TIMEOUT: duration('300s'),
  AI_SERVICE_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),
  AI_SERVICE_MAX_RESPONSE_SIZE: byteSize('64mb'),
  AI_SERVICE_CIRCUIT_THRESHOLD: Joi.number().integer().min(1).max(100).default(5),
  AI_SERVICE_CIRCUIT_COOLDOWN: duration('30s'),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 — vector store (Qdrant Cloud) and embeddings
  // ───────────────────────────────────────────────────────────────────────────
  QDRANT_URL: Joi.string().uri().allow('').default(''),
  QDRANT_API_KEY: Joi.string().allow('').default(''),
  QDRANT_COLLECTION_PREFIX: Joi.string()
    .pattern(/^[a-z0-9_-]{0,40}$/)
    .allow('')
    .default('daiap_'),
  /**
   * `collection` — one collection per workspace: physical isolation at the
   * vector layer. `shared` — one collection, partitioned by a tenant-indexed
   * payload field: Qdrant's recommendation once workspaces number in the
   * hundreds. The mandatory tenant filter applies in both modes.
   */
  QDRANT_TENANCY: Joi.string().valid('collection', 'shared').default('collection'),
  QDRANT_TIMEOUT: duration('15s'),
  /** int8 scalar quantisation: ~4x less vector memory, with rescoring. */
  QDRANT_QUANTIZATION: Joi.string().valid('scalar', 'none').default('scalar'),
  QDRANT_CIRCUIT_THRESHOLD: Joi.number().integer().min(1).max(100).default(5),
  QDRANT_CIRCUIT_COOLDOWN: duration('20s'),
  EMBEDDING_MODEL: Joi.string().max(128).default('nomic-embed-text'),
  EMBEDDING_DIMENSIONS: Joi.number().integer().min(8).max(8192).default(768),
  EMBEDDING_BATCH_SIZE: Joi.number().integer().min(1).max(512).default(32),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 — background processing (BullMQ on the Redis above)
  // ───────────────────────────────────────────────────────────────────────────
  /** Defaults to `${REDIS_KEY_PREFIX}bull`. */
  QUEUE_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9:_-]*$/)
    .allow('')
    .default(''),
  /**
   * Whether this process consumes jobs. `true` suits a single-service
   * deployment; set `false` on the API and run `npm run start:worker`
   * separately to scale ingestion independently.
   */
  QUEUE_WORKERS_ENABLED: Joi.boolean().default(true),
  /**
   * How long an idle worker waits on Redis before polling its queue again. A
   * new job wakes it at once, so this only sets the idle traffic: every worker
   * runs one poll cycle per interval. Raise it (60s) on a hosted Redis that
   * bills per command, such as Upstash (BullMQ still polls a queue holding a
   * scheduled job at least every 10 seconds).
   */
  QUEUE_DRAIN_DELAY: duration('5s'),
  /**
   * How often each worker looks for jobs whose worker died. The engines have
   * their own stall sweeps in PostgreSQL; this is BullMQ's own safety net.
   */
  QUEUE_STALLED_INTERVAL: duration('30s'),
  INGESTION_CONCURRENCY: Joi.number().integer().min(1).max(32).default(2),
  INGESTION_MAX_ATTEMPTS: Joi.number().integer().min(1).max(20).default(5),
  INGESTION_BACKOFF_DELAY: duration('15s'),
  INGESTION_JOB_TIMEOUT: duration('30m'),
  INGESTION_MAX_CHUNKS: Joi.number().integer().min(1).max(200_000).default(20_000),
  CHUNK_SIZE_DEFAULT: Joi.number().integer().min(64).max(4096).default(512),
  CHUNK_OVERLAP_DEFAULT: Joi.number().integer().min(0).max(1024).default(64),
  MAINTENANCE_SWEEP_INTERVAL: duration('5m'),
  /** A document in-flight this long without progress is considered stalled. */
  INGESTION_STALL_THRESHOLD: duration('45m'),
  /** Grace period before a deleted workspace's documents are destroyed. */
  ORGANIZATION_PURGE_GRACE: duration('7d'),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 — secure retrieval (module 6.6)
  // ───────────────────────────────────────────────────────────────────────────
  RAG_DEFAULT_TOP_K: Joi.number().integer().min(1).max(100).default(8),
  RAG_MAX_TOP_K: Joi.number().integer().min(1).max(200).default(50),
  /** `hybrid` fuses dense and lexical (BM25) results; `dense` is vectors only. */
  RAG_SEARCH_MODE: Joi.string().valid('hybrid', 'dense').default('hybrid'),
  /** Candidates fetched per final result when reranking. */
  RAG_CANDIDATE_MULTIPLIER: Joi.number().integer().min(1).max(20).default(4),
  RAG_RERANK_ENABLED: Joi.boolean().default(false),
  RAG_MAX_QUERY_LENGTH: Joi.number().integer().min(16).max(16_384).default(2_000),
  /**
   * Also record *what the access policy withheld* from each query — document
   * ids only, never content — so an auditor can see the policy working.
   */
  RAG_AUDIT_WITHHELD: Joi.boolean().default(true),
  RAG_WITHHELD_SCORE_THRESHOLD: Joi.number().min(0).max(1).default(0.35),
  RAG_REQUEST_TIMEOUT: duration('60s'),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3 — LLM gateway (module 6.7). Optional at boot: without
  // LLM_BASE_URL the inference endpoints answer 503 LLM_NOT_CONFIGURED.
  // ───────────────────────────────────────────────────────────────────────────
  /** `ollama`: Ollama's native API. `openai`: any OpenAI-compatible server. */
  LLM_PROVIDER: Joi.string().valid('ollama', 'openai').default('ollama'),
  LLM_BASE_URL: Joi.string().uri().allow('').default(''),
  /** Bearer token for an authenticating proxy, Ollama Cloud or a hosted API. */
  LLM_API_KEY: Joi.string().allow('').default(''),
  LLM_DEFAULT_MODEL: Joi.string().max(200).default('llama3.1:8b'),
  /** Comma-separated platform allowlist. Empty: whatever the endpoint serves. */
  LLM_ALLOWED_MODELS: Joi.string().allow('').default(''),
  LLM_DEFAULT_CONTEXT_WINDOW: Joi.number().integer().min(512).max(1_048_576).default(8192),
  /** Ceiling on the context window requested from the model (bounds GPU memory). */
  LLM_MAX_CONTEXT_WINDOW: Joi.number().integer().min(512).max(1_048_576).default(32_768),
  LLM_DEFAULT_MAX_OUTPUT_TOKENS: Joi.number().integer().min(16).max(65_536).default(1024),
  LLM_MAX_OUTPUT_TOKENS: Joi.number().integer().min(16).max(65_536).default(4096),
  LLM_DEFAULT_TEMPERATURE: Joi.number().min(0).max(2).default(0.3),
  /** Until the first token: generous, because it includes loading the model. */
  LLM_FIRST_TOKEN_TIMEOUT: duration('120s'),
  LLM_IDLE_TIMEOUT: duration('30s'),
  LLM_MAX_DURATION: duration('240s'),
  /** HTTP budget of the inference routes. Must exceed LLM_MAX_DURATION. */
  LLM_REQUEST_TIMEOUT: duration('300s'),
  /** Concurrent generations per process. One GPU serves only a few at once. */
  LLM_MAX_CONCURRENCY: Joi.number().integer().min(1).max(256).default(4),
  LLM_QUEUE_TIMEOUT: duration('30s'),
  LLM_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(1),
  LLM_MAX_RESPONSE_SIZE: byteSize('4mb'),
  LLM_CIRCUIT_THRESHOLD: Joi.number().integer().min(1).max(100).default(5),
  LLM_CIRCUIT_COOLDOWN: duration('30s'),
  /** Ollama only: how long a model stays loaded after a request. */
  LLM_KEEP_ALIVE: Joi.string()
    .pattern(/^-?\d+(ms|s|m|h)?$/)
    .default('30m'),
  /**
   * The most sensitive classification whose masked content may be sent to
   * this endpoint. RESTRICTED for a model you host; lower for a third party.
   */
  LLM_MAX_CLASSIFICATION: Joi.string()
    .valid('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
    .default('RESTRICTED'),
  LLM_MODEL_CACHE_TTL: duration('60s'),
  /** Phase 5 — mutual TLS to a self-hosted model endpoint (a proxy that checks client certificates). */
  LLM_TLS_CERT: pem(),
  LLM_TLS_KEY: pem(),
  LLM_TLS_KEY_PASSPHRASE: Joi.string().allow('').default(''),
  LLM_TLS_CA: pem(),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3 — PII redaction engine (module 6.12)
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * Where names and other free-text entities are detected. `ai-service`: the
   * Python AI service's /v1/pii/analyze (HMAC-signed). `presidio`: a stock
   * Presidio analyzer. `none`: validated pattern recognizers only.
   */
  PII_NER_PROVIDER: Joi.string()
    .valid('ai-service', 'presidio', 'none')
    .default('ai-service'),
  PRESIDIO_ANALYZER_URL: Joi.string().uri().allow('').default(''),
  PRESIDIO_API_KEY: Joi.string().allow('').default(''),
  PRESIDIO_CONCURRENCY: Joi.number().integer().min(1).max(32).default(4),
  PII_TIMEOUT: duration('10s'),
  PII_DEFAULT_ENTITIES: Joi.string()
    .pattern(/^\s*[A-Z][A-Z0-9_]{1,40}(\s*,\s*[A-Z][A-Z0-9_]{1,40})*\s*$/)
    .default(
      'PERSON,EMAIL_ADDRESS,PHONE_NUMBER,CREDIT_CARD,IBAN_CODE,US_SSN,PK_CNIC,IP_ADDRESS,SALARY,CREDENTIAL',
    ),
  /** REFUSE: fail closed. DEGRADE_TO_PATTERNS: continue with pattern recognizers only. */
  PII_DEFAULT_ON_FAILURE: Joi.string()
    .valid('REFUSE', 'DEGRADE_TO_PATTERNS')
    .default('REFUSE'),
  PII_SCORE_THRESHOLD: Joi.number().min(0).max(1).default(0.5),
  PII_LANGUAGE: Joi.string()
    .pattern(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default('en'),
  /** NER results cached by keyed fingerprint (never text). 0 disables. */
  PII_DETECTION_CACHE_TTL: duration('1h'),
  PII_CIRCUIT_THRESHOLD: Joi.number().integer().min(1).max(100).default(5),
  PII_CIRCUIT_COOLDOWN: duration('30s'),
  PII_MAX_ANALYZE_LENGTH: Joi.number().integer().min(100).max(200_000).default(20_000),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3 — agents and conversational memory (modules 6.8, 6.10)
  // ───────────────────────────────────────────────────────────────────────────
  AGENT_MEMORY_MAX_MESSAGES: Joi.number().integer().min(0).max(500).default(20),
  AGENT_MEMORY_MAX_MESSAGES_CEILING: Joi.number().integer().min(0).max(500).default(100),
  AGENT_MEMORY_MAX_TOKENS: Joi.number().integer().min(0).max(262_144).default(3000),
  AGENT_CONTEXT_MAX_TOKENS: Joi.number().integer().min(0).max(262_144).default(3000),
  AGENT_MAX_MESSAGE_LENGTH: Joi.number().integer().min(100).max(100_000).default(16_000),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 4 — multi-agent workflow engine (modules 6.9, 6.13). Runs on the
  // Redis/BullMQ of phase 2; nothing new to provision.
  // ───────────────────────────────────────────────────────────────────────────
  WORKFLOW_MAX_NODES: Joi.number().integer().min(2).max(500).default(50),
  WORKFLOW_MAX_EDGES: Joi.number().integer().min(1).max(2_000).default(150),
  /** Steps one run may schedule, loops included. The runaway-loop stop. */
  WORKFLOW_MAX_STEPS: Joi.number().integer().min(2).max(10_000).default(100),
  WORKFLOW_MAX_LOOP_ITERATIONS: Joi.number().integer().min(1).max(1_000).default(10),
  WORKFLOW_MAX_SUPERVISOR_ROUNDS: Joi.number().integer().min(1).max(200).default(12),
  WORKFLOW_MAX_INPUT_SIZE: byteSize('64kb'),
  WORKFLOW_MAX_STEP_OUTPUT_SIZE: byteSize('256kb'),
  WORKFLOW_RUN_TIMEOUT: duration('30m'),
  /** One step may make several model calls (tool use), so this exceeds LLM_MAX_DURATION. */
  WORKFLOW_STEP_TIMEOUT: duration('10m'),
  WORKFLOW_STEP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3),
  WORKFLOW_STEP_BACKOFF: duration('10s'),
  WORKFLOW_STEP_BACKOFF_MAX: duration('5m'),
  WORKFLOW_CONCURRENCY: Joi.number().integer().min(1).max(64).default(4),
  WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG: Joi.number().integer().min(1).max(10_000).default(20),
  WORKFLOW_MAX_TOKENS_PER_RUN: Joi.number()
    .integer()
    .min(1_000)
    .max(100_000_000)
    .default(200_000),
  WORKFLOW_HEARTBEAT_INTERVAL: duration('15s'),
  WORKFLOW_STALL_THRESHOLD: duration('2m'),
  WORKFLOW_SWEEP_INTERVAL: duration('1m'),
  WORKFLOW_APPROVAL_TIMEOUT: duration('24h'),
  /** 0 keeps finished runs forever. */
  WORKFLOW_RUN_RETENTION: duration('90d'),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 4 — tool execution engine (module 6.11)
  // ───────────────────────────────────────────────────────────────────────────
  TOOLS_ENABLED: Joi.boolean().default(true),
  /** Comma-separated built-in tool names to switch off platform-wide. */
  TOOLS_DISABLED_BUILTINS: Joi.string()
    .pattern(/^\s*([a-z_]+\s*(,\s*[a-z_]+\s*)*)?$/)
    .allow('')
    .default(''),
  TOOL_MAX_ITERATIONS: Joi.number().integer().min(1).max(32).default(8),
  TOOL_DEFAULT_ITERATIONS: Joi.number().integer().min(1).max(32).default(4),
  TOOL_DEFAULT_TIMEOUT: duration('15s'),
  TOOL_MAX_TIMEOUT: duration('60s'),
  TOOL_MAX_RESULT_SIZE: byteSize('32kb'),
  TOOL_RESULT_MAX_TOKENS: Joi.number().integer().min(64).max(32_768).default(1_500),
  TOOL_MAX_CALLS_PER_RUN: Joi.number().integer().min(1).max(10_000).default(50),
  /**
   * Hosts HTTP tools may call: `api.example.com` or `*.example.com`, comma
   * separated. Empty disables outbound HTTP tools altogether.
   */
  TOOL_HTTP_ALLOWED_HOSTS: Joi.string()
    .pattern(/^\s*((\*\.)?[a-z0-9.-]+(:\d+)?)?(\s*,\s*(\*\.)?[a-z0-9.-]+(:\d+)?)*\s*$/i)
    .allow('')
    .default(''),
  /** Never in production: lets HTTP tools reach private and loopback addresses. */
  TOOL_HTTP_ALLOW_PRIVATE_NETWORKS: Joi.boolean().default(false),
  /** Never in production: lets HTTP tools use plain http://. */
  TOOL_HTTP_ALLOW_INSECURE: Joi.boolean().default(false),
  TOOL_HTTP_MAX_RESPONSE_SIZE: byteSize('256kb'),
  TOOL_EMAIL_ENABLED: Joi.boolean().default(true),
  TOOL_EMAIL_MAX_PER_RUN: Joi.number().integer().min(0).max(100).default(5),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 4 — real-time events over WebSocket (module 6.16)
  // ───────────────────────────────────────────────────────────────────────────
  REALTIME_ENABLED: Joi.boolean().default(true),
  REALTIME_PATH: Joi.string()
    .pattern(/^\/?[A-Za-z0-9._/-]{1,64}$/)
    .default('/realtime'),
  /** `websocket` (no sticky sessions needed) or `websocket,polling`. */
  REALTIME_TRANSPORTS: Joi.string()
    .pattern(/^\s*(websocket|polling)(\s*,\s*(websocket|polling))*\s*$/)
    .default('websocket'),
  REALTIME_MAX_CONNECTIONS_PER_USER: Joi.number().integer().min(1).max(1_000).default(10),
  REALTIME_MAX_HANDSHAKES_PER_MINUTE: Joi.number().integer().min(1).max(10_000).default(60),
  REALTIME_REVALIDATE_INTERVAL: duration('60s'),
  REALTIME_REPLAY_MAX: Joi.number().integer().min(0).max(5_000).default(200),
  REALTIME_STREAM_MAXLEN: Joi.number().integer().min(10).max(100_000).default(1_000),
  REALTIME_STREAM_TTL: duration('24h'),
  REALTIME_PING_INTERVAL: duration('25s'),
  REALTIME_PING_TIMEOUT: duration('20s'),
  REALTIME_MAX_MESSAGE_SIZE: byteSize('4kb'),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 5 — token quotas and throttling (module 6.14). Enforced at the LLM
  // gateway, the one path every model call takes. Nothing to provision: the
  // budgets live in PostgreSQL, the per-minute rate in Redis.
  // ───────────────────────────────────────────────────────────────────────────
  QUOTA_ENFORCEMENT_ENABLED: Joi.boolean().default(true),
  /**
   * The platform's monthly token allowance per workspace, by plan. 0 means
   * unlimited. Workspaces may set stricter budgets of their own, never looser.
   */
  QUOTA_FREE_MONTHLY_TOKENS: Joi.number().integer().min(0).default(2_000_000),
  QUOTA_PRO_MONTHLY_TOKENS: Joi.number().integer().min(0).default(20_000_000),
  QUOTA_ENTERPRISE_MONTHLY_TOKENS: Joi.number().integer().min(0).default(0),
  /** Tokens per minute one workspace may spend (a token bucket). 0 disables the rate. */
  QUOTA_TOKENS_PER_MINUTE: Joi.number().integer().min(0).default(100_000),
  /** Percentage of a budget at which administrators are alerted, once per period. */
  QUOTA_ALERT_THRESHOLD: Joi.number().integer().min(1).max(100).default(80),
  /** How long a reservation outlives a crashed call before the sweep releases it. */
  QUOTA_RESERVATION_TTL: duration('10m'),
  /** How long a workspace's quota definitions are cached per process. */
  QUOTA_CACHE_TTL: duration('30s'),

  // ── Circuit breaking for agents (conversations and across runs) ────────────
  /** Tokens one conversation turn may spend across its tool-loop iterations. 0 = no limit. */
  AGENT_MAX_TOKENS_PER_TURN: Joi.number().integer().min(0).max(100_000_000).default(60_000),
  /** Tokens one conversation may spend over its lifetime. 0 = no limit. */
  AGENT_MAX_TOKENS_PER_CONVERSATION: Joi.number()
    .integer()
    .min(0)
    .max(1_000_000_000)
    .default(1_000_000),
  /** The per-agent breaker: opens on runaway spend or repeated agent-caused failures. */
  AGENT_CIRCUIT_ENABLED: Joi.boolean().default(true),
  AGENT_CIRCUIT_WINDOW: duration('60s'),
  /** Tokens one agent may spend within the window before its circuit opens. 0 = off. */
  AGENT_CIRCUIT_MAX_TOKENS: Joi.number().integer().min(0).default(250_000),
  /** Consecutive agent-caused failures that open the circuit. 0 = off. */
  AGENT_CIRCUIT_FAILURE_THRESHOLD: Joi.number().integer().min(0).max(1_000).default(5),
  AGENT_CIRCUIT_COOLDOWN: duration('5m'),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 5 — observability: Prometheus metrics and OpenTelemetry traces
  // ───────────────────────────────────────────────────────────────────────────
  METRICS_ENABLED: Joi.boolean().default(true),
  METRICS_PATH: Joi.string()
    .pattern(/^\/?[A-Za-z0-9._/-]{1,64}$/)
    .default('/metrics'),
  /**
   * Bearer token a scraper must present. Required to scrape outside
   * development: without it the endpoint answers 401 in production.
   */
  METRICS_TOKEN: Joi.string().min(24).allow('').default(''),
  /**
   * The dedicated worker has no API port. Set this to serve /health/live,
   * /health/ready and /metrics from it (for a platform health check or a
   * scraper). 0 disables.
   */
  WORKER_HTTP_PORT: Joi.number().port().allow(0).default(0),
  /**
   * Standard OpenTelemetry variables, read by the SDK before the application
   * starts (see src/observability/tracing.ts). Validated here so a typo fails
   * the boot instead of silently disabling tracing.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().allow('').optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: Joi.string().uri().allow('').optional(),
  OTEL_EXPORTER_OTLP_HEADERS: Joi.string().allow('').optional(),
  OTEL_SERVICE_NAME: Joi.string().allow('').optional(),
  OTEL_SDK_DISABLED: Joi.boolean().optional(),
  OTEL_TRACES_SAMPLER: Joi.string()
    .valid(
      'always_on',
      'always_off',
      'traceidratio',
      'parentbased_always_on',
      'parentbased_always_off',
      'parentbased_traceidratio',
    )
    .optional(),
  OTEL_TRACES_SAMPLER_ARG: Joi.number().min(0).max(1).optional(),

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 5 — data lifecycle: retention, pruning, export and erasure
  // ───────────────────────────────────────────────────────────────────────────
  /** How often the lifecycle sweep runs (one sweep at a time, cluster-wide). */
  LIFECYCLE_SWEEP_INTERVAL: duration('6h'),
  /**
   * Audit records older than this are archived (encrypted, to object storage)
   * and pruned, leaving a signed anchor so the remaining chain still verifies.
   * 0 keeps the audit log forever. A workspace may choose its own period
   * (settings.auditRetentionDays), never below AUDIT_RETENTION_MIN.
   */
  AUDIT_RETENTION: duration('0'),
  AUDIT_RETENTION_MIN: duration('30d'),
  /** Refuse to prune what could not first be archived. */
  AUDIT_ARCHIVE_BEFORE_PRUNE: Joi.boolean().default(true),
  /** Expired or revoked sessions are deleted this long after they ended. */
  SESSION_RETENTION: duration('30d'),
  /** The usage and tool ledgers (content-free). 0 keeps them forever. */
  USAGE_RETENTION: duration('0'),
  /** Conversations idle this long are crypto-shredded and deleted. 0 keeps them. */
  CONVERSATION_RETENTION: duration('0'),
  /** Self-service account erasure (the right to be forgotten). */
  ACCOUNT_ERASURE_ENABLED: Joi.boolean().default(true),
  /** Most messages, runs and records one personal-data export includes per kind. */
  DATA_EXPORT_MAX_ITEMS: Joi.number().integer().min(100).max(1_000_000).default(20_000),

  // ───────────────────────────────────────────────────────────────────────────
  // Outbound email
  // ───────────────────────────────────────────────────────────────────────────
  /** `log` prints messages to the console; nothing is sent. Ideal for development. */
  MAIL_TRANSPORT: Joi.string().valid('log', 'smtp').default('log'),
  MAIL_FROM_NAME: Joi.string().default('AI Agent Platform'),
  // A bare host such as `no-reply@localhost` — the natural default on a
  // development machine or inside a container network — must be accepted.
  // Joi rejects it twice over by default: `tlds` insists on a registered
  // top-level domain, and `minDomainSegments` insists on at least two labels.
  MAIL_FROM_ADDRESS: Joi.string()
    .email({ tlds: { allow: false }, minDomainSegments: 1 })
    .default('no-reply@localhost'),
  MAIL_REPLY_TO: Joi.string().allow('').default(''),
  SMTP_HOST: Joi.string()
    .allow('')
    .when('MAIL_TRANSPORT', {
      is: 'smtp',
      then: Joi.string().required(),
      otherwise: Joi.string().allow('').default(''),
    }),
  SMTP_PORT: Joi.number().port().default(587),
  /** True for implicit TLS on port 465; false for STARTTLS on 587. */
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USERNAME: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string().allow('').default(''),
  SMTP_REJECT_UNAUTHORIZED: Joi.boolean().default(true),

  // ───────────────────────────────────────────────────────────────────────────
  // Bootstrap / seeding
  // ───────────────────────────────────────────────────────────────────────────
  /** When both are set, `npm run seed` provisions a platform administrator. */
  PLATFORM_ADMIN_EMAIL: Joi.string().email().allow('').default(''),
  PLATFORM_ADMIN_PASSWORD: Joi.string().allow('').default(''),
  PLATFORM_ADMIN_NAME: Joi.string().default('Platform Administrator'),
  /** Seeds a demo workspace with sample members and roles. Never in production. */
  SEED_DEMO_DATA: Joi.boolean().default(false),
  /** Ceiling on workspaces a single non-admin user may own. */
  MAX_OWNED_ORGANIZATIONS: Joi.number().integer().min(1).max(100).default(5),
  /** Ceiling on members per workspace. Zero means unlimited. */
  MAX_MEMBERS_PER_ORGANIZATION: Joi.number().integer().min(0).default(0),
})
  // Unknown keys are allowed: the shell environment always carries far more than
  // we declare (PATH, HOME, CI variables, the platform's own injected values).
  .unknown(true);

export interface EnvValidationResult {
  values: Record<string, unknown>;
  /** Secrets that fell back to an insecure development default. */
  insecureDefaultsUsed: string[];
}

/**
 * Validates `process.env` against the schema.
 *
 * Wired into `ConfigModule.forRoot({ validate })` so failures surface during
 * bootstrap rather than at the first request that happens to read the value.
 */
export function validateEnvironment(raw: Record<string, unknown>): Record<string, unknown> {
  // Joi's result is loosely typed; annotating keeps the `any` from leaking into
  // every caller of this function.
  const result = envValidationSchema.validate(raw, {
    abortEarly: false,
    convert: true,
    stripUnknown: false,
  }) as { error?: Joi.ValidationError; value: Record<string, unknown> };

  const { error, value } = result;

  const problems = error ? error.details.map((detail) => detail.message) : [];
  if (!error) problems.push(...crossFieldProblems(value));

  if (problems.length > 0) {
    const details = problems.map((problem) => `  - ${problem}`).join('\n');
    throw new Error(
      `Environment validation failed. The application will not start with an invalid configuration.\n${details}\n\n` +
        'See .env.example for the full list of supported variables.',
    );
  }

  return value;
}

/**
 * Relationships between variables that per-field rules cannot express.
 *
 * Each one is a configuration that would otherwise fail confusingly at run
 * time — an HTTP budget shorter than the generation it wraps turns every long
 * answer into a 408 with the model still running.
 */
function crossFieldProblems(values: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const ms = (key: string): number => parseDuration(values[key] as string);

  if (ms('LLM_REQUEST_TIMEOUT') < ms('LLM_MAX_DURATION') + 10_000) {
    problems.push(
      '"LLM_REQUEST_TIMEOUT" must exceed "LLM_MAX_DURATION" by at least 10s, so a generation ' +
        'can finish and be saved before the HTTP budget runs out.',
    );
  }
  if (ms('LLM_FIRST_TOKEN_TIMEOUT') > ms('LLM_MAX_DURATION')) {
    problems.push('"LLM_FIRST_TOKEN_TIMEOUT" cannot exceed "LLM_MAX_DURATION".');
  }
  if (values.PII_NER_PROVIDER === 'presidio' && !values.PRESIDIO_ANALYZER_URL) {
    problems.push(
      '"PRESIDIO_ANALYZER_URL" is required when "PII_NER_PROVIDER" is presidio.',
    );
  }

  const drainDelay = ms('QUEUE_DRAIN_DELAY');
  if (drainDelay < 1_000 || drainDelay > 300_000) {
    problems.push('"QUEUE_DRAIN_DELAY" must be between 1s and 5m.');
  }
  const stalledInterval = ms('QUEUE_STALLED_INTERVAL');
  if (stalledInterval < 5_000 || stalledInterval > 600_000) {
    problems.push('"QUEUE_STALLED_INTERVAL" must be between 5s and 10m.');
  }

  // ── Phase 4 ────────────────────────────────────────────────────────────────
  if (ms('WORKFLOW_STEP_TIMEOUT') < ms('LLM_MAX_DURATION') + 30_000) {
    problems.push(
      '"WORKFLOW_STEP_TIMEOUT" must exceed "LLM_MAX_DURATION" by at least 30s: an agent step ' +
        'makes at least one full model call.',
    );
  }
  if (ms('WORKFLOW_RUN_TIMEOUT') < ms('WORKFLOW_STEP_TIMEOUT')) {
    problems.push('"WORKFLOW_RUN_TIMEOUT" cannot be shorter than "WORKFLOW_STEP_TIMEOUT".');
  }
  if (ms('WORKFLOW_STALL_THRESHOLD') < 3 * ms('WORKFLOW_HEARTBEAT_INTERVAL')) {
    problems.push(
      '"WORKFLOW_STALL_THRESHOLD" must be at least three "WORKFLOW_HEARTBEAT_INTERVAL"s, or ' +
        'a slow heartbeat would be mistaken for a dead worker.',
    );
  }
  if (ms('WORKFLOW_STEP_BACKOFF') > ms('WORKFLOW_STEP_BACKOFF_MAX')) {
    problems.push('"WORKFLOW_STEP_BACKOFF" cannot exceed "WORKFLOW_STEP_BACKOFF_MAX".');
  }
  if (ms('TOOL_DEFAULT_TIMEOUT') > ms('TOOL_MAX_TIMEOUT')) {
    problems.push('"TOOL_DEFAULT_TIMEOUT" cannot exceed "TOOL_MAX_TIMEOUT".');
  }
  if (Number(values.TOOL_DEFAULT_ITERATIONS) > Number(values.TOOL_MAX_ITERATIONS)) {
    problems.push('"TOOL_DEFAULT_ITERATIONS" cannot exceed "TOOL_MAX_ITERATIONS".');
  }
  if (ms('TOOL_MAX_TIMEOUT') >= ms('WORKFLOW_STEP_TIMEOUT')) {
    problems.push('"TOOL_MAX_TIMEOUT" must be shorter than "WORKFLOW_STEP_TIMEOUT".');
  }
  const production = values.NODE_ENV === 'production' || values.NODE_ENV === 'staging';
  if (production && values.TOOL_HTTP_ALLOW_PRIVATE_NETWORKS === true) {
    problems.push(
      '"TOOL_HTTP_ALLOW_PRIVATE_NETWORKS" cannot be enabled outside development: it lets an ' +
        'agent reach cloud metadata endpoints and internal services.',
    );
  }
  if (production && values.TOOL_HTTP_ALLOW_INSECURE === true) {
    problems.push('"TOOL_HTTP_ALLOW_INSECURE" cannot be enabled outside development.');
  }

  // ── Phase 5 ────────────────────────────────────────────────────────────────
  if (
    ms('QUOTA_RESERVATION_TTL') <
    ms('LLM_QUEUE_TIMEOUT') + ms('LLM_MAX_DURATION') + 30_000
  ) {
    problems.push(
      '"QUOTA_RESERVATION_TTL" must exceed "LLM_QUEUE_TIMEOUT" + "LLM_MAX_DURATION" by at least ' +
        '30s, or a slow but healthy generation would have its reservation released under it.',
    );
  }
  const perTurn = Number(values.AGENT_MAX_TOKENS_PER_TURN);
  if (perTurn > 0 && perTurn < Number(values.LLM_DEFAULT_CONTEXT_WINDOW)) {
    problems.push(
      '"AGENT_MAX_TOKENS_PER_TURN" must be 0 (no limit) or at least "LLM_DEFAULT_CONTEXT_WINDOW": ' +
        'a single model call can use a whole context window.',
    );
  }
  const perConversation = Number(values.AGENT_MAX_TOKENS_PER_CONVERSATION);
  if (perConversation > 0 && perTurn > 0 && perConversation < perTurn) {
    problems.push(
      '"AGENT_MAX_TOKENS_PER_CONVERSATION" cannot be smaller than "AGENT_MAX_TOKENS_PER_TURN".',
    );
  }
  const auditRetention = ms('AUDIT_RETENTION');
  if (auditRetention > 0 && auditRetention < ms('AUDIT_RETENTION_MIN')) {
    problems.push(
      '"AUDIT_RETENTION" must be 0 (keep forever) or at least "AUDIT_RETENTION_MIN".',
    );
  }
  if (ms('LIFECYCLE_SWEEP_INTERVAL') < 60_000) {
    problems.push('"LIFECYCLE_SWEEP_INTERVAL" must be at least one minute.');
  }
  if (values.WORKER_HTTP_PORT && values.WORKER_HTTP_PORT === values.APP_PORT) {
    problems.push(
      '"WORKER_HTTP_PORT" must differ from "APP_PORT" (the API and a co-located worker ' +
        'would both try to listen on it).',
    );
  }
  for (const [prefix, label] of [
    ['AI_SERVICE_TLS', 'the AI service'],
    ['LLM_TLS', 'the model endpoint'],
  ] as const) {
    problems.push(
      ...describeClientTlsProblems(
        {
          cert: values[`${prefix}_CERT`] as string,
          key: values[`${prefix}_KEY`] as string,
          passphrase: values[`${prefix}_KEY_PASSPHRASE`] as string,
          ca: values[`${prefix}_CA`] as string,
        },
        prefix,
        label,
      ),
    );
  }
  if (
    values.AI_SERVICE_TLS_CERT &&
    typeof values.AI_SERVICE_URL === 'string' &&
    values.AI_SERVICE_URL.startsWith('http://')
  ) {
    problems.push(
      '"AI_SERVICE_TLS_CERT" is set but "AI_SERVICE_URL" uses http://: mutual TLS needs https://.',
    );
  }
  if (
    values.LLM_TLS_CERT &&
    typeof values.LLM_BASE_URL === 'string' &&
    values.LLM_BASE_URL.startsWith('http://')
  ) {
    problems.push(
      '"LLM_TLS_CERT" is set but "LLM_BASE_URL" uses http://: mutual TLS needs https://.',
    );
  }

  return problems;
}

/**
 * Reports which security-critical secrets are still on their development
 * default, so that bootstrap can warn loudly.
 */
export function findInsecureDefaults(env: Record<string, unknown>): string[] {
  const insecure = Object.entries(INSECURE_DEV_DEFAULTS)
    .filter(([key, devValue]) => env[key] === devValue)
    .map(([key]) => key);

  if (env.AI_SERVICE_SIGNING_SECRET === INSECURE_AI_SIGNING_DEFAULT) {
    insecure.push('AI_SERVICE_SIGNING_SECRET');
  }

  return insecure;
}
