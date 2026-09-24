import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException, PermissionDeniedError } from '../../common/exceptions/app.exception';
import { hasPermission } from '../../common/utils/permission.util';
import { PII_CONFIG_KEY, type PiiConfig } from '../../config/pii.config';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { DocumentsService } from '../knowledge/documents/documents.service';
import { listEntityTypes, needsNer } from './domain/entity-catalogue';
import type { MaskedSegment } from './domain/masking-session';
import { PiiDetectionService } from './detection/pii-detection.service';
import type {
  AnalyzeResultDto,
  AnalyzeTextDto,
  DetectedEntityDto,
  DocumentPiiReportDto,
  DocumentReportQueryDto,
  EntityTypeDto,
} from './dto/privacy.dto';
import { RedactionService } from './redaction.service';

export const REVEAL_PERMISSION = 'pii:reveal';

/**
 * Redaction reports: what the engine finds in a piece of text or a document,
 * and what the model would receive instead.
 *
 * The values themselves are shown only to holders of `pii:reveal` — the most
 * sensitive permission on the platform — who must ask for them explicitly, and
 * every such request is written to the audit log as `pii.unmasked`, a
 * CRITICAL event. Everyone else sees types, positions and masked text: enough
 * to check the policy works, never the data it protects.
 */
@Injectable()
export class PrivacyService {
  private readonly config: PiiConfig;

  constructor(
    private readonly redaction: RedactionService,
    private readonly detection: PiiDetectionService,
    private readonly documents: DocumentsService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<PiiConfig>(PII_CONFIG_KEY);
  }

  async entityTypes(organizationId: string): Promise<EntityTypeDto[]> {
    const policy = await this.redaction.policyFor(organizationId);
    const nerAvailable = this.detection.nerDetector.isConfigured;
    const enabled = new Set(policy.entityTypes);

    return listEntityTypes().map((definition) => ({
      type: definition.type,
      label: definition.label,
      description: definition.description,
      detector: definition.detector,
      available: needsNer(definition.type) ? nerAvailable : true,
      enabled: enabled.has(definition.type),
      example: definition.example,
    }));
  }

  async analyze(
    principal: AccessPrincipal,
    input: AnalyzeTextDto,
  ): Promise<AnalyzeResultDto> {
    const reveal = await this.authorizeReveal(principal, input.reveal === true);

    if (input.text.length > this.config.maxAnalyzeLength) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, {
        message: `Text for analysis is limited to ${this.config.maxAnalyzeLength} characters.`,
      });
    }

    const outcome = await this.redaction.redact({
      organizationId: principal.organizationId,
      segments: [{ id: 'text', text: input.text }],
      purpose: 'analysis',
    });

    try {
      const [segment] = outcome.segments;
      const entities = this.entities(segment, reveal);

      if (reveal) {
        await this.auditReveal(principal, 'analysis', {
          entities: entities.length,
          byType: outcome.summary?.byType ?? {},
        });
      }

      return {
        maskedText: segment.text,
        entities,
        entityCount: outcome.summary?.entities ?? 0,
        byType: outcome.summary?.byType ?? {},
        degraded: outcome.degraded,
        detectors: outcome.detectors,
        revealed: reveal,
        timings: outcome.timings,
      };
    } finally {
      outcome.session?.destroy();
    }
  }

  /**
   * Redaction preview for one document, a page of chunks at a time: what the
   * model would see if these chunks were retrieved. Access to the document is
   * checked by the knowledge layer exactly as for reading its chunks.
   */
  async documentReport(
    principal: AccessPrincipal,
    documentId: string,
    query: DocumentReportQueryDto,
  ): Promise<DocumentPiiReportDto> {
    const reveal = await this.authorizeReveal(principal, query.reveal === true);
    const page = await this.documents.listChunks(
      principal,
      documentId,
      query.page,
      query.limit,
    );

    const outcome = await this.redaction.redact({
      organizationId: principal.organizationId,
      segments: page.items.map((chunk) => ({ id: chunk.id, text: chunk.text })),
      purpose: 'document-report',
    });

    try {
      const chunks = page.items.map((chunk, index) => ({
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        pageStart: chunk.pageStart,
        maskedText: outcome.segments[index].text,
        entities: this.entities(outcome.segments[index], reveal),
      }));

      if (reveal) {
        await this.auditReveal(principal, 'document-report', {
          documentId,
          chunks: chunks.length,
          byType: outcome.summary?.byType ?? {},
        });
      }

      return {
        documentId,
        chunks,
        byType: outcome.summary?.byType ?? {},
        entityCount: outcome.summary?.entities ?? 0,
        page: page.meta.page,
        totalChunks: page.meta.totalItems,
        degraded: outcome.degraded,
        revealed: reveal,
        timings: outcome.timings,
      };
    } finally {
      outcome.session?.destroy();
    }
  }

  private entities(segment: MaskedSegment, reveal: boolean): DetectedEntityDto[] {
    return segment.spans.map((span) => ({
      entityType: span.entityType,
      start: span.start,
      end: span.end,
      score: Math.round(span.score * 1000) / 1000,
      source: span.source,
      recognizer: span.recognizer,
      placeholder: span.placeholder,
      ...(reveal ? { value: segment.input.slice(span.start, span.end) } : {}),
    }));
  }

  /**
   * Refuses a reveal to anyone without `pii:reveal`, and audits the refusal.
   * API keys never hold it: see `API_KEY_SCOPES`.
   */
  private async authorizeReveal(
    principal: AccessPrincipal,
    requested: boolean,
  ): Promise<boolean> {
    if (!requested) return false;
    if (hasPermission(principal.permissions, REVEAL_PERMISSION)) return true;

    await this.auditService.recordAccessDenied(
      'pii_reveal',
      [REVEAL_PERMISSION],
      principal.organizationId,
    );
    throw new PermissionDeniedError([REVEAL_PERMISSION]);
  }

  private async auditReveal(
    principal: AccessPrincipal,
    purpose: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditService.record({
      action: AuditAction.PII_UNMASKED,
      organizationId: principal.organizationId,
      resourceType: 'pii_report',
      metadata: { purpose, principalKind: principal.kind, ...metadata },
    });
  }
}
