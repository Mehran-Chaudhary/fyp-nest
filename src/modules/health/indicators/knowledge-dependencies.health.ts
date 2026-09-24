import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { AiServiceClient } from '../../../shared/ai-service/ai-service.client';
import { QueueService } from '../../../shared/queue/queue.service';
import { ObjectStorageService } from '../../../shared/storage/object-storage.service';
import { VectorStoreService } from '../../../shared/vector-store/vector-store.service';

/**
 * Probes for the phase 2 cloud dependencies.
 *
 * All four report **degraded**, never **down**, when unreachable — for the same
 * reason as Redis. Sign-in, workspaces, members, audit: everything outside the
 * knowledge layer keeps working without them, so pulling the API out of
 * rotation because the vector store blipped would turn a partial outage into a
 * total one. They appear in the full `/health` report and not in readiness.
 *
 * An unconfigured dependency reports degraded with `configured: false`, so a
 * half-provisioned deployment is visible at a glance.
 */
@Injectable()
export class KnowledgeDependenciesHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly storage: ObjectStorageService,
    private readonly vectorStore: VectorStoreService,
    private readonly aiService: AiServiceClient,
    private readonly queues: QueueService,
  ) {}

  objectStorage(key: string): Promise<HealthIndicatorResult> {
    return this.probe(key, this.storage.isConfigured, () => this.storage.ping());
  }

  vectorStoreHealth(key: string): Promise<HealthIndicatorResult> {
    return this.probe(key, this.vectorStore.isConfigured, () => this.vectorStore.ping(), {
      circuit: this.vectorStore.circuit.state,
    });
  }

  aiServiceHealth(key: string): Promise<HealthIndicatorResult> {
    return this.probe(
      key,
      this.aiService.isConfigured,
      async () => (await this.aiService.health()).status === 'ok',
      { circuit: this.aiService.circuit.state },
    );
  }

  queue(key: string): Promise<HealthIndicatorResult> {
    return this.probe(key, true, () => this.queues.ping(), {
      workersEnabled: this.queues.workersEnabled,
    });
  }

  private async probe(
    key: string,
    configured: boolean,
    check: () => Promise<boolean>,
    extra: Record<string, unknown> = {},
  ): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    if (!configured) {
      return indicator.degraded({ configured: false, ...extra });
    }

    const startedAt = Date.now();
    try {
      const healthy = await Promise.race([
        check(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      const responseTimeMs = Date.now() - startedAt;

      return healthy
        ? indicator.up({ configured: true, responseTimeMs, ...extra })
        : indicator.degraded({ configured: true, responseTimeMs, ...extra });
    } catch (error) {
      return indicator.degraded({
        configured: true,
        message: (error as Error).message,
        responseTimeMs: Date.now() - startedAt,
        ...extra,
      });
    }
  }
}
