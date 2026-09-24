import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

/**
 * The PII redaction engine (proposal module 6.12).
 *
 * Detection runs in two layers. Structured identifiers — payment cards, IBANs,
 * national ids, emails, phone numbers, salaries, credentials — are found
 * in-process by validated pattern recognizers, which need no configuration.
 * Names and other free-text entities need a statistical NER model, which runs
 * in Python: either inside the platform's AI service (`ai-service`, the
 * default, HMAC-signed like every other AI call) or as a stock Microsoft
 * Presidio analyzer (`presidio`) on a private network.
 */
export type NerProviderKind = 'ai-service' | 'presidio' | 'none';

/**
 * What happens when a detector the policy relies on is unavailable.
 *
 * There is deliberately no "send it unmasked" option. Redaction can be
 * switched off only by an explicit, audited policy change — never as a side
 * effect of an outage.
 */
export type DetectorFailureMode = 'REFUSE' | 'DEGRADE_TO_PATTERNS';

export interface PiiConfig {
  nerProvider: NerProviderKind;
  presidio: {
    url: string;
    apiKey?: string;
    concurrency: number;
  };
  timeoutMs: number;
  /** Applied to a workspace until it saves a policy of its own. */
  defaults: {
    entityTypes: string[];
    onDetectorFailure: DetectorFailureMode;
    scoreThreshold: number;
    language: string;
  };
  /** Zero disables the NER result cache. */
  cacheTtlSeconds: number;
  circuitBreaker: {
    failureThreshold: number;
    cooldownMs: number;
  };
  /** Ceiling on text submitted to the analysis preview endpoint. */
  maxAnalyzeLength: number;
}

export const PII_CONFIG_KEY = 'pii';

export default registerAs(PII_CONFIG_KEY, (): PiiConfig => {
  return {
    nerProvider: (process.env.PII_NER_PROVIDER ?? 'ai-service') as NerProviderKind,
    presidio: {
      url: (process.env.PRESIDIO_ANALYZER_URL ?? '').replace(/\/+$/, ''),
      apiKey: process.env.PRESIDIO_API_KEY || undefined,
      concurrency: Number(process.env.PRESIDIO_CONCURRENCY),
    },
    timeoutMs: parseDuration(process.env.PII_TIMEOUT as string),
    defaults: {
      entityTypes: (process.env.PII_DEFAULT_ENTITIES as string)
        .split(',')
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean),
      onDetectorFailure: (process.env.PII_DEFAULT_ON_FAILURE ??
        'REFUSE') as DetectorFailureMode,
      scoreThreshold: Number(process.env.PII_SCORE_THRESHOLD),
      language: process.env.PII_LANGUAGE as string,
    },
    cacheTtlSeconds: Math.floor(
      parseDuration(process.env.PII_DETECTION_CACHE_TTL as string) / 1000,
    ),
    circuitBreaker: {
      failureThreshold: Number(process.env.PII_CIRCUIT_THRESHOLD),
      cooldownMs: parseDuration(process.env.PII_CIRCUIT_COOLDOWN as string),
    },
    maxAnalyzeLength: Number(process.env.PII_MAX_ANALYZE_LENGTH),
  };
});
