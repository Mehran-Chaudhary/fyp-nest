import { HttpStatus, Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { AuditService } from '../audit/audit.service';
import {
  MaskingSession,
  prepareText,
  type MaskedSegment,
  type RedactionSummary,
} from './domain/masking-session';
import { maskingPolicyFor, type EffectivePiiPolicy } from './domain/policy';
import {
  PiiDetectionService,
  PiiDetectionUnavailableError,
  type DetectionOutcome,
} from './detection/pii-detection.service';
import { PiiPolicyService } from './pii-policy.service';

export interface RedactionSegment {
  id: string;
  text: string;
}

export interface RedactionTimings {
  patternMs: number;
  nerMs: number;
  maskingMs: number;
  totalMs: number;
}

/** The outcome of masking a set of segments in one session. */
export interface RedactionOutcome {
  /** False when the workspace has switched redaction off; texts pass through unchanged. */
  enabled: boolean;
  /** Owns the reverse mapping. The caller must `destroy()` it when done. */
  session: MaskingSession | null;
  segments: MaskedSegment[];
  summary: RedactionSummary | null;
  degraded: boolean;
  detectors: string[];
  cacheHits: number;
  timings: RedactionTimings;
  policy: EffectivePiiPolicy;
}

export interface RedactionRequest {
  organizationId: string;
  segments: readonly RedactionSegment[];
  /** Reuse a policy already loaded for this request. */
  policy?: EffectivePiiPolicy;
  /** Recorded if detection fails, e.g. `agent-turn`, `direct-chat`, `supervision`. */
  purpose: string;
  signal?: AbortSignal;
}

/**
 * The PII engine's front door: detect, then mask, in one call.
 *
 * Every path that sends text to a model goes through here — agent turns, direct
 * gateway calls — as does every path that shows one person's data to another
 * (supervised conversation reads). The session it returns carries the reverse
 * mapping for exactly as long as the caller needs it.
 */
@Injectable()
export class RedactionService {
  constructor(
    private readonly policies: PiiPolicyService,
    private readonly detection: PiiDetectionService,
    private readonly auditService: AuditService,
  ) {}

  policyFor(organizationId: string): Promise<EffectivePiiPolicy> {
    return this.policies.getEffective(organizationId);
  }

  /**
   * Detects and masks `segments` in one session.
   *
   * Fails closed: when the policy needs the NER detector and it is
   * unavailable, this throws `PII_DETECTION_UNAVAILABLE` (503) — unless the
   * workspace chose to degrade to pattern-only detection — and records
   * `pii.redaction.failed`. Nothing has been sent anywhere at that point.
   */
  async redact(request: RedactionRequest): Promise<RedactionOutcome> {
    const started = performance.now();
    const policy =
      request.policy ?? (await this.policies.getEffective(request.organizationId));

    if (!policy.enabled) {
      return {
        enabled: false,
        session: null,
        segments: request.segments.map((segment) => ({
          id: segment.id,
          text: segment.text,
          input: segment.text,
          spans: [],
        })),
        summary: null,
        degraded: false,
        detectors: [],
        cacheHits: 0,
        timings: {
          patternMs: 0,
          nerMs: 0,
          maskingMs: 0,
          totalMs: round(performance.now() - started),
        },
        policy,
      };
    }

    const prepared = request.segments.map((segment) => ({
      id: segment.id,
      text: prepareText(segment.text),
    }));

    let detection: DetectionOutcome;
    try {
      detection = await this.detection.detect({
        organizationId: request.organizationId,
        policy,
        texts: prepared.map((segment) => segment.text),
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof PiiDetectionUnavailableError) {
        await this.auditService.recordSafe({
          action: AuditAction.PII_REDACTION_FAILED,
          status: AuditStatus.FAILURE,
          organizationId: request.organizationId,
          resourceType: 'pii_redaction',
          metadata: {
            purpose: request.purpose,
            reason: error.reason,
            detector: error.detector,
            entityTypes: error.entityTypes,
            onDetectorFailure: policy.onDetectorFailure,
          },
        });
        throw new AppException(
          ErrorCode.PII_DETECTION_UNAVAILABLE,
          HttpStatus.SERVICE_UNAVAILABLE,
          {
            cause: error,
            details: {
              reason: error.reason,
              detector: error.detector,
              entityTypes: error.entityTypes,
              missingConfiguration: error.missingConfiguration,
              hint:
                'Configure the NER detector, or set the workspace PII policy to ' +
                'DEGRADE_TO_PATTERNS to continue with pattern-based masking only.',
            },
          },
        );
      }
      throw error;
    }

    const maskingStarted = performance.now();
    const session = new MaskingSession(maskingPolicyFor(policy));
    let segments: MaskedSegment[];
    try {
      segments = session.mask(prepared, detection.spans);
    } catch (error) {
      session.destroy();
      throw error;
    }
    const maskingMs = round(performance.now() - maskingStarted);

    return {
      enabled: true,
      session,
      segments,
      summary: session.summary(),
      degraded: detection.degraded,
      detectors: detection.detectors,
      cacheHits: detection.cacheHits,
      timings: {
        patternMs: detection.timings.patternMs,
        nerMs: detection.timings.nerMs,
        maskingMs,
        totalMs: round(performance.now() - started),
      },
      policy,
    };
  }

  /**
   * Detects and masks more segments into a session that already exists.
   *
   * A tool result arrives in the middle of a reason → act loop, after the
   * prompt was masked. Masking it in the *same* session keeps one person one
   * placeholder across the whole exchange — "[PERSON_1]" in the passage the
   * model searched for is "[PERSON_1]" in the email it drafts — and lets the
   * gateway's egress check cover the result too. Fails closed exactly as
   * {@link redact} does.
   */
  async extend(
    session: MaskingSession,
    request: Omit<RedactionRequest, 'segments'> & {
      segments: readonly RedactionSegment[];
      policy: EffectivePiiPolicy;
    },
  ): Promise<{ segments: MaskedSegment[]; timings: RedactionTimings; degraded: boolean }> {
    const started = performance.now();
    const prepared = request.segments.map((segment) => ({
      id: segment.id,
      text: prepareText(segment.text),
    }));
    const detection = await this.detectOrRefuse(request, prepared, request.policy);
    const maskingStarted = performance.now();
    const segments = session.mask(prepared, detection.spans);
    return {
      segments,
      degraded: detection.degraded,
      timings: {
        patternMs: detection.timings.patternMs,
        nerMs: detection.timings.nerMs,
        maskingMs: round(performance.now() - maskingStarted),
        totalMs: round(performance.now() - started),
      },
    };
  }

  /**
   * The entity types present in `texts`, without masking anything. Used to
   * inspect a tool request that is about to leave the platform with real
   * values in it (a workflow tool node's arguments). Empty when the workspace
   * has redaction switched off.
   */
  async detectTypes(
    request: Omit<RedactionRequest, 'segments'> & { texts: string[] },
  ): Promise<{
    entityTypes: string[];
    degraded: boolean;
  }> {
    const policy =
      request.policy ?? (await this.policies.getEffective(request.organizationId));
    if (!policy.enabled || request.texts.length === 0) {
      return { entityTypes: [], degraded: false };
    }
    const prepared = request.texts.map((text, index) => ({
      id: `inspect:${index}`,
      text: prepareText(text),
    }));
    const detection = await this.detectOrRefuse(request, prepared, policy);
    const session = new MaskingSession(maskingPolicyFor(policy));
    try {
      const masked = session.mask(prepared, detection.spans);
      const types = new Set<string>();
      for (const segment of masked)
        for (const span of segment.spans) types.add(span.entityType);
      return { entityTypes: [...types].sort(), degraded: detection.degraded };
    } finally {
      session.destroy();
    }
  }

  private async detectOrRefuse(
    request: Pick<RedactionRequest, 'organizationId' | 'purpose' | 'signal'>,
    prepared: Array<{ id: string; text: string }>,
    policy: EffectivePiiPolicy,
  ): Promise<DetectionOutcome> {
    try {
      return await this.detection.detect({
        organizationId: request.organizationId,
        policy,
        texts: prepared.map((segment) => segment.text),
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof PiiDetectionUnavailableError) {
        await this.auditService.recordSafe({
          action: AuditAction.PII_REDACTION_FAILED,
          status: AuditStatus.FAILURE,
          organizationId: request.organizationId,
          resourceType: 'pii_redaction',
          metadata: {
            purpose: request.purpose,
            reason: error.reason,
            detector: error.detector,
            entityTypes: error.entityTypes,
            onDetectorFailure: policy.onDetectorFailure,
          },
        });
        throw new AppException(
          ErrorCode.PII_DETECTION_UNAVAILABLE,
          HttpStatus.SERVICE_UNAVAILABLE,
          {
            cause: error,
            details: {
              reason: error.reason,
              detector: error.detector,
              entityTypes: error.entityTypes,
              missingConfiguration: error.missingConfiguration,
            },
          },
        );
      }
      throw error;
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
