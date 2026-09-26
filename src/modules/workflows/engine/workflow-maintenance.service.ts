import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { ActorType } from '../../../common/enums/auth-type.enum';
import {
  WORKFLOWS_CONFIG_KEY,
  type WorkflowsConfig,
} from '../../../config/workflows.config';
import { returnedRows } from '../../../database/query.util';
import { RequestContextService } from '../../../shared/context/request-context.service';
import { AuditService } from '../../audit/audit.service';
import { RunCryptoService } from '../run-crypto.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowJobsService } from './workflow-jobs.service';

const BATCH = 100;

export interface WorkflowSweepReport {
  dispatched: number;
  recovered: number;
  timedOut: number;
  approvalsExpired: number;
  reconciled: number;
  purged: number;
}

/**
 * Reconciliation for the workflow engine: PostgreSQL is the source of truth,
 * and this sweep drives the queue towards it. Everything here is idempotent,
 * and runs as a BullMQ job scheduler — exactly one sweep per interval, however
 * many workers are running.
 *
 *  1. **Undelivered steps.** QUEUED with no job, or with a job long overdue
 *     (Redis lost it, or the enqueue after commit failed): dispatched again.
 *  2. **Stalled steps.** RUNNING without a heartbeat for the stall threshold:
 *     the worker died. Re-dispatched; the next claim takes it over.
 *  3. **Deadlines.** Active runs past their deadline are timed out.
 *  4. **Approvals.** Waiting past their expiry: decided by the node's
 *     timeout policy (reject, unless configured to approve).
 *  5. **Stuck runs.** Active, with nothing in flight: re-evaluated, which
 *     settles or advances them.
 *  6. **Retention.** Finished runs past `WORKFLOW_RUN_RETENTION` are deleted,
 *     their keys destroyed first.
 */
