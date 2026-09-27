import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { UsageService } from '../llm/usage.service';
import { AgentCircuitService } from '../quotas/agent-circuit.service';
import { QuotaService } from '../quotas/quota.service';
import {
  SeriesInterval,
  SeriesMetric,
  TopDimension,
  type AnalyticsOverviewDto,
  type SecurityEventDto,
  type TimeseriesDto,
  type TopEntryDto,
} from './dto/analytics.dto';

const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 400 * DAY_MS;
const MAX_HOURLY_RANGE_MS = 14 * DAY_MS;

/**
 * A series: the table it is read from, its time column, and the aggregate.
 * Constants only — the requested metric picks one of these, so nothing a
 * caller sends reaches the SQL text.
 */
interface SeriesDefinition {
  table: 'llm_invocations' | 'workflow_runs' | 'tool_executions' | 'audit_logs';
  value: string;
}

const SERIES: Readonly<Record<SeriesMetric, SeriesDefinition>> = {
  [SeriesMetric.TOKENS]: {
    table: 'llm_invocations',
    value: 'sum(prompt_tokens + completion_tokens)',
  },
  [SeriesMetric.INVOCATIONS]: { table: 'llm_invocations', value: 'count(*)' },
  [SeriesMetric.THROTTLED]: {
    table: 'llm_invocations',
    value: "count(*) FILTER (WHERE status = 'THROTTLED')",
  },
  [SeriesMetric.FAILURES]: {
    table: 'llm_invocations',
    value: "count(*) FILTER (WHERE status IN ('FAILED','BLOCKED','REFUSED'))",
  },
  [SeriesMetric.LATENCY_P95]: {
    table: 'llm_invocations',
    value:
      "percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE status = 'COMPLETED')",
  },
  [SeriesMetric.TTFT_P95]: {
    table: 'llm_invocations',
    value:
      "percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE status = 'COMPLETED')",
  },
  [SeriesMetric.REDACTION_P95]: {
    table: 'llm_invocations',
    value:
      'percentile_cont(0.95) WITHIN GROUP (ORDER BY redaction_ms) ' +
      "FILTER (WHERE status = 'COMPLETED' AND redaction_ms IS NOT NULL)",
  },
  [SeriesMetric.ENTITIES_MASKED]: { table: 'llm_invocations', value: 'sum(entities_masked)' },
  [SeriesMetric.WORKFLOW_RUNS]: { table: 'workflow_runs', value: 'count(*)' },
  [SeriesMetric.WORKFLOW_FAILURES]: {
    table: 'workflow_runs',
    value: "count(*) FILTER (WHERE status IN ('FAILED','TIMED_OUT'))",
  },
  [SeriesMetric.TOOL_CALLS]: { table: 'tool_executions', value: 'count(*)' },
  [SeriesMetric.TOOL_DENIALS]: {
    table: 'tool_executions',
    value: "count(*) FILTER (WHERE status = 'DENIED')",
  },
  [SeriesMetric.SECURITY_EVENTS]: {
    table: 'audit_logs',
    value: "count(*) FILTER (WHERE severity IN ('WARNING','CRITICAL'))",
  },
  [SeriesMetric.RAG_QUERIES]: {
    table: 'audit_logs',
    value: "count(*) FILTER (WHERE action = 'rag.query.executed')",
  },
};

/** How each top-N dimension groups the ledger and names its entries. */
const TOP_DIMENSIONS: Readonly<
  Record<TopDimension, { column: string; label: string | null }>
> = {
  [TopDimension.AGENTS]: {
    column: 'i.agent_id',
    label: `(SELECT a.name FROM agents a WHERE a.id = i.agent_id)`,
  },
  [TopDimension.MODELS]: { column: 'i.model', label: null },
  [TopDimension.MEMBERS]: {
    column: 'i.user_id',
    label: `(SELECT COALESCE(u.display_name, u.first_name || ' ' || u.last_name)
               FROM users u WHERE u.id = i.user_id)`,
  },
  [TopDimension.API_KEYS]: {
    column: 'i.api_key_id',
    label: `(SELECT k.name || ' (' || k.prefix || ')' FROM api_keys k WHERE k.id = i.api_key_id)`,
  },
};

