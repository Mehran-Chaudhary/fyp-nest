import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  AppException,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/exceptions/app.exception';
import { returnedRows } from '../../database/query.util';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import {
  applicableQuotas,
  consumedPercent,
  QuotaEnforcement,
  QuotaManager,
  QuotaPeriod,
  QuotaScope,
  type QuotaDefinition,
} from './domain/quota-model';
import type {
  CreateQuotaDto,
  QuotaDto,
  QuotaHistoryEntryDto,
  UpdateQuotaDto,
} from './dto/quota.dto';
import { QuotaService } from './quota.service';
import { TokenRateLimiterService } from './token-rate-limiter.service';

/**
 * The quota API behind `quota:manage` (writes) and `usage:read` (reads).
 *
 * A workspace administrator sets budgets inside the platform's allowance —
 * for the whole workspace, a member, an agent or an API key — and can never
 * touch the `PLATFORM` rows. Every change is audited with the old and new
 * limits, and takes effect for the next call in this process at once (and in
 * others within QUOTA_CACHE_TTL).
 */
@Injectable()
export class QuotaManagementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly quotas: QuotaService,
    private readonly rates: TokenRateLimiterService,
    private readonly auditService: AuditService,
  ) {}

  async list(organizationId: string): Promise<QuotaDto[]> {
    const definitions = await this.quotas.definitions(organizationId);
    return this.present(organizationId, definitions);
  }

  /** The quotas that bind the caller: the workspace's, and their own. */
  async forPrincipal(principal: AccessPrincipal): Promise<QuotaDto[]> {
    const definitions = await this.quotas.definitions(principal.organizationId);
    const { budgets, rates } = applicableQuotas(definitions, {
      organizationId: principal.organizationId,
      userId: principal.userId ?? null,
      apiKeyId: principal.apiKeyId ?? null,
    });
    // Agent quotas are shown with the agent, not per caller.
    return this.present(
      principal.organizationId,
      [...budgets, ...rates].filter((quota) => quota.scope !== QuotaScope.AGENT),
    );
  }

  async create(
    organizationId: string,
    actorUserId: string | undefined,
    input: CreateQuotaDto,
  ): Promise<QuotaDto> {
    const subjectId = input.scope === QuotaScope.ORGANIZATION ? null : (input.subjectId ?? null);
    if (subjectId) await this.assertSubject(organizationId, input.scope, subjectId);

    const rows = returnedRows<{ id: string }>(
      await this.dataSource
        .query(
          `INSERT INTO usage_quotas
             (organization_id, scope, subject_id, period, token_limit, enforcement,
              alert_threshold, managed_by, label, created_by_id, updated_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'WORKSPACE', $8, $9, $9)
           RETURNING id`,
          [
            organizationId,
            input.scope,
            subjectId,
            input.period,
            input.tokenLimit,
            input.enforcement ?? QuotaEnforcement.HARD,
            input.alertThreshold ?? 80,
            input.label ?? null,
            actorUserId ?? null,
          ],
        )
        .catch((error: { code?: string }) => {
          if (error.code === '23505') {
            throw new ConflictError(ErrorCode.RESOURCE_CONFLICT, {
              message:
                'A quota for this scope, subject and period already exists. Change it instead.',
            });
          }
          throw error;
        }),
    );
    const id = rows[0].id;
    this.quotas.invalidate(organizationId);

    await this.auditService.recordSafe({
      action: AuditAction.QUOTA_CREATED,
      organizationId,
      resourceType: 'usage_quota',
      resourceId: id,
      metadata: {
        scope: input.scope,
        subjectId,
        period: input.period,
        tokenLimit: input.tokenLimit,
        enforcement: input.enforcement ?? QuotaEnforcement.HARD,
      },
    });
    return this.get(organizationId, id);
  }

  async update(
    organizationId: string,
    quotaId: string,
    actorUserId: string | undefined,
    input: UpdateQuotaDto,
  ): Promise<QuotaDto> {
    const before = await this.dataSource.transaction(async (manager) => {
      const quota = await QuotaService.lockQuota(manager, organizationId, quotaId);
      if (!quota) throw new NotFoundError(ErrorCode.QUOTA_NOT_FOUND);
      if (quota.managedBy === QuotaManager.PLATFORM) {
        throw new ForbiddenError(ErrorCode.QUOTA_MANAGED_BY_PLATFORM);
      }
      await manager.query(
        `UPDATE usage_quotas
            SET token_limit = COALESCE($3, token_limit),
                enforcement = COALESCE($4, enforcement),
                alert_threshold = COALESCE($5, alert_threshold),
                label = CASE WHEN $6::boolean THEN $7 ELSE label END,
                updated_by_id = $8
          WHERE id = $1 AND organization_id = $2`,
        [
          quotaId,
          organizationId,
          input.tokenLimit ?? null,
          input.enforcement ?? null,
          input.alertThreshold ?? null,
          input.label !== undefined,
          input.label ?? null,
          actorUserId ?? null,
        ],
      );
      return quota;
    });
    this.quotas.invalidate(organizationId);

    await this.auditService.recordSafe({
      action: AuditAction.QUOTA_UPDATED,
      organizationId,
      resourceType: 'usage_quota',
      resourceId: quotaId,
      metadata: {
        scope: before.scope,
        subjectId: before.subjectId,
        period: before.period,
        before: {
          tokenLimit: before.tokenLimit,
          enforcement: before.enforcement,
          alertThreshold: before.alertThreshold,
        },
        after: {
          tokenLimit: input.tokenLimit ?? before.tokenLimit,
          enforcement: input.enforcement ?? before.enforcement,
          alertThreshold: input.alertThreshold ?? before.alertThreshold,
        },
        // Raising a limit, or softening enforcement, relaxes a control.
        weakened:
          (input.tokenLimit ?? before.tokenLimit) > before.tokenLimit ||
          (before.enforcement === QuotaEnforcement.HARD &&
            input.enforcement === QuotaEnforcement.SOFT),
      },
    });
    return this.get(organizationId, quotaId);
  }

  async remove(organizationId: string, quotaId: string): Promise<{ deleted: true }> {
    const removed = await this.dataSource.transaction(async (manager) => {
      const quota = await QuotaService.lockQuota(manager, organizationId, quotaId);
      if (!quota) throw new NotFoundError(ErrorCode.QUOTA_NOT_FOUND);
      if (quota.managedBy === QuotaManager.PLATFORM) {
        throw new ForbiddenError(ErrorCode.QUOTA_MANAGED_BY_PLATFORM);
      }
      await manager.query(`DELETE FROM usage_quotas WHERE id = $1 AND organization_id = $2`, [
        quotaId,
        organizationId,
      ]);
      return quota;
    });
    this.quotas.invalidate(organizationId);

    await this.auditService.recordSafe({
      action: AuditAction.QUOTA_DELETED,
      organizationId,
      resourceType: 'usage_quota',
      resourceId: quotaId,
      metadata: {
        scope: removed.scope,
        subjectId: removed.subjectId,
        period: removed.period,
        tokenLimit: removed.tokenLimit,
        weakened: true,
      },
    });
    return { deleted: true };
  }

  async history(
    organizationId: string,
    quotaId: string,
    periods: number,
  ): Promise<QuotaHistoryEntryDto[]> {
    const definitions = await this.quotas.definitions(organizationId);
    const quota = definitions.find((candidate) => candidate.id === quotaId);
    if (!quota) throw new NotFoundError(ErrorCode.QUOTA_NOT_FOUND);
    return this.quotas.history(organizationId, quotaId, periods);
  }

  private async get(organizationId: string, quotaId: string): Promise<QuotaDto> {
    const definitions = await this.quotas.definitions(organizationId);
    const quota = definitions.find((candidate) => candidate.id === quotaId);
    if (!quota) throw new NotFoundError(ErrorCode.QUOTA_NOT_FOUND);
    const [dto] = await this.present(organizationId, [quota]);
    return dto;
  }

  private async present(
    organizationId: string,
    quotas: QuotaDefinition[],
  ): Promise<QuotaDto[]> {
    const usage = await this.quotas.usage(organizationId, quotas);
    const rows: Array<{ id: string; label: string | null }> =
      quotas.length > 0
        ? await this.dataSource.query(
            `SELECT id, label FROM usage_quotas WHERE id = ANY($1::uuid[])`,
            [quotas.map((quota) => quota.id)],
          )
        : [];
    const labels = new Map(rows.map((row) => [row.id, row.label]));

    return Promise.all(
      quotas.map(async (quota) => {
        const current = usage.get(quota.id);
        return {
          id: quota.id,
          scope: quota.scope,
          subjectId: quota.subjectId,
          period: quota.period,
          tokenLimit: quota.tokenLimit,
          enforcement: quota.enforcement,
          alertThreshold: quota.alertThreshold,
          managedBy: quota.managedBy,
          label: labels.get(quota.id) ?? null,
          usage: current
            ? {
                used: current.used,
                reserved: current.reserved,
                remaining: Math.max(0, quota.tokenLimit - current.used - current.reserved),
                percent: consumedPercent(quota.tokenLimit, current.used, current.reserved),
                periodStart: current.periodStart,
                resetsAt: current.resetsAt,
              }
            : null,
          rate:
            quota.period === QuotaPeriod.MINUTE
              ? { available: await this.rates.available(quota) }
              : null,
        };
      }),
    );
  }

  /** The subject must belong to this workspace — a quota cannot name someone else's. */
  private async assertSubject(
    organizationId: string,
    scope: QuotaScope,
    subjectId: string,
  ): Promise<void> {
    const query =
      scope === QuotaScope.MEMBER
        ? `SELECT 1 FROM organization_members
            WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL`
        : scope === QuotaScope.AGENT
          ? `SELECT 1 FROM agents WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`
          : `SELECT 1 FROM api_keys
              WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`;
    const rows: unknown[] = await this.dataSource.query(query, [organizationId, subjectId]);
    if (rows.length === 0) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, {
        message: `No ${scope.toLowerCase().replace('_', ' ')} with that id exists in this workspace.`,
        details: { scope, subjectId },
      });
    }
  }
}
