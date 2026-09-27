import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { GOVERNANCE_CONFIG_KEY, type GovernanceConfig } from '../../config/governance.config';
import { returnedRows } from '../../database/query.util';
import { MetricsService } from '../../observability/metrics.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AuditService } from '../audit/audit.service';
import {
  applicableQuotas,
  consumedPercent,
  periodEnd,
  periodStart,
  planAllowance,
  QuotaEnforcement,
  QuotaManager,
  QuotaPeriod,
  QuotaScope,
  secondsUntilReset,
  type QuotaDefinition,
  type QuotaSubject,
} from './domain/quota-model';

/** A reservation against budgets, settled when the call ends. */
export interface BudgetReservation {
  id: string;
  organizationId: string;
  tokens: number;
  counters: Array<{ quotaId: string; periodStart: string }>;
}

/** Why a quota row was touched, for alerts. */
interface CounterSnapshot {
  quota: QuotaDefinition;
  periodStart: Date;
  used: number;
  reserved: number;
}

interface QuotaRow {
  id: string;
  organization_id: string;
  scope: QuotaScope;
  subject_id: string | null;
  period: QuotaPeriod;
  token_limit: string;
  enforcement: QuotaEnforcement;
  alert_threshold: number;
  managed_by: QuotaManager;
}

class BudgetExhausted extends Error {
  constructor(
    readonly quota: QuotaDefinition,
    readonly periodStart: Date,
  ) {
    super('budget exhausted');
  }
}

