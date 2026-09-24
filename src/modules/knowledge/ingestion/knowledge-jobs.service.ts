import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INGESTION_CONFIG_KEY,
  type IngestionConfig,
} from '../../../config/ingestion.config';
import { RequestContextService } from '../../../shared/context/request-context.service';
import { QUEUE_NAME } from '../../../shared/queue/queue.constants';
import { QueueService } from '../../../shared/queue/queue.service';
import {
  INGESTION_JOB,
  ingestionJobId,
  type DeadLetterRecord,
  type IngestionJobData,
  type MaintenanceJobData,
  type MaintenanceJobName,
} from './knowledge-jobs';

/**
 * Hands work to the knowledge layer's queues.
 *
 * Every method reports failure by return value rather than by throwing. The
 * callers — an upload, a delete — have already committed their durable change
 * to PostgreSQL by the time they enqueue, and the maintenance sweep treats that
 * durable state as an outbox. A failed enqueue therefore means "later", never
 * "lost", and must not turn a successful upload into an error response.
 */
@Injectable()
export class KnowledgeJobsService {
  private readonly logger = new Logger(KnowledgeJobsService.name);
  private readonly config: IngestionConfig;

  constructor(
    private readonly queues: QueueService,
    private readonly requestContext: RequestContextService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<IngestionConfig>(INGESTION_CONFIG_KEY);
  }

  /**
   * Enqueues a document version for ingestion.
   *
   * With `replaceFinished`, a completed or failed job left behind under the same
   * id is removed first so the version can run again — the sweep uses this to
   * resume work whose job vanished or gave up while the document still says it
   * is in flight.
   */
  async enqueueIngestion(
    document: { organizationId: string; id: string; indexVersion: number },
    options: { replaceFinished?: boolean; requestId?: string } = {},
  ): Promise<boolean> {
    const queue = this.queues.getQueue(QUEUE_NAME.INGESTION);
    const jobId = ingestionJobId(document.id, document.indexVersion);

    try {
      if (options.replaceFinished) {
        const existing = await queue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state !== 'completed' && state !== 'failed') return true;
          await existing.remove();
        }
      }

      const data: IngestionJobData = {
        organizationId: document.organizationId,
        documentId: document.id,
        indexVersion: document.indexVersion,
        requestId: options.requestId ?? this.requestContext.requestId,
        enqueuedAt: Date.now(),
      };

      await queue.add(INGESTION_JOB, data, {
        jobId,
        attempts: this.config.maxAttempts,
        backoff: { type: 'exponential', delay: this.config.backoffDelayMs },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
      });

      return true;
    } catch (error) {
      this.logger.warn(
        `Could not enqueue ingestion for document ${document.id} v${document.indexVersion}: ` +
          `${(error as Error).message}. The maintenance sweep will retry.`,
      );
      return false;
    }
  }

  /**
   * Enqueues a maintenance job, deduplicated within one sweep interval.
   *
   * The id includes the current sweep window, so a request-triggered purge and
   * the sweep that follows it collapse into one job — while a purge that
   * genuinely failed can still be re-attempted by a later window. Every
   * maintenance job is idempotent, so the rare overlap is harmless.
   */
  async enqueueMaintenance(
    name: MaintenanceJobName,
    data: MaintenanceJobData,
    subjectId: string,
  ): Promise<boolean> {
    const window = Math.floor(Date.now() / this.config.sweepIntervalMs);

    try {
      await this.queues.getQueue(QUEUE_NAME.MAINTENANCE).add(
        name,
        { ...data, requestId: data.requestId ?? this.requestContext.requestId },
        {
          jobId: `${name}_${subjectId}_${window}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not enqueue ${name} for ${subjectId}: ${(error as Error).message}. ` +
          'The maintenance sweep will retry.',
      );
      return false;
    }
  }

  /** Records a job that exhausted its retries. Metadata only. */
  async deadLetter(record: DeadLetterRecord): Promise<void> {
    try {
      await this.queues.getQueue(QUEUE_NAME.DEAD_LETTER).add('dead-letter', record, {
        jobId: `dlq_${record.jobId}_${Date.now()}`,
        removeOnComplete: false,
        removeOnFail: false,
      });
    } catch (error) {
      this.logger.error(
        `Could not dead-letter job ${record.jobId}: ${(error as Error).message}.`,
      );
    }
  }
}
