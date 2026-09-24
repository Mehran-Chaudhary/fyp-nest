import { registerAs } from '@nestjs/config';
import { parseByteSize } from '../common/utils/byte-size.util';
import { parseDuration } from '../common/utils/duration.util';

/**
 * The Python AI service: document parsing and chunking, embeddings, and
 * (optionally) cross-encoder reranking.
 *
 * The contract, including the request-signing scheme, is specified in
 * `docs/contracts/ai-service-v1.md`.
 */
export interface AiServiceConfig {
  configured: boolean;
  /** Base URL without a trailing slash, e.g. `https://ai.example.com`. */
  url: string;
  signingSecret: string;
  keyId: string;
  timeoutMs: number;
  parseTimeoutMs: number;
  maxRetries: number;
  maxResponseBytes: number;
  circuitBreaker: {
    failureThreshold: number;
    cooldownMs: number;
  };
}

export const AI_SERVICE_CONFIG_KEY = 'aiService';

export default registerAs(AI_SERVICE_CONFIG_KEY, (): AiServiceConfig => {
  const url = (process.env.AI_SERVICE_URL ?? '').replace(/\/+$/, '');

  return {
    configured: url.length > 0,
    url,
    signingSecret: process.env.AI_SERVICE_SIGNING_SECRET ?? '',
    keyId: process.env.AI_SERVICE_KEY_ID as string,
    timeoutMs: parseDuration(process.env.AI_SERVICE_TIMEOUT as string),
    parseTimeoutMs: parseDuration(process.env.AI_SERVICE_PARSE_TIMEOUT as string),
    maxRetries: Number(process.env.AI_SERVICE_MAX_RETRIES),
    maxResponseBytes: parseByteSize(process.env.AI_SERVICE_MAX_RESPONSE_SIZE as string),
    circuitBreaker: {
      failureThreshold: Number(process.env.AI_SERVICE_CIRCUIT_THRESHOLD),
      cooldownMs: parseDuration(process.env.AI_SERVICE_CIRCUIT_COOLDOWN as string),
    },
  };
});
