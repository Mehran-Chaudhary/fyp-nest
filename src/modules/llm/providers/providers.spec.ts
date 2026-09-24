import type { LlmConfig } from '../../../config/llm.config';
import { Classification } from '../../knowledge/domain/classification';
import type { GenerationParameters } from '../domain/generation';
import { connectionError, errorFromResponse, extractMessage } from './http-errors';
import { OllamaProvider } from './ollama.provider';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';
import {
  LlmProviderError,
  type ProviderEvent,
  type ProviderStream,
} from './provider.types';
import { decodeNdjson, decodeSse, readLines } from './stream-decoding';

/**
 * The two model-endpoint dialects, tested against scripted HTTP responses:
 * what is sent (the parameters that silently break things when missing) and
 * how a streamed body is decoded, including the ways it arrives broken.
 */

const encoder = new TextEncoder();

function bodyOf(
  chunks: Array<string | Uint8Array>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++];
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function* linesOf(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield await Promise.resolve(line);
}

async function failure(promise: Promise<unknown>): Promise<LlmProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmProviderError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('stream decoding', () => {
  it('cuts lines only at newlines, across chunk boundaries and CRLF', async () => {
    const lines = await collect(
      readLines(bodyOf(['{"a":', '1}\r\n{"b"', ':2}\n', 'tail']), 1_000),
    );
    expect(lines).toEqual(['{"a":1}', '{"b":2}', 'tail']);
  });

  it('decodes a multi-byte character split between two chunks', async () => {
    const bytes = encoder.encode('café ✓\n');
    const split = bytes.indexOf(0xa9); // inside "é"
    const lines = await collect(
      readLines(bodyOf([bytes.slice(0, split), bytes.slice(split)]), 1_000),
    );
    expect(lines).toEqual(['café ✓']);
  });

  it('refuses a body larger than the limit', async () => {
    const error = await failure(
      collect(readLines(bodyOf(['x'.repeat(600), 'y'.repeat(600)]), 1_000)),
    );
    expect(error.code).toBe('TOO_LARGE');
  });

  it('stops the download when the consumer stops early', async () => {
    let cancelled = false;
    const lines = readLines(
      bodyOf(['one\n', 'two\n', 'three\n'], () => (cancelled = true)),
      1_000,
    );
    for await (const line of lines) {
      expect(line).toBe('one');
      break;
    }
    expect(cancelled).toBe(true);
  });

  it('parses NDJSON, skipping blank lines and rejecting garbage', async () => {
    expect(await collect(decodeNdjson(linesOf(['{"a":1}', '', '  ', '{"b":2}'])))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect((await failure(collect(decodeNdjson(linesOf(['{"a":', '1}']))))).code).toBe(
      'INVALID_RESPONSE',
    );
  });

  it('parses SSE: multi-line data, comments, other fields, and an unterminated last event', async () => {
    const events = await collect(
      decodeSse(
        linesOf([
          ': keep-alive',
          'event: message',
          'data: {"part":1,',
          'data:"more":true}',
          'id: 7',
          '',
          '',
          'data: [DONE]',
        ]),
      ),
    );
    expect(events).toEqual(['{"part":1,\n"more":true}', '[DONE]']);
  });
});

describe('model endpoint errors', () => {
  const response = (status: number, body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers });

  it('classifies failures by status, keeping the retry hint', async () => {
    expect((await errorFromResponse(response(401, '{}'))).code).toBe('AUTH');
    expect((await errorFromResponse(response(404, '{}'))).code).toBe('MODEL_NOT_FOUND');
    expect(
      (
        await errorFromResponse(
          response(400, '{"error":"model \\"x\\" not found, try pulling it first"}'),
        )
      ).code,
    ).toBe('MODEL_NOT_FOUND');
    expect((await errorFromResponse(response(400, '{"error":"bad"}'))).code).toBe(
      'REJECTED',
    );

    const throttled = await errorFromResponse(response(429, '', { 'retry-after': '3' }));
    expect(throttled).toMatchObject({
      code: 'OVERLOADED',
      retryable: true,
      retryAfterMs: 3_000,
    });
    const failing = await errorFromResponse(response(503, 'upstream down'));
    expect(failing).toMatchObject({ code: 'SERVER_ERROR', retryable: true, status: 503 });
    expect((await errorFromResponse(response(422, '{}'))).retryable).toBe(false);
  });

  it('extracts the provider message in either dialect, sanitised and bounded', () => {
    expect(extractMessage('{"error":"Ollama says no"}')).toBe('Ollama says no');
    expect(extractMessage('{"error":{"message":"OpenAI says no","type":"x"}}')).toBe(
      'OpenAI says no',
    );
    expect(extractMessage('{"detail":"TGI says no"}')).toBe('TGI says no');
    expect(extractMessage('plain \u0007text')).toBe('plain text');
    expect(extractMessage('z'.repeat(1_000))).toHaveLength(300);
  });

  it('tells a timeout from an unreachable endpoint', () => {
    expect(connectionError(new Error('x'), true, 5_000)).toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
    expect(connectionError(new TypeError('fetch failed'), false, 0)).toMatchObject({
      code: 'UNREACHABLE',
      retryable: true,
    });
  });
});