@Injectable()
export class WorkflowMaintenanceService {
  private readonly logger = new Logger(WorkflowMaintenanceService.name);
  private readonly config: WorkflowsConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: WorkflowEngineService,
    private readonly jobs: WorkflowJobsService,
    private readonly crypto: RunCryptoService,
    private readonly auditService: AuditService,
    private readonly requestContext: RequestContextService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
  }

  sweep(): Promise<WorkflowSweepReport> {
    return this.requestContext.runAsSystem('workflow maintenance', () => this.run());
  }

  private async run(): Promise<WorkflowSweepReport> {
    const report: WorkflowSweepReport = {
      dispatched: 0,
      recovered: 0,
      timedOut: 0,
      approvalsExpired: 0,
      reconciled: 0,
      purged: 0,
    };
    const stall = this.config.stallThresholdMs;

    // 1 + 2. Steps whose job is missing, overdue, or whose worker went silent.
    const lost = returnedRows<{
      id: string;
      run_id: string;
      organization_id: string;
      dispatch: number;
      recovered: boolean;
    }>(
      await this.dataSource.query(
        `UPDATE workflow_steps s
            SET dispatch = s.dispatch + 1,
                enqueued_at = NULL,
                status = 'QUEUED',
                heartbeat_at = NULL
           FROM workflow_runs r
          WHERE r.id = s.run_id AND r.status IN ('RUNNING','WAITING_APPROVAL','QUEUED')
            AND s.id IN (
              SELECT s2.id FROM workflow_steps s2
               WHERE (s2.status = 'QUEUED' AND (
                        (s2.enqueued_at IS NULL AND s2.updated_at < now() - interval '30 seconds')
                     OR (COALESCE(s2.next_attempt_at, s2.enqueued_at) < now() - $1 * interval '1 millisecond')))
                  OR (s2.status = 'RUNNING' AND s2.heartbeat_at < now() - $1 * interval '1 millisecond')
               LIMIT ${BATCH})
          RETURNING s.id, s.run_id, s.organization_id, s.dispatch,
                    (s.started_at IS NOT NULL AND s.attempt > 0) AS recovered`,
        [stall],
      ),
    );
    for (const row of lost) {
      const key = await this.runKey(row.run_id);
      if (!key) continue;
      try {
        const enqueued = await this.jobs.enqueueStep({
          organizationId: row.organization_id,
          runId: row.run_id,
          stepId: row.id,
          dispatch: row.dispatch,
          runKey: key,
        });
        if (enqueued) {
          if (row.recovered) report.recovered += 1;
          else report.dispatched += 1;
        }
      } finally {
        this.crypto.destroy(key);
      }
    }

    // 3. Deadlines.
    const overdue: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM workflow_runs
        WHERE status IN ('QUEUED','RUNNING','WAITING_APPROVAL') AND deadline_at < now()
          AND deleted_at IS NULL
        LIMIT ${BATCH}`,
    );
    for (const run of overdue) {
      if (await this.engine.timeoutRun(run.id)) report.timedOut += 1;
    }

    // 4. Approvals past their expiry, decided by the node's timeout policy.
    const expired: Array<{
      id: string;
      run_id: string;
      node_id: string;
      graph: { nodes: Array<{ id: string; data?: { onTimeout?: string } }> };
    }> = await this.dataSource.query(
      `SELECT s.id, s.run_id, s.node_id, v.graph
           FROM workflow_steps s
           JOIN workflow_runs r ON r.id = s.run_id
           JOIN workflow_versions v ON v.workflow_id = r.workflow_id AND v.version = r.workflow_version
          WHERE s.status = 'WAITING_APPROVAL' AND (s.approval->>'expiresAt')::timestamptz < now()
            AND r.status IN ('RUNNING','WAITING_APPROVAL')
          LIMIT ${BATCH}`,
    );
    for (const step of expired) {
      const node = step.graph.nodes.find((candidate) => candidate.id === step.node_id);
      const decided = await this.engine.decideApproval({
        runId: step.run_id,
        stepId: step.id,
        decision: node?.data?.onTimeout === 'approve' ? 'approved' : 'rejected',
        decidedBy: 'timeout',
        actorUserId: null,
      });
      if (decided) report.approvalsExpired += 1;
    }

    // 5. Active runs with nothing in flight: settle or advance them.
    const stuck: Array<{ id: string }> = await this.dataSource.query(
      `SELECT r.id FROM workflow_runs r
        WHERE r.status IN ('RUNNING','QUEUED') AND r.deleted_at IS NULL
          AND r.updated_at < now() - interval '1 minute'
          AND NOT EXISTS (SELECT 1 FROM workflow_steps s
                           WHERE s.run_id = r.id AND s.status IN ('QUEUED','RUNNING','WAITING_APPROVAL'))
        LIMIT ${BATCH}`,
    );
    for (const run of stuck) {
      await this.engine.reconcile(run.id);
      report.reconciled += 1;
    }

    // 6. Retention: destroy the key, then the rows.
    if (this.config.runRetentionMs > 0) {
      const old: Array<{ id: string; organization_id: string }> =
        await this.dataSource.query(
          `SELECT id, organization_id FROM workflow_runs
          WHERE status IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT')
            AND completed_at < now() - $1 * interval '1 millisecond'
            AND deleted_at IS NULL
          LIMIT ${BATCH}`,
          [this.config.runRetentionMs],
        );
      for (const run of old) {
        await this.dataSource.transaction(async (manager) => {
          await manager.query(
            `UPDATE workflow_runs
                SET wrapped_data_key = NULL, input_ciphertext = NULL, output_ciphertext = NULL,
                    deleted_at = now()
              WHERE id = $1`,
            [run.id],
          );
          await manager.query(`DELETE FROM workflow_steps WHERE run_id = $1`, [run.id]);
          await this.auditService.record(
            {
              action: AuditAction.WORKFLOW_RUN_DELETED,
              organizationId: run.organization_id,
              resourceType: 'workflow_run',
              resourceId: run.id,
              actor: { type: ActorType.SYSTEM, label: 'workflow retention' },
              metadata: { runId: run.id, reason: 'RETENTION' },
            },
            manager,
          );
        });
        report.purged += 1;
      }
    }

    if (Object.values(report).some((count) => count > 0)) {
      this.logger.log(`Workflow sweep: ${JSON.stringify(report)}`);
    }
    return report;
  }

  private async runKey(runId: string): Promise<Buffer | null> {
    const [row]: Array<{ wrapped_data_key: string | null }> = await this.dataSource.query(
      `SELECT wrapped_data_key FROM workflow_runs WHERE id = $1`,
      [runId],
    );
    return row?.wrapped_data_key ? this.crypto.unwrap(runId, row.wrapped_data_key) : null;
  }
}
