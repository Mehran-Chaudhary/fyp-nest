import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

/**
 * Token quotas, throttling and agent circuit breaking (proposal module 6.14,
 * completed in phase 5).
 *
 * Three controls, each answering a different question:
 *
 *  - **Budgets** — how many tokens a workspace, member, agent or API key may
 *    spend per day or month. Held in PostgreSQL, reserved before every model
 *    call and settled after it, so concurrent calls cannot overspend.
 *  - **Rate** — how fast a workspace may spend them: a token bucket per
 *    minute, in Redis, which smooths bursts instead of refusing a whole month.
 *  - **Circuit breakers** — whether an agent has started to run away:
 *    per-turn and per-conversation budgets, and a per-agent breaker that opens
 *    on anomalous spend or repeated agent-caused failures.
 *
 * All three are enforced at the LLM gateway, the one path every model call in
 * the platform takes, so no feature can forget them.
 */
export interface GovernanceConfig {
  quotas: {
    enabled: boolean;
    /** Monthly token allowance per workspace by plan; 0 = unlimited. */
    planMonthlyTokens: { FREE: number; PRO: number; ENTERPRISE: number };
    /** Workspace token rate per minute; 0 = no rate limit. */
    tokensPerMinute: number;
    alertThresholdPercent: number;
    reservationTtlMs: number;
    cacheTtlMs: number;
  };
  circuit: {
    maxTokensPerTurn: number;
    maxTokensPerConversation: number;
    agent: {
      enabled: boolean;
      windowMs: number;
      maxTokensPerWindow: number;
      failureThreshold: number;
      cooldownMs: number;
    };
  };
}

export const GOVERNANCE_CONFIG_KEY = 'governance';

export default registerAs(
  GOVERNANCE_CONFIG_KEY,
  (): GovernanceConfig => ({
    quotas: {
      enabled: process.env.QUOTA_ENFORCEMENT_ENABLED !== 'false',
      planMonthlyTokens: {
        FREE: Number(process.env.QUOTA_FREE_MONTHLY_TOKENS ?? 2_000_000),
        PRO: Number(process.env.QUOTA_PRO_MONTHLY_TOKENS ?? 20_000_000),
        ENTERPRISE: Number(process.env.QUOTA_ENTERPRISE_MONTHLY_TOKENS ?? 0),
      },
      tokensPerMinute: Number(process.env.QUOTA_TOKENS_PER_MINUTE ?? 100_000),
      alertThresholdPercent: Number(process.env.QUOTA_ALERT_THRESHOLD ?? 80),
      reservationTtlMs: parseDuration(process.env.QUOTA_RESERVATION_TTL ?? '10m'),
      cacheTtlMs: parseDuration(process.env.QUOTA_CACHE_TTL ?? '30s'),
    },
    circuit: {
      maxTokensPerTurn: Number(process.env.AGENT_MAX_TOKENS_PER_TURN ?? 60_000),
      maxTokensPerConversation: Number(
        process.env.AGENT_MAX_TOKENS_PER_CONVERSATION ?? 1_000_000,
      ),
      agent: {
        enabled: process.env.AGENT_CIRCUIT_ENABLED !== 'false',
        windowMs: parseDuration(process.env.AGENT_CIRCUIT_WINDOW ?? '60s'),
        maxTokensPerWindow: Number(process.env.AGENT_CIRCUIT_MAX_TOKENS ?? 250_000),
        failureThreshold: Number(process.env.AGENT_CIRCUIT_FAILURE_THRESHOLD ?? 5),
        cooldownMs: parseDuration(process.env.AGENT_CIRCUIT_COOLDOWN ?? '5m'),
      },
    },
  }),
);
