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
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
