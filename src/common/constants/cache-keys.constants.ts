/**
 * Centralised Redis key builders.
 *
 * Every key the platform writes is produced here. Two reasons:
 *
 *  1. Namespacing. Redis is shared with BullMQ from phase 4 onward; a typo'd
 *     ad-hoc key that collides with a queue key is an extremely unpleasant bug.
 *  2. Invalidation. Knowing every shape a key can take is what makes targeted
 *     invalidation (for example, dropping every cached permission set for a
 *     workspace after its roles change) tractable.
 *
 * A global prefix is applied separately by ioredis via `keyPrefix`, so the
 * builders below return the unprefixed portion.
 */

export const CACHE_NAMESPACE = {
  AUTH: 'auth',
  RBAC: 'rbac',
  ORG: 'org',
  THROTTLE: 'throttle',
  LOCK: 'lock',
  IDEMPOTENCY: 'idem',
  PII: 'pii',
  LLM: 'llm',
  EVENTS: 'events',
  REALTIME: 'rt',
  WORKFLOW: 'wf',
  QUOTA: 'quota',
  CIRCUIT: 'circuit',
} as const;

export const CacheKeys = {
  /** Effective permission set for a member within a workspace. */
  memberPermissions: (organizationId: string, userId: string): string =>
    `${CACHE_NAMESPACE.RBAC}:perms:${organizationId}:${userId}`,

  /** Wildcard used to invalidate every cached permission set in a workspace. */
  memberPermissionsPattern: (organizationId: string): string =>
    `${CACHE_NAMESPACE.RBAC}:perms:${organizationId}:*`,

  /** Cached workspace record, keyed by id. */
  organization: (organizationId: string): string =>
    `${CACHE_NAMESPACE.ORG}:id:${organizationId}`,

  /** Slug to id lookup. */
  organizationSlug: (slug: string): string => `${CACHE_NAMESPACE.ORG}:slug:${slug}`,

  /** Cached IP allowlist for a workspace. */
  organizationIpAllowlist: (organizationId: string): string =>
    `${CACHE_NAMESPACE.ORG}:ip-allowlist:${organizationId}`,

  /** Cached membership record. */
  membership: (organizationId: string, userId: string): string =>
    `${CACHE_NAMESPACE.ORG}:member:${organizationId}:${userId}`,

  /** Cached authenticated-user projection, avoiding a DB round trip per request. */
  userProfile: (userId: string): string => `${CACHE_NAMESPACE.AUTH}:user:${userId}`,

  /**
   * Denylist entry for an access token that was invalidated before its natural
   * expiry (sign-out, password change, membership revocation). Keyed by the
   * token's `jti` and expired automatically at the token's own `exp`.
   */
  revokedAccessToken: (jti: string): string => `${CACHE_NAMESPACE.AUTH}:revoked:${jti}`,

  /**
   * Cut-off timestamp per user. Any access token issued before this instant is
   * rejected. One key invalidates every outstanding token for a user, which is
   * what "sign out everywhere" and "password changed" need.
   */
  userTokenEpoch: (userId: string): string => `${CACHE_NAMESPACE.AUTH}:epoch:${userId}`,

  /** Cached API-key lookup, keyed by the key's public prefix. */
  apiKeyByPrefix: (prefix: string): string => `${CACHE_NAMESPACE.AUTH}:apikey:${prefix}`,

  /** Failed sign-in counter, keyed by normalised email. */
  loginAttempts: (emailHash: string): string =>
    `${CACHE_NAMESPACE.AUTH}:login-attempts:${emailHash}`,

  /** Failed sign-in counter, keyed by source IP. */
  loginAttemptsByIp: (ip: string): string => `${CACHE_NAMESPACE.AUTH}:login-ip:${ip}`,

  /** Generic throttle bucket. */
  throttle: (policy: string, identifier: string): string =>
    `${CACHE_NAMESPACE.THROTTLE}:${policy}:${identifier}`,

  /** Distributed mutex. */
  lock: (resource: string): string => `${CACHE_NAMESPACE.LOCK}:${resource}`,

  /**
   * NER results for one text, keyed by a keyed digest of the text, the
   * workspace and the policy. The value is offsets and types only — never text.
   */
  piiDetection: (fingerprint: string): string =>
    `${CACHE_NAMESPACE.PII}:ner:${fingerprint}`,

  /**
   * A workspace's recent real-time events: a capped Redis stream, so a client
   * that reconnects can ask for what it missed. Metadata only — events never
   * carry content.
   */
  eventStream: (organizationId: string): string =>
    `${CACHE_NAMESPACE.EVENTS}:org:${organizationId}`,

  /** Live real-time connections per user, for the per-user connection ceiling. */
  realtimeConnections: (subjectId: string): string =>
    `${CACHE_NAMESPACE.REALTIME}:conns:${subjectId}`,

  /** Real-time handshake attempts per source IP. */
  realtimeHandshakes: (ip: string): string => `${CACHE_NAMESPACE.REALTIME}:hs:${ip}`,

  /** Tool calls made so far in one workflow run, for the per-run ceiling. */
  workflowToolCalls: (runId: string): string =>
    `${CACHE_NAMESPACE.WORKFLOW}:tool-calls:${runId}`,

  /**
   * A workspace's per-minute token bucket (phase 5). Hash-tagged by workspace,
   * so every key a single admission script touches hashes to one cluster slot.
   */
  tokenBucket: (organizationId: string, quotaId: string): string =>
    `${CACHE_NAMESPACE.QUOTA}:{${organizationId}}:bucket:${quotaId}`,

  /** An agent's circuit-breaker state and its rolling spend (phase 5). */
  agentCircuit: (agentId: string): string => `${CACHE_NAMESPACE.CIRCUIT}:agent:${agentId}`,
  agentSpend: (agentId: string, window: number): string =>
    `${CACHE_NAMESPACE.CIRCUIT}:agent-spend:${agentId}:${window}`,
  agentFailures: (agentId: string): string =>
    `${CACHE_NAMESPACE.CIRCUIT}:agent-failures:${agentId}`,
  /** The agents of a workspace whose circuit is open, for the Command Centre. */
  openCircuits: (organizationId: string): string =>
    `${CACHE_NAMESPACE.CIRCUIT}:open:${organizationId}`,
  /** Throttles the audit record of rate refusals to one per scope per minute. */
  rateLimitAudit: (organizationId: string, scope: string, subjectId: string): string =>
    `${CACHE_NAMESPACE.QUOTA}:rate-audit:${organizationId}:${scope}:${subjectId}`,

  /** A pending second-factor sign-in challenge: attempts so far (phase 5). */
  mfaChallengeAttempts: (challengeId: string): string =>
    `${CACHE_NAMESPACE.AUTH}:mfa-attempts:${challengeId}`,
  /** A completed challenge, so the same challenge cannot be redeemed twice. */
  mfaChallengeUsed: (challengeId: string): string =>
    `${CACHE_NAMESPACE.AUTH}:mfa-used:${challengeId}`,
} as const;

/**
 * Redis pub/sub channels. Channel names are not keys — ioredis does not apply
 * `keyPrefix` to them — so these are combined with the prefix explicitly by
 * the event bus.
 */
export const PubSubChannels = {
  /** Real-time events, fanned out to every API instance holding sockets. */
  events: 'events:live',
  /** Control messages: cancel a run's in-flight steps, revalidate a user's sockets. */
  control: 'events:control',
} as const;

/** Default TTLs, in seconds, for cached projections. */
export const CACHE_TTL_SECONDS = {
  MEMBER_PERMISSIONS: 300,
  ORGANIZATION: 300,
  MEMBERSHIP: 300,
  USER_PROFILE: 120,
  IP_ALLOWLIST: 300,
  API_KEY: 60,
  /** Long, because the epoch must outlive the longest possible refresh token. */
  USER_TOKEN_EPOCH: 60 * 60 * 24 * 60,
} as const;
