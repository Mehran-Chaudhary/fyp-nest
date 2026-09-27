import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { CacheKeys } from '../../common/constants/cache-keys.constants';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { GOVERNANCE_CONFIG_KEY, type GovernanceConfig } from '../../config/governance.config';
import { MetricsService } from '../../observability/metrics.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';

export type CircuitReason = 'RUNAWAY_SPEND' | 'REPEATED_FAILURES';

export interface AgentCircuitState {
  agentId: string;
  state: 'closed' | 'open';
  reason?: CircuitReason;
  openedAt?: string;
  /** When the circuit closes by itself (half-open: the next call decides). */
  retryAt?: string;
}

interface OpenRecord {
  organizationId: string;
  reason: CircuitReason;
  openedAt: string;
  until: number;
  detail: Record<string, number>;
}

/**
 * Errors that say something about the agent rather than about the model
 * endpoint: its prompt kept tripping the egress check, outgrowing the context
 * window, being rejected, or producing unusable output. An endpoint outage is
 * the gateway's own breaker's business, and must not take every agent down
 * with it once the endpoint recovers.
 */
const AGENT_FAULTS: ReadonlySet<string> = new Set([
  ErrorCode.PII_EGRESS_BLOCKED,
  ErrorCode.LLM_CONTEXT_OVERFLOW,
  ErrorCode.LLM_REJECTED,
  ErrorCode.LLM_RESPONSE_INVALID,
  ErrorCode.AGENT_TOKEN_BUDGET_EXCEEDED,
  ErrorCode.WORKFLOW_OUTPUT_INVALID,
]);

/**
 * The per-agent circuit breaker (proposal module 6.14: "runaway agents
 * exhausting tokens"). An agent is broken open — every call refused with
 * `AGENT_CIRCUIT_OPEN` for `AGENT_CIRCUIT_COOLDOWN` — when, across every
 * conversation and workflow run in which it takes part:
 *
 *  - it spends more than `AGENT_CIRCUIT_MAX_TOKENS` within
 *    `AGENT_CIRCUIT_WINDOW` (a loop between an automation and an agent, a
 *    prompt that makes it ramble to its output limit on every call); or
 *  - `AGENT_CIRCUIT_FAILURE_THRESHOLD` of its calls fail in a row for
 *    reasons of its own (see AGENT_FAULTS).
 *
 * Opening is audited once as `agent.circuit_broken` and notified live to
 * those who manage quotas; after the cooldown the next call is let through
 * (half-open), and an administrator can close it early. State lives in Redis
 * so every API and worker instance sees the same breaker; if Redis is down
 * the breaker fails open, like the other Redis-held controls — the token
 * budgets in PostgreSQL still bound the damage.
 */
@Injectable()
export class AgentCircuitService {
  private readonly logger = new Logger(AgentCircuitService.name);
  private readonly config: GovernanceConfig['circuit']['agent'];

