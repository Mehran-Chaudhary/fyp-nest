import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { CacheKeys } from '../../common/constants/cache-keys.constants';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { MetricsService } from '../../observability/metrics.service';
import { withSpan } from '../../observability/telemetry';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AgentCircuitService } from './agent-circuit.service';
import { applicableQuotas, type QuotaSubject } from './domain/quota-model';
import { QuotaService, type BudgetReservation } from './quota.service';
import { TokenRateLimiterService } from './token-rate-limiter.service';

/** Who a model call is for: what every budget, rate and breaker is keyed by. */
export interface InvocationAttribution {
  userId?: string | null;
  apiKeyId?: string | null;
  agentId?: string | null;
  /** For metrics and audit only. */
  purpose?: string;
}

export interface AdmissionRequest {
  organizationId: string;
  attribution?: InvocationAttribution;
  /** The call's worst case: the prompt about to be sent plus its maximum output. */
  estimatedTokens: number;
}

export interface CallOutcome {
  /** Tokens actually consumed (prompt and completion); 0 if nothing reached the model. */
  tokens: number;
  errorCode?: string | null;
  cancelled?: boolean;
}

/** Settled exactly once, when the call ends however it ends. */
export interface AdmissionLease {
  settle(outcome: CallOutcome): Promise<void>;
}

/** Governance refusals: a model call throttled rather than failed (usage status THROTTLED). */
export const GOVERNANCE_ERROR_CODES: ReadonlySet<string> = new Set([
  ErrorCode.QUOTA_EXCEEDED,
  ErrorCode.TOKEN_RATE_LIMITED,
  ErrorCode.AGENT_CIRCUIT_OPEN,
  ErrorCode.AGENT_TOKEN_BUDGET_EXCEEDED,
  ErrorCode.CONVERSATION_TOKEN_BUDGET_EXCEEDED,
]);

/**
 * Admission control for model calls (proposal module 6.14) — the one place
 * the LLM gateway asks "may this call happen?", in this order:
 *
 *  1. **Agent circuit.** Is the agent broken open? (Redis; fails open.)
 *  2. **Rate.** Do the per-minute token buckets hold this call's worst case?
 *     (Redis; fails open.) Refused → `TOKEN_RATE_LIMITED` with the seconds
 *     until they would: the caller is slowed, not stopped.
 *  3. **Budgets.** Can every binding day and month budget reserve it?
 *     (PostgreSQL; authoritative.) Refused → `QUOTA_EXCEEDED` with the
 *     seconds until the budget resets.
 *
 * All three answer 429 or 503 with `Retry-After` before anything is sent to
 * the model, and a workflow step refused for rate is retried with backoff by
 * the engine: "a workspace exceeding its quota is throttled, not crashed".
 *
 * The lease's `settle` gives back what the call reserved but did not spend,
 * charges what it did, and tells the agent's breaker how the call went.
 */
@Injectable()
export class GovernorService {
  private readonly logger = new Logger(GovernorService.name);

