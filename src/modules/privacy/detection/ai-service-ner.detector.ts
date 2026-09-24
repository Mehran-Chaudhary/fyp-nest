import { AiServiceClient } from '../../../shared/ai-service/ai-service.client';
import { AiServiceError } from '../../../shared/ai-service/ai-service.types';
import type { DetectedSpan } from '../domain/spans';
import {
  NerUnavailableError,
  type NerDetector,
  type NerRequest,
  type NerResponse,
} from './ner-detector';

/** Keeps each request comfortably inside the AI service's body and time limits. */
const MAX_TEXTS_PER_BATCH = 32;
const MAX_CHARACTERS_PER_BATCH = 120_000;

/**
 * NER through the platform's own Python AI service (`POST /v1/pii/analyze`,
 * contract v1). The recommended setup: the request is HMAC-signed like every
 * other AI call, rides the same circuit breaker, and needs no extra service.
 */
export class AiServiceNerDetector implements NerDetector {
  readonly kind = 'ai-service' as const;

  constructor(
    private readonly aiService: AiServiceClient,
    private readonly timeoutMs: number,
  ) {}

  get isConfigured(): boolean {
    return this.aiService.isConfigured;
  }

  get missingConfiguration(): string[] {
    return this.isConfigured ? [] : ['AI_SERVICE_URL'];
  }

  get circuitState(): string {
    return this.aiService.circuit.state;
  }

  async detect(request: NerRequest): Promise<NerResponse> {
    if (!this.isConfigured) {
      throw new NerUnavailableError(
        'NOT_CONFIGURED',
        'Name detection needs the AI service, which is not configured.',
        this.missingConfiguration,
      );
    }

    const spans: DetectedSpan[][] = request.texts.map(() => []);
    let detector = 'unknown';

    for (const batch of batches(request.texts)) {
      try {
        const result = await this.aiService.analyzePii({
          texts: batch.map((index) => request.texts[index]),
          entities: request.entityTypes,
          language: request.language,
          scoreThreshold: request.scoreThreshold,
          organizationId: request.organizationId,
          timeoutMs: this.timeoutMs,
          signal: request.signal,
        });
        detector = result.detector;

        result.results.forEach((list, position) => {
          spans[batch[position]] = list.map((span) => ({
            ...span,
            source: 'ner' as const,
            recognizer: result.detector,
          }));
        });
      } catch (error) {
        throw toNerError(error);
      }
    }

    return { spans, detector };
  }

  async ping(): Promise<boolean> {
    if (!this.isConfigured) return false;
    try {
      return (await this.aiService.health()).pii.available;
    } catch {
      return false;
    }
  }
}

/** Groups non-empty texts into batches; empty texts need no detection. */
function* batches(texts: readonly string[]): Generator<number[]> {
  let current: number[] = [];
  let characters = 0;

  for (let index = 0; index < texts.length; index += 1) {
    const length = texts[index].length;
    if (length === 0) continue;

    if (
      current.length > 0 &&
      (current.length >= MAX_TEXTS_PER_BATCH ||
        characters + length > MAX_CHARACTERS_PER_BATCH)
    ) {
      yield current;
      current = [];
      characters = 0;
    }
    current.push(index);
    characters += length;
  }

  if (current.length > 0) yield current;
}

function toNerError(error: unknown): unknown {
  if (!(error instanceof AiServiceError)) return error;

  switch (error.code) {
    case 'AI_SERVICE_NOT_CONFIGURED':
      return new NerUnavailableError('NOT_CONFIGURED', error.message, ['AI_SERVICE_URL'], {
        cause: error,
      });
    case 'AI_SERVICE_CIRCUIT_OPEN':
      return new NerUnavailableError('CIRCUIT_OPEN', error.message, [], { cause: error });
    case 'AI_SERVICE_TIMEOUT':
      return new NerUnavailableError('TIMEOUT', error.message, [], { cause: error });
    case 'AI_CONTRACT_VIOLATION':
      return new NerUnavailableError('INVALID_RESPONSE', error.message, [], {
        cause: error,
      });
    default:
      // A 404 means an AI service built before phase 3: reachable, but without
      // the endpoint. Worth its own message, since the fix is a deploy.
      if (error.status === 404) {
        return new NerUnavailableError(
          'UNSUPPORTED',
          'The AI service does not implement POST /v1/pii/analyze yet (docs/contracts/ai-service-v1.md).',
          [],
          { cause: error },
        );
      }
      return new NerUnavailableError('UNAVAILABLE', error.message, [], { cause: error });
  }
}
