/**
 * A counting semaphore with a bounded, cancellable wait: the bulkhead in front
 * of the language model.
 *
 * A GPU serves a handful of generations at once. Sending it more does not make
 * anything faster — every answer slows down and the first-token timeouts start
 * firing together. The gateway therefore admits at most `capacity` concurrent
 * generations per process and makes the rest wait, briefly and in order. A
 * request that cannot get a slot within its timeout is refused with a clear
 * "busy, retry shortly" instead of joining an unbounded queue.
 *
 * Waiters are served first come, first served. A permit is handed directly to
 * the next waiter on release, so a burst of new arrivals cannot overtake
 * requests that have been waiting.
 */

export class SemaphoreTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`No capacity became available within ${waitedMs}ms.`);
    this.name = 'SemaphoreTimeoutError';
  }
}

export class SemaphoreFullError extends Error {
  constructor(readonly queueLength: number) {
    super(`The wait queue is full (${queueLength} waiting).`);
    this.name = 'SemaphoreFullError';
  }
}

interface Waiter {
  grant: (release: () => void) => void;
  reject: (error: Error) => void;
}

export interface AcquireOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export class Semaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly capacity: number,
    /** Waiters beyond this are refused at once rather than queued. */
    private readonly maxQueue = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Semaphore capacity must be a positive integer, got ${capacity}.`);
    }
    this.available = capacity;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Resolves with a release function once a permit is held.
   *
   * The release function is idempotent: calling it twice returns one permit,
   * not two, so a `finally` that races an error handler cannot inflate the
   * capacity.
   */
  acquire(options: AcquireOptions): Promise<() => void> {
    if (options.signal?.aborted) {
      return Promise.reject(abortReason(options.signal));
    }

    if (this.available > 0 && this.waiters.length === 0) {
      this.available -= 1;
      return Promise.resolve(this.releaser());
    }

    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new SemaphoreFullError(this.waiters.length));
    }

    return new Promise<() => void>((resolve, reject) => {
      const startedAt = Date.now();
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
      };

      const waiter: Waiter = {
        grant: (release) => {
          if (settled) {
            release();
            return;
          }
          settled = true;
          cleanup();
          resolve(release);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };

      const timer = setTimeout(
        () => waiter.reject(new SemaphoreTimeoutError(Date.now() - startedAt)),
        options.timeoutMs,
      );
      const onAbort = () => waiter.reject(abortReason(options.signal as AbortSignal));
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handOff();
    };
  }

  private handOff(): void {
    const next = this.waiters.shift();
    if (next) {
      // The permit passes straight to the next waiter; `available` never
      // rises, so a newcomer cannot slip in between.
      next.grant(this.releaser());
      return;
    }
    this.available += 1;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}
