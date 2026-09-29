import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

export interface IngestionConfig {
  /** BullMQ key prefix. BullMQ manages its own prefix and must not share ioredis's. */
  queuePrefix: string;
  workersEnabled: boolean;
  /** BullMQ `drainDelay`: seconds an idle worker blocks before polling again. */
  drainDelaySeconds: number;
  /** BullMQ `stalledInterval`: milliseconds between stalled-job checks. */
  stalledIntervalMs: number;
  concurrency: number;
  maxAttempts: number;
  backoffDelayMs: number;
  jobTimeoutMs: number;
  maxChunksPerDocument: number;
  chunkSizeDefault: number;
  chunkOverlapDefault: number;
  sweepIntervalMs: number;
  stallThresholdMs: number;
  organizationPurgeGraceMs: number;
}

export const INGESTION_CONFIG_KEY = 'ingestion';

export default registerAs(INGESTION_CONFIG_KEY, (): IngestionConfig => {
  const redisPrefix = (process.env.REDIS_KEY_PREFIX ?? 'daiap:').replace(/:+$/, '');

  return {
    queuePrefix: process.env.QUEUE_PREFIX || `${redisPrefix}:bull`,
    workersEnabled: process.env.QUEUE_WORKERS_ENABLED !== 'false',
    drainDelaySeconds: parseDuration(process.env.QUEUE_DRAIN_DELAY as string) / 1000,
    stalledIntervalMs: parseDuration(process.env.QUEUE_STALLED_INTERVAL as string),
    concurrency: Number(process.env.INGESTION_CONCURRENCY),
    maxAttempts: Number(process.env.INGESTION_MAX_ATTEMPTS),
    backoffDelayMs: parseDuration(process.env.INGESTION_BACKOFF_DELAY as string),
    jobTimeoutMs: parseDuration(process.env.INGESTION_JOB_TIMEOUT as string),
    maxChunksPerDocument: Number(process.env.INGESTION_MAX_CHUNKS),
    chunkSizeDefault: Number(process.env.CHUNK_SIZE_DEFAULT),
    chunkOverlapDefault: Number(process.env.CHUNK_OVERLAP_DEFAULT),
    sweepIntervalMs: parseDuration(process.env.MAINTENANCE_SWEEP_INTERVAL as string),
    stallThresholdMs: parseDuration(process.env.INGESTION_STALL_THRESHOLD as string),
    organizationPurgeGraceMs: parseDuration(process.env.ORGANIZATION_PURGE_GRACE as string),
  };
});
