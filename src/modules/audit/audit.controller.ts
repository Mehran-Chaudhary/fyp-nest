import { Controller, Get, Header, Param, Query, StreamableFile } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Readable } from 'node:stream';
import {
  ApiEnvelopedResponse,
  ApiPaginatedResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  RequirePermissions,
  SkipResponseEnvelope,
} from '../../common/decorators/auth.decorators';
import { CurrentOrganizationId } from '../../common/decorators/param.decorators';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { NotFoundError } from '../../common/exceptions/app.exception';
import type { PaginatedResult } from '../../common/utils/pagination.util';
import { AuditRetentionService } from './audit-retention.service';
import { AuditService } from './audit.service';
import {
  AuditLogDto,
  AuditStatisticsDto,
  ChainVerificationDto,
  QueryAuditLogsDto,
} from './dto/audit.dto';
import type { AuditLog } from './entities/audit-log.entity';

/**
 * The compliance log (proposal module 6.15).
 *
 * Every route is scoped to the workspace resolved by the organization-context
 * guard. The workspace is never taken from a query parameter, because an audit
 * endpoint that let a caller choose which tenant to read would be the most
 * damaging possible isolation failure — this log is a summary of everything that
 * has ever happened inside a workspace.
 */
@ApiTags('Audit')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/audit-logs', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly retention: AuditRetentionService,
  ) {}

  @Get()
  @RequirePermissions('audit:read')
  @ApiOperation({
    summary: 'Search the audit log',
    description:
      'Filter by action, severity, actor, resource, request id, IP or time range. ' +
      'Filtering on severity WARNING or CRITICAL is the fastest route to the ' +
      'security-relevant subset, and is backed by a dedicated partial index.',
  })
  @ApiPaginatedResponse(AuditLogDto)
  @ApiStandardErrors()
  async query(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Query() query: QueryAuditLogsDto,
  ): Promise<PaginatedResult<AuditLogDto>> {
    const result = await this.auditService.query(organizationId, {
      page: query.page,
      limit: query.limit,
      action: query.action,
      actionPrefix: query.actionPrefix,
      status: query.status,
      severity: query.severity,
      actorType: query.actorType,
      actorId: query.actorId,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      requestId: query.requestId,
      ipAddress: query.ipAddress,
      from: query.from,
      to: query.to,
    });

    return { items: result.items.map((log) => this.toDto(log)), meta: result.meta };
  }

  @Get('statistics')
  @RequirePermissions('audit:read')
  @ApiOperation({
    summary: 'Aggregate counts for the security dashboard',
    description:
      'Totals by severity and status, plus the ten most frequent actions. Backs ' +
      'the "live security status feed" panel of the command centre screen.',
  })
  @ApiEnvelopedResponse(AuditStatisticsDto)
  @ApiStandardErrors()
  async statistics(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<AuditStatisticsDto> {
    return this.auditService.statistics(organizationId);
  }

  @Get('verify')
  @RequirePermissions('audit:verify')
  @ApiOperation({
    summary: 'Verify the integrity of the audit chain',
    description:
      'Recomputes every record’s hash and checks it against its stored value ' +
      'and against its predecessor. A failure names the exact sequence number at ' +
      'which the chain diverges and what specifically broke — a deleted record, a ' +
      'broken link, or altered content. This is what makes "immutable" a claim ' +
      'that can be demonstrated rather than merely asserted.',
  })
  @ApiEnvelopedResponse(ChainVerificationDto)
  @ApiStandardErrors()
  async verify(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Query('maxRecords') maxRecords?: string,
  ): Promise<ChainVerificationDto> {
    const result = await this.auditService.verifyChain(organizationId, {
      maxRecords: maxRecords ? Number(maxRecords) : undefined,
    });

    // Recorded as an audit entry of its own, so that "who checked, and what did
    // they find" is itself part of the compliance record.
    await this.auditService.recordSafe({
      action: result.valid
        ? AuditAction.AUDIT_CHAIN_VERIFIED
        : AuditAction.AUDIT_CHAIN_TAMPER_DETECTED,
      organizationId,
      resourceType: 'audit_chain',
      metadata: {
        valid: result.valid,
        recordsChecked: result.recordsChecked,
        brokenAtSequence: result.brokenAtSequence,
        reason: result.reason,
      },
    });

    return result;
  }

  @Get('export')
  @RequirePermissions('audit:export')
  @SkipResponseEnvelope()
  @Header('Content-Type', 'application/x-ndjson')
  @Header('Content-Disposition', 'attachment; filename="audit-log.ndjson"')
  @ApiProduces('application/x-ndjson')
  @ApiOperation({
    summary: 'Export the audit log',
    description:
      'Streams newline-delimited JSON. Each line carries its own `hash` and ' +
      '`previousHash`, so an external auditor can verify the chain offline without ' +
      'access to this system. NDJSON rather than a JSON array because a mature ' +
      'workspace’s log is far too large to buffer on either side.',
  })
  @ApiStandardErrors()
  async export(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<StreamableFile> {
    await this.auditService.recordSafe({
      action: AuditAction.AUDIT_LOG_EXPORTED,
      organizationId,
      resourceType: 'audit_chain',
      metadata: { from, to },
    });

    const generator = this.auditService.exportChain(organizationId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });

    return new StreamableFile(Readable.from(generator));
  }

  // ── Retention archives (phase 5) ─────────────────────────────────────────

  @Get('archives')
  @RequirePermissions('audit:read')
  @ApiOperation({
    summary: 'Where retention pruned this chain',
    description:
      'One entry per pruning: the records it removed, the cutoff, the signed anchor the ' +
      'chain now verifies from, and whether an encrypted archive of the records exists.',
  })
  @ApiStandardErrors()
  async archives(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<
    Array<{
      sequence: string;
      firstSequence: string;
      recordsPruned: number;
      cutoff: Date;
      archived: boolean;
      archiveSha256: string | null;
      createdAt: Date;
    }>
  > {
    const anchors = await this.retention.anchors(organizationId);
    return anchors.map((anchor) => ({
      sequence: anchor.sequence,
      firstSequence: anchor.firstSequence,
      recordsPruned: Number(anchor.recordsPruned),
      cutoff: anchor.cutoff,
      archived: anchor.archiveKey !== null,
      archiveSha256: anchor.archiveSha256,
      createdAt: anchor.createdAt,
    }));
  }

  @Get('archives/:sequence')
  @RequirePermissions('audit:export')
  @SkipResponseEnvelope()
  @Header('Content-Type', 'application/x-ndjson')
  @ApiProduces('application/x-ndjson')
  @ApiOperation({
    summary: 'Download the archive of pruned records',
    description:
      'The records one pruning removed, decrypted, as NDJSON — the same format as the ' +
      'export, verifiable offline: its last `hash` equals the anchor’s. The stored ' +
      'object’s digest is checked against the anchor before anything is served.',
  })
  @ApiStandardErrors()
  async archive(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('sequence') sequence: string,
  ): Promise<StreamableFile> {
    if (!/^\d{1,19}$/.test(sequence)) {
      throw new NotFoundError(ErrorCode.RESOURCE_NOT_FOUND);
    }
    const body = await this.retention.readArchive(organizationId, sequence);
    await this.auditService.recordSafe({
      action: AuditAction.AUDIT_LOG_EXPORTED,
      organizationId,
      resourceType: 'audit_chain',
      metadata: { archive: true, anchorSequence: sequence },
    });
    return new StreamableFile(body, {
      disposition: `attachment; filename="audit-archive-${sequence}.ndjson"`,
    });
  }

  private toDto(log: AuditLog): AuditLogDto {
    return {
      id: log.id,
      sequence: log.sequence,
      action: log.action,
      status: log.status,
      severity: log.severity,
      actorType: log.actorType,
      actorId: log.actorId,
      actorLabel: log.actorLabel,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      resourceLabel: log.resourceLabel,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      requestId: log.requestId,
      httpMethod: log.httpMethod,
      httpPath: log.httpPath,
      httpStatus: log.httpStatus,
      durationMs: log.durationMs,
      errorCode: log.errorCode,
      errorMessage: log.errorMessage,
      metadata: log.metadata,
      createdAt: log.createdAt,
    };
  }
}