// ── Providers ───────────────────────────────────────────────────────────────

const CONFIG: LlmConfig = {
  configured: true,
  provider: 'ollama',
  baseUrl: 'https://llm.test',
  apiKey: 'proxy-token',
  defaultModel: 'llama3.1:8b',
  allowedModels: [],
  defaultContextWindow: 8_192,
  maxContextWindow: 32_768,
  defaultMaxOutputTokens: 1_024,
  maxOutputTokens: 4_096,
  defaultTemperature: 0.3,
  firstTokenTimeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  maxDurationMs: 5_000,
  maxConcurrency: 2,
  queueTimeoutMs: 100,
  maxRetries: 0,
  maxResponseBytes: 64 * 1024,
  circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
  keepAlive: '30m',
  maxClassification: Classification.RESTRICTED,
  modelCacheTtlMs: 60_000,
};

const PARAMETERS: GenerationParameters = {
  temperature: 0.2,
  maxOutputTokens: 64,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  seed: 7,
  stop: ['###'],
};

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

function scriptedFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (url: string, init: RequestInit) => {
    calls.push({
      url,
      init,
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    });
    const next = responses.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new TypeError('fetch failed'));
  };
  return { calls, fetchImpl };
}

const streamed =
  (chunks: string[], headers: Record<string, string> = {}) =>
  () =>
    new Response(bodyOf(chunks), { status: 200, headers });

async function drain(stream: ProviderStream): Promise<ProviderEvent[]> {
  return collect(stream.events);
}

const REQUEST = {
  model: 'llama3.1:8b',
  messages: [
    { role: 'system' as const, content: 'Be brief.' },
    { role: 'user' as const, content: 'Hi' },
  ],
  parameters: PARAMETERS,
  contextWindow: 8_192,
};

describe('Ollama provider', () => {
  it('normalises model names the way Ollama reports them', () => {
    const provider = new OllamaProvider(CONFIG);
    expect(provider.normalizeModelName('llama3.1')).toBe('llama3.1:latest');
    expect(provider.normalizeModelName(' llama3.1:8b ')).toBe('llama3.1:8b');
    expect(provider.normalizeModelName('hf.co/org/model')).toBe('hf.co/org/model:latest');
    expect(provider.normalizeModelName('registry:5000/model')).toBe(
      'registry:5000/model:latest',
    );
  });

  it('always sends num_ctx and keep_alive, and authenticates to the proxy', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      streamed([
        '{"message":{"content":"Hel"},"done":false}\n',
        '{"message":{"content":"lo"},"done":false}\n{"message":{"content":""},"done":true,',
        '"done_reason":"stop","prompt_eval_count":21,"eval_count":2}\n',
      ]),
    ]);
    const provider = new OllamaProvider(CONFIG, fetchImpl);
    const events = await drain(await provider.open(REQUEST, new AbortController().signal));

    expect(calls[0].url).toBe('https://llm.test/api/chat');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer proxy-token',
    );
    expect(calls[0].body).toMatchObject({
      model: 'llama3.1:8b',
      stream: true,
      keep_alive: '30m',
      options: {
        num_ctx: 8_192,
        num_predict: 64,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
        seed: 7,
        stop: ['###'],
      },
    });
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'done', finishReason: 'stop', promptTokens: 21, completionTokens: 2 },
    ]);
  });

  it('turns an error line mid-stream into a failure', async () => {
    const { fetchImpl } = scriptedFetch([
      streamed([
        '{"message":{"content":"Hi"},"done":false}\n',
        '{"error":"CUDA out of memory"}\n',
      ]),
    ]);
    const stream = await new OllamaProvider(CONFIG, fetchImpl).open(
      REQUEST,
      new AbortController().signal,
    );
    const error = await failure(drain(stream));
    expect(error.code).toBe('SERVER_ERROR');
    expect(error.message).toContain('CUDA out of memory');
  });

  it('ends without a done event when the body stops early, for the gateway to catch', async () => {
    const { fetchImpl } = scriptedFetch([
      streamed(['{"message":{"content":"Hi"},"done":false}\n']),
    ]);
    const stream = await new OllamaProvider(CONFIG, fetchImpl).open(
      REQUEST,
      new AbortController().signal,
    );
    expect((await drain(stream)).map((event) => event.type)).toEqual(['delta']);
  });

  it('reports HTTP and connection failures as provider errors', async () => {
    const { fetchImpl } = scriptedFetch([
      () => new Response('{"error":"model \\"nope\\" not found"}', { status: 404 }),
    ]);
    const provider = new OllamaProvider(CONFIG, fetchImpl);
    expect((await failure(provider.open(REQUEST, new AbortController().signal))).code).toBe(
      'MODEL_NOT_FOUND',
    );
    expect((await failure(provider.open(REQUEST, new AbortController().signal))).code).toBe(
      'UNREACHABLE',
    );
  });

  it('passes the caller’s own abort through untouched', async () => {
    const controller = new AbortController();
    const abort = new Error('client left');
    controller.abort(abort);
    const provider = new OllamaProvider(CONFIG, () => Promise.reject(abort));
    await expect(provider.open(REQUEST, controller.signal)).rejects.toBe(abort);
  });

  it('lists models with their details and reads the context length', async () => {
    const { fetchImpl } = scriptedFetch([
      () =>
        Response.json({
          models: [
            {
              name: 'llama3.1',
              size: 4_700_000_000,
              details: {
                family: 'llama',
                parameter_size: '8B',
                quantization_level: 'Q4_K_M',
              },
            },
            { model: 'qwen2.5:7b' },
            { nonsense: true },
          ],
        }),
      () =>
        Response.json({
          model_info: { 'llama.context_length': 131_072, 'general.architecture': 'llama' },
        }),
    ]);
    const provider = new OllamaProvider(CONFIG, fetchImpl);
    const models = await provider.listModels();
    expect(models.map((model) => model.name)).toEqual(['llama3.1:latest', 'qwen2.5:7b']);
    expect(models[0]).toMatchObject({
      family: 'llama',
      parameterSize: '8B',
      quantization: 'Q4_K_M',
    });
    expect(await provider.describeModel('llama3.1:latest')).toEqual({
      contextLength: 131_072,
    });
  });

  it('reports an unreachable endpoint as not alive', async () => {
    expect(await new OllamaProvider(CONFIG, scriptedFetch([]).fetchImpl).ping()).toBe(
      false,
    );
  });
});

