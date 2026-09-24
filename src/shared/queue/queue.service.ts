import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import { APP_CONFIG_KEY, type AppConfig } from '../../config/app.config';
import { INGESTION_CONFIG_KEY, type IngestionConfig } from '../../config/ingestion.config';
import { REDIS_CONFIG_KEY, type RedisConfig } from '../../config/redis.config';
import { buildBullConnectionOptions } from './bull-connection';
import type { QueueName } from './queue.constants';

/**
 * Owns every BullMQ queue and worker in the process.
 *
 * BullMQ is used directly rather than through a Nest wrapper because the two
 * decisions that matter here are runtime decisions: *whether* this process
 * consumes jobs at all (`QUEUE_WORKERS_ENABLED`, so the API and the worker can
 * be deployed as one service or two), and *how many* at once
 * (`INGESTION_CONCURRENCY`). Decorator-based processors fix both at import
 * time.
 *
 * ## Shutdown order
 *
 * Workers close first and are given the configured grace period to finish
 * their current job, so a deploy does not abandon half-embedded documents.
 * Anything still running when the grace period ends is recovered by BullMQ's
 * stalled-job detection on the next worker to start — and every ingestion step
 * is idempotent, so re-running it is safe.
 */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly redisConfig: RedisConfig;
  private readonly ingestionConfig: IngestionConfig;
  private readonly shutdownTimeoutMs: number;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private producerConnection?: Redis;

  constructor(configService: ConfigService) {
    this.redisConfig = configService.getOrThrow<RedisConfig>(REDIS_CONFIG_KEY);
    this.ingestionConfig = configService.getOrThrow<IngestionConfig>(INGESTION_CONFIG_KEY);
    this.shutdownTimeoutMs =
      configService.getOrThrow<AppConfig>(APP_CONFIG_KEY).shutdownTimeoutMs;
  }

  get workersEnabled(): boolean {
    return this.ingestionConfig.workersEnabled;
  }

  get prefix(): string {
    return this.ingestionConfig.queuePrefix;
  }

  /** A producer handle for `name`, created on first use and reused thereafter. */
  getQueue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, {
      // One shared connection for every producer in the process.
      connection: this.getProducerConnection(),
      prefix: this.prefix,
    });

    queue.on('error', (error: Error) => {
      this.logger.warn(`Queue "${name}" error: ${error.message}`);
    });

    this.queues.set(name, queue);
    return queue;
  }

  /**
   * Starts a worker for `name`, or returns `null` when this process does not
   * consume jobs.
   */
  startWorker<TData, TResult>(
    name: QueueName,
    processor: (job: Job<TData, TResult>) => Promise<TResult>,
    options: Pick<WorkerOptions, 'concurrency' | 'lockDuration' | 'maxStalledCount'> = {},
  ): Worker<TData, TResult> | null {
    if (!this.workersEnabled) return null;

    const worker = new Worker<TData, TResult>(name, processor, {
      connection: buildBullConnectionOptions(this.redisConfig, 'worker'),
      prefix: this.prefix,
      concurrency: options.concurrency ?? 1,
      lockDuration: options.lockDuration ?? 60_000,
      // A job whose worker died is picked up again once more before being
      // failed. Twice-stalled usually means the job itself kills the process.
      maxStalledCount: options.maxStalledCount ?? 2,
    });

    worker.on('error', (error: Error) => {
      this.logger.warn(`Worker "${name}" error: ${error.message}`);
    });

    this.workers.push(worker as Worker);
    this.logger.log(
      `Worker started for "${name}" (concurrency ${options.concurrency ?? 1}).`,
    );

    return worker;
  }

  /** Round-trip check for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      return (await this.getProducerConnection().ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.workers.map((worker) =>
        Promise.race([
          worker.close(),
          new Promise<void>((resolve) => setTimeout(resolve, this.shutdownTimeoutMs)),
        ]).catch((error: Error) =>
          this.logger.warn(
            `Worker "${worker.name}" did not close cleanly: ${error.message}`,
          ),
        ),
      ),
    );

    await Promise.all(
      [...this.queues.values()].map((queue) =>
        queue
          .close()
          .catch((error: Error) =>
            this.logger.debug(`Queue "${queue.name}" close failed: ${error.message}`),
          ),
      ),
    );

    if (this.producerConnection) {
      await this.producerConnection
        .quit()
        .catch(() => this.producerConnection?.disconnect());
    }
  }

  private getProducerConnection(): Redis {
    if (!this.producerConnection) {
      this.producerConnection = new Redis(
        buildBullConnectionOptions(this.redisConfig, 'producer'),
      );
      this.producerConnection.on('error', (error: Error) => {
        this.logger.debug(`Queue producer connection error: ${error.message}`);
      });
    }
    return this.producerConnection;
  }
}
