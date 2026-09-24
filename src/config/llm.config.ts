import { registerAs } from '@nestjs/config';
import type { Classification } from '../modules/knowledge/domain/classification';
import { parseByteSize } from '../common/utils/byte-size.util';
import { parseDuration } from '../common/utils/duration.util';

/**
 * The LLM gateway (proposal module 6.7).
 *
 * Two wire protocols are supported, because "a locally hosted open model" in a
 * cloud-only deployment means one of two things in practice:
 *
 *  - `ollama` — Ollama's native API (`/api/chat`, `/api/tags`, `/api/show`),
 *    whether on a GPU machine you run (behind an authenticating proxy) or on
 *    Ollama's own cloud.
 *  - `openai` — the OpenAI-compatible Chat Completions API that vLLM, TGI,
 *    llama.cpp's server, LM Studio and every hosted open-weight provider
 *    (Groq, Together, Fireworks, DeepInfra, OpenRouter) speak.
 *
 * The gateway is optional at boot. Without `LLM_BASE_URL` the platform runs
 * and the inference endpoints answer 503 `LLM_NOT_CONFIGURED`.
 */
export type LlmProviderKind = 'ollama' | 'openai';

export interface LlmConfig {
  configured: boolean;
  provider: LlmProviderKind;
  /** Base URL without a trailing slash. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer …` when set. */
  apiKey?: string;
  defaultModel: string;
  /** Platform allowlist. Empty means every model the endpoint serves. */
  allowedModels: string[];
  /** Assumed when the endpoint does not report a model's context length. */
  defaultContextWindow: number;
  /** Hard ceiling, whatever a model or an agent asks for. Bounds GPU memory. */
  maxContextWindow: number;
  defaultMaxOutputTokens: number;
  maxOutputTokens: number;
  defaultTemperature: number;
  /** Request start → first generated token. Covers a cold model load. */
  firstTokenTimeoutMs: number;
  /** Longest silence tolerated between two chunks once generation started. */
  idleTimeoutMs: number;
  /** Hard ceiling on one generation, however steadily it streams. */
  maxDurationMs: number;
  /** Concurrent generations this process sends to the endpoint. */
  maxConcurrency: number;
  /** How long a request may wait for a free slot before 503 `LLM_BUSY`. */
  queueTimeoutMs: number;
  /** Retries of the connection only, never after a token has been received. */
  maxRetries: number;
  maxResponseBytes: number;
  circuitBreaker: {
    failureThreshold: number;
    cooldownMs: number;
  };
  /** Ollama only: how long the model stays loaded after a request. */
  keepAlive: string;
  /**
   * The most sensitive document classification whose (masked) content may be
   * placed in a prompt to this endpoint. A self-hosted model can take
   * RESTRICTED; a third-party open-model API should be capped lower.
   */
  maxClassification: Classification;
  modelCacheTtlMs: number;
}

export const LLM_CONFIG_KEY = 'llm';

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default registerAs(LLM_CONFIG_KEY, (): LlmConfig => {
  const baseUrl = (process.env.LLM_BASE_URL ?? '').replace(/\/+$/, '');
  const maxOutputTokens = Number(process.env.LLM_MAX_OUTPUT_TOKENS);
  const maxContextWindow = Number(process.env.LLM_MAX_CONTEXT_WINDOW);

  return {
    configured: baseUrl.length > 0,
    provider: (process.env.LLM_PROVIDER ?? 'ollama') as LlmProviderKind,
    baseUrl,
    apiKey: process.env.LLM_API_KEY || undefined,
    defaultModel: process.env.LLM_DEFAULT_MODEL as string,
    allowedModels: csv(process.env.LLM_ALLOWED_MODELS),
    defaultContextWindow: Math.min(
      Number(process.env.LLM_DEFAULT_CONTEXT_WINDOW),
      maxContextWindow,
    ),
    maxContextWindow,
    defaultMaxOutputTokens: Math.min(
      Number(process.env.LLM_DEFAULT_MAX_OUTPUT_TOKENS),
      maxOutputTokens,
    ),
    maxOutputTokens,
    defaultTemperature: Number(process.env.LLM_DEFAULT_TEMPERATURE),
    firstTokenTimeoutMs: parseDuration(process.env.LLM_FIRST_TOKEN_TIMEOUT as string),
    idleTimeoutMs: parseDuration(process.env.LLM_IDLE_TIMEOUT as string),
    maxDurationMs: parseDuration(process.env.LLM_MAX_DURATION as string),
    maxConcurrency: Number(process.env.LLM_MAX_CONCURRENCY),
    queueTimeoutMs: parseDuration(process.env.LLM_QUEUE_TIMEOUT as string),
    maxRetries: Number(process.env.LLM_MAX_RETRIES),
    maxResponseBytes: parseByteSize(process.env.LLM_MAX_RESPONSE_SIZE as string),
    circuitBreaker: {
      failureThreshold: Number(process.env.LLM_CIRCUIT_THRESHOLD),
      cooldownMs: parseDuration(process.env.LLM_CIRCUIT_COOLDOWN as string),
    },
    keepAlive: process.env.LLM_KEEP_ALIVE as string,
    maxClassification: (process.env.LLM_MAX_CLASSIFICATION ??
      'RESTRICTED') as Classification,
    modelCacheTtlMs: parseDuration(process.env.LLM_MODEL_CACHE_TTL as string),
  };
});