  constructor(
    private readonly quotas: QuotaService,
    private readonly rates: TokenRateLimiterService,
    private readonly circuit: AgentCircuitService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async admit(request: AdmissionRequest): Promise<AdmissionLease> {
    return withSpan(
      'governance.admit',
      { 'daiap.tokens_estimated': Math.round(request.estimatedTokens) },
      () => this.decide(request),
    );
  }

  private async decide(request: AdmissionRequest): Promise<AdmissionLease> {
    const attribution = request.attribution ?? {};
    const subject: QuotaSubject = {
      organizationId: request.organizationId,
      userId: attribution.userId ?? null,
      apiKeyId: attribution.apiKeyId ?? null,
      agentId: attribution.agentId ?? null,
    };
    const agentId = subject.agentId ?? null;
    const cost = Math.max(0, Math.round(request.estimatedTokens));

    // ── 1. The agent's breaker ──────────────────────────────────────────
    if (agentId) await this.circuit.assertClosed(request.organizationId, agentId);

    if (!this.quotas.enabled) {
      return this.lease(request.organizationId, agentId, null, [], 0);
    }

    const definitions = await this.quotas.definitions(request.organizationId);
    const { rates } = applicableQuotas(definitions, subject);

    // ── 2. The per-minute rate ──────────────────────────────────────────
    const rate = await this.rates.admit(rates, cost);
    if (!rate.admitted) {
      const retryAfterSeconds = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
      this.metrics?.quotaDecisions.inc({
        decision: 'rejected',
        reason: 'rate',
        scope: rate.quota.scope,
      });
      await this.auditRateLimit(request.organizationId, rate.quota, subject, retryAfterSeconds);
      throw new AppException(ErrorCode.TOKEN_RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, {
        retryAfterSeconds,
        details: {
          quotaId: rate.quota.id,
          scope: rate.quota.scope,
          tokensPerMinute: rate.quota.tokenLimit,
          requested: cost,
          retryAfterSeconds,
        },
      });
    }

    // ── 3. Budgets ──────────────────────────────────────────────────────
    let reservation: BudgetReservation | null;
    try {
      reservation = await this.quotas.reserve(subject, cost, definitions);
    } catch (error) {
      await this.rates.refund(rates, rate.cost);
      throw error;
    }

    this.metrics?.quotaDecisions.inc({ decision: 'admitted', reason: 'none', scope: 'ALL' });
    return this.lease(request.organizationId, agentId, reservation, rates, rate.cost);
  }

  /**
   * Feeds an agent-caused failure that happened outside a model call (a turn
   * stopped by its token budget) into the agent's breaker.
   */
  async recordAgentFault(organizationId: string, agentId: string, errorCode: string): Promise<void> {
    await this.circuit.record(organizationId, agentId, { tokens: 0, errorCode });
  }

  private lease(
    organizationId: string,
    agentId: string | null,
    reservation: BudgetReservation | null,
    rates: Parameters<TokenRateLimiterService['refund']>[0],
    rateCost: number,
  ): AdmissionLease {
    let settled = false;
    return {
      settle: async (outcome) => {
        if (settled) return;
        settled = true;
        const tokens = Math.max(0, Math.round(outcome.tokens));
        try {
          if (reservation) await this.quotas.settle(reservation, tokens);
          if (rateCost > tokens) await this.rates.refund(rates, rateCost - tokens);
          if (agentId) {
            await this.circuit.record(organizationId, agentId, {
              tokens,
              errorCode: outcome.errorCode ?? null,
              cancelled: outcome.cancelled,
            });
          }
        } catch (error) {
          this.logger.warn(`Settling a model call failed: ${(error as Error).message}`);
        }
      },
    };
  }

  /** At most one audit record per rate, per workspace, per minute: a refused burst is one event. */
  private async auditRateLimit(
    organizationId: string,
    quota: { id: string; scope: string; subjectId: string | null; tokenLimit: number },
    subject: QuotaSubject,
    retryAfterSeconds: number,
  ): Promise<void> {
    try {
      const first = await this.redis.redis.set(
        CacheKeys.rateLimitAudit(organizationId, quota.scope, quota.subjectId ?? quota.id),
        '1',
        'EX',
        60,
        'NX',
      );
      if (first !== 'OK') return;
    } catch {
      // Without Redis the rate limiter itself is failing open; nothing to audit.
      return;
    }
    await this.auditService.recordSafe({
      action: AuditAction.QUOTA_RATE_LIMITED,
      status: AuditStatus.DENIED,
      organizationId,
      resourceType: 'usage_quota',
      resourceId: quota.id,
      actor: { type: ActorType.SYSTEM, label: 'token rate limiter' },
      metadata: {
        scope: quota.scope,
        subjectId: quota.subjectId,
        tokensPerMinute: quota.tokenLimit,
        retryAfterSeconds,
        triggeredBy: {
          userId: subject.userId ?? null,
          apiKeyId: subject.apiKeyId ?? null,
          agentId: subject.agentId ?? null,
        },
      },
    });
  }
}
