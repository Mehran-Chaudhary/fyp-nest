import { Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { LIFECYCLE_CONFIG_KEY, type LifecycleConfig } from '../../config/lifecycle.config';
import { returnedRows } from '../../database/query.util';
import { MetricsService } from '../../observability/metrics.service';
import { RequestContextService } from '../../shared/context/request-context.service';
import { QUEUE_NAME } from '../../shared/queue/queue.constants';
import { QueueService } from '../../shared/queue/queue.service';
import { AuditRetentionService } from '../audit/audit-retention.service';
import { AuditService } from '../audit/audit.service';

const SWEEP_SCHEDULER_ID = 'data-lifecycle-sweep';
/** Rows removed per statement: keeps each delete short and its locks brief. */
const BATCH = 1_000;
/** Batches per kind per sweep: bounds one sweep's work; the next continues. */
const MAX_BATCHES = 50;
/** Resolved invitations keep their (personal) address this long, then go. */
const INVITATION_RETENTION_MS = 90 * 86_400_000;

export interface LifecycleReport {
  sessions: number;
  userTokens: number;
  invitationsExpired: number;
  invitations: number;
  usageRecords: number;
  toolRecords: number;
  conversations: number;
  auditRecords: number;
}

/**
 * The data lifecycle (phase 5): nothing lives longer than the deployment
 * decided it should.
 *
 *  - **Sessions** end, then are kept SESSION_RETENTION as evidence (a rotation
 *    chain is what an incident investigation reads), then deleted.
 *  - **One-time tokens** (verification, reset) are deleted a day after expiry.
 *  - **Invitations** past their expiry are marked EXPIRED; resolved ones are
 *    deleted after 90 days — they hold the invitee's address.
 *  - **Ledgers** (usage, tools) are content-free, kept forever unless
 *    USAGE_RETENTION says otherwise.
 *  - **Idle conversations** are crypto-shredded after CONVERSATION_RETENTION,
 *    when set: their key is destroyed, so every copy of their messages —
 *    backups included — is unreadable.
 *  - **The audit log** is archived and pruned per chain (AuditRetentionService),
 *    leaving signed anchors.
 *
 * One sweep per LIFECYCLE_SWEEP_INTERVAL, cluster-wide (a BullMQ job
 * scheduler), run unbound: it is a cross-tenant maintenance path by nature.
 * Each workspace whose data was removed gets one `data.retention.applied`
 * record saying what and how much.
 */
@Injectable()
export class DataLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataLifecycleService.name);
  private readonly config: LifecycleConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly queues: QueueService,
    private readonly requestContext: RequestContextService,
    private readonly auditRetention: AuditRetentionService,
    private readonly auditService: AuditService,
    configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.config = configService.getOrThrow<LifecycleConfig>(LIFECYCLE_CONFIG_KEY);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queues.workersEnabled) return;
    this.queues.startWorker<Record<string, never>, LifecycleReport>(
      QUEUE_NAME.LIFECYCLE_MAINTENANCE,
      () => this.sweep(),
      // Long: a first sweep over a large, old database has a lot to do.
      { concurrency: 1, lockDuration: 300_000 },
    );
    try {
      await this.queues
        .getQueue(QUEUE_NAME.LIFECYCLE_MAINTENANCE)
        .upsertJobScheduler(
          SWEEP_SCHEDULER_ID,
          { every: this.config.sweepIntervalMs },
          { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } },
        );
    } catch (error) {
      this.logger.warn(
        `Could not schedule the lifecycle sweep: ${(error as Error).message}. ` +
          'It will be scheduled on the next start.',
      );
    }
  }

  sweep(now = new Date()): Promise<LifecycleReport> {
    return this.requestContext.runAsSystem('data lifecycle', () => this.run(now));
  }

  private async run(now: Date): Promise<LifecycleReport> {
    const perOrganization = new Map<string, Record<string, number>>();
    const tally = (rows: Array<{ organization_id: string | null }>, kind: string) => {
      for (const row of rows) {
        if (!row.organization_id) continue;
        const counts = perOrganization.get(row.organization_id) ?? {};
        counts[kind] = (counts[kind] ?? 0) + 1;
        perOrganization.set(row.organization_id, counts);
      }
      return rows.length;
    };
    const ago = (ms: number) => new Date(now.getTime() - ms);

    const report: LifecycleReport = {
      sessions: await this.drain(
        `DELETE FROM sessions WHERE id IN (
           SELECT id FROM sessions
            WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)
            LIMIT ${BATCH})
         RETURNING NULL::uuid AS organization_id`,
        [ago(this.config.sessionRetentionMs)],
      ).then((rows) => rows.length),
      userTokens: await this.drain(
        `DELETE FROM user_tokens WHERE id IN (
           SELECT id FROM user_tokens
            WHERE expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1)
            LIMIT ${BATCH})
         RETURNING NULL::uuid AS organization_id`,
        [ago(86_400_000)],
      ).then((rows) => rows.length),
      invitationsExpired: returnedRows(
        await this.dataSource.query(
          `UPDATE invitations SET status = 'EXPIRED'
            WHERE status = 'PENDING' AND expires_at < $1
            RETURNING id`,
          [now],
        ),
      ).length,
      invitations: tally(
        await this.drain(
          `DELETE FROM invitations WHERE id IN (
             SELECT id FROM invitations
              WHERE status <> 'PENDING' AND updated_at < $1 LIMIT ${BATCH})
           RETURNING organization_id`,
          [ago(INVITATION_RETENTION_MS)],
        ),
        'invitations',
      ),
      usageRecords: 0,
      toolRecords: 0,
      conversations: 0,
      auditRecords: 0,
    };

    if (this.config.usageRetentionMs > 0) {
      const cutoff = ago(this.config.usageRetentionMs);
      report.usageRecords = tally(
        await this.drain(
          `DELETE FROM llm_invocations WHERE id IN (
             SELECT id FROM llm_invocations WHERE created_at < $1 LIMIT ${BATCH})
           RETURNING organization_id`,
          [cutoff],
        ),
        'usageRecords',
      );
      report.toolRecords = tally(
        await this.drain(
          `DELETE FROM tool_executions WHERE id IN (
             SELECT id FROM tool_executions
              WHERE created_at < $1 AND status <> 'RUNNING' LIMIT ${BATCH})
           RETURNING organization_id`,
          [cutoff],
        ),
        'toolRecords',
      );
    }

    if (this.config.conversationRetentionMs > 0) {
      // Crypto-shredding: the key goes, and with it every copy of the content.
      report.conversations = tally(
        await this.drain(
          `UPDATE conversations
              SET wrapped_data_key = NULL, title_ciphertext = NULL, deleted_at = now()
            WHERE id IN (
              SELECT id FROM conversations
               WHERE deleted_at IS NULL AND COALESCE(last_message_at, created_at) < $1
                 AND turn_lock_id IS NULL
               LIMIT ${BATCH})
            RETURNING organization_id`,
          [ago(this.config.conversationRetentionMs)],
        ),
        'conversations',
      );
    }

    const pruned = await this.auditRetention.applyRetention(now);
    report.auditRecords = pruned.reduce((sum, outcome) => sum + outcome.pruned, 0);

    for (const [kind, count] of Object.entries(report)) {
      if (count > 0) this.metrics?.lifecycleRemovals.inc({ kind }, count);
    }
    for (const [organizationId, counts] of perOrganization) {
      await this.auditService.recordSafe({
        action: AuditAction.DATA_RETENTION_APPLIED,
        organizationId,
        resourceType: 'organization',
        resourceId: organizationId,
        actor: { type: ActorType.SYSTEM, label: 'data lifecycle' },
        metadata: {
          ...counts,
          retention: {
            usageDays: Math.round(this.config.usageRetentionMs / 86_400_000),
            conversationDays: Math.round(this.config.conversationRetentionMs / 86_400_000),
          },
        },
      });
    }

    if (Object.values(report).some((count) => count > 0)) {
      this.logger.log(`Lifecycle sweep: ${JSON.stringify(report)}`);
    }
    return report;
  }

  /** Runs a batched DELETE/UPDATE … RETURNING until it returns nothing (or the cap). */
  private async drain(
    sql: string,
    params: unknown[],
  ): Promise<Array<{ organization_id: string | null }>> {
    const all: Array<{ organization_id: string | null }> = [];
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = returnedRows<{ organization_id: string | null }>(
        await this.dataSource.query(sql, params),
      );
      all.push(...rows);
      if (rows.length < BATCH) break;
    }
    return all;
  }
}
