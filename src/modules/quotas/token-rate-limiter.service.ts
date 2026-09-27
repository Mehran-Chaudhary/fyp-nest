import { Injectable, Logger } from '@nestjs/common';
import { CacheKeys } from '../../common/constants/cache-keys.constants';
import { RedisService } from '../../shared/redis/redis.service';
import type { QuotaDefinition } from './domain/quota-model';

/**
 * Token buckets for every applicable per-minute rate, checked and debited in
 * one atomic step. A bucket holds up to `limit` tokens and refills at
 * `limit` per minute, continuously — so a workspace may burst to its full
 * minute and is then paced, rather than refused for the rest of a fixed
 * window. The clock is Redis's own (`TIME`), so API instances with skewed
 * clocks agree.
 *
 * KEYS: one bucket per rate. ARGV[1]: the cost; ARGV[2..]: each bucket's limit.
 * Returns {1, 0, 0} when admitted, or {0, waitMs, index} naming the bucket
 * that refused and how long until it could admit the call.
 */
const ADMIT_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cost = tonumber(ARGV[1])
local levels = {}
local worstWait = 0
local refusedBy = 0
for i = 1, #KEYS do
  local capacity = tonumber(ARGV[i + 1])
  local rate = capacity / 60000
  local state = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tokens = tonumber(state[1]) or capacity
  local ts = tonumber(state[2]) or now
  tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)
  levels[i] = tokens
  local need = math.min(cost, capacity)
  if tokens < need then
    local wait = math.ceil((need - tokens) / rate)
    if wait > worstWait then
      worstWait = wait
      refusedBy = i
    end
  end
end
for i = 1, #KEYS do
  local capacity = tonumber(ARGV[i + 1])
  local level = levels[i]
  if refusedBy == 0 then level = level - math.min(cost, capacity) end
  redis.call('HSET', KEYS[i], 'tokens', tostring(level), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[i], 120000)
end
if refusedBy > 0 then return {0, worstWait, refusedBy} end
return {1, 0, 0}
`;

/** Gives unused tokens back to the buckets (capped at each bucket's limit). */
const REFUND_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local amount = tonumber(ARGV[1])
for i = 1, #KEYS do
  local capacity = tonumber(ARGV[i + 1])
  local rate = capacity / 60000
  local state = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  if state[1] then
    local ts = tonumber(state[2]) or now
    local tokens = math.min(capacity, tonumber(state[1]) + math.max(0, now - ts) * rate + amount)
    redis.call('HSET', KEYS[i], 'tokens', tostring(tokens), 'ts', tostring(now))
    redis.call('PEXPIRE', KEYS[i], 120000)
  end
end
return 1
`;

export type RateDecision =
  | { admitted: true; cost: number }
  | { admitted: false; retryAfterMs: number; quota: QuotaDefinition };

/**
 * The per-minute token rate (proposal module 6.14: "throttled, not crashed").
 *
 * Fails open like the request rate limiter: if Redis is unreachable the call
 * is admitted with a warning. The budgets in PostgreSQL still bound what a
 * workspace can spend; the rate only smooths how fast.
 */
@Injectable()
export class TokenRateLimiterService {
  private readonly logger = new Logger(TokenRateLimiterService.name);
  private lastWarning = 0;

  constructor(private readonly redis: RedisService) {}

  async admit(rates: QuotaDefinition[], cost: number): Promise<RateDecision> {
    const amount = Math.max(0, Math.round(cost));
    if (rates.length === 0 || amount === 0) return { admitted: true, cost: amount };

    try {
      const result = (await this.redis.redis.eval(
        ADMIT_SCRIPT,
        rates.length,
        ...rates.map(bucketKey),
        String(amount),
        ...rates.map((quota) => String(quota.tokenLimit)),
      )) as [number, number, number];
      if (Number(result[0]) === 1) return { admitted: true, cost: amount };
      return {
        admitted: false,
        retryAfterMs: Math.max(1, Number(result[1])),
        quota: rates[Math.max(0, Number(result[2]) - 1)],
      };
    } catch (error) {
      this.warn(error);
      return { admitted: true, cost: 0 };
    }
  }

  /** Returns what a call reserved but did not spend. Best effort. */
  async refund(rates: QuotaDefinition[], amount: number): Promise<void> {
    const tokens = Math.round(amount);
    if (rates.length === 0 || tokens <= 0) return;
    try {
      await this.redis.redis.eval(
        REFUND_SCRIPT,
        rates.length,
        ...rates.map(bucketKey),
        String(tokens),
        ...rates.map((quota) => String(quota.tokenLimit)),
      );
    } catch (error) {
      this.warn(error);
    }
  }

  /** Tokens currently available in a bucket (for the quota status view). */
  async available(quota: QuotaDefinition): Promise<number | null> {
    try {
      const [tokens, ts] = await this.redis.redis.hmget(bucketKey(quota), 'tokens', 'ts');
      if (tokens === null) return quota.tokenLimit;
      const elapsed = Math.max(0, Date.now() - Number(ts));
      return Math.min(
        quota.tokenLimit,
        Math.floor(Number(tokens) + (elapsed * quota.tokenLimit) / 60_000),
      );
    } catch {
      return null;
    }
  }

  private warn(error: unknown): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(
      `Token rate limiting unavailable (${(error as Error).message}); admitting calls. ` +
        'Budgets in PostgreSQL still apply.',
    );
  }
}

/** One bucket per rate quota (a platform rate and a stricter workspace one are distinct). */
function bucketKey(quota: QuotaDefinition): string {
  return CacheKeys.tokenBucket(quota.organizationId, quota.id);
}