/**
 * The Command Centre (phase 5): what a workspace's agents did, what it cost,
 * how fast, what the privacy and access controls withheld, and what needs
 * attention — from the ledgers the platform already keeps (usage, tools,
 * runs, the audit log). Nothing here reads content: every figure is a count,
 * a sum or a percentile over metadata.
 *
 * Every query is scoped to the caller's workspace by its own filter and,
 * beneath it, by row-level security.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly usage: UsageService,
    private readonly quotas: QuotaService,
    private readonly circuits: AgentCircuitService,
  ) {}

  async overview(organizationId: string, from?: Date, to?: Date): Promise<AnalyticsOverviewDto> {
    const range = resolveRange(from, to);
    const params = [organizationId, range.from, range.to];

    const [inference, activity, workflows, deadLetters, tools, denials] = await Promise.all([
      this.usage.summary(organizationId, range.from, range.to),
      this.one<{
        members: number;
        keys: number;
        agents: number;
        turns: number;
      }>(
        `SELECT count(DISTINCT user_id)::int AS members, count(DISTINCT api_key_id)::int AS keys,
                count(DISTINCT agent_id)::int AS agents,
                count(*) FILTER (WHERE purpose = 'AGENT_TURN' AND message_id IS NOT NULL
                                   AND status = 'COMPLETED')::int AS turns
           FROM llm_invocations
          WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3`,
        params,
      ),
      this.one<{
        runs: number;
        completed: number;
        failed: number;
        cancelled: number;
        timed_out: number;
        active: number;
        p50: number | null;
        p95: number | null;
        tokens: string;
      }>(
        `SELECT count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                count(*) FILTER (WHERE status = 'TIMED_OUT')::int AS timed_out,
                count(*) FILTER (WHERE status IN ('QUEUED','RUNNING','WAITING_APPROVAL'))::int AS active,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY
                  extract(epoch FROM completed_at - started_at) * 1000)
                  FILTER (WHERE status = 'COMPLETED') AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY
                  extract(epoch FROM completed_at - started_at) * 1000)
                  FILTER (WHERE status = 'COMPLETED') AS p95,
                COALESCE(sum(tokens_used), 0)::text AS tokens
           FROM workflow_runs
          WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3`,
        params,
      ),
      this.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM workflow_steps
          WHERE organization_id = $1 AND dead_lettered_at >= $2 AND dead_lettered_at < $3`,
        params,
      ),
      this.one<{
        calls: number;
        succeeded: number;
        failed: number;
        timed_out: number;
        denied: number;
      }>(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                count(*) FILTER (WHERE status = 'TIMED_OUT')::int AS timed_out,
                count(*) FILTER (WHERE status = 'DENIED')::int AS denied
           FROM tool_executions
          WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3`,
        params,
      ),
      this.dataSource.query<Array<{ reason: string; count: number }>>(
        `SELECT denial_reason AS reason, count(*)::int AS count FROM tool_executions
          WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
            AND status = 'DENIED' AND denial_reason IS NOT NULL
          GROUP BY denial_reason`,
        params,
      ),
    ]);

    const [conversations, documents, audit, entityTypes, nearLimit, openCircuits] =
      await Promise.all([
        this.one<{ count: number }>(
          `SELECT count(*)::int AS count FROM conversations
            WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3`,
          params,
        ),
        this.dataSource.query<Array<{ status: string; count: number; bytes: string }>>(
          `SELECT status, count(*)::int AS count, COALESCE(sum(size_bytes), 0)::text AS bytes
             FROM documents WHERE organization_id = $1 AND deleted_at IS NULL
            GROUP BY status`,
          [organizationId],
        ),
        this.dataSource.query<Array<{ action: string; severity: string; count: number }>>(
          `SELECT action, severity, count(*)::int AS count FROM audit_logs
            WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
              AND (severity IN ('WARNING','CRITICAL')
                   OR action IN ('rag.query.executed','rag.access.filtered','quota.exhausted',
                                 'quota.rate_limited','agent.circuit_broken'))
            GROUP BY action, severity`,
          params,
        ),
        this.dataSource.query<Array<{ type: string; count: string }>>(
          `SELECT entry.key AS type, sum((entry.value)::int)::text AS count
             FROM llm_invocations i,
                  jsonb_each_text(COALESCE(i.metrics->'redaction'->'byType', '{}'::jsonb)) AS entry
            WHERE i.organization_id = $1 AND i.created_at >= $2 AND i.created_at < $3
            GROUP BY entry.key`,
          params,
        ),
        this.budgetsNearLimit(organizationId),
        this.circuits.listOpen(organizationId),
      ]);

    const countOf = (action: string) =>
      audit.filter((row) => row.action === action).reduce((sum, row) => sum + row.count, 0);
    const bySeverity: Record<string, number> = {};
    for (const row of audit) {
      if (row.severity === 'WARNING' || row.severity === 'CRITICAL') {
        bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + row.count;
      }
    }

    return {
      from: range.from,
      to: range.to,
      inference,
      activity: {
        activeMembers: activity.members,
        activeApiKeys: activity.keys,
        activeAgents: activity.agents,
        conversationsStarted: conversations.count,
        turns: activity.turns,
      },
      workflows: {
        runs: workflows.runs,
        completed: workflows.completed,
        failed: workflows.failed,
        cancelled: workflows.cancelled,
        timedOut: workflows.timed_out,
        active: workflows.active,
        durationP50Ms: rounded(workflows.p50),
        durationP95Ms: rounded(workflows.p95),
        tokens: Number(workflows.tokens),
        deadLetters: deadLetters.count,
      },
      tools: {
        calls: tools.calls,
        succeeded: tools.succeeded,
        failed: tools.failed,
        timedOut: tools.timed_out,
        denied: tools.denied,
        denialsByReason: Object.fromEntries(denials.map((row) => [row.reason, row.count])),
      },
      knowledge: {
        documentsByStatus: Object.fromEntries(documents.map((row) => [row.status, row.count])),
        storedBytes: documents.reduce((sum, row) => sum + Number(row.bytes), 0),
        retrievalQueries: countOf('rag.query.executed'),
        withheldEvents: countOf('rag.access.filtered'),
      },
      privacy: {
        entitiesMasked: inference.totals.entitiesMasked,
        entitiesByType: Object.fromEntries(entityTypes.map((row) => [row.type, Number(row.count)])),
        egressBlocked: inference.totals.blocked,
        refusedForRedaction: inference.totals.refused,
        degradedRedactions: inference.totals.degradedRedactions,
      },
      governance: {
        throttledCalls: inference.totals.throttled,
        budgetExhaustions: countOf('quota.exhausted'),
        rateLimitEvents: countOf('quota.rate_limited'),
        circuitBreaks: countOf('agent.circuit_broken'),
        openCircuits: openCircuits.length,
        budgetsNearLimit: nearLimit,
      },
      security: {
        bySeverity,
        topAlerts: audit
          .filter((row) => row.severity === 'WARNING' || row.severity === 'CRITICAL')
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map((row) => ({ action: row.action, count: row.count })),
        failedSignIns: countOf('user.login.failed'),
        accessDenials: countOf('access.denied'),
      },
    };
  }

  async timeseries(
    organizationId: string,
    metric: SeriesMetric,
    interval: SeriesInterval,
    from?: Date,
    to?: Date,
  ): Promise<TimeseriesDto> {
    const range = resolveRange(
      from,
      to,
      interval === SeriesInterval.HOUR ? MAX_HOURLY_RANGE_MS : MAX_RANGE_MS,
      interval === SeriesInterval.HOUR ? DAY_MS : 30 * DAY_MS,
    );
    const series = SERIES[metric];
    const rows: Array<{ bucket: Date; value: string | number | null }> =
      await this.dataSource.query(
        `WITH buckets AS (
           SELECT generate_series(date_trunc($4, $2::timestamptz, 'UTC'),
                                  date_trunc($4, $3::timestamptz, 'UTC'),
                                  ('1 ' || $4)::interval) AS bucket
         ),
         measured AS (
           SELECT date_trunc($4, created_at, 'UTC') AS bucket, ${series.value} AS value
             FROM ${series.table}
            WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
            GROUP BY 1
         )
         SELECT b.bucket, m.value FROM buckets b LEFT JOIN measured m ON m.bucket = b.bucket
          ORDER BY b.bucket`,
        [organizationId, range.from, range.to, interval],
      );
    const percentile = metric.endsWith('_p95');
    return {
      metric,
      interval,
      from: range.from,
      to: range.to,
      points: rows.map((row) => ({
        at: row.bucket,
        value:
          row.value === null ? (percentile ? null : 0) : Math.round(Number(row.value) * 100) / 100,
      })),
    };
  }

  async top(
    organizationId: string,
    dimension: TopDimension,
    limit: number,
    from?: Date,
    to?: Date,
  ): Promise<TopEntryDto[]> {
    const range = resolveRange(from, to);
    const { column, label } = TOP_DIMENSIONS[dimension];
    const rows: Array<{
      key: string | null;
      label: string | null;
      invocations: number;
      tokens: string;
      throttled: number;
    }> = await this.dataSource.query(
      `SELECT ${column}::text AS key, ${label ? `${label}` : 'NULL'} AS label,
              count(*)::int AS invocations,
              COALESCE(sum(i.prompt_tokens + i.completion_tokens), 0)::text AS tokens,
              count(*) FILTER (WHERE i.status = 'THROTTLED')::int AS throttled
         FROM llm_invocations i
        WHERE i.organization_id = $1 AND i.created_at >= $2 AND i.created_at < $3
          AND ${column} IS NOT NULL
        GROUP BY ${column}
        ORDER BY sum(i.prompt_tokens + i.completion_tokens) DESC NULLS LAST, count(*) DESC
        LIMIT $4`,
      [organizationId, range.from, range.to, limit],
    );
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      invocations: row.invocations,
      tokens: Number(row.tokens),
      throttled: row.throttled,
    }));
  }

  /** Warnings and critical events, newest first: the security feed. Metadata only. */
  async securityEvents(
    organizationId: string,
    limit: number,
    before?: Date,
    from?: Date,
  ): Promise<SecurityEventDto[]> {
    const rows: Array<{
      id: string;
      created_at: Date;
      action: string;
      severity: string;
      status: string;
      actor_type: string;
      actor_label: string | null;
      resource_type: string | null;
      resource_id: string | null;
      error_code: string | null;
      ip_address: string | null;
      request_id: string | null;
    }> = await this.dataSource.query(
      `SELECT id, created_at, action, severity, status, actor_type, actor_label, resource_type,
              resource_id, error_code, ip_address, request_id
         FROM audit_logs
        WHERE organization_id = $1 AND severity IN ('WARNING','CRITICAL')
          AND created_at < $2 AND created_at >= $3
        ORDER BY created_at DESC, sequence DESC
        LIMIT $4`,
      [
        organizationId,
        before ?? new Date(Date.now() + 1_000),
        from ?? new Date(Date.now() - MAX_RANGE_MS),
        limit,
      ],
    );
    return rows.map((row) => ({
      id: row.id,
      at: row.created_at,
      action: row.action,
      severity: row.severity,
      status: row.status,
      actorType: row.actor_type,
      actorLabel: row.actor_label,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      errorCode: row.error_code,
      ipAddress: row.ip_address,
      requestId: row.request_id,
    }));
  }

  private async budgetsNearLimit(organizationId: string): Promise<number> {
    const quotas = await this.quotas.definitions(organizationId);
    const usage = await this.quotas.usage(organizationId, quotas);
    return quotas.filter((quota) => {
      const current = usage.get(quota.id);
      return (
        current &&
        (current.used + current.reserved) * 100 >= quota.tokenLimit * quota.alertThreshold
      );
    }).length;
  }

  private async one<T>(sql: string, params: unknown[]): Promise<T> {
    const [row]: T[] = await this.dataSource.query(sql, params);
    return row;
  }
}

/** A validated range: `from` before `to`, no longer than the ceiling. */
function resolveRange(
  from: Date | undefined,
  to: Date | undefined,
  ceilingMs = MAX_RANGE_MS,
  defaultSpanMs = 30 * DAY_MS,
): { from: Date; to: Date } {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - defaultSpanMs);
  if (start.getTime() >= end.getTime()) {
    throw new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, {
      message: '"from" must be before "to".',
    });
  }
  if (end.getTime() - start.getTime() > ceilingMs) {
    throw new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, {
      message: `The range may span at most ${Math.round(ceilingMs / DAY_MS)} days.`,
    });
  }
  return { from: start, to: end };
}

function rounded(value: number | string | null): number | null {
  return value === null ? null : Math.round(Number(value));
}
