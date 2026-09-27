import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { MetricsService } from '../../observability/metrics.service';
import type { UsageSummaryDto } from './dto/llm.dto';
import { InvocationStatus, LlmInvocation } from './entities/llm-invocation.entity';

type InvocationEntry = Omit<LlmInvocation, 'createdAt'>;

interface SummaryRow {
  invocations: number;
  completed: number;
  failed: number;
  cancelled: number;
  refused: number;
  blocked: number;
  throttled: number;
  prompt_tokens: string;
  completion_tokens: string;
  entities_masked: string;
  degraded: number;
  estimated: number;
  total_p50: number | null;
  total_p95: number | null;
  ttft_p50: number | null;
  ttft_p95: number | null;
  redaction_p50: number | null;
  redaction_p95: number | null;
  redaction_p99: number | null;
  redaction_share: number | null;
}

/**
 * The usage ledger (`llm_invocations`): writing it, and reading it back as the
 * benchmark the proposal commits to — latency distributions, token spend, and
 * the processing time the PII engine adds, per workspace.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(LlmInvocation)
    private readonly repository: Repository<LlmInvocation>,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Records one invocation. Inside `manager`'s transaction when given, so the
   * ledger row commits with the message it describes. Without one, a failure
   * is logged, never thrown: losing a usage row must not fail an answer the
   * user has already received.
   */
  async record(entry: InvocationEntry, manager?: EntityManager): Promise<void> {
    if (manager) {
      await manager.getRepository(LlmInvocation).insert(entry);
      this.observe(entry);
      return;
    }
    try {
      await this.repository.insert(entry);
      this.observe(entry);
    } catch (error) {
      this.logger.error(
        { invocationId: entry.id, err: error as Error },
        'Failed to record an LLM invocation in the usage ledger.',
      );
    }
  }

  /**
   * The ledger row, as Prometheus metrics (phase 5): every model call passes
   * through here, so this is the one place they are counted. Labels are the
   * purpose, the outcome, the model and entity types — never who or which
   * workspace (see MetricsService).
   */
  private observe(entry: InvocationEntry): void {
    const metrics = this.metrics;
    if (!metrics) return;
    const model = entry.model.slice(0, 100);
    metrics.llmInvocations.inc({ purpose: entry.purpose, status: entry.status, model });
    if (entry.promptTokens > 0) {
      metrics.llmTokens.inc(
        { purpose: entry.purpose, kind: 'prompt', model },
        entry.promptTokens,
      );
    }
    if (entry.completionTokens > 0) {
      metrics.llmTokens.inc(
        { purpose: entry.purpose, kind: 'completion', model },
        entry.completionTokens,
      );
    }
    if (entry.status !== InvocationStatus.COMPLETED) return;
    if (entry.totalMs !== null) {
      metrics.llmDuration.observe({ purpose: entry.purpose, model }, entry.totalMs / 1000);
    }
    if (entry.ttftMs !== null) {
      metrics.llmTimeToFirstToken.observe({ model }, entry.ttftMs / 1000);
    }
    if (entry.redactionMs !== null) {
      metrics.redactionDuration.observe(Number(entry.redactionMs) / 1000);
    }
    for (const [entityType, count] of Object.entries(entry.metrics?.redaction?.byType ?? {})) {
      if (count > 0) metrics.entitiesMasked.inc({ entity_type: entityType.slice(0, 40) }, count);
    }
  }

  async summary(organizationId: string, from: Date, to: Date): Promise<UsageSummaryDto> {
    const params = [organizationId, from, to];

    const [totals]: SummaryRow[] = await this.repository.query(
      `SELECT count(*)::int                                                    AS invocations,
              count(*) FILTER (WHERE status = 'COMPLETED')::int                AS completed,
              count(*) FILTER (WHERE status = 'FAILED')::int                   AS failed,
              count(*) FILTER (WHERE status = 'CANCELLED')::int                AS cancelled,
              count(*) FILTER (WHERE status = 'REFUSED')::int                  AS refused,
              count(*) FILTER (WHERE status = 'BLOCKED')::int                  AS blocked,
              count(*) FILTER (WHERE status = 'THROTTLED')::int                AS throttled,
              COALESCE(sum(prompt_tokens), 0)::text                            AS prompt_tokens,
              COALESCE(sum(completion_tokens), 0)::text                        AS completion_tokens,
              COALESCE(sum(entities_masked), 0)::text                          AS entities_masked,
              count(*) FILTER (WHERE redaction_degraded)::int                  AS degraded,
              count(*) FILTER (WHERE tokens_estimated)::int                    AS estimated,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY total_ms)
                FILTER (WHERE status = 'COMPLETED')                            AS total_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)
                FILTER (WHERE status = 'COMPLETED')                            AS total_p95,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY ttft_ms)
                FILTER (WHERE status = 'COMPLETED')                            AS ttft_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms)
                FILTER (WHERE status = 'COMPLETED')                            AS ttft_p95,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY redaction_ms)
                FILTER (WHERE status = 'COMPLETED' AND redaction_ms IS NOT NULL) AS redaction_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY redaction_ms)
                FILTER (WHERE status = 'COMPLETED' AND redaction_ms IS NOT NULL) AS redaction_p95,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY redaction_ms)
                FILTER (WHERE status = 'COMPLETED' AND redaction_ms IS NOT NULL) AS redaction_p99,
              avg(redaction_ms::float8 / NULLIF(total_ms, 0))
                FILTER (WHERE status = 'COMPLETED' AND redaction_ms IS NOT NULL) AS redaction_share
         FROM llm_invocations
        WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3`,
      params,
    );

    const byModel: Array<{
      model: string;
      invocations: number;
      prompt_tokens: string;
      completion_tokens: string;
      total_p50: number | null;
    }> = await this.repository.query(
      `SELECT model,
              count(*)::int                               AS invocations,
              COALESCE(sum(prompt_tokens), 0)::text       AS prompt_tokens,
              COALESCE(sum(completion_tokens), 0)::text   AS completion_tokens,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)
                FILTER (WHERE status = 'COMPLETED')       AS total_p50
         FROM llm_invocations
        WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
        GROUP BY model
        ORDER BY count(*) DESC
        LIMIT 20`,
      params,
    );

    const byAgent: Array<{
      agent_id: string | null;
      invocations: number;
      prompt_tokens: string;
      completion_tokens: string;
    }> = await this.repository.query(
      `SELECT agent_id,
              count(*)::int                               AS invocations,
              COALESCE(sum(prompt_tokens), 0)::text       AS prompt_tokens,
              COALESCE(sum(completion_tokens), 0)::text   AS completion_tokens
         FROM llm_invocations
        WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
        GROUP BY agent_id
        ORDER BY count(*) DESC
        LIMIT 20`,
      params,
    );

    return {
      from,
      to,
      totals: {
        invocations: totals.invocations,
        completed: totals.completed,
        failed: totals.failed,
        cancelled: totals.cancelled,
        refused: totals.refused,
        blocked: totals.blocked,
        throttled: totals.throttled,
        promptTokens: Number(totals.prompt_tokens),
        completionTokens: Number(totals.completion_tokens),
        entitiesMasked: Number(totals.entities_masked),
        degradedRedactions: totals.degraded,
        estimatedTokenCounts: totals.estimated,
      },
      latencyMs: {
        totalP50: rounded(totals.total_p50),
        totalP95: rounded(totals.total_p95),
        timeToFirstTokenP50: rounded(totals.ttft_p50),
        timeToFirstTokenP95: rounded(totals.ttft_p95),
      },
      redactionOverhead: {
        p50Ms: rounded(totals.redaction_p50),
        p95Ms: rounded(totals.redaction_p95),
        p99Ms: rounded(totals.redaction_p99),
        shareOfTotal:
          totals.redaction_share === null
            ? null
            : Math.round(totals.redaction_share * 10_000) / 10_000,
      },
      byModel: byModel.map((row) => ({
        model: row.model,
        invocations: row.invocations,
        promptTokens: Number(row.prompt_tokens),
        completionTokens: Number(row.completion_tokens),
        totalP50Ms: rounded(row.total_p50),
      })),
      byAgent: byAgent.map((row) => ({
        agentId: row.agent_id,
        invocations: row.invocations,
        promptTokens: Number(row.prompt_tokens),
        completionTokens: Number(row.completion_tokens),
      })),
    };
  }
}

function rounded(value: number | string | null): number | null {
  return value === null ? null : Math.round(Number(value) * 100) / 100;
}
