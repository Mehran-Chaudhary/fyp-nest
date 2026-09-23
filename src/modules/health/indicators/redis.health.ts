import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { RedisService } from '../../../shared/redis/redis.service';

/**
 * Redis probe.
 *
 * Reported as **degraded** rather than **down** when unreachable. That is not
 * leniency: Redis carries caching, rate limiting and the token-revocation
 * overlay, all of which have documented fallbacks — permission checks fall
 * through to PostgreSQL, rate limiting fails open, and revocation is still
 * enforced against `users.tokens_valid_from`. The API continues to serve correct
 * responses, more slowly and with a wider revocation window.
 *
 * Marking it `down` would make an orchestrator pull a working instance out of
 * rotation, turning a cache incident into a user-visible outage — which is
 * exactly the failure mode the fallbacks were written to avoid.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly redis: RedisService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const startedAt = Date.now();

    try {
      const alive = await this.redis.ping();
      const responseTimeMs = Date.now() - startedAt;

      if (!alive) {
        return indicator.degraded({
          message: 'PING did not return PONG. Caching and rate limiting are impaired.',
          responseTimeMs,
          connectionState: this.redis.redis.status,
        });
      }

      return indicator.up({ responseTimeMs, connectionState: this.redis.redis.status });
    } catch (error) {
      return indicator.degraded({
        message: `${(error as Error).message}. Caching and rate limiting are impaired.`,
        responseTimeMs: Date.now() - startedAt,
      });
    }
  }
}
