import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WORKFLOWS_CONFIG_KEY,
  type WorkflowsConfig,
} from '../../../config/workflows.config';
import { QUEUE_NAME } from '../../../shared/queue/queue.constants';
import { QueueService } from '../../../shared/queue/queue.service';
import type { StepJobData } from '../domain/job-auth';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowMaintenanceService } from './workflow-maintenance.service';

const SWEEP_SCHEDULER_ID = 'workflow-maintenance-sweep';

/**
 * Starts the workflow engine's workers in processes configured to consume
 * jobs (`QUEUE_WORKERS_ENABLED`, shared with ingestion): the API process by
 * default, or the dedicated worker (`npm run start:worker`).
 */
@Injectable()
export class WorkflowWorkersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowWorkersService.name);
  private readonly config: WorkflowsConfig;

  constructor(
    private readonly queues: QueueService,
    private readonly engine: WorkflowEngineService,
    private readonly maintenance: WorkflowMaintenanceService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queues.workersEnabled) return;

    this.queues.startWorker<StepJobData, { outcome: string }>(
      QUEUE_NAME.WORKFLOW_STEPS,
      (job) => this.engine.process(job),
      {
        concurrency: this.config.concurrency,
        // Renewed while the step runs; bounds how fast a dead worker is noticed.
        lockDuration: 60_000,
        // The engine's own heartbeat and takeover handle a dead worker; BullMQ
        // re-delivering once more is enough.
        maxStalledCount: 1,
      },
    );

    this.queues.startWorker<Record<string, never>, unknown>(
      QUEUE_NAME.WORKFLOW_MAINTENANCE,
      () => this.maintenance.sweep(),
      { concurrency: 1 },
    );

    try {
      await this.queues
        .getQueue(QUEUE_NAME.WORKFLOW_MAINTENANCE)
        .upsertJobScheduler(
          SWEEP_SCHEDULER_ID,
          { every: this.config.sweepIntervalMs },
          { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } },
        );
    } catch (error) {
      this.logger.warn(
        `Could not schedule the workflow sweep: ${(error as Error).message}. ` +
          'It will be scheduled on the next start.',
      );
    }
  }
}
