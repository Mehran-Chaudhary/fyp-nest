import type { LlmProviderKind } from '../../../config/llm.config';
import type { ChatMessage, GenerationParameters } from '../domain/generation';

export interface ProviderChatRequest {
  model: string;
  messages: ChatMessage[];
  parameters: GenerationParameters;
  /** Context window to allocate. Ollama must be told, or it silently uses 2–4k. */
  contextWindow: number;
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      finishReason: string | null;
      promptTokens: number | null;
      completionTokens: number | null;
    };

/** An open generation: the HTTP response has arrived and its body is streaming. */
export interface ProviderStream {
  events: AsyncIterable<ProviderEvent>;
  /** Aborts the upstream request, which stops generation on the GPU. */
  cancel(): void;
}

export interface ProviderModel {
  name: string;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  contextLength: number | null;
  sizeBytes: number | null;
}

export type ProviderErrorCode =
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'AUTH'
  | 'MODEL_NOT_FOUND'
  | 'REJECTED'
  | 'OVERLOADED'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE'
  | 'TOO_LARGE';

/**
 * A failure talking to the model endpoint.
 *
 * `retryable` is only ever acted on before the first token: once text has
 * streamed to a user it cannot be taken back, so a mid-stream failure ends the
 * turn instead of silently starting a different answer.
 */
export class LlmProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmProviderError';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface LlmProvider {
  readonly kind: LlmProviderKind;
  /**
   * Whether the model list is exactly what the endpoint will run. True for
   * Ollama (`/api/tags` is the set of pulled models); false for
   * OpenAI-compatible servers, some of which accept names they do not list
   * (TGI ignores the field entirely) — there the endpoint decides.
   */
  readonly listsEveryServedModel: boolean;
  /** The name the endpoint knows a model by (Ollama: `llama3.1` → `llama3.1:latest`). */
  normalizeModelName(name: string): string;
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  /** Context length where the endpoint can tell; null otherwise. */
  describeModel(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ contextLength: number | null }>;
  /** Sends the request; resolves once response headers arrive with a 2xx. */
  open(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderStream>;
  ping(): Promise<boolean>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const LLM_FETCH = Symbol('LLM_FETCH');
