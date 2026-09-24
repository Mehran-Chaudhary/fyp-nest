import type { NerProviderKind } from '../../../config/pii.config';
import type { DetectedSpan } from '../domain/spans';

export interface NerRequest {
  organizationId: string;
  /** Prepared (canonicalised) texts. */
  texts: string[];
  entityTypes: string[];
  language: string;
  scoreThreshold: number;
  signal?: AbortSignal;
}

export interface NerResponse {
  /** UTF-16 offsets, one list per text. */
  spans: DetectedSpan[][];
  detector: string;
}

export type NerFailureReason =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CIRCUIT_OPEN'
  | 'INVALID_RESPONSE';

/**
 * The NER model could not be used. Whether that refuses the request or
 * degrades to pattern-only detection is the workspace policy's decision, not
 * the detector's.
 */
export class NerUnavailableError extends Error {
  constructor(
    readonly reason: NerFailureReason,
    message: string,
    /** Environment variables to set, when the cause is missing configuration. */
    readonly missingConfiguration: string[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'NerUnavailableError';
  }
}

/**
 * A statistical named-entity detector — the part of PII detection that finds
 * names, places and organisations, which no regular expression can.
 */
export interface NerDetector {
  readonly kind: NerProviderKind;
  readonly isConfigured: boolean;
  /** What to set to make this detector usable; empty when configured. */
  readonly missingConfiguration: string[];
  detect(request: NerRequest): Promise<NerResponse>;
  ping(): Promise<boolean>;
  readonly circuitState?: string;
}

export const NER_DETECTOR = Symbol('NER_DETECTOR');

/** Used when `PII_NER_PROVIDER=none`: every call reports "not configured". */
export class DisabledNerDetector implements NerDetector {
  readonly kind = 'none' as const;
  readonly isConfigured = false;
  readonly missingConfiguration = ['PII_NER_PROVIDER'];

  detect(): Promise<NerResponse> {
    return Promise.reject(
      new NerUnavailableError(
        'NOT_CONFIGURED',
        'No NER detector is configured (PII_NER_PROVIDER=none).',
        this.missingConfiguration,
      ),
    );
  }

  ping(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
