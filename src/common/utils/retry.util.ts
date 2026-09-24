/**
 * Retry with exponential backoff and full jitter.
 *
 * "Full jitter" — sleeping a uniformly random time between zero and the
 * exponential ceiling — rather than a fixed exponential schedule. When a shared
 * dependency blips, every caller fails at the same moment; a deterministic
 * schedule then has them all retry at the same moment too, and the recovering
 * service is knocked over again by the synchronised wave. Randomising spreads
 * the retries out.
 */

export interface RetryOptions {
  /** Retries after the first attempt. `2` means up to three attempts in total. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Whether a given failure is worth retrying. Defaults to always. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** A server-mandated delay (e.g. `Retry-After`) that overrides the backoff. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** Aborts the wait between attempts. */
  signal?: AbortSignal;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const exhausted = attempt >= options.retries;
      const retryable = options.shouldRetry ? options.shouldRetry(error, attempt) : true;

      if (exhausted || !retryable) throw error;

      const mandated = options.retryAfterMs?.(error);
      const delay =
        mandated !== undefined
          ? Math.min(mandated, options.maxDelayMs)
          : backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs, random);

      await wait(delay, options.signal);
    }
  }
}
