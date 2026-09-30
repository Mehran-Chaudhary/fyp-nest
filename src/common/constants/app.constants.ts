/**
 * Cross-cutting constants: reflection metadata keys, custom header names and
 * request-scoped property names.
 *
 * Keeping these in one place avoids the classic decorator/guard drift where a
 * decorator writes metadata under one key and the guard reads another, silently
 * disabling an authorization check.
 */

// ── Reflection metadata keys ────────────────────────────────────────────────
export const METADATA_KEY = {
  /** Authentication schemes a route accepts (`AuthType[]`). */
  AUTH_TYPE: 'daiap:auth-type',
  /** Permission keys a route requires (`string[]`). */
  REQUIRED_PERMISSIONS: 'daiap:required-permissions',
  /** Whether required permissions are ANY-of instead of ALL-of (`boolean`). */
  PERMISSIONS_ANY_OF: 'daiap:permissions-any-of',
  /** System role slugs a route requires (`string[]`). */
  REQUIRED_ROLES: 'daiap:required-roles',
  /** Marks a route as not needing a workspace context. */
  SKIP_ORGANIZATION_CONTEXT: 'daiap:skip-organization-context',
  /** Resolves the workspace context when one is supplied, and proceeds without it otherwise. */
  OPTIONAL_ORGANIZATION_CONTEXT: 'daiap:optional-organization-context',
  /** Marks a route as requiring platform-administrator status. */
  PLATFORM_ADMIN_ONLY: 'daiap:platform-admin-only',
  /** Audit descriptor attached by `@Audit()`. */
  AUDIT: 'daiap:audit',
  /** Marks a route's response as already enveloped / raw. */
  SKIP_RESPONSE_ENVELOPE: 'daiap:skip-response-envelope',
  /** Per-route throttle policy name. */
  THROTTLE_POLICY: 'daiap:throttle-policy',
  /** Requires a verified email address. */
  REQUIRE_VERIFIED_EMAIL: 'daiap:require-verified-email',
  /** Named request-timeout budget overriding the global default. */
  TIMEOUT_BUDGET: 'daiap:timeout-budget',
} as const;

// ── Custom request / response headers ───────────────────────────────────────
export const HEADER = {
  /** Selects the active workspace for workspace-scoped endpoints. */
  ORGANIZATION_ID: 'x-organization-id',
  /** Alternative to the above, accepting a slug rather than a UUID. */
  ORGANIZATION_SLUG: 'x-organization-slug',
  /** Correlation id, echoed back on every response and stamped on every log line. */
  REQUEST_ID: 'x-request-id',
  /** Machine authentication for the Python AI service and other service callers. */
  API_KEY: 'x-api-key',
  /** Standard rate-limit surface. */
  RATE_LIMIT_LIMIT: 'x-ratelimit-limit',
  RATE_LIMIT_REMAINING: 'x-ratelimit-remaining',
  RATE_LIMIT_RESET: 'x-ratelimit-reset',
  RETRY_AFTER: 'retry-after',
  /** Advertises the API version that served the response. */
  API_VERSION: 'x-api-version',
} as const;

// ── Request-scoped property names ───────────────────────────────────────────
export const REQUEST_PROPERTY = {
  USER: 'user',
  API_KEY: 'apiKey',
  ORGANIZATION: 'organization',
  MEMBERSHIP: 'membership',
  PERMISSIONS: 'permissions',
  REQUEST_ID: 'requestId',
  AUTH_TYPE: 'authType',
  START_TIME: 'startTime',
} as const;

// ── Route parameter names recognised for workspace resolution ───────────────
export const ORGANIZATION_ROUTE_PARAMS = [
  'organizationId',
  'orgId',
  'workspaceId',
] as const;

// ── Miscellaneous ───────────────────────────────────────────────────────────

/** Bearer scheme prefix, compared case-insensitively. */
export const BEARER_PREFIX = 'Bearer';

/** Swagger security scheme identifiers. */
export const SECURITY_SCHEME = {
  BEARER: 'bearer',
  API_KEY: 'api-key',
} as const;

/**
 * Upper bound on any single JSON body. Documents are uploaded as multipart and
 * are governed by their own, larger limit (`UPLOAD_MAX_FILE_SIZE`).
 */
export const DEFAULT_JSON_BODY_LIMIT = '2mb';

/** How many concurrent workspaces a single user may own before being throttled. */
export const DEFAULT_MAX_OWNED_ORGANIZATIONS = 5;
