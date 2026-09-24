import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, hkdfSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CacheKeys } from '../../../common/constants/cache-keys.constants';
import { PII_CONFIG_KEY, type PiiConfig } from '../../../config/pii.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../../config/security.config';
import { RedisService } from '../../../shared/redis/redis.service';
import {
  maskingPolicyFor,
  nerTypesOf,
  policyFingerprint,
  type EffectivePiiPolicy,
} from '../domain/policy';
import { runRecognizers } from '../domain/recognizers';
import type { DetectedSpan } from '../domain/spans';
import {
  NER_DETECTOR,
  NerUnavailableError,
  type NerDetector,
  type NerFailureReason,
} from './ner-detector';

/** Bumped whenever the pattern layer changes behaviour; recorded with every result. */
export const PATTERN_LAYER_VERSION = 'patterns@1';

export interface DetectionRequest {
  organizationId: string;
  policy: EffectivePiiPolicy;
  /** Prepared (canonicalised) texts. */
  texts: string[];
  signal?: AbortSignal;
}

export interface DetectionOutcome {
  /** One list per text: pattern and NER detections together, unmerged. */
  spans: DetectedSpan[][];
  /** True when NER was needed, unavailable, and the policy chose to continue without it. */
  degraded: boolean;
  degradedReason: NerFailureReason | null;
  nerUsed: boolean;
  detectors: string[];
  cacheHits: number;
  timings: { patternMs: number; nerMs: number };
}

/**
 * NER was required by the policy, unavailable, and the policy refuses to
 * proceed without it (the default). Nothing is sent to the model.
 */
export class PiiDetectionUnavailableError extends Error {
  constructor(
    readonly reason: NerFailureReason,
    readonly detector: string,
    readonly entityTypes: string[],
    readonly missingConfiguration: string[],
    options?: { cause?: unknown },
  ) {
    super(
      `PII detection for ${entityTypes.join(', ')} is unavailable (${reason}); the policy refuses to continue without it.`,
      options,
    );
    this.name = 'PiiDetectionUnavailableError';
  }
}

type CachedSpan = [type: string, start: number, end: number, score: number];

/**
 * Detection, stage one of the three-stage pipeline.
 *
 * Runs the in-process pattern recognizers over every text, then asks the NER
 * model for the types only it can find — and applies the workspace's failure
 * policy when it cannot be reached.
 *
 * ## The NER cache
 *
 * Retrieved passages recur: the same handbook chunk answers many questions,
 * and each conversation turn re-sends its history. Their NER results are
 * cached in Redis under a keyed digest of (workspace, policy, text). The cached
 * value is offsets and entity types only, and the key cannot be computed
 * without the platform secret, so a Redis compromise yields "some text in some
 * workspace has a PERSON at offsets 10–20" — nothing more. The workspace is
 * part of the key so that one tenant's cache can never answer, or time, another
 * tenant's lookup.
 */
@Injectable()
export class PiiDetectionService {
  private readonly logger = new Logger(PiiDetectionService.name);
  private readonly config: PiiConfig;
  private readonly cacheKey: Buffer;

  constructor(
    @Inject(NER_DETECTOR) private readonly ner: NerDetector,
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<PiiConfig>(PII_CONFIG_KEY);
    const security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    this.cacheKey = Buffer.from(
      hkdfSync(
        'sha256',
        security.encryptionKey,
        'daiap-pii-cache',
        'daiap/pii-detection-cache/v1',
        32,
      ),
    );
  }

  get nerDetector(): NerDetector {
    return this.ner;
  }

