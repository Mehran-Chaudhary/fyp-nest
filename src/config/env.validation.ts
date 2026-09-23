import * as Joi from 'joi';

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

export const envValidationSchema = Joi.object({
  // ───────────────────────────────────────────────────────────────────────────
  // Application
  // ───────────────────────────────────────────────────────────────────────────
  NODE_ENV: Joi.string()
    .valid(...NODE_ENVIRONMENTS)
    .default('development'),
  APP_NAME: Joi.string().default('Distributed AI Agent Management Platform'),
  APP_PORT: Joi.number().port().default(3000),
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
  // we declare (PATH, HOME, CI variables, and the phase 2+ keys documented in
  // .env.example but not yet read by any code).
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

  if (error) {
    const details = error.details.map((detail) => `  - ${detail.message}`).join('\n');
    throw new Error(
      `Environment validation failed. The application will not start with an invalid configuration.\n${details}\n\n` +
        'See .env.example for the full list of supported variables.',
    );
  }

  return value;
}

/**
 * Reports which security-critical secrets are still on their development
 * default, so that bootstrap can warn loudly.
 */
export function findInsecureDefaults(env: Record<string, unknown>): string[] {
  return Object.entries(INSECURE_DEV_DEFAULTS)
    .filter(([key, devValue]) => env[key] === devValue)
    .map(([key]) => key);
}
