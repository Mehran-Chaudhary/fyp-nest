import { LlmProviderError } from './provider.types';

/**
 * Line-oriented decoding of a streamed HTTP body.
 *
 * A network chunk boundary can fall anywhere — inside a JSON object, inside a
 * multi-byte UTF-8 character — so bytes are decoded with a streaming
 * `TextDecoder` and lines are cut only at `\n`. The total size is bounded: a
 * model looping on a pathological prompt, or a misbehaving proxy, cannot make
 * the process buffer without limit.
 */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > maxBytes) {
        throw new LlmProviderError(
          'TOO_LARGE',
          `The model response exceeded ${maxBytes} bytes.`,
          false,
        );
      }

      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        yield pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }

    pending += decoder.decode();
    if (pending.length > 0) yield pending.replace(/\r$/, '');
  } finally {
    // Stops the download if the consumer stopped early (cancellation, error).
    await reader.cancel().catch(() => undefined);
  }
}

/** Newline-delimited JSON (Ollama): one object per non-empty line. */
export async function* decodeNdjson(lines: AsyncIterable<string>): AsyncGenerator<unknown> {
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      yield JSON.parse(line) as unknown;
    } catch (error) {
      throw new LlmProviderError(
        'INVALID_RESPONSE',
        'The model endpoint sent a line that is not valid JSON.',
        false,
        undefined,
        undefined,
        { cause: error },
      );
    }
  }
}

/**
 * Server-Sent Events (OpenAI-compatible servers): yields each event's `data`,
 * with multi-line data joined per the SSE specification. Comments and other
 * fields are ignored; `[DONE]` is passed through for the caller to recognise.
 */
export async function* decodeSse(lines: AsyncIterable<string>): AsyncGenerator<string> {
  let data: string[] = [];

  for await (const line of lines) {
    if (line.length === 0) {
      if (data.length > 0) {
        yield data.join('\n');
        data = [];
      }
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (data.length > 0) yield data.join('\n');
}
