import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

export type VectorTenancyMode = 'collection' | 'shared';

export interface VectorStoreConfig {
  configured: boolean;
  url: string;
  apiKey?: string;
  collectionPrefix: string;
  tenancy: VectorTenancyMode;
  timeoutMs: number;
  quantization: 'scalar' | 'none';
  circuitBreaker: {
    failureThreshold: number;
    cooldownMs: number;
  };
  /**
   * The embedding space. Recorded on every knowledge base and every vector, and
   * part of every retrieval filter: similarity between vectors from two
   * different models is meaningless, so they must never be compared.
   */
  embedding: {
    model: string;
    dimensions: number;
    batchSize: number;
  };
}

export const VECTOR_STORE_CONFIG_KEY = 'vectorStore';

export default registerAs(VECTOR_STORE_CONFIG_KEY, (): VectorStoreConfig => {
  const url = (process.env.QDRANT_URL ?? '').replace(/\/+$/, '');

  return {
    configured: url.length > 0,
    url,
    apiKey: process.env.QDRANT_API_KEY || undefined,
    collectionPrefix: process.env.QDRANT_COLLECTION_PREFIX ?? '',
    tenancy: (process.env.QDRANT_TENANCY ?? 'collection') as VectorTenancyMode,
    timeoutMs: parseDuration(process.env.QDRANT_TIMEOUT as string),
    quantization: (process.env.QDRANT_QUANTIZATION ?? 'scalar') as 'scalar' | 'none',
    circuitBreaker: {
      failureThreshold: Number(process.env.QDRANT_CIRCUIT_THRESHOLD),
      cooldownMs: parseDuration(process.env.QDRANT_CIRCUIT_COOLDOWN as string),
    },
    embedding: {
      model: process.env.EMBEDDING_MODEL as string,
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS),
      batchSize: Number(process.env.EMBEDDING_BATCH_SIZE),
    },
  };
});
