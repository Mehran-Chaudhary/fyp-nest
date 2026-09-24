import { CircuitBreaker, CircuitOpenError } from '../../../common/utils/circuit-breaker';
import {
  isRetryableStatus,
  readBoundedText,
  ResponseTooLargeError,
} from '../../../common/utils/http.util';
import { withRetry } from '../../../common/utils/retry.util';
import { Semaphore } from '../../../common/utils/semaphore';
import type { PiiConfig } from '../../../config/pii.config';
import { validatePiiAnalyzeResponse } from '../../../shared/ai-service/response-validation';
import { AiServiceError } from '../../../shared/ai-service/ai-service.types';
import type { DetectedSpan } from '../domain/spans';
import {
  NerUnavailableError,
  type NerDetector,
  type NerRequest,
  type NerResponse,
} from './ner-detector';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class TransientPresidioError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientPresidioError';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * NER through a stock Microsoft Presidio analyzer (`POST /analyze`).
 *
 * For teams that deploy Microsoft's container image as-is. That image has **no
 * authentication**, so it must sit on a private network (Railway private
 * networking, a Render private service, Cloud Run internal ingress) or behind
 * an authenticating proxy, whose token goes in `PRESIDIO_API_KEY`. Everything
 * sent to it is plaintext about to be masked — exposing it publicly would
 * publish that plaintext.
 *
 * The analyzer takes one text per request, so texts are sent concurrently up
 * to `PRESIDIO_CONCURRENCY`. Offsets come back as Python code points and are
 * converted exactly as for the AI service.
 */
export class PresidioNerDetector implements NerDetector {
  readonly kind = 'presidio' as const;
  private readonly breaker: CircuitBreaker;
  private readonly limiter: Semaphore;

  constructor(
    private readonly config: PiiConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.breaker = new CircuitBreaker('presidio', config.circuitBreaker);
    this.limiter = new Semaphore(config.presidio.concurrency);
  }

  get isConfigured(): boolean {
    return this.config.presidio.url.length > 0;
  }

  get missingConfiguration(): string[] {
    return this.isConfigured ? [] : ['PRESIDIO_ANALYZER_URL'];
  }

  get circuitState(): string {
    return this.breaker.state;
  }

  async detect(request: NerRequest): Promise<NerResponse> {
    if (!this.isConfigured) {
      throw new NerUnavailableError(
        'NOT_CONFIGURED',
        'Name detection needs a Presidio analyzer, which is not configured.',
        this.missingConfiguration,
      );
    }

    try {
      const spans = await Promise.all(
        request.texts.map((text) =>
          text.length === 0 ? Promise.resolve([]) : this.analyzeOne(text, request),
        ),
      );
      return { spans, detector: 'presidio-analyzer' };
    } catch (error) {
      if (error instanceof NerUnavailableError) throw error;
      if (error instanceof CircuitOpenError) {
        throw new NerUnavailableError('CIRCUIT_OPEN', error.message, [], { cause: error });
      }
      if (error instanceof AiServiceError) {
        throw new NerUnavailableError('INVALID_RESPONSE', error.message, [], {
          cause: error,
        });
      }
      throw new NerUnavailableError('UNAVAILABLE', (error as Error).message, [], {
        cause: error,
      });
    }
  }

  async ping(): Promise<boolean> {
    if (!this.isConfigured) return false;
    try {
      const response = await this.fetchImpl(`${this.config.presidio.url}/health`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async analyzeOne(text: string, request: NerRequest): Promise<DetectedSpan[]> {
    const release = await this.limiter.acquire({
      timeoutMs: this.config.timeoutMs,
      signal: request.signal,
    });

    try {
      return await this.breaker.execute(
        () =>
          withRetry(() => this.post(text, request), {
            retries: 1,
            baseDelayMs: 200,
            maxDelayMs: 1_000,
            signal: request.signal,
            shouldRetry: (error) => error instanceof TransientPresidioError,
          }),
        (error) => error instanceof TransientPresidioError,
      );
    } finally {
      release();
    }
  }

  private async post(text: string, request: NerRequest): Promise<DetectedSpan[]> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.presidio.url}/analyze`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          language: request.language,
          entities: request.entityTypes,
          score_threshold: request.scoreThreshold,
        }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new TransientPresidioError(
        timeout.aborted
          ? `Presidio did not respond within ${this.config.timeoutMs}ms.`
          : `Presidio could not be reached: ${(error as Error).message}.`,
        { cause: error },
      );
    }

    let body: string;
    try {
      body = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        throw new NerUnavailableError('INVALID_RESPONSE', error.message);
      }
      throw new TransientPresidioError((error as Error).message, { cause: error });
    }

    if (!response.ok) {
      const message = `Presidio returned HTTP ${response.status}.`;
      if (isRetryableStatus(response.status)) throw new TransientPresidioError(message);
      throw new NerUnavailableError('UNAVAILABLE', message);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new NerUnavailableError('INVALID_RESPONSE', 'Presidio returned invalid JSON.');
    }

    const [spans] = validatePiiAnalyzeResponse(
      { results: [parsed] },
      { texts: [text] },
    ).results;
    return spans.map((span) => ({
      ...span,
      source: 'ner',
      recognizer: 'presidio-analyzer',
    }));
  }

  private headers(): Record<string, string> {
    return this.config.presidio.apiKey
      ? {
          authorization: `Bearer ${this.config.presidio.apiKey}`,
          accept: 'application/json',
        }
      : { accept: 'application/json' };
  }
}
