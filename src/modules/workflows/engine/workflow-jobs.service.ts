import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestContextService } from '../../../shared/context/request-context.service';
import { QUEUE_NAME } from '../../../shared/queue/queue.constants';
import { QueueService } from '../../../shared/queue/queue.service';
import type { WorkflowDeadLetterRecord } from '../domain/dead-letter';
import { jobMacKey, signStepJob, stepJobId } from '../domain/job-auth';

export const STEP_JOB = 'step';

/**
 * Hands workflow steps to the queue.
 *
 * Like the knowledge layer's job service, failure is reported, not thrown:
 * the step row is committed (QUEUED) before the job is added, so a failed
 * enqueue means "later", never "lost" — the sweep finds QUEUED steps with no
 * `enqueued_at` and dispatches them.
 */
@Injectable()
export class WorkflowJobsService {
  private readonly logger = new Logger(WorkflowJobsService.name);

  constructor(
    private readonly queues: QueueService,
    private readonly dataSource: DataSource,
    private readonly requestContext: RequestContextService,
  ) {}

  async enqueueStep(input: {
    organizationId: string;
    runId: string;
    stepId: string;
    dispatch: number;
    /** The run's data key: the job's MAC is derived from it. */
    runKey: Buffer;
    delayMs?: number;
    requestId?: string | null;
  }): Promise<boolean> {
    const data = signStepJob(jobMacKey(input.runKey), {
      organizationId: input.organizationId,
      runId: input.runId,
      stepId: input.stepId,
      dispatch: input.dispatch,
      issuedAt: Date.now(),
      ...((input.requestId ?? this.requestContext.requestId)
        ? { requestId: input.requestId ?? this.requestContext.requestId }
        : {}),
    });

    try {
      await this.queues.getQueue(QUEUE_NAME.WORKFLOW_STEPS).add(STEP_JOB, data, {
        jobId: stepJobId(input.stepId, input.dispatch),
        delay: Math.max(0, Math.round(input.delayMs ?? 0)),
        // Retries are the engine's, recorded in PostgreSQL; BullMQ carries one attempt.
        attempts: 1,
        removeOnComplete: { age: 3_600, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 3_600, count: 10_000 },
      });
      await this.dataSource.query(
        `UPDATE workflow_steps SET enqueued_at = now() WHERE id = $1 AND dispatch = $2`,
        [input.stepId, input.dispatch],
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not enqueue workflow step ${input.stepId} (dispatch ${input.dispatch}): ` +
          `${(error as Error).message}. The workflow sweep will retry.`,
      );
      return false;
    }
  }

  /** Records a step that failed for good. Metadata only — see `dead-letter.ts`. */
  async deadLetter(record: WorkflowDeadLetterRecord): Promise<boolean> {
    try {
      await this.queues.getQueue(QUEUE_NAME.DEAD_LETTER).add('dead-letter', record, {
        jobId: `dlq_${record.stepId}_${record.attempts}`,
        removeOnComplete: false,
        removeOnFail: false,
      });
      return true;
    } catch (error) {
      this.logger.error(
        `Could not dead-letter workflow step ${record.stepId}: ${(error as Error).message}.`,
      );
      return false;
    }
  }
}
