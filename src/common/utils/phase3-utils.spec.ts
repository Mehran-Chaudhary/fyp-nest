import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { ErrorCode } from '../enums/error-code.enum';
import { AppException } from '../exceptions/app.exception';
import { HttpStatus } from '@nestjs/common';
import {
  isRetryableStatus,
  parseRetryAfter,
  readBoundedText,
  ResponseTooLargeError,
} from './http.util';
import { sleep } from './retry.util';
import { Semaphore, SemaphoreFullError, SemaphoreTimeoutError } from './semaphore';
import { runAsEventStream } from './sse-stream';
import { SseWriter } from './sse-writer';
import { canonicalizeText, codePointLength, codePointOffsetMapper } from './unicode.util';

/**
 * Infrastructure added for inference: the bulkhead in front of the model, the
 * Server-Sent Events transport, and the Unicode handling the PII engine
 * depends on.
 */

describe('semaphore', () => {
  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it('grants up to its capacity at once', async () => {
    const semaphore = new Semaphore(2);
    await semaphore.acquire({ timeoutMs: 10 });
    await semaphore.acquire({ timeoutMs: 10 });
    expect(semaphore.inUse).toBe(2);
    await expect(semaphore.acquire({ timeoutMs: 10 })).rejects.toBeInstanceOf(
      SemaphoreTimeoutError,
    );
    expect(semaphore.waiting).toBe(0);
  });

  it('serves waiters first come, first served, and newcomers cannot overtake', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire({ timeoutMs: 10 });
    const order: string[] = [];
    const a = semaphore.acquire({ timeoutMs: 1_000 }).then((next) => {
      order.push('a');
      return next;
    });
    const b = semaphore.acquire({ timeoutMs: 1_000 }).then((next) => {
      order.push('b');
      return next;
    });

    release();
    const late = semaphore.acquire({ timeoutMs: 1_000 }).then((next) => {
      order.push('late');
      return next;
    });
    (await a)();
    (await b)();
    (await late)();
    expect(order).toEqual(['a', 'b', 'late']);
    expect(semaphore.inUse).toBe(0);
  });

  it('refuses at once when the queue is full', async () => {
    const semaphore = new Semaphore(1, 1);
    await semaphore.acquire({ timeoutMs: 10 });
    const queued = semaphore.acquire({ timeoutMs: 50 });
    await expect(semaphore.acquire({ timeoutMs: 50 })).rejects.toBeInstanceOf(
      SemaphoreFullError,
    );
    await expect(queued).rejects.toBeInstanceOf(SemaphoreTimeoutError);
  });

  it('abandons the wait when the caller aborts', async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire({ timeoutMs: 10 });
    const controller = new AbortController();
    const reason = new Error('client left');
    const waiting = semaphore.acquire({ timeoutMs: 1_000, signal: controller.signal });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(semaphore.waiting).toBe(0);
    await expect(
      semaphore.acquire({ timeoutMs: 10, signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it('returns one permit however many times a release is called', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire({ timeoutMs: 10 });
    release();
    release();
    await semaphore.acquire({ timeoutMs: 10 });
    await expect(semaphore.acquire({ timeoutMs: 10 })).rejects.toBeInstanceOf(
      SemaphoreTimeoutError,
    );
  });
});

/** Just enough of an Express response for the SSE transport. */
class FakeResponse extends EventEmitter {
  statusCode = 0;
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  headersSent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders(): void {
    this.headersSent = true;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
    this.emit('close');
  }
  /** The client going away. */
  disconnect(): void {
    this.destroyed = true;
    this.emit('close');
  }

  get body(): string {
    return this.chunks.join('');
  }

  events(): Array<{ event: string; data: unknown }> {
    return this.body
      .split('\n\n')
      .filter((block) => block.includes('event: '))
      .map((block) => {
        const lines = block.split('\n');
        const data = lines.filter((line) => line.startsWith('data: '));
        expect(data).toHaveLength(1);
        return {
          event: (lines.find((line) => line.startsWith('event: ')) as string).slice(7),
          data: JSON.parse(data[0].slice(6)) as unknown,
        };
      });
  }
}

const asResponse = (fake: FakeResponse) => fake as unknown as Response;

describe('server-sent events', () => {
  it('streams through proxies and compression, with one data line per event', async () => {
    const response = new FakeResponse();
    await runAsEventStream(
      asResponse(response),
      (channel) => {
        channel.open('meta', { conversationId: 'c1' });
        channel.send('delta', { text: 'line one\n\nevent: done\ndata: {"forged":true}' });
        return Promise.resolve({ answer: 42 });
      },
      (result) => result,
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-transform');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.body.startsWith('retry: 5000\n\n')).toBe(true);
    expect(response.events()).toEqual([
      { event: 'meta', data: { conversationId: 'c1' } },
      { event: 'delta', data: { text: 'line one\n\nevent: done\ndata: {"forged":true}' } },
      { event: 'done', data: { answer: 42 } },
    ]);
    expect(response.body).toMatch(/id: 1\n[\s\S]*id: 2\n[\s\S]*id: 3\n/);
    expect(response.writableEnded).toBe(true);
  });

  it('leaves a failure before the stream opens to the ordinary error handler', async () => {
    const response = new FakeResponse();
    const refusal = new AppException(ErrorCode.LLM_BUSY, HttpStatus.SERVICE_UNAVAILABLE);
    await expect(
      runAsEventStream(
        asResponse(response),
        () => Promise.reject(refusal),
        () => null,
      ),
    ).rejects.toBe(refusal);
    expect(response.statusCode).toBe(0);
    expect(response.chunks).toEqual([]);
  });

  it('reports a failure after the stream opened as an error event, without internals', async () => {
    const coded = new FakeResponse();
    await runAsEventStream(
      asResponse(coded),
      (channel) => {
        channel.open('meta', {});
        return Promise.reject(
          new AppException(ErrorCode.LLM_TIMEOUT, HttpStatus.GATEWAY_TIMEOUT),
        );
      },
      () => null,
    );
    expect(coded.events().at(-1)).toMatchObject({
      event: 'error',
      data: { code: ErrorCode.LLM_TIMEOUT },
    });
    expect(coded.writableEnded).toBe(true);

    const unexpected = new FakeResponse();
    await runAsEventStream(
      asResponse(unexpected),
      (channel) => {
        channel.open('meta', {});
        return Promise.reject(new Error('connection to 10.0.0.7 refused'));
      },
      () => null,
    );
    const last = unexpected.events().at(-1) as { data: { code: string; message: string } };
    expect(last.data.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
    expect(unexpected.body).not.toContain('10.0.0.7');
  });

  it('aborts the operation when the client disconnects, and writes nothing more', async () => {
    const response = new FakeResponse();
    let aborted = false;
    await runAsEventStream(
      asResponse(response),
      async (channel, signal) => {
        channel.open('meta', {});
        response.disconnect();
        aborted = signal.aborted;
        await sleep(1_000, signal);
      },
      () => null,
    );
    expect(aborted).toBe(true);
    expect(response.events().map((event) => event.event)).toEqual(['meta']);
  });

  it('sends heartbeats while idle, and stops them at the end', async () => {
    const response = new FakeResponse();
    const writer = new SseWriter(asResponse(response), 10);
    writer.open();
    await sleep(45);
    const beats = response.chunks.filter((chunk) => chunk === ': keep-alive\n\n').length;
    expect(beats).toBeGreaterThanOrEqual(2);
    writer.end();
    const after = response.chunks.length;
    await sleep(30);
    expect(response.chunks.length).toBe(after);
    writer.send('late', {});
    expect(response.chunks.length).toBe(after);
  });
});

describe('HTTP helpers', () => {
  const streamed = (text: string, headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
      { headers },
    );

  it('reads a body within the limit and refuses one beyond it', async () => {
    expect(await readBoundedText(streamed('hello'), 10)).toBe('hello');
    await expect(readBoundedText(streamed('x'.repeat(11)), 10)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    await expect(
      readBoundedText(streamed('small', { 'content-length': '999999' }), 10),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('parses Retry-After in seconds or as a date', () => {
    expect(parseRetryAfter('7')).toBe(7_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
    const future = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString()) as number;
    expect(future).toBeGreaterThan(55_000);
    expect(future).toBeLessThanOrEqual(60_000);
  });

  it('retries only timeouts, throttling and server faults', () => {
    expect([408, 425, 429, 500, 502, 503].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isRetryableStatus)).toBe(false);
  });
});

describe('Unicode canonicalisation', () => {
  const fullWidth = (digits: string) =>
    digits.replace(/[0-9]/g, (digit) => String.fromCodePoint(0xff10 + Number(digit)));
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
  const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
  const LINE_SEPARATOR = String.fromCodePoint(0x2028);

  it('folds look-alike digits and removes invisible characters', () => {
    expect(canonicalizeText(fullWidth('4111 1111 1111 1111'))).toBe('4111 1111 1111 1111');
    expect(canonicalizeText(`4111${ZERO_WIDTH_SPACE}1111`)).toBe('41111111');
    expect(canonicalizeText(`Ay${SOFT_HYPHEN}esha`)).toBe('Ayesha');
    expect(canonicalizeText(`abc${RIGHT_TO_LEFT_OVERRIDE}def`)).toBe('abcdef');
  });

  it('normalises every kind of line break to \\n', () => {
    expect(canonicalizeText(`a\r\nb\rc${LINE_SEPARATOR}d`)).toBe('a\nb\nc\nd');
  });

  it('maps Python code-point offsets to JavaScript string offsets', () => {
    const text = 'Hi 😀 Ayesha';
    const toUtf16 = codePointOffsetMapper(text);
    // Python: "Ayesha" starts at code point 5; in UTF-16 the emoji takes two units.
    expect(text.slice(toUtf16(5), toUtf16(11))).toBe('Ayesha');
    expect(codePointLength(text)).toBe(11);
    expect(toUtf16(-3)).toBe(0);
    expect(toUtf16(999)).toBe(text.length);
  });

  it('is the identity on text without astral characters', () => {
    const toUtf16 = codePointOffsetMapper('plain text');
    expect([0, 5, 10, 11].map(toUtf16)).toEqual([0, 5, 10, 10]);
  });
});