describe('OpenAI-compatible provider', () => {
  const config = {
    ...CONFIG,
    provider: 'openai' as const,
    baseUrl: 'https://api.example.com/v1',
  };

  it('sends only standard parameters and asks for usage', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      streamed([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    ]);
    const provider = new OpenAiCompatibleProvider(config, fetchImpl);
    const events = await drain(await provider.open(REQUEST, new AbortController().signal));

    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0].body).toMatchObject({
      model: 'llama3.1:8b',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      seed: 7,
      stop: ['###'],
    });
    expect(calls[0].body).not.toHaveProperty('top_k');
    expect(calls[0].body).not.toHaveProperty('repeat_penalty');
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'done', finishReason: 'stop', promptTokens: 30, completionTokens: 2 },
    ]);
  });

  it('accepts a finish reason without [DONE], but not a body that just stops', async () => {
    const { fetchImpl } = scriptedFetch([
      streamed([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"length"}]}\n\n',
      ]),
      streamed(['data: {"choices":[{"delta":{"content":"cut"}}]}\n\n']),
    ]);
    const provider = new OpenAiCompatibleProvider(config, fetchImpl);

    const complete = await drain(
      await provider.open(REQUEST, new AbortController().signal),
    );
    expect(complete.at(-1)).toEqual({
      type: 'done',
      finishReason: 'length',
      promptTokens: null,
      completionTokens: null,
    });

    const truncated = await provider.open(REQUEST, new AbortController().signal);
    expect((await failure(drain(truncated))).code).toBe('INVALID_RESPONSE');
  });

  it('turns an error event into a failure without echoing it', async () => {
    const { fetchImpl } = scriptedFetch([
      streamed(['data: {"error":{"message":"internal host gpu-7.corp failed"}}\n\n']),
    ]);
    const stream = await new OpenAiCompatibleProvider(config, fetchImpl).open(
      REQUEST,
      new AbortController().signal,
    );
    const error = await failure(drain(stream));
    expect(error.code).toBe('SERVER_ERROR');
    expect(error.message).not.toContain('gpu-7');
  });

  it('learns context lengths from the model list where the server reports them', async () => {
    const { fetchImpl } = scriptedFetch([
      () =>
        Response.json({
          data: [
            {
              id: 'meta-llama/Llama-3.1-8B-Instruct',
              owned_by: 'vllm',
              max_model_len: 16_384,
            },
            { id: 'mistral', context_length: 32_768 },
            { id: 'plain' },
          ],
        }),
    ]);
    const provider = new OpenAiCompatibleProvider(config, fetchImpl);
    const models = await provider.listModels();
    expect(models.map((model) => model.contextLength)).toEqual([16_384, 32_768, null]);
    expect(await provider.describeModel('mistral')).toEqual({ contextLength: 32_768 });
    expect(await provider.describeModel('unknown')).toEqual({ contextLength: null });
  });
});
