import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUE_NAME } from '../../shared/queue/queue.constants';
import { QueueService } from '../../shared/queue/queue.service';
import { RequestContextService } from '../../shared/context/request-context.service';
import { QuotaService } from './quota.service';

const SWEEP_SCHEDULER_ID = 'quota-maintenance-sweep';
const SWEEP_INTERVAL_MS = 60_000;
/** Counters are kept for thirteen months: a year of history, month over month. */
const COUNTER_RETENTION_MS = 400 * 86_400_000;

export interface QuotaSweepReport {
  reservationsReleased: number;
  countersReconciled: number;
  countersPruned: number;
}

/**
 * Keeps the budgets honest (phase 5), once a minute, in whichever process
 * consumes the governance queue:
 *
 *  1. **Expired reservations** — left by a call whose process died — are
 *     released, so a crash cannot leak budget for the rest of the period.
 *  2. **Counters behind the ledger** — a settlement lost to that same crash —
 *     are raised to the usage ledger's sum.
 *  3. **Old counters** are pruned after thirteen months.
 *
 * Runs unbound (no workspace): it is the one legitimately cross-tenant path
 * in the quota engine.
 */
@Injectable()
export class QuotaMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QuotaMaintenanceService.name);

  constructor(
    private readonly quotas: QuotaService,
    private readonly queues: QueueService,
    private readonly requestContext: RequestContextService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queues.workersEnabled) return;

    this.queues.startWorker<Record<string, never>, QuotaSweepReport>(
      QUEUE_NAME.GOVERNANCE_MAINTENANCE,
      () => this.sweep(),
      { concurrency: 1 },
    );
    try {
      await this.queues
        .getQueue(QUEUE_NAME.GOVERNANCE_MAINTENANCE)
        .upsertJobScheduler(
          SWEEP_SCHEDULER_ID,
          { every: SWEEP_INTERVAL_MS },
          { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } },
        );
    } catch (error) {
      this.logger.warn(
        `Could not schedule the quota sweep: ${(error as Error).message}. ` +
          'It will be scheduled on the next start.',
      );
    }
  }

  sweep(): Promise<QuotaSweepReport> {
    return this.requestContext.runAsSystem('quota maintenance', async () => {
      const report: QuotaSweepReport = {
        reservationsReleased: await this.quotas.releaseExpired(),
        countersReconciled: await this.quotas.reconcile(),
        countersPruned: await this.quotas.pruneCounters(COUNTER_RETENTION_MS),
      };
      if (Object.values(report).some((count) => count > 0)) {
        this.logger.log(`Quota sweep: ${JSON.stringify(report)}`);
      }
      return report;
    });
  }
}
