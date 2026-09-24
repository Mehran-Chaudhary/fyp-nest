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
import { decodeSse, readLines } from './stream-decoding';

interface CompletionChunk {
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  error?: unknown;
}

/**
 * Any server speaking the OpenAI Chat Completions API: vLLM, Hugging Face TGI,
 * llama.cpp's server, LM Studio, Ollama's `/v1` layer, and hosted open-weight
 * providers (Groq, Together, Fireworks, DeepInfra, OpenRouter).
 *
 * `LLM_BASE_URL` includes the version path, as those providers document it:
 * `https://api.together.xyz/v1`, `http://vllm:8000/v1`.
 *
 * Only standard parameters are sent. `top_k` and `repeat_penalty` are not part
 * of the OpenAI API, and some strict servers reject unknown fields; they are
 * dropped rather than risk a failed request. Token usage is requested in the
 * final stream chunk (`stream_options.include_usage`); where a server does not
 * provide it, the gateway estimates.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind = 'openai' as const;
  readonly listsEveryServedModel = false;
  private readonly contextByModel = new Map<string, number>();

  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  normalizeModelName(name: string): string {
    return name.trim();
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const json = (await this.getJson('/models', signal)) as { data?: unknown };
    if (!Array.isArray(json.data)) {
      throw new LlmProviderError(
        'INVALID_RESPONSE',
        '/models returned no model list.',
        false,
      );
    }

    return json.data
      .map((raw: unknown): ProviderModel | null => {
        const model = raw as {
          id?: unknown;
          owned_by?: unknown;
          max_model_len?: unknown;
          context_length?: unknown;
        };
        if (typeof model.id !== 'string') return null;
        // vLLM reports max_model_len; OpenRouter reports context_length.
        const context = [model.max_model_len, model.context_length].find(
          (value): value is number => typeof value === 'number' && value > 0,
        );
        if (context) this.contextByModel.set(model.id, context);
        return {
          name: model.id,
          family: typeof model.owned_by === 'string' ? model.owned_by.slice(0, 64) : null,
          parameterSize: null,
          quantization: null,
          contextLength: context ?? null,
          sizeBytes: null,
        };
      })
      .filter((model): model is ProviderModel => model !== null);
  }

  describeModel(name: string): Promise<{ contextLength: number | null }> {
    return Promise.resolve({ contextLength: this.contextByModel.get(name) ?? null });
  }

  async open(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderStream> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const { parameters } = request;

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: parameters.temperature,
      max_tokens: parameters.maxOutputTokens,
    };
    if (parameters.topP !== undefined) body.top_p = parameters.topP;
    if (parameters.seed !== undefined) body.seed = parameters.seed;
    if (parameters.stop) body.stop = parameters.stop;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw connectionError(error, false, 0);
    }

    if (!response.ok || !response.body) {
      throw await errorFromResponse(response);
    }

    const stream = response.body as ReadableStream<Uint8Array>;
    const maxBytes = this.config.maxResponseBytes;

    async function* events(): AsyncGenerator<ProviderEvent> {
      let finishReason: string | null = null;
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      let sawDone = false;

      for await (const data of decodeSse(readLines(stream, maxBytes))) {
        if (data.trim() === '[DONE]') {
          sawDone = true;
          break;
        }

        let chunk: CompletionChunk;
        try {
          chunk = JSON.parse(data) as CompletionChunk;
        } catch (error) {
          throw new LlmProviderError(
            'INVALID_RESPONSE',
            'The model endpoint sent an event that is not valid JSON.',
            false,
            undefined,
            undefined,
            { cause: error },
          );
        }

        if (chunk.error !== undefined && chunk.error !== null) {
          throw new LlmProviderError(
            'SERVER_ERROR',
            'The model failed during generation.',
            false,
          );
        }

        const choice = chunk.choices?.[0];
        const content = choice?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          yield { type: 'delta', text: content };
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;

        if (chunk.usage) {
          promptTokens = asCount(chunk.usage.prompt_tokens) ?? promptTokens;
          completionTokens = asCount(chunk.usage.completion_tokens) ?? completionTokens;
        }
      }

      // A body that simply stops — a proxy timing out, a server restarting —
      // closes as cleanly as a finished one. Only `[DONE]` or a finish reason
      // says the answer is complete; anything else is a truncated answer.
      if (!sawDone && finishReason === null) {
        throw new LlmProviderError(
          'INVALID_RESPONSE',
          'The model stream ended without completing.',
          false,
        );
      }

      yield { type: 'done', finishReason, promptTokens, completionTokens };
    }

    return { events: events(), cancel: () => controller.abort() };
  }

  async ping(): Promise<boolean> {
    try {
      await this.getJson('/models', AbortSignal.timeout(5_000));
      return true;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return this.config.apiKey
      ? { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json' }
      : { accept: 'application/json' };
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
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

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
