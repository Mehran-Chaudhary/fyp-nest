/**
 * Small helpers for talking to internal HTTP services with `fetch`.
 */

export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The response exceeded the ${limit} byte limit.`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Reads a response body as text, refusing more than `limit` bytes.
 *
 * `response.text()` buffers whatever arrives; a misbehaving peer returning a
 * gigabyte would take the process down with it.
 */
export async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(limit);
  }
  if (!response.body) return '';

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new ResponseTooLargeError(limit);
    }
    parts.push(value);
  }

  return Buffer.concat(parts).toString('utf8');
}

/** Parses `Retry-After` (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(date - Date.now(), 0);
}

/** True for statuses worth retrying: timeouts, throttling and server faults. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
