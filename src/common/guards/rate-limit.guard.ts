import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CacheKeys } from '../constants/cache-keys.constants';
import { HEADER, METADATA_KEY } from '../constants/app.constants';
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
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../../modules/audit/audit.service';

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
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
 * Buckets are keyed by principal where one exists (user id, then API key id) and
 * fall back to source IP only for unauthenticated traffic. Keying purely on IP
 * would let one user behind a corporate NAT exhaust the budget for their whole
 * office, and would let an attacker with a proxy pool bypass the limit entirely.
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

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {
    this.config = this.configService.getOrThrow<ThrottleConfig>(THROTTLE_CONFIG_KEY);
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

    const policy = this.config.policies[policyName] ?? this.config.policies[THROTTLE_POLICY.DEFAULT];
    const identifier = this.identify(request);

    const decision = await this.consume(policyName, identifier, policy);

    response.setHeader(HEADER.RATE_LIMIT_LIMIT, String(decision.limit));
    response.setHeader(HEADER.RATE_LIMIT_REMAINING, String(Math.max(decision.remaining, 0)));
    response.setHeader(
      HEADER.RATE_LIMIT_RESET,
      String(Math.ceil((Date.now() + decision.resetMs) / 1000)),
    );

    if (decision.allowed) return true;

    const retryAfterSeconds = Math.max(Math.ceil(decision.resetMs / 1000), 1);

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

  /**
   * Chooses the bucket key for a request.
   *
   * Authenticated principals get their own budget. Unauthenticated traffic falls
   * back to source IP, which is the only identity available — and is why
   * `TRUST_PROXY` must be configured correctly, since a spoofable client IP
   * would make the limit trivially evadable.
   */
  private identify(request: AuthenticatedRequest): string {
    if (request.user) return `user:${request.user.id}`;
    if (request.apiKey) return `key:${request.apiKey.id}`;

    const ip = normaliseIp(request.ip);

    // For unauthenticated credential endpoints, the attempted identity is folded
    // into the key so that one address cannot spray many accounts from a single
    // budget, and one account cannot be locked out cheaply from many addresses.
    const body = request.body as { email?: unknown } | undefined;
    if (typeof body?.email === 'string') {
      return `ip:${ip}:email:${body.email.toLowerCase().slice(0, 320)}`;
    }

    return `ip:${ip}`;
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
