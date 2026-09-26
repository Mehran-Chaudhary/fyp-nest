import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { DataSource } from 'typeorm';
import { REALTIME_CONFIG_KEY, type RealtimeConfig } from '../../../config/realtime.config';
import {
  WORKFLOWS_CONFIG_KEY,
  type WorkflowsConfig,
} from '../../../config/workflows.config';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { QueueService } from '../../../shared/queue/queue.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

/**
 * Probes for the phase 4 machinery: the workflow engine and real-time events.
 *
 * Both report **degraded**, never **down**, like every probe added since
 * phase 2. A stuck workflow backlog or a lost event subscription is worth an
 * alert, but taking the API out of rotation for it would stop sign-in,
 * documents and chat as well — and would not unstick a single step.
 */
@Injectable()
export class OrchestrationHealthIndicator {
  private readonly workflows: WorkflowsConfig;
  private readonly realtimeConfig: RealtimeConfig;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly dataSource: DataSource,
    private readonly queues: QueueService,
    private readonly events: EventBusService,
    configService: ConfigService,
    @Optional() private readonly gateway?: RealtimeGateway,
  ) {
    this.workflows = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
    this.realtimeConfig = configService.getOrThrow<RealtimeConfig>(REALTIME_CONFIG_KEY);
  }

  /**
   * Whether workflow steps are being picked up — by this process or by a
   * separate worker. The reconciliation sweep reclaims a step whose heartbeat
   * stopped after `WORKFLOW_STALL_THRESHOLD` and re-enqueues overdue steps each
   * `WORKFLOW_SWEEP_INTERVAL`; steps that stay stalled or overdue well past
   * those windows mean no worker is consuming the queue at all. Counts only:
   * nothing about any tenant's runs.
   */
  async workflowEngine(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const workersEnabled = this.queues.workersEnabled;
    const stalledAfterMs = 2 * this.workflows.stallThresholdMs;
    const overdueAfterMs = Math.max(3 * this.workflows.sweepIntervalMs, 60_000);
    const startedAt = Date.now();

    try {
      const rows = await Promise.race([
        this.dataSource.query<Array<{ stalled: string; overdue: string }>>(
          `SELECT
             count(*) FILTER (WHERE status = 'RUNNING'
               AND heartbeat_at < now() - $1 * interval '1 millisecond') AS stalled,
             count(*) FILTER (WHERE status = 'QUEUED'
               AND COALESCE(next_attempt_at, updated_at) < now() - $2 * interval '1 millisecond') AS overdue
             FROM workflow_steps
            WHERE status IN ('QUEUED', 'RUNNING')`,
          [stalledAfterMs, overdueAfterMs],
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out')), 3_000).unref(),
        ),
      ]);
      const stalledSteps = Number(rows[0]?.stalled ?? 0);
      const overdueSteps = Number(rows[0]?.overdue ?? 0);
      const details = {
        workersEnabled,
        stalledSteps,
        overdueSteps,
        responseTimeMs: Date.now() - startedAt,
      };
      if (stalledSteps === 0 && overdueSteps === 0) return indicator.up(details);
      return indicator.degraded({
        ...details,
        message:
          'Workflow steps are not being picked up. Check that a process with ' +
          'QUEUE_WORKERS_ENABLED=true (the API or `node dist/worker`) is running.',
      });
    } catch (error) {
      return indicator.degraded({
        workersEnabled,
        message: (error as Error).message,
        responseTimeMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Whether this instance can deliver live events: real-time enabled, and the
   * event-bus subscription (through which a worker's events reach whichever
   * API instance holds the socket) established.
   */
  realtime(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    if (!this.realtimeConfig.enabled) return indicator.up({ enabled: false });

    const details = {
      enabled: true,
      eventBus: this.events.isSubscribed ? 'subscribed' : 'not subscribed',
      connections: this.gateway?.connectionCount ?? 0,
    };
    return this.events.isSubscribed
      ? indicator.up(details)
      : indicator.degraded({
          ...details,
          message: 'Not subscribed to the event bus; live events will not arrive.',
        });
  }
}