  async detect(request: DetectionRequest): Promise<DetectionOutcome> {
    const masking = maskingPolicyFor(request.policy);

    // ── Patterns: in-process, always available ────────────────────────────
    const patternStarted = performance.now();
    const spans: DetectedSpan[][] = request.texts.map((text) =>
      runRecognizers(masking.recognizers, text, masking.enabledTypes).map((match) => ({
        entityType: match.entityType,
        start: match.start,
        end: match.end,
        score: match.score,
        source:
          match.recognizer === 'deny-list' ? ('custom' as const) : ('pattern' as const),
        recognizer: match.recognizer,
      })),
    );
    const patternMs = elapsed(patternStarted);

    const outcome: DetectionOutcome = {
      spans,
      degraded: false,
      degradedReason: null,
      nerUsed: false,
      detectors: [PATTERN_LAYER_VERSION],
      cacheHits: 0,
      timings: { patternMs, nerMs: 0 },
    };

    // ── NER: only for the types patterns cannot find ──────────────────────
    const nerTypes = nerTypesOf(request.policy);
    if (nerTypes.length === 0 || request.texts.every((text) => text.length === 0)) {
      return outcome;
    }

    const nerStarted = performance.now();
    try {
      const { results, detector, cacheHits } = await this.runNer(request, nerTypes);
      results.forEach((list, index) => spans[index].push(...list));
      outcome.nerUsed = true;
      outcome.cacheHits = cacheHits;
      if (detector) outcome.detectors.push(detector);
    } catch (error) {
      // The caller left: a cancellation, not a detector outage to audit or degrade around.
      if (request.signal?.aborted) throw request.signal.reason ?? error;
      if (!(error instanceof NerUnavailableError)) throw error;

      if (request.policy.onDetectorFailure !== 'DEGRADE_TO_PATTERNS') {
        throw new PiiDetectionUnavailableError(
          error.reason,
          this.ner.kind,
          nerTypes,
          error.missingConfiguration,
          { cause: error },
        );
      }

      this.logger.warn(
        `NER unavailable (${error.reason}) for workspace ${request.organizationId}; ` +
          `continuing with pattern detection only, as its policy allows.`,
      );
      outcome.degraded = true;
      outcome.degradedReason = error.reason;
    } finally {
      outcome.timings.nerMs = elapsed(nerStarted);
    }

    return outcome;
  }

  /** NER over every text, served from the cache where possible. */
  private async runNer(
    request: DetectionRequest,
    entityTypes: string[],
  ): Promise<{ results: DetectedSpan[][]; detector: string | null; cacheHits: number }> {
    const results: DetectedSpan[][] = request.texts.map(() => []);
    const policyKey = policyFingerprint(request.policy);
    const keys = request.texts.map((text) =>
      this.fingerprint(request.organizationId, policyKey, text),
    );

    const misses: number[] = [];
    let cacheHits = 0;

    if (this.config.cacheTtlSeconds > 0) {
      const cached = await Promise.all(
        keys.map((key, index) =>
          request.texts[index].length === 0
            ? Promise.resolve([] as CachedSpan[])
            : this.redis.getJson<CachedSpan[]>(CacheKeys.piiDetection(key)),
        ),
      );
      cached.forEach((entry, index) => {
        // Anything malformed — a truncated write, a stale format — is a miss.
        if (entry === null || !isValidCacheEntry(entry, request.texts[index].length)) {
          misses.push(index);
          return;
        }
        if (request.texts[index].length > 0) cacheHits += 1;
        results[index] = entry.map(([type, start, end, score]) => ({
          entityType: type,
          start,
          end,
          score,
          source: 'ner',
          recognizer: 'ner-cache',
        }));
      });
    } else {
      request.texts.forEach((_text, index) => misses.push(index));
    }

    if (misses.length === 0) return { results, detector: null, cacheHits };

    const response = await this.ner.detect({
      organizationId: request.organizationId,
      texts: misses.map((index) => request.texts[index]),
      entityTypes,
      language: request.policy.language,
      scoreThreshold: request.policy.scoreThreshold,
      signal: request.signal,
    });

    await Promise.all(
      misses.map((index, position) => {
        const found = response.spans[position] ?? [];
        results[index] = found;
        if (this.config.cacheTtlSeconds <= 0 || request.texts[index].length === 0) {
          return Promise.resolve();
        }
        const compact: CachedSpan[] = found.map((span) => [
          span.entityType,
          span.start,
          span.end,
          Math.round(span.score * 1000) / 1000,
        ]);
        return this.redis.setJson(
          CacheKeys.piiDetection(keys[index]),
          compact,
          this.config.cacheTtlSeconds,
        );
      }),
    );

    return { results, detector: response.detector, cacheHits };
  }

  private fingerprint(organizationId: string, policyKey: string, text: string): string {
    return createHmac('sha256', this.cacheKey)
      .update(`${organizationId}\n${this.ner.kind}\n${policyKey}\n`)
      .update(text, 'utf8')
      .digest('base64url');
  }
}

function isValidCacheEntry(entry: unknown, textLength: number): entry is CachedSpan[] {
  return (
    Array.isArray(entry) &&
    entry.every(
      (span: unknown) =>
        Array.isArray(span) &&
        span.length === 4 &&
        typeof span[0] === 'string' &&
        Number.isInteger(span[1]) &&
        Number.isInteger(span[2]) &&
        (span[1] as number) >= 0 &&
        (span[1] as number) < (span[2] as number) &&
        (span[2] as number) <= textLength &&
        typeof span[3] === 'number',
    )
  );
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}
