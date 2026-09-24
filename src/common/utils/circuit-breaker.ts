/**
 * A three-state circuit breaker.
 *
 * Wraps calls to a remote dependency — the Python AI service, the vector store —
 * and stops calling it once it has failed repeatedly. Without one, a dead
 * dependency costs every request its full timeout: thirty seconds of a held
 * connection, a held worker slot and a user staring at a spinner, multiplied by
 * every concurrent caller. With one, the first few requests pay that price and
 * the rest fail in microseconds with a clear "unavailable" until a probe shows
 * the dependency is back.
 *
 *     CLOSED ──(threshold consecutive failures)──▶ OPEN
 *       ▲                                            │ cooldown elapses
 *       └──(probe succeeds)── HALF_OPEN ◀────────────┘
 *                                │ probe fails
 *                                └──────────────────▶ OPEN
 *
 * Only failures the caller classifies as the dependency's fault count. A 422
 * from the AI service because one PDF is corrupt says nothing about the
 * service's health and must not open the circuit for everyone else's documents.
 *
 * State is per process. Each API and worker instance learns about an outage
 * independently, which is the conventional trade-off: a shared breaker in Redis
 * would add a network hop to every call to save a handful of failed ones.
 */

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /** Consecutive counted failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before admitting a probe. */
  cooldownMs: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(
    readonly circuit: string,
    readonly retryAfterMs: number,
  ) {
    super(`Circuit "${circuit}" is open; failing fast for another ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private currentState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (
      this.currentState === CircuitState.OPEN &&
      this.now() - this.openedAt >= this.options.cooldownMs
    ) {
      return CircuitState.HALF_OPEN;
    }
    return this.currentState;
  }

  /** Snapshot for health reporting. */
  describe(): { name: string; state: CircuitState; consecutiveFailures: number } {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Runs `operation` through the breaker.
   *
   * `countsAsFailure` decides whether a thrown error reflects on the
   * dependency's health. Errors it rejects are rethrown untouched and leave the
   * breaker's state as it was.
   */
  async execute<T>(
    operation: () => Promise<T>,
    countsAsFailure: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    const state = this.state;

    if (state === CircuitState.OPEN) {
      throw new CircuitOpenError(
        this.name,
        Math.max(this.options.cooldownMs - (this.now() - this.openedAt), 0),
      );
    }

    if (state === CircuitState.HALF_OPEN) {
      // Exactly one probe at a time. Letting every waiting caller through the
      // moment the cooldown ends would hit a recovering dependency with the
      // full backlog at once.
      if (this.probeInFlight) {
        throw new CircuitOpenError(this.name, this.options.cooldownMs);
      }
      this.probeInFlight = true;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      if (countsAsFailure(error)) {
        this.onFailure(state);
      } else if (state === CircuitState.HALF_OPEN) {
        // The dependency answered — just not happily about this input. That is
        // proof of life.
        this.onSuccess();
      }
      throw error;
    } finally {
      if (state === CircuitState.HALF_OPEN) this.probeInFlight = false;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.currentState = CircuitState.CLOSED;
  }

  private onFailure(stateAtCall: CircuitState): void {
    this.consecutiveFailures += 1;

    if (
      stateAtCall === CircuitState.HALF_OPEN ||
      this.consecutiveFailures >= this.options.failureThreshold
    ) {
      this.currentState = CircuitState.OPEN;
      this.openedAt = this.now();
    }
  }
}
