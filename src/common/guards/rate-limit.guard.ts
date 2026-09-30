import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CacheKeys } from '../constants/cache-keys.constants';
import { BEARER_PREFIX, HEADER, METADATA_KEY } from '../constants/app.constants';
import { AuditAction, AuditStatus } from '../enums/audit-action.enum';
import { AuthType } from '../enums/auth-type.enum';
import { ErrorCode } from '../enums/error-code.enum';
import { RateLimitError } from '../exceptions/app.exception';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { normaliseIp } from '../utils/ip.util';
import {
  THROTTLE_CONFIG_KEY,
  THROTTLE_POLICY,
  type ThrottleConfig,
  type ThrottlePolicyConfig,
} from '../../config/throttle.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../../modules/audit/audit.service';
import { JwtTokenService } from '../../modules/auth/services/jwt-token.service';
import { MetricsService } from '../../observability/metrics.service';

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

/** What the limiter could establish about a request before authentication. */
export interface ThrottleIdentityInput {
  policyName: string;
  /** Subject of a correctly signed, unexpired access token, if one was presented. */
  userId: string | null;
  /** Family of a correctly signed refresh token, on the refresh route only. */
  sessionFamily: string | null;
  ip: string;
  /** The address a credential endpoint was asked about, if its body names one. */
  email: string | null;
}

/**
 * Chooses the bucket a request counts against.
 *
 * The refresh route counts per session: a browser renews on every page load,
 * and one person's tabs must not starve another's. A request whose body names
 * an email address counts per source address *and* that email, so one address
 * cannot spray many accounts from one budget and one account cannot be cheaply
 * locked out from many addresses. Everything else counts per signed-in user —
 * an identity that cannot be spoofed, and which keeps an office behind one NAT
 * address from sharing a single budget — or, without one, per source address.
 */
export function resolveThrottleIdentity(input: ThrottleIdentityInput): string {
  if (input.policyName === THROTTLE_POLICY.REFRESH && input.sessionFamily) {
    return `session:${input.sessionFamily}`;
  }
  // A request naming an email address (sign-in, registration, recovery, an
  // invitation) keeps its per-address budget even when a token is presented:
  // those budgets protect the address, not the caller.
  if (input.email) return `ip:${input.ip}:email:${input.email.toLowerCase().slice(0, 320)}`;
  if (input.userId) return `user:${input.userId}`;
  return `ip:${input.ip}`;
}

