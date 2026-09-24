import type { LlmConfig } from '../../../config/llm.config';
import { readBoundedText } from '../../../common/utils/http.util';
import { connectionError, errorFromResponse } from './http-errors';
import {
  LlmProviderError,
  type FetchLike,
  type LlmProvider,
  type ProviderChatRequest,
  type ProviderEvent,
  type ProviderModel,
  type ProviderStream,
} from './provider.types';
import { decodeNdjson, readLines } from './stream-decoding';

interface OllamaChunk {
  message?: { content?: unknown };
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

/**
 * Ollama's native API.
 *
 * `LLM_BASE_URL` is the server root (`https://ollama.example.com`), with no
 * path. Ollama has no authentication of its own: a self-hosted instance must
 * sit behind an authenticating proxy, whose bearer token is `LLM_API_KEY` —
 * the same header Ollama's own cloud expects.
 *
 * Two details that bite everyone who integrates Ollama:
 *
 *  - **`num_ctx` must be sent.** Without it Ollama uses its default context
 *    (2k–4k tokens depending on version) whatever the model supports, and an
 *    overflowing prompt is truncated *from the front* — silently dropping the
 *    system prompt, and with it the instructions about placeholders.
 *  - **`keep_alive`** keeps the model loaded between requests; otherwise the
 *    first request after five idle minutes pays a cold load of tens of seconds.
 */
export class OllamaProvider implements LlmProvider {
  readonly kind = 'ollama' as const;
  readonly listsEveryServedModel = true;

  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  normalizeModelName(name: string): string {
    const trimmed = name.trim();
    const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return lastSegment.includes(':') ? trimmed : `${trimmed}:latest`;
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const json = await this.getJson('/api/tags', signal);
    const models = (json as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      throw new LlmProviderError(
        'INVALID_RESPONSE',
        '/api/tags returned no model list.',
        false,
      );
    }

    return models
      .map((raw: unknown): ProviderModel | null => {
        const model = raw as {
          name?: unknown;
          model?: unknown;
          size?: unknown;
          details?: {
            family?: unknown;
            parameter_size?: unknown;
            quantization_level?: unknown;
          };
        };
        const name = typeof model.name === 'string' ? model.name : model.model;
        if (typeof name !== 'string') return null;
        return {
          name: this.normalizeModelName(name),
          family: asString(model.details?.family),
          parameterSize: asString(model.details?.parameter_size),
          quantization: asString(model.details?.quantization_level),
          contextLength: null,
          sizeBytes: typeof model.size === 'number' ? model.size : null,
        };
      })
      .filter((model): model is ProviderModel => model !== null);
  }

  async describeModel(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ contextLength: number | null }> {
    const json = await this.postJson('/api/show', { model: name }, signal);
    const info = (json as { model_info?: Record<string, unknown> }).model_info ?? {};
    // The key is architecture-specific: "llama.context_length", "qwen2.context_length", …
    const entry = Object.entries(info).find(([key]) => key.endsWith('.context_length'));
    const value = entry?.[1];
    return {
      contextLength: typeof value === 'number' && value > 0 ? value : null,
    };
  }

  async open(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderStream> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const { parameters } = request;

    const options: Record<string, unknown> = {
      temperature: parameters.temperature,
      num_predict: parameters.maxOutputTokens,
      num_ctx: request.contextWindow,
    };
    if (parameters.topP !== undefined) options.top_p = parameters.topP;
    if (parameters.topK !== undefined) options.top_k = parameters.topK;
    if (parameters.repeatPenalty !== undefined)
      options.repeat_penalty = parameters.repeatPenalty;
    if (parameters.seed !== undefined) options.seed = parameters.seed;
    if (parameters.stop) options.stop = parameters.stop;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          options,
          keep_alive: this.config.keepAlive,
        }),
        signal: combined,
      });
    } catch (error) {
      // An abort is the gateway's own deadline or the client leaving; it knows which.
      if (signal.aborted) throw error;
      throw connectionError(error, false, 0);
    }

    if (!response.ok || !response.body) {
      throw await errorFromResponse(response);
    }

    const body = response.body as ReadableStream<Uint8Array>;
    const maxBytes = this.config.maxResponseBytes;

    async function* events(): AsyncGenerator<ProviderEvent> {
      for await (const raw of decodeNdjson(readLines(body, maxBytes))) {
        const chunk = raw as OllamaChunk;

        if (typeof chunk.error === 'string') {
          throw new LlmProviderError(
            'SERVER_ERROR',
            `The model failed during generation: ${chunk.error.slice(0, 300)}`,
            false,
          );
        }

        const content = chunk.message?.content;
        if (typeof content === 'string' && content.length > 0) {
          yield { type: 'delta', text: content };
        }

        if (chunk.done === true) {
          yield {
            type: 'done',
            finishReason: asString(chunk.done_reason),
            promptTokens: asCount(chunk.prompt_eval_count),
            completionTokens: asCount(chunk.eval_count),
          };
          return;
        }
      }
    }

    return { events: events(), cancel: () => controller.abort() };
  }

  async ping(): Promise<boolean> {
    try {
      await this.getJson('/api/version', AbortSignal.timeout(5_000));
      return true;
    } catch {
      return false;
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return this.config.apiKey
      ? { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json' }
      : { accept: 'application/json' };
  }

  private getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'GET', headers: this.headers() }, signal);
  }

  private postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      path,
      {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      throw connectionError(error, timeout.aborted, 15_000);
    }
    if (!response.ok) throw await errorFromResponse(response);

    const text = await readBoundedText(response, 8 * 1024 * 1024);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new LlmProviderError(
        'INVALID_RESPONSE',
        `${path} did not return JSON.`,
        false,
        response.status,
        undefined,
        { cause: error },
      );
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 64) : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
