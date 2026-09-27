import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RowLevelSecurityService } from '../../database/tenancy/row-level-security.service';
import { circuitStateValue, MetricsService } from '../../observability/metrics.service';
import { AiServiceClient } from '../../shared/ai-service/ai-service.client';
import { QUEUE_NAME, type QueueName } from '../../shared/queue/queue.constants';
import { QueueService } from '../../shared/queue/queue.service';
import { VectorStoreService } from '../../shared/vector-store/vector-store.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/** The pg pool's counters, as node-postgres exposes them. */
interface PoolCounters {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

const OBSERVED_QUEUES: QueueName[] = [
  QUEUE_NAME.INGESTION,
  QUEUE_NAME.WORKFLOW_STEPS,
  QUEUE_NAME.DEAD_LETTER,
];
const JOB_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * Gauges refreshed at scrape time (phase 5): the database pool, the queues'
 * depth, whether row-level security is in force, open sockets, and the state
 * of every dependency's circuit breaker. Counters and histograms are recorded
 * where things happen; these are the numbers that only make sense read now.
 */
@Injectable()
export class MetricsCollectorsService implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly dataSource: DataSource,
    private readonly queues: QueueService,
    private readonly rowLevelSecurity: RowLevelSecurityService,
    private readonly aiService: AiServiceClient,
    private readonly vectorStore: VectorStoreService,
    @Optional() private readonly gateway?: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.metrics.onScrape(() => this.database());
    this.metrics.onScrape(() => this.queueDepths());
    this.metrics.onScrape(() => this.dependencies());
  }

  private async database(): Promise<void> {
    const pool = (this.dataSource.driver as unknown as { master?: PoolCounters }).master;
    if (pool) {
      this.metrics.dbPool.set({ state: 'total' }, pool.totalCount ?? 0);
      this.metrics.dbPool.set({ state: 'idle' }, pool.idleCount ?? 0);
      this.metrics.dbPool.set({ state: 'waiting' }, pool.waitingCount ?? 0);
    }
    const status = this.rowLevelSecurity.lastStatus ?? (await this.rowLevelSecurity.describe());
    this.metrics.rowLevelSecurity.set(status.enforced && status.binding ? 1 : 0);
  }

  private async queueDepths(): Promise<void> {
    await Promise.all(
      OBSERVED_QUEUES.map(async (name) => {
        const counts = await this.queues.getQueue(name).getJobCounts(...JOB_STATES);
        for (const state of JOB_STATES) {
          this.metrics.queueJobs.set({ queue: name, state }, counts[state] ?? 0);
        }
      }),
    );
  }

  private dependencies(): void {
    this.metrics.circuitState.set(
      { dependency: 'ai_service' },
      circuitStateValue(this.aiService.circuit.state),
    );
    this.metrics.circuitState.set(
      { dependency: 'vector_store' },
      circuitStateValue(this.vectorStore.circuit.state),
    );
    this.metrics.realtimeConnections.set(this.gateway?.connectionCount ?? 0);
  }
}