  constructor(
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
    configService: ConfigService,
    @Optional() private readonly events?: EventBusService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.config = configService.getOrThrow<GovernanceConfig>(GOVERNANCE_CONFIG_KEY).circuit.agent;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Throws `AGENT_CIRCUIT_OPEN` (503, `Retry-After`) while the agent's circuit is open. */
  async assertClosed(organizationId: string, agentId: string): Promise<void> {
    if (!this.config.enabled) return;
    const record = await this.read(agentId);
    if (!record || record.until <= Date.now()) return;

    this.metrics?.quotaDecisions.inc({ decision: 'rejected', reason: 'circuit', scope: 'AGENT' });
    const retryAfterSeconds = Math.max(1, Math.ceil((record.until - Date.now()) / 1000));
    throw new AppException(ErrorCode.AGENT_CIRCUIT_OPEN, HttpStatus.SERVICE_UNAVAILABLE, {
      retryAfterSeconds,
      details: {
        agentId,
        organizationId,
        reason: record.reason,
        openedAt: record.openedAt,
        retryAfterSeconds,
      },
    });
  }

  /**
   * Feeds one finished call into the breaker: its tokens into the spend
   * window, and its failure (or success, which resets the failure run).
   */
  async record(
    organizationId: string,
    agentId: string,
    outcome: { tokens: number; errorCode?: string | null; cancelled?: boolean },
  ): Promise<void> {
    if (!this.config.enabled) return;
    try {
      if (this.config.maxTokensPerWindow > 0 && outcome.tokens > 0) {
        // A fixed window per agent: coarse, but a runaway is not subtle.
        const key = CacheKeys.agentSpend(agentId, Math.floor(Date.now() / this.config.windowMs));
        const results = await this.redis.redis
          .multi()
          .incrby(key, Math.round(outcome.tokens))
          .expire(key, Math.ceil((this.config.windowMs * 2) / 1000), 'NX')
          .exec();
        const total = Number(results?.[0]?.[1] ?? 0);
        if (total > this.config.maxTokensPerWindow) {
          await this.open(organizationId, agentId, 'RUNAWAY_SPEND', {
            tokens: total,
            limit: this.config.maxTokensPerWindow,
            windowSeconds: Math.round(this.config.windowMs / 1000),
          });
          return;
        }
      }

      if (outcome.cancelled) return;
      const failureKey = CacheKeys.agentFailures(agentId);
      if (outcome.errorCode && AGENT_FAULTS.has(outcome.errorCode)) {
        if (this.config.failureThreshold <= 0) return;
        const { value: failures } = await this.redis.increment(
          failureKey,
          Math.ceil((this.config.cooldownMs * 4) / 1000),
        );
        if (failures >= this.config.failureThreshold) {
          await this.open(
            organizationId,
            agentId,
            'REPEATED_FAILURES',
            { failures, threshold: this.config.failureThreshold },
            outcome.errorCode,
          );
          await this.redis.del(failureKey);
        }
      } else if (!outcome.errorCode) {
        await this.redis.del(failureKey);
      }
    } catch (error) {
      this.logger.debug(`Agent circuit bookkeeping unavailable: ${(error as Error).message}`);
    }
  }

  async state(agentId: string): Promise<AgentCircuitState> {
    const record = await this.read(agentId);
    if (!record || record.until <= Date.now()) return { agentId, state: 'closed' };
    return {
      agentId,
      state: 'open',
      reason: record.reason,
      openedAt: record.openedAt,
      retryAt: new Date(record.until).toISOString(),
    };
  }

  /** The open circuits of a workspace (expired ones pruned as they are found). */
  async listOpen(organizationId: string): Promise<AgentCircuitState[]> {
    try {
      const agentIds = await this.redis.redis.smembers(CacheKeys.openCircuits(organizationId));
      const states: AgentCircuitState[] = [];
      for (const agentId of agentIds) {
        const state = await this.state(agentId);
        if (state.state === 'open') states.push(state);
        else await this.redis.redis.srem(CacheKeys.openCircuits(organizationId), agentId);
      }
      return states;
    } catch {
      return [];
    }
  }

  /** Closes a circuit early (an administrator decided the agent is fixed). */
  async reset(organizationId: string, agentId: string, actorUserId?: string): Promise<boolean> {
    const record = await this.read(agentId);
    await this.redis.del(CacheKeys.agentCircuit(agentId), CacheKeys.agentFailures(agentId));
    await this.redis.redis
      .srem(CacheKeys.openCircuits(organizationId), agentId)
      .catch(() => undefined);
    const wasOpen = !!record && record.until > Date.now();
    await this.auditService.recordSafe({
      action: AuditAction.AGENT_CIRCUIT_RESET,
      organizationId,
      resourceType: 'agent',
      resourceId: agentId,
      ...(actorUserId ? {} : { actor: { type: ActorType.SYSTEM, label: 'circuit breaker' } }),
      metadata: { wasOpen, reason: record?.reason ?? null },
    });
    return wasOpen;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async open(
    organizationId: string,
    agentId: string,
    reason: CircuitReason,
    detail: Record<string, number>,
    errorCode?: string,
  ): Promise<void> {
    const record: OpenRecord = {
      organizationId,
      reason,
      openedAt: new Date().toISOString(),
      until: Date.now() + this.config.cooldownMs,
      detail,
    };
    // NX: of all the calls that push an agent over the edge at once, one
    // opens the circuit — and only that one audits and notifies.
    const opened = await this.redis.redis.set(
      CacheKeys.agentCircuit(agentId),
      JSON.stringify(record),
      'PX',
      this.config.cooldownMs,
      'NX',
    );
    if (opened !== 'OK') return;

    await this.redis.redis
      .sadd(CacheKeys.openCircuits(organizationId), agentId)
      .catch(() => undefined);
    this.metrics?.agentCircuitOpened.inc({ reason });
    this.logger.warn(`Agent ${agentId} circuit opened (${reason}).`);

    await this.auditService.recordSafe({
      action: AuditAction.AGENT_CIRCUIT_BROKEN,
      status: AuditStatus.DENIED,
      organizationId,
      resourceType: 'agent',
      resourceId: agentId,
      actor: { type: ActorType.SYSTEM, label: 'circuit breaker' },
      metadata: {
        scope: 'agent',
        reason,
        cooldownSeconds: Math.round(this.config.cooldownMs / 1000),
        ...detail,
        ...(errorCode ? { errorCode } : {}),
      },
    });
    await this.notify(organizationId, agentId, reason);
  }

  private async notify(
    organizationId: string,
    agentId: string,
    reason: CircuitReason,
  ): Promise<void> {
    if (!this.events) return;
    try {
      const recipients: Array<{ user_id: string }> = await this.dataSource.query(
        `SELECT user_id FROM organization_members
          WHERE organization_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'
            AND effective_permissions ?| ARRAY['quota:manage','quota:*','agent:update','agent:*','*:*']
          LIMIT 50`,
        [organizationId],
      );
      if (recipients.length === 0) return;
      await this.events.publish({
        type: 'notification',
        organizationId,
        recipientUserIds: recipients.map((row) => row.user_id),
        data: {
          kind: 'agent.circuit_opened',
          agentId,
          reason,
          cooldownSeconds: Math.round(this.config.cooldownMs / 1000),
        },
      });
    } catch (error) {
      this.logger.debug(`Could not notify about an agent circuit: ${(error as Error).message}`);
    }
  }

  private async read(agentId: string): Promise<OpenRecord | null> {
    try {
      const raw = await this.redis.get(CacheKeys.agentCircuit(agentId));
      return raw ? (JSON.parse(raw) as OpenRecord) : null;
    } catch {
      return null;
    }
  }
}