/**
 * Redis-backed request throttling — the foundation of proposal module 6.14.
 *
 * ## Sliding window, not fixed window
 *
 * Each bucket is a Redis sorted set of request timestamps. Admitting a request
 * means dropping entries older than the window, adding this one, and counting.
 *
 * The obvious alternative — a counter with a TTL — allows double the intended
 * rate across a window boundary: ten requests at 00:59 and ten more at 01:01
 * both pass a "ten per minute" limit. For the sign-in endpoint that is the
 * difference between blunting a credential-stuffing run and not.
 *
 * ## Identity, not just address
 *
 * This guard runs before authentication, deliberately: a rejected request
 * should not pay for a database lookup. It therefore identifies the caller
 * cheaply itself — by verifying the access token's signature and expiry (no
 * database, no revocation check) and keying the budget by its subject, or the
 * refresh token's session family on the refresh route. Only traffic without a
 * verifiable identity falls back to the source address (see
 * {@link resolveThrottleIdentity}). Keying purely on IP would let one user
 * behind a corporate NAT exhaust the budget for their whole office.
 *
 * ## Fails open
 *
 * If Redis is unavailable the request is allowed, with a warning. A rate limiter
 * that takes the API down when its cache blips has converted a degradation into
 * an outage. The account lockout counters in PostgreSQL remain authoritative for
 * credential-stuffing defence, so the security-critical case still holds.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly config: ThrottleConfig;
  private readonly refreshCookieName: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly jwtTokenService: JwtTokenService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.config = this.configService.getOrThrow<ThrottleConfig>(THROTTLE_CONFIG_KEY);
    this.refreshCookieName =
      this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY).refreshCookie.name;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.enabled) return true;
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const policyName =
      this.reflector.getAllAndOverride<string>(METADATA_KEY.THROTTLE_POLICY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? this.config.defaultPolicy;

    const policy =
      this.config.policies[policyName] ?? this.config.policies[THROTTLE_POLICY.DEFAULT];
    const identifier = await this.identify(request, policyName);

    const decision = await this.consume(policyName, identifier, policy);

    response.setHeader(HEADER.RATE_LIMIT_LIMIT, String(decision.limit));
    response.setHeader(
      HEADER.RATE_LIMIT_REMAINING,
      String(Math.max(decision.remaining, 0)),
    );
    response.setHeader(
      HEADER.RATE_LIMIT_RESET,
      String(Math.ceil((Date.now() + decision.resetMs) / 1000)),
    );

    if (decision.allowed) return true;

    const retryAfterSeconds = Math.max(Math.ceil(decision.resetMs / 1000), 1);
    this.metrics?.rateLimitRejections.inc({ policy: policyName });

    await this.auditService.recordSafe({
      action: AuditAction.RATE_LIMIT_TRIGGERED,
      status: AuditStatus.DENIED,
      organizationId: request.organization?.id,
      resourceType: 'endpoint',
      resourceId: request.originalUrl?.split('?')[0],
      metadata: {
        policy: policyName,
        limit: policy.limit,
        windowMs: policy.ttlMs,
        retryAfterSeconds,
      },
    });

    throw new RateLimitError(retryAfterSeconds, ErrorCode.RATE_LIMIT_EXCEEDED, {
      message:
        `Rate limit exceeded for this endpoint (${policy.limit} requests per ` +
        `${Math.round(policy.ttlMs / 1000)}s). Try again in ${retryAfterSeconds}s.`,
    });
  }

  /**
   * Admits or rejects one request against a sliding window.
   *
   * The candidate is added optimistically and removed again on rejection. Doing
   * it this way keeps the whole operation inside one `MULTI` with no Lua, which
   * matters because ioredis applies its configured key prefix to ordinary
   * commands but not reliably to `EVAL` key arguments — a mismatch that would
   * silently split every bucket in two.
   */
  private async consume(
    policyName: string,
    identifier: string,
    policy: ThrottlePolicyConfig,
  ): Promise<RateLimitDecision> {
    const key = CacheKeys.throttle(policyName, identifier);
    const now = Date.now();
    const windowStart = now - policy.ttlMs;
    const member = `${now}-${randomUUID()}`;

    try {
      const results = await this.redis.redis
        .multi()
        .zremrangebyscore(key, 0, windowStart)
        .zadd(key, now, member)
        .zcard(key)
        .pexpire(key, policy.ttlMs)
        .exec();

      const count = Number(results?.[2]?.[1] ?? 0);

      if (count <= policy.limit) {
        return {
          allowed: true,
          limit: policy.limit,
          remaining: policy.limit - count,
          resetMs: policy.ttlMs,
        };
      }

      // Rejected: take the candidate back out so a blocked caller does not
      // extend their own penalty by continuing to hammer the endpoint.
      await this.redis.redis.zrem(key, member);

      const oldest = await this.redis.redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestScore = oldest.length >= 2 ? Number(oldest[1]) : now;
      const resetMs = Math.max(policy.ttlMs - (now - oldestScore), 0);

      return { allowed: false, limit: policy.limit, remaining: 0, resetMs };
    } catch (error) {
      this.logger.warn(
        `Rate limiting unavailable (${(error as Error).message}); allowing the request.`,
      );
      return {
        allowed: true,
        limit: policy.limit,
        remaining: policy.limit,
        resetMs: policy.ttlMs,
      };
    }
  }

  /** Establishes the caller's identity for {@link resolveThrottleIdentity}. */
  private async identify(
    request: AuthenticatedRequest,
    policyName: string,
  ): Promise<string> {
    const bearer = this.bearerToken(request);
    const userId = bearer ? await this.jwtTokenService.identifyAccessToken(bearer) : null;

    let sessionFamily: string | null = null;
    if (policyName === THROTTLE_POLICY.REFRESH) {
      const body = request.body as { refreshToken?: unknown } | undefined;
      const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies;
      const refreshToken =
        typeof body?.refreshToken === 'string'
          ? body.refreshToken
          : cookies?.[this.refreshCookieName];
      if (refreshToken) {
        sessionFamily = await this.jwtTokenService.identifyRefreshToken(refreshToken);
      }
    }

    const body = request.body as { email?: unknown } | undefined;
    return resolveThrottleIdentity({
      policyName,
      userId,
      sessionFamily,
      // `TRUST_PROXY` must be configured correctly: a spoofable client IP would
      // make the anonymous budget trivially evadable.
      ip: normaliseIp(request.ip),
      email: typeof body?.email === 'string' ? body.email : null,
    });
  }

  private bearerToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, ...rest] = header.split(' ');
    if (scheme?.toLowerCase() !== BEARER_PREFIX.toLowerCase()) return null;
    const token = rest.join(' ').trim();
    return token.length > 0 ? token : null;
  }

  /** Exposed for tests and for the sign-in path's pre-emptive check. */
  async peek(policyName: string, identifier: string): Promise<number> {
    const policy =
      this.config.policies[policyName] ?? this.config.policies[THROTTLE_POLICY.DEFAULT];
    const key = CacheKeys.throttle(policyName, identifier);

    try {
      await this.redis.redis.zremrangebyscore(key, 0, Date.now() - policy.ttlMs);
      return await this.redis.redis.zcard(key);
    } catch {
      return 0;
    }
  }
}

/** Re-exported so callers do not need the config module to name a policy. */
export { THROTTLE_POLICY, AuthType };
