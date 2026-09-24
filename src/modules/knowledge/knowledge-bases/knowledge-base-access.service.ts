import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction, AuditStatus } from '../../../common/enums/audit-action.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { ForbiddenError, NotFoundError } from '../../../common/exceptions/app.exception';
import { AuditService } from '../../audit/audit.service';
import {
  AccessLevel,
  accessLevelFromRank,
  atLeast,
  computeAccessScope,
  type AccessPrincipal,
  type AccessScope,
  type KnowledgeBaseAccessRow,
  KnowledgeBaseAccessMode,
} from '../domain/access';
import { KnowledgeBase } from '../entities/knowledge-base.entity';

/**
 * Resolves what a principal may do in the knowledge layer.
 *
 * One query per request, and deliberately uncached. The inputs — a member's
 * roles, a base's grants, a base's access mode — are edited by three different
 * services, and a cache here would need invalidating from all of them; a missed
 * invalidation would leave someone reading a compartment they were just removed
 * from. The query is a single indexed pass over the workspace's bases, which is
 * cheaper than the correctness risk.
 */
@Injectable()
export class KnowledgeBaseAccessService {
  constructor(
    @InjectRepository(KnowledgeBase)
    private readonly knowledgeBaseRepository: Repository<KnowledgeBase>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  async resolveScope(principal: AccessPrincipal): Promise<AccessScope> {
    const rows: Array<{ id: string; access_mode: string; grant_rank: number | null }> =
      await this.dataSource.query(
        `SELECT kb.id,
                kb.access_mode,
                MAX(CASE g.access_level
                      WHEN 'MANAGE' THEN 3
                      WHEN 'WRITE'  THEN 2
                      WHEN 'READ'   THEN 1
                    END) AS grant_rank
           FROM knowledge_bases kb
           LEFT JOIN knowledge_base_grants g
                  ON g.knowledge_base_id = kb.id
                 AND (
                       ($2::uuid IS NOT NULL AND g.member_id = $2::uuid)
                    OR ($2::uuid IS NOT NULL AND g.role_id IN (
                          SELECT mr.role_id
                            FROM member_roles mr
                            JOIN roles r ON r.id = mr.role_id AND r.deleted_at IS NULL
                           WHERE mr.member_id = $2::uuid))
                    OR ($3::uuid IS NOT NULL AND g.api_key_id = $3::uuid)
                 )
          WHERE kb.organization_id = $1
            AND kb.deleted_at IS NULL
          GROUP BY kb.id, kb.access_mode`,
        [
          principal.organizationId,
          principal.membershipId ?? null,
          principal.apiKeyId ?? null,
        ],
      );

    const accessRows: KnowledgeBaseAccessRow[] = rows.map((row) => ({
      id: row.id,
      accessMode: row.access_mode as KnowledgeBaseAccessMode,
      grantLevel: accessLevelFromRank(
        row.grant_rank === null ? null : Number(row.grant_rank),
      ),
    }));

    return computeAccessScope(principal, accessRows);
  }

  /**
   * Loads a base the principal may act on at `required` level, or throws.
   *
   * A base the principal cannot even read is reported as not found — the same
   * answer a nonexistent id gets — so compartments cannot be discovered by
   * probing. A base they can read but not act on at this level is a 403 with a
   * specific code, because in that case its existence is already known to them.
   */
  async requireKnowledgeBase(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
    required: AccessLevel,
  ): Promise<{ scope: AccessScope; knowledgeBase: KnowledgeBase; level: AccessLevel }> {
    const scope = await this.resolveScope(principal);
    const level = scope.knowledgeBases.get(knowledgeBaseId);

    if (!level) {
      await this.recordHiddenProbe(principal, 'knowledge_base', knowledgeBaseId);
      throw new NotFoundError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND);
    }

    if (!atLeast(level, required)) {
      throw new ForbiddenError(ErrorCode.KNOWLEDGE_BASE_ACCESS_DENIED, {
        details: { required, granted: level },
      });
    }

    const knowledgeBase = await this.knowledgeBaseRepository.findOne({
      where: { id: knowledgeBaseId, organizationId: principal.organizationId },
    });
    if (!knowledgeBase) throw new NotFoundError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND);

    return { scope, knowledgeBase, level };
  }

  /**
   * Audits an attempt to address a resource that exists but is hidden from the
   * caller.
   *
   * The response is a 404 either way, so the caller learns nothing. The audit
   * log, however, records the difference: someone asking for an id that does
   * not exist is noise, while someone asking for the id of a compartment they
   * were never admitted to — an id they should not even know — is exactly the
   * signal a security reviewer is looking for.
   */
  async recordHiddenProbe(
    principal: AccessPrincipal,
    resourceType: 'knowledge_base' | 'document',
    resourceId: string,
    reason: 'compartment' | 'clearance' = 'compartment',
  ): Promise<void> {
    const table = resourceType === 'knowledge_base' ? 'knowledge_bases' : 'documents';
    const rows: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [resourceId, principal.organizationId],
    );
    if (rows.length === 0) return;

    await this.auditService.recordSafe({
      action: AuditAction.ACCESS_DENIED,
      status: AuditStatus.DENIED,
      organizationId: principal.organizationId,
      resourceType,
      resourceId,
      metadata: { reason, principalKind: principal.kind },
    });
  }
}