/** The ledger column a scope's consumption is summed by. */
const SCOPE_COLUMN: Readonly<Record<QuotaScope, string | null>> = {
  [QuotaScope.ORGANIZATION]: null,
  [QuotaScope.MEMBER]: 'user_id',
  [QuotaScope.AGENT]: 'agent_id',
  [QuotaScope.API_KEY]: 'api_key_id',
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Token budgets (proposal module 6.14): reservation before every model call,
 * settlement after it, in PostgreSQL.
 *
 * ## Why reserve
 *
 * A call's cost is only known once the model has answered, but whether to
 * make it must be decided before. Counting only finished calls would let a
 * burst of concurrent requests all pass an almost-exhausted budget, and
 * together overspend it by an arbitrary amount. So each call reserves its
 * worst case — the prompt it is about to send plus the most tokens it may
 * generate — with a conditional `UPDATE … WHERE used + reserved + cost ≤
 * limit`, which PostgreSQL evaluates under the row lock: two admissions can
 * never both see the same headroom. Settlement then swaps the reservation for
 * what was actually spent.
 *
 * ## Why it cannot drift
 *
 *  - Several budgets can bind one call (the workspace's, the member's, the
 *    agent's). All are reserved in one transaction, in a fixed order, so the
 *    call is admitted by all of them or by none, and two admissions never
 *    deadlock.
 *  - A reservation is a row with an expiry. A process that dies mid-call
 *    leaves it behind; the maintenance sweep releases it after
 *    `QUOTA_RESERVATION_TTL`.
 *  - The usage ledger remains the source of truth. A counter created
 *    mid-period starts from the ledger's sum, and the sweep raises any counter
 *    that fell behind the ledger (a settlement lost to a crash).
 *
 * ## Platform allowances
 *
 * The deployment's own limits on a workspace — its plan's monthly allowance
 * and the per-minute rate — are kept as `PLATFORM` rows, synchronised from
 * the environment when a workspace's quotas are loaded. They are read-only to
 * the workspace, which can only add stricter budgets of its own.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly config: GovernanceConfig['quotas'];
  private readonly cache = new Map<string, { expires: number; quotas: QuotaDefinition[] }>();
  /** Counters known to exist, per process: `${quotaId}@${periodStart}`. */
  private readonly ensured = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    configService: ConfigService,
    @Optional() private readonly events?: EventBusService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.config = configService.getOrThrow<GovernanceConfig>(GOVERNANCE_CONFIG_KEY).quotas;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // ── Definitions ───────────────────────────────────────────────────────────

  /** A workspace's quotas, platform allowances synchronised; cached briefly. */
  async definitions(organizationId: string): Promise<QuotaDefinition[]> {
    const cached = this.cache.get(organizationId);
    if (cached && cached.expires > Date.now()) return cached.quotas;

    await this.syncPlatformQuotas(organizationId);
    const rows: QuotaRow[] = await this.dataSource.query(
      `SELECT id, organization_id, scope, subject_id, period, token_limit, enforcement,
              alert_threshold, managed_by
         FROM usage_quotas WHERE organization_id = $1`,
      [organizationId],
    );
    const quotas = rows.map(toDefinition);
    this.cache.set(organizationId, { expires: Date.now() + this.config.cacheTtlMs, quotas });
    if (this.cache.size > 5_000) this.cache.clear();
    return quotas;
  }

  /** Drops the cached definitions after a change (this process; others expire). */
  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  /**
   * Makes the `PLATFORM` rows match the environment and the workspace's plan:
   * the monthly allowance and the per-minute rate, each removed when set to 0
   * (unlimited). Writes only when something differs.
   */
  private async syncPlatformQuotas(organizationId: string): Promise<void> {
    const [organization]: Array<{ plan: string }> = await this.dataSource.query(
      `SELECT plan FROM organizations WHERE id = $1`,
      [organizationId],
    );
    if (!organization) return;

    const wanted: Array<{ period: QuotaPeriod; limit: number; label: string }> = [
      {
        period: QuotaPeriod.MONTH,
        limit: planAllowance(organization.plan, this.config.planMonthlyTokens),
        label: `Platform allowance (${organization.plan} plan)`,
      },
      {
        period: QuotaPeriod.MINUTE,
        limit: this.config.tokensPerMinute,
        label: 'Platform token rate',
      },
    ];
    const existing: Array<{ id: string; period: QuotaPeriod; token_limit: string }> =
      await this.dataSource.query(
        `SELECT id, period, token_limit FROM usage_quotas
          WHERE organization_id = $1 AND managed_by = 'PLATFORM'`,
        [organizationId],
      );

    for (const { period, limit, label } of wanted) {
      const current = existing.find((row) => row.period === period);
      if (limit <= 0) {
        if (current) {
          await this.dataSource.query(`DELETE FROM usage_quotas WHERE id = $1`, [current.id]);
        }
        continue;
      }
      if (current && Number(current.token_limit) === limit) continue;
      await this.dataSource.query(
        `INSERT INTO usage_quotas
           (organization_id, scope, subject_id, period, token_limit, enforcement,
            alert_threshold, managed_by, label)
         VALUES ($1, 'ORGANIZATION', NULL, $2, $3, 'HARD', $4, 'PLATFORM', $5)
         ON CONFLICT (organization_id, scope,
                      (COALESCE(subject_id, '${NIL_UUID}'::uuid)), period, managed_by)
         DO UPDATE SET token_limit = EXCLUDED.token_limit, label = EXCLUDED.label`,
        [organizationId, period, limit, this.config.alertThresholdPercent, label],
      );
    }
  }

  // ── Admission ─────────────────────────────────────────────────────────────

  /**
   * Reserves `tokens` against every day and month budget that binds this
   * call, or throws `QUOTA_EXCEEDED` (429, with `Retry-After` until the
   * binding budget resets). Returns null when no budget applies.
   */
  async reserve(
    subject: QuotaSubject,
    tokens: number,
    quotas?: QuotaDefinition[],
    now = new Date(),
  ): Promise<BudgetReservation | null> {
    const definitions = quotas ?? (await this.definitions(subject.organizationId));
    const budgets = applicableQuotas(definitions, subject).budgets;
    if (budgets.length === 0) return null;

    const cost = Math.max(0, Math.round(tokens));
    // A call that could never fit is refused without touching a row.
    const impossible = budgets.find(
      (quota) => quota.enforcement === QuotaEnforcement.HARD && cost > quota.tokenLimit,
    );
    if (impossible) {
      await this.recordRejection(impossible, periodStart(impossible.period, now), subject);
      throw this.exceeded(impossible, now, cost);
    }

    await this.ensureCounters(budgets, now);
    const id = randomUUID();

    let snapshots: CounterSnapshot[];
    try {
      snapshots = await this.dataSource.transaction(async (manager) => {
        const reserved: CounterSnapshot[] = [];
        for (const quota of budgets) {
          const start = periodStart(quota.period, now);
          const [row] = returnedRows<{ tokens_used: string; tokens_reserved: string }>(
            await manager.query(
              `UPDATE usage_counters
                  SET tokens_reserved = tokens_reserved + $3, requests = requests + 1,
                      updated_at = now()
                WHERE quota_id = $1 AND period_start = $2
                  AND ($4::boolean OR tokens_used + tokens_reserved + $3 <= $5)
                RETURNING tokens_used, tokens_reserved`,
              [
                quota.id,
                start,
                cost,
                quota.enforcement === QuotaEnforcement.SOFT,
                quota.tokenLimit,
              ],
            ),
          );
          if (!row) throw new BudgetExhausted(quota, start);
          reserved.push({
            quota,
            periodStart: start,
            used: Number(row.tokens_used),
            reserved: Number(row.tokens_reserved),
          });
        }
        await manager.query(
          `INSERT INTO quota_reservations (id, organization_id, tokens, counters, expires_at)
           VALUES ($1, $2, $3, $4::jsonb, now() + $5 * interval '1 millisecond')`,
          [
            id,
            subject.organizationId,
            cost,
            JSON.stringify(
              reserved.map((entry) => ({
                quotaId: entry.quota.id,
                periodStart: entry.periodStart.toISOString(),
              })),
            ),
            this.config.reservationTtlMs,
          ],
        );
        return reserved;
      });
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        await this.recordRejection(error.quota, error.periodStart, subject);
        throw this.exceeded(error.quota, now, cost);
      }
      throw error;
    }

    // A SOFT budget admits past its limit; say so, once per period.
    for (const snapshot of snapshots) {
      if (
        snapshot.quota.enforcement === QuotaEnforcement.SOFT &&
        snapshot.used + snapshot.reserved > snapshot.quota.tokenLimit
      ) {
        void this.markExhausted(snapshot.quota, snapshot.periodStart, subject);
      }
    }

    return {
      id,
      organizationId: subject.organizationId,
      tokens: cost,
      counters: snapshots.map((entry) => ({
        quotaId: entry.quota.id,
        periodStart: entry.periodStart.toISOString(),
      })),
    };
  }

  /**
   * Swaps a reservation for what the call actually spent. Never throws: the
   * answer has been delivered, and the sweep reconciles anything lost here.
   */
  async settle(reservation: BudgetReservation, actualTokens: number): Promise<void> {
    const actual = Math.max(0, Math.round(actualTokens));
    try {
      const crossed = await this.dataSource.transaction(async (manager) => {
        const [held] = returnedRows<{ tokens: string }>(
          await manager.query(`DELETE FROM quota_reservations WHERE id = $1 RETURNING tokens`, [
            reservation.id,
          ]),
        );
        // Already released by the sweep: nothing left reserved to give back.
        const release = held ? Number(held.tokens) : 0;
        const alerts: Array<{ quotaId: string; periodStart: string; used: number }> = [];
        for (const counter of [...reservation.counters].sort(byQuota)) {
          const [row] = returnedRows<{ tokens_used: string; alert: boolean }>(
            await manager.query(
              `UPDATE usage_counters c
                  SET tokens_reserved = GREATEST(c.tokens_reserved - $3, 0),
                      tokens_used = c.tokens_used + $4,
                      alerted_at = CASE
                        WHEN c.alerted_at IS NULL
                         AND (c.tokens_used + $4) * 100 >= q.token_limit * q.alert_threshold
                        THEN now() ELSE c.alerted_at END,
                      updated_at = now()
                 FROM usage_quotas q
                WHERE q.id = c.quota_id AND c.quota_id = $1 AND c.period_start = $2
                RETURNING c.tokens_used,
                          (c.alerted_at IS NOT NULL AND c.alerted_at = now()) AS alert`,
              [counter.quotaId, counter.periodStart, release, actual],
            ),
          );
          if (row?.alert) {
            alerts.push({ ...counter, used: Number(row.tokens_used) });
          }
        }
        return alerts;
      });
      for (const alert of crossed) void this.alertThreshold(reservation.organizationId, alert);
    } catch (error) {
      this.logger.warn(
        `Could not settle quota reservation ${reservation.id}: ${(error as Error).message}. ` +
          'The maintenance sweep will reconcile it.',
      );
    }
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /** Releases reservations whose call outlived QUOTA_RESERVATION_TTL (a crash). */
  async releaseExpired(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const expired = returnedRows<{
        tokens: string;
        counters: Array<{ quotaId: string; periodStart: string }>;
      }>(
        await manager.query(
          `DELETE FROM quota_reservations
            WHERE id IN (SELECT id FROM quota_reservations WHERE expires_at < now()
                          ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)
            RETURNING tokens, counters`,
        ),
      );
      for (const reservation of expired) {
        for (const counter of [...reservation.counters].sort(byQuota)) {
          await manager.query(
            `UPDATE usage_counters SET tokens_reserved = GREATEST(tokens_reserved - $3, 0)
              WHERE quota_id = $1 AND period_start = $2`,
            [counter.quotaId, counter.periodStart, Number(reservation.tokens)],
          );
        }
      }
      return expired.length;
    });
  }

  /**
   * Raises counters of the current period that fell behind the usage ledger
   * (a settlement lost to a crash). Never lowers one: a reservation or a
   * just-settled call may not have reached the ledger yet.
   */
  async reconcile(now = new Date()): Promise<number> {
    const active: Array<QuotaRow & { period_start: Date; tokens_used: string }> =
      await this.dataSource.query(
        `SELECT q.id, q.organization_id, q.scope, q.subject_id, q.period, q.token_limit,
                q.enforcement, q.alert_threshold, q.managed_by, c.period_start, c.tokens_used
           FROM usage_counters c JOIN usage_quotas q ON q.id = c.quota_id
          WHERE c.updated_at > now() - interval '2 hours'
            AND c.period_start IN ($1, $2)
          ORDER BY c.updated_at DESC
          LIMIT 1000`,
        [periodStart(QuotaPeriod.DAY, now), periodStart(QuotaPeriod.MONTH, now)],
      );

    let raised = 0;
    for (const row of active) {
      const quota = toDefinition(row);
      if (quota.period !== QuotaPeriod.DAY && quota.period !== QuotaPeriod.MONTH) continue;
      const ledger = await this.ledgerSum(quota, new Date(row.period_start));
      if (ledger > Number(row.tokens_used)) {
        await this.dataSource.query(
          `UPDATE usage_counters SET tokens_used = GREATEST(tokens_used, $3)
            WHERE quota_id = $1 AND period_start = $2`,
          [quota.id, row.period_start, ledger],
        );
        raised += 1;
      }
    }
    return raised;
  }

  /** Deletes counters of periods that ended more than `keepMs` ago. */
  async pruneCounters(keepMs: number): Promise<number> {
    const result = returnedRows(
      await this.dataSource.query(
        `DELETE FROM usage_counters WHERE period_start < now() - $1 * interval '1 millisecond'
         RETURNING quota_id`,
        [keepMs],
      ),
    );
    return result.length;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Current-period consumption of each quota (rates have no counter). */
  async usage(
    organizationId: string,
    quotas: QuotaDefinition[],
    now = new Date(),
  ): Promise<
    Map<string, { used: number; reserved: number; periodStart: Date; resetsAt: Date }>
  > {
    const budgets = quotas.filter((quota) => quota.period !== QuotaPeriod.MINUTE);
    const usage = new Map<
      string,
      { used: number; reserved: number; periodStart: Date; resetsAt: Date }
    >();
    if (budgets.length === 0) return usage;

    const rows: Array<{
      quota_id: string;
      period_start: Date;
      tokens_used: string;
      tokens_reserved: string;
    }> = await this.dataSource.query(
      `SELECT quota_id, period_start, tokens_used, tokens_reserved
         FROM usage_counters
        WHERE organization_id = $1 AND quota_id = ANY($2::uuid[]) AND period_start IN ($3, $4)`,
      [
        organizationId,
        budgets.map((quota) => quota.id),
        periodStart(QuotaPeriod.DAY, now),
        periodStart(QuotaPeriod.MONTH, now),
      ],
    );
    for (const quota of budgets) {
      const start = periodStart(quota.period, now);
      const row = rows.find(
        (candidate) =>
          candidate.quota_id === quota.id &&
          new Date(candidate.period_start).getTime() === start.getTime(),
      );
      usage.set(quota.id, {
        used: row
          ? Number(row.tokens_used)
          : await this.ledgerSum(quota, start).catch(() => 0),
        reserved: row ? Number(row.tokens_reserved) : 0,
        periodStart: start,
        resetsAt: periodEnd(quota.period, start),
      });
    }
    return usage;
  }

  /** Past periods of one budget, newest first. */
  async history(
    organizationId: string,
    quotaId: string,
    periods: number,
  ): Promise<
    Array<{
      periodStart: Date;
      tokensUsed: number;
      requests: number;
      rejected: number;
      alertedAt: Date | null;
      exhaustedAt: Date | null;
    }>
  > {
    const rows: Array<{
      period_start: Date;
      tokens_used: string;
      requests: number;
      rejected: number;
      alerted_at: Date | null;
      exhausted_at: Date | null;
    }> = await this.dataSource.query(
      `SELECT period_start, tokens_used, requests, rejected, alerted_at, exhausted_at
         FROM usage_counters WHERE organization_id = $1 AND quota_id = $2
        ORDER BY period_start DESC LIMIT $3`,
      [organizationId, quotaId, periods],
    );
    return rows.map((row) => ({
      periodStart: row.period_start,
      tokensUsed: Number(row.tokens_used),
      requests: row.requests,
      rejected: row.rejected,
      alertedAt: row.alerted_at,
      exhaustedAt: row.exhausted_at,
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Creates this period's counters where missing, starting from the ledger:
   * a budget added (or a deployment restarted) mid-month must count what the
   * month has already spent.
   */
  private async ensureCounters(quotas: QuotaDefinition[], now: Date): Promise<void> {
    for (const quota of quotas) {
      const start = periodStart(quota.period, now);
      const key = `${quota.id}@${start.toISOString()}`;
      if (this.ensured.has(key)) continue;

      const [exists]: Array<{ one: number }> = await this.dataSource.query(
        `SELECT 1 AS one FROM usage_counters WHERE quota_id = $1 AND period_start = $2`,
        [quota.id, start],
      );
      if (!exists) {
        const baseline = await this.ledgerSum(quota, start);
        await this.dataSource.query(
          `INSERT INTO usage_counters (quota_id, period_start, organization_id, tokens_used)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (quota_id, period_start) DO NOTHING`,
          [quota.id, start, quota.organizationId, baseline],
        );
      }
      if (this.ensured.size > 50_000) this.ensured.clear();
      this.ensured.add(key);
    }
  }

  /** Tokens the usage ledger records for a quota's scope since `start`. */
  private async ledgerSum(quota: QuotaDefinition, start: Date): Promise<number> {
    const column = SCOPE_COLUMN[quota.scope];
    const [row]: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0)::text AS total
         FROM llm_invocations
        WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
          ${column ? `AND ${column} = $4` : ''}`,
      column
        ? [quota.organizationId, start, periodEnd(quota.period, start), quota.subjectId]
        : [quota.organizationId, start, periodEnd(quota.period, start)],
    );
    return Number(row?.total ?? 0);
  }

  private exceeded(quota: QuotaDefinition, now: Date, cost: number): AppException {
    const retryAfterSeconds = secondsUntilReset(quota.period, now);
    this.metrics?.quotaDecisions.inc({
      decision: 'rejected',
      reason: 'budget',
      scope: quota.scope,
    });
    return new AppException(ErrorCode.QUOTA_EXCEEDED, HttpStatus.TOO_MANY_REQUESTS, {
      message:
        quota.managedBy === QuotaManager.PLATFORM
          ? 'This workspace has used its token allowance for the month.'
          : `The ${describeScope(quota.scope)} token budget for this ${quota.period.toLowerCase()} is used up.`,
      retryAfterSeconds,
      details: {
        quotaId: quota.id,
        scope: quota.scope,
        period: quota.period,
        limit: quota.tokenLimit,
        requested: cost,
        managedBy: quota.managedBy,
        resetsAt: periodEnd(quota.period, periodStart(quota.period, now)).toISOString(),
        retryAfterSeconds,
      },
    });
  }

  private async recordRejection(
    quota: QuotaDefinition,
    start: Date,
    subject: QuotaSubject,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE usage_counters SET rejected = rejected + 1
          WHERE quota_id = $1 AND period_start = $2`,
        [quota.id, start],
      );
    } catch {
      // Bookkeeping only.
    }
    await this.markExhausted(quota, start, subject);
  }

  /** Audits and notifies the first exhaustion of a budget in a period. */
  private async markExhausted(
    quota: QuotaDefinition,
    start: Date,
    subject: QuotaSubject,
  ): Promise<void> {
    try {
      const first = returnedRows(
        await this.dataSource.query(
          `UPDATE usage_counters SET exhausted_at = now()
            WHERE quota_id = $1 AND period_start = $2 AND exhausted_at IS NULL
            RETURNING quota_id`,
          [quota.id, start],
        ),
      );
      if (first.length === 0) return;

      await this.auditService.recordSafe({
        action: AuditAction.QUOTA_EXHAUSTED,
        status: quota.enforcement === QuotaEnforcement.HARD ? AuditStatus.DENIED : AuditStatus.SUCCESS,
        organizationId: quota.organizationId,
        resourceType: 'usage_quota',
        resourceId: quota.id,
        actor: { type: ActorType.SYSTEM, label: 'quota enforcement' },
        metadata: {
          scope: quota.scope,
          subjectId: quota.subjectId,
          period: quota.period,
          periodStart: start.toISOString(),
          limit: quota.tokenLimit,
          enforcement: quota.enforcement,
          managedBy: quota.managedBy,
          triggeredBy: {
            userId: subject.userId ?? null,
            apiKeyId: subject.apiKeyId ?? null,
            agentId: subject.agentId ?? null,
          },
        },
      });
      await this.notify(quota, 'quota.exhausted', {
        percent: 100,
        enforcement: quota.enforcement,
      });
    } catch (error) {
      this.logger.debug(`Could not record quota exhaustion: ${(error as Error).message}`);
    }
  }

  private async alertThreshold(
    organizationId: string,
    alert: { quotaId: string; periodStart: string; used: number },
  ): Promise<void> {
    const quota = (await this.definitions(organizationId)).find(
      (candidate) => candidate.id === alert.quotaId,
    );
    if (!quota) return;
    const percent = consumedPercent(quota.tokenLimit, alert.used);
    await this.auditService.recordSafe({
      action: AuditAction.QUOTA_THRESHOLD_REACHED,
      organizationId,
      resourceType: 'usage_quota',
      resourceId: quota.id,
      actor: { type: ActorType.SYSTEM, label: 'quota enforcement' },
      metadata: {
        scope: quota.scope,
        subjectId: quota.subjectId,
        period: quota.period,
        periodStart: alert.periodStart,
        limit: quota.tokenLimit,
        used: alert.used,
        percent,
        threshold: quota.alertThreshold,
      },
    });
    await this.notify(quota, 'quota.threshold', { percent, threshold: quota.alertThreshold });
  }

  /**
   * A live notification to the people who manage budgets, and to the member
   * a member budget belongs to. Metadata only, like every real-time event.
   */
  private async notify(
    quota: QuotaDefinition,
    kind: 'quota.threshold' | 'quota.exhausted',
    data: Record<string, number | string>,
  ): Promise<void> {
    if (!this.events) return;
    try {
      const recipients: Array<{ user_id: string }> = await this.dataSource.query(
        `SELECT user_id FROM organization_members
          WHERE organization_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'
            AND effective_permissions ?| ARRAY['quota:manage','quota:*','*:*']
          LIMIT 50`,
        [quota.organizationId],
      );
      const userIds = new Set(recipients.map((row) => row.user_id));
      if (quota.scope === QuotaScope.MEMBER && quota.subjectId) userIds.add(quota.subjectId);
      if (userIds.size === 0) return;
      await this.events.publish({
        type: 'notification',
        organizationId: quota.organizationId,
        recipientUserIds: [...userIds],
        data: {
          kind,
          quotaId: quota.id,
          scope: quota.scope,
          period: quota.period,
          limit: quota.tokenLimit,
          ...data,
        },
      });
    } catch (error) {
      this.logger.debug(`Could not notify about a quota: ${(error as Error).message}`);
    }
  }

  /** Reads a quota row with its creator's manager check, inside a transaction. */
  static async lockQuota(
    manager: EntityManager,
    organizationId: string,
    quotaId: string,
  ): Promise<QuotaDefinition | null> {
    const [row]: QuotaRow[] = await manager.query(
      `SELECT id, organization_id, scope, subject_id, period, token_limit, enforcement,
              alert_threshold, managed_by
         FROM usage_quotas WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [quotaId, organizationId],
    );
    return row ? toDefinition(row) : null;
  }
}

function toDefinition(row: QuotaRow): QuotaDefinition {
  return {
    id: row.id,
    organizationId: row.organization_id,
    scope: row.scope,
    subjectId: row.subject_id,
    period: row.period,
    tokenLimit: Number(row.token_limit),
    enforcement: row.enforcement,
    alertThreshold: row.alert_threshold,
    managedBy: row.managed_by,
  };
}

function byQuota(
  a: { quotaId: string },
  b: { quotaId: string },
): number {
  return a.quotaId < b.quotaId ? -1 : a.quotaId > b.quotaId ? 1 : 0;
}

function describeScope(scope: QuotaScope): string {
  switch (scope) {
    case QuotaScope.ORGANIZATION:
      return 'workspace';
    case QuotaScope.MEMBER:
      return 'member';
    case QuotaScope.AGENT:
      return 'agent';
    case QuotaScope.API_KEY:
      return 'API key';
  }
}
