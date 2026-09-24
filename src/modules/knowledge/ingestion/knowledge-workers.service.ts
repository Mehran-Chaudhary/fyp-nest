import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INGESTION_CONFIG_KEY,
  type IngestionConfig,
} from '../../../config/ingestion.config';
import { QUEUE_NAME } from '../../../shared/queue/queue.constants';
import { QueueService } from '../../../shared/queue/queue.service';
import { IngestionPipeline, type IngestionOutcome } from './ingestion.pipeline';
import {
  MAINTENANCE_JOB,
  type IngestionJobData,
  type MaintenanceJobData,
} from './knowledge-jobs';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.service';

const SWEEP_SCHEDULER_ID = 'knowledge-maintenance-sweep';

/**
 * Starts the knowledge layer's workers in processes configured to run them.
 *
 * With `QUEUE_WORKERS_ENABLED=true` (the default) the API process also
 * processes documents — the simplest deployment: one service. Setting it to
 * `false` on the API and running `npm run start:worker` elsewhere separates the
 * two, so a burst of large uploads cannot slow the API down.
 */
@Injectable()
export class KnowledgeWorkersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KnowledgeWorkersService.name);
  private readonly config: IngestionConfig;

  constructor(
    private readonly queues: QueueService,
    private readonly pipeline: IngestionPipeline,
    private readonly maintenance: KnowledgeMaintenanceService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<IngestionConfig>(INGESTION_CONFIG_KEY);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queues.workersEnabled) {
      this.logger.log(
        'Queue workers disabled in this process (QUEUE_WORKERS_ENABLED=false).',
      );
      return;
    }

    this.queues.startWorker<IngestionJobData, IngestionOutcome>(
      QUEUE_NAME.INGESTION,
      (job) => this.pipeline.process(job),
      {
        concurrency: this.config.concurrency,
        // Parsing a long PDF is slow; the lock is renewed every half-period
        // while the job runs, so this only bounds detection of a dead worker.
        lockDuration: 120_000,
      },
    );

    this.queues.startWorker<MaintenanceJobData, unknown>(
      QUEUE_NAME.MAINTENANCE,
      (job) => this.maintenance.handle(job),
      { concurrency: 2 },
    );

    try {
      // A scheduler, not a timer: however many worker processes run, BullMQ
      // produces exactly one sweep job per interval.
      await this.queues.getQueue(QUEUE_NAME.MAINTENANCE).upsertJobScheduler(
        SWEEP_SCHEDULER_ID,
        { every: this.config.sweepIntervalMs },
        {
          name: MAINTENANCE_JOB.SWEEP,
          data: {},
          opts: { removeOnComplete: true, removeOnFail: 50 },
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not schedule the maintenance sweep: ${(error as Error).message}. ` +
          'It will be scheduled on the next start.',
      );
    }
  }
}
