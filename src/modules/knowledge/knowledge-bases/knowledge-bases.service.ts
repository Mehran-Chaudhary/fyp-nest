import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../common/exceptions/app.exception';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import {
  INGESTION_CONFIG_KEY,
  type IngestionConfig,
} from '../../../config/ingestion.config';
import { returnedRows } from '../../../database/query.util';
import { VectorStoreService } from '../../../shared/vector-store/vector-store.service';
import { AuditService } from '../../audit/audit.service';
import {
  AccessLevel,
  KnowledgeBaseAccessMode,
  readableKnowledgeBaseIds,
  type AccessPrincipal,
  type AccessScope,
} from '../domain/access';
import { Classification, classificationsWithin, dominates } from '../domain/classification';
import {
  GrantSubjectType,
  KnowledgeBaseGrant,
} from '../entities/knowledge-base-grant.entity';
import { KnowledgeBase } from '../entities/knowledge-base.entity';
import { effectiveChunking } from '../ingestion/chunking';
import { MAINTENANCE_JOB } from '../ingestion/knowledge-jobs';
import { KnowledgeJobsService } from '../ingestion/knowledge-jobs.service';
import type {
  CreateKnowledgeBaseDto,
  KnowledgeBaseDto,
  KnowledgeBaseGrantDto,
  KnowledgeBaseStatsDto,
  UpdateKnowledgeBaseDto,
  UpsertGrantDto,
} from './dto/knowledge-base.dto';
import { KnowledgeBaseAccessService } from './knowledge-base-access.service';

const PG_UNIQUE_VIOLATION = '23505';
const SORTABLE = ['name', 'createdAt', 'updatedAt'] as const;

/**
 * Knowledge bases and their access grants (proposal modules 6.4 and 6.6).
 */
@Injectable()
export class KnowledgeBasesService {
  private readonly ingestion: IngestionConfig;

  constructor(
    @InjectRepository(KnowledgeBase)
    private readonly knowledgeBaseRepository: Repository<KnowledgeBase>,
    @InjectRepository(KnowledgeBaseGrant)
    private readonly grantRepository: Repository<KnowledgeBaseGrant>,
    private readonly dataSource: DataSource,
    private readonly access: KnowledgeBaseAccessService,
    private readonly jobs: KnowledgeJobsService,
    private readonly vectorStore: VectorStoreService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.ingestion = configService.getOrThrow<IngestionConfig>(INGESTION_CONFIG_KEY);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Only bases the caller may read. Restricted bases without a grant do not appear at all. */
  async list(
    principal: AccessPrincipal,
    query: {
      page: number;
      limit: number;
      search?: string;
      sortBy?: string;
      sortDirection: 'ASC' | 'DESC';
    },
  ): Promise<PaginatedResult<KnowledgeBaseDto>> {
    const scope = await this.access.resolveScope(principal);
    const readable = readableKnowledgeBaseIds(scope);

    if (readable.length === 0) {
      return { items: [], meta: buildPaginationMeta(0, query.page, query.limit) };
    }

    const sortBy = SORTABLE.includes(query.sortBy as (typeof SORTABLE)[number])
      ? (query.sortBy as (typeof SORTABLE)[number])
      : 'name';

    const builder = this.knowledgeBaseRepository
      .createQueryBuilder('kb')
      .where('kb.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      })
      .andWhere('kb.id IN (:...readable)', { readable });

    if (query.search) {
      builder.andWhere('kb.name ILIKE :search', {
        search: `%${escapeLike(query.search)}%`,
      });
    }

    // Alphabetical by default; an explicit `sortBy` honours `sortDirection`.
    const direction = query.sortBy === undefined ? 'ASC' : query.sortDirection;

    const [bases, total] = await builder
      .orderBy(`kb.${sortBy}`, direction)
      .addOrderBy('kb.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    const stats = await this.statsFor(
      scope,
      bases.map((base) => base.id),
    );

    return {
      items: bases.map((base) =>
        this.toDto(
          base,
          scope.knowledgeBases.get(base.id) as AccessLevel,
          stats.get(base.id),
        ),
      ),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async get(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
  ): Promise<KnowledgeBaseDto> {
    const { scope, knowledgeBase, level } = await this.access.requireKnowledgeBase(
      principal,
      knowledgeBaseId,
      AccessLevel.READ,
    );
    const stats = await this.statsFor(scope, [knowledgeBase.id]);
    return this.toDto(knowledgeBase, level, stats.get(knowledgeBase.id));
  }

  /**
   * Document counts per base, restricted to what the caller is cleared to see.
   * An unfiltered count would itself disclose how many CONFIDENTIAL documents a
   * base holds to someone who may not know they exist.
   */
  private async statsFor(
    scope: AccessScope,
    knowledgeBaseIds: string[],
  ): Promise<Map<string, KnowledgeBaseStatsDto>> {
    if (knowledgeBaseIds.length === 0) return new Map();

    const rows: Array<{
      id: string;
      documents: number;
      ready: number;
      processing: number;
      failed: number;
      total_bytes: string;
    }> = await this.dataSource.query(
      `SELECT knowledge_base_id AS id,
              COUNT(*)::int                                                           AS documents,
              COUNT(*) FILTER (WHERE status = 'READY')::int                           AS ready,
              COUNT(*) FILTER (WHERE status IN ('UPLOADED','PARSING','CHUNKING','EMBEDDING'))::int AS processing,
              COUNT(*) FILTER (WHERE status = 'FAILED')::int                          AS failed,
              COALESCE(SUM(size_bytes), 0)::text                                      AS total_bytes
         FROM documents
        WHERE organization_id = $1
          AND knowledge_base_id = ANY($2::uuid[])
          AND classification = ANY($3::varchar[])
          AND deleted_at IS NULL
        GROUP BY knowledge_base_id`,
      [scope.organizationId, knowledgeBaseIds, classificationsWithin(scope.clearance)],
    );

    return new Map(
      rows.map((row) => [
        row.id,
        {
          documents: row.documents,
          ready: row.ready,
          processing: row.processing,
          failed: row.failed,
          totalBytes: row.total_bytes,
        },
      ]),
    );
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(
    principal: AccessPrincipal,
    input: CreateKnowledgeBaseDto,
  ): Promise<KnowledgeBaseDto> {
    const scope = await this.access.resolveScope(principal);
    const accessMode = input.accessMode ?? KnowledgeBaseAccessMode.WORKSPACE;
    const defaultClassification = input.defaultClassification ?? Classification.INTERNAL;

    this.assertWithinClearance(scope, defaultClassification);
    await this.assertChunking(
      principal.organizationId,
      input.chunkSize ?? null,
      input.chunkOverlap ?? null,
      input,
    );

    try {
      const created = await this.dataSource.transaction(async (manager) => {
        const knowledgeBase = await manager.getRepository(KnowledgeBase).save(
          manager.getRepository(KnowledgeBase).create({
            organizationId: principal.organizationId,
            name: input.name,
            description: input.description || null,
            accessMode,
            defaultClassification,
            embeddingModel: this.vectorStore.embeddingModel,
            embeddingDimensions: this.vectorStore.embeddingDimensions,
            chunkSize: input.chunkSize ?? null,
            chunkOverlap: input.chunkOverlap ?? null,
            createdById: principal.userId ?? null,
          }),
        );

        // The creator of a compartment must be able to see what they created.
        if (accessMode === KnowledgeBaseAccessMode.RESTRICTED) {
          await this.ensureCreatorGrant(manager, scope, knowledgeBase);
        }

        await this.auditService.record(
          {
            action: AuditAction.KNOWLEDGE_BASE_CREATED,
            organizationId: principal.organizationId,
            resourceType: 'knowledge_base',
            resourceId: knowledgeBase.id,
            resourceLabel: knowledgeBase.name,
            metadata: {
              accessMode,
              defaultClassification,
              embeddingModel: knowledgeBase.embeddingModel,
            },
          },
          manager,
        );

        return knowledgeBase;
      });

      return this.toDto(created, AccessLevel.MANAGE, undefined);
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  async update(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
    input: UpdateKnowledgeBaseDto,
  ): Promise<KnowledgeBaseDto> {
    const { scope, knowledgeBase } = await this.access.requireKnowledgeBase(
      principal,
      knowledgeBaseId,
      AccessLevel.MANAGE,
    );

    if (input.defaultClassification) {
      this.assertWithinClearance(scope, input.defaultClassification);
    }
    // `null` is an explicit return to the workspace default, so only an absent
    // field keeps the stored value.
    await this.assertChunking(
      principal.organizationId,
      input.chunkSize !== undefined ? input.chunkSize : knowledgeBase.chunkSize,
      input.chunkOverlap !== undefined ? input.chunkOverlap : knowledgeBase.chunkOverlap,
      input,
    );

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const apply = <K extends keyof KnowledgeBase>(
      field: K,
      value: KnowledgeBase[K] | undefined,
    ) => {
      if (value === undefined || value === knowledgeBase[field]) return;
      changes[field as string] = { from: knowledgeBase[field], to: value };
      knowledgeBase[field] = value;
    };

    apply('name', input.name);
    // An empty description is no description.
    apply('description', input.description === '' ? null : input.description);
    apply('accessMode', input.accessMode);
    apply('defaultClassification', input.defaultClassification);
    apply('chunkSize', input.chunkSize);
    apply('chunkOverlap', input.chunkOverlap);

    if (Object.keys(changes).length === 0) {
      return this.get(principal, knowledgeBaseId);
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(KnowledgeBase).save(knowledgeBase);

        // Turning a base into a compartment must not lock out the person doing it.
        if (
          changes.accessMode &&
          knowledgeBase.accessMode === KnowledgeBaseAccessMode.RESTRICTED
        ) {
          await this.ensureCreatorGrant(manager, scope, knowledgeBase);
        }

        await this.auditService.record(
          {
            action: AuditAction.KNOWLEDGE_BASE_UPDATED,
            organizationId: principal.organizationId,
            resourceType: 'knowledge_base',
            resourceId: knowledgeBase.id,
            resourceLabel: knowledgeBase.name,
            metadata: { changes },
          },
          manager,
        );
      });
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }

    return this.get(principal, knowledgeBaseId);
  }

  /**
   * Deletes a base and destroys its content.
   *
   * Every document's data key is shredded and every chunk row removed inside
   * the transaction, so the content is unrecoverable the moment this returns.
   * Removing vectors and stored objects follows asynchronously; until it does
   * they are unreadable ciphertext and unreachable, since retrieval joins
   * through the rows just deleted.
   */
  async remove(principal: AccessPrincipal, knowledgeBaseId: string): Promise<void> {
    const { knowledgeBase } = await this.access.requireKnowledgeBase(
      principal,
      knowledgeBaseId,
      AccessLevel.MANAGE,
    );

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM document_chunks
          WHERE document_id IN (SELECT id FROM documents WHERE knowledge_base_id = $1)`,
        [knowledgeBase.id],
      );

      const shredded = returnedRows<{ id: string }>(
        await manager.query(
          `UPDATE documents
              SET deleted_at = COALESCE(deleted_at, now()), wrapped_data_key = NULL
            WHERE knowledge_base_id = $1 AND wrapped_data_key IS NOT NULL
          RETURNING id`,
          [knowledgeBase.id],
        ),
      );

      await manager.getRepository(KnowledgeBase).softDelete({ id: knowledgeBase.id });

      await this.auditService.record(
        {
          action: AuditAction.KNOWLEDGE_BASE_DELETED,
          organizationId: principal.organizationId,
          resourceType: 'knowledge_base',
          resourceId: knowledgeBase.id,
          resourceLabel: knowledgeBase.name,
          metadata: { documentsDestroyed: shredded.length },
        },
        manager,
      );
    });

    await this.jobs.enqueueMaintenance(
      MAINTENANCE_JOB.PURGE_KNOWLEDGE_BASE,
      { organizationId: principal.organizationId, knowledgeBaseId: knowledgeBase.id },
      knowledgeBase.id,
    );
  }

  // ── Grants ────────────────────────────────────────────────────────────────

  async listGrants(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
  ): Promise<KnowledgeBaseGrantDto[]> {
    await this.access.requireKnowledgeBase(principal, knowledgeBaseId, AccessLevel.MANAGE);

    const rows: Array<{
      id: string;
      role_id: string | null;
      member_id: string | null;
      api_key_id: string | null;
      access_level: AccessLevel;
      granted_by_id: string | null;
      created_at: Date;
      role_name: string | null;
      member_name: string | null;
      api_key_name: string | null;
    }> = await this.dataSource.query(
      `SELECT g.id, g.role_id, g.member_id, g.api_key_id, g.access_level, g.granted_by_id, g.created_at,
              r.name AS role_name,
              COALESCE(m.display_name, u.display_name, u.first_name || ' ' || u.last_name) AS member_name,
              k.name || ' (' || k.prefix || ')' AS api_key_name
         FROM knowledge_base_grants g
         LEFT JOIN roles r                ON r.id = g.role_id AND r.deleted_at IS NULL
         LEFT JOIN organization_members m ON m.id = g.member_id AND m.deleted_at IS NULL
         LEFT JOIN users u                ON u.id = m.user_id
         LEFT JOIN api_keys k             ON k.id = g.api_key_id
        WHERE g.knowledge_base_id = $1 AND g.organization_id = $2
          -- Grants whose subject has since been removed are inert; hide them.
          AND (g.role_id IS NULL OR r.id IS NOT NULL)
          AND (g.member_id IS NULL OR m.id IS NOT NULL)
          AND (g.api_key_id IS NULL OR k.revoked_at IS NULL)
        ORDER BY g.created_at ASC`,
      [knowledgeBaseId, principal.organizationId],
    );

    return rows.map((row) => ({
      id: row.id,
      subjectType: row.role_id
        ? GrantSubjectType.ROLE
        : row.member_id
          ? GrantSubjectType.MEMBER
          : GrantSubjectType.API_KEY,
      subjectId: (row.role_id ?? row.member_id ?? row.api_key_id) as string,
      subjectLabel: row.role_name ?? row.member_name ?? row.api_key_name,
      accessLevel: row.access_level,
      grantedById: row.granted_by_id,
      createdAt: row.created_at,
    }));
  }

  async upsertGrant(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
    input: UpsertGrantDto,
  ): Promise<KnowledgeBaseGrantDto> {
    const { knowledgeBase } = await this.access.requireKnowledgeBase(
      principal,
      knowledgeBaseId,
      AccessLevel.MANAGE,
    );

    await this.assertSubjectExists(
      principal.organizationId,
      input.subjectType,
      input.subjectId,
    );

    const column = subjectColumn(input.subjectType);

    const grant = await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(KnowledgeBaseGrant);
      const existing = await repository.findOne({
        where: { knowledgeBaseId, [column]: input.subjectId },
      });

      const previousLevel = existing?.accessLevel ?? null;
      const saved = await repository.save(
        existing
          ? Object.assign(existing, {
              accessLevel: input.accessLevel,
              grantedById: principal.userId ?? null,
            })
          : repository.create({
              organizationId: principal.organizationId,
              knowledgeBaseId,
              roleId: null,
              memberId: null,
              apiKeyId: null,
              [column]: input.subjectId,
              accessLevel: input.accessLevel,
              grantedById: principal.userId ?? null,
            }),
      );

      await this.auditService.record(
        {
          action: AuditAction.KNOWLEDGE_BASE_ACCESS_GRANTED,
          organizationId: principal.organizationId,
          resourceType: 'knowledge_base',
          resourceId: knowledgeBase.id,
          resourceLabel: knowledgeBase.name,
          metadata: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            accessLevel: input.accessLevel,
            previousLevel,
          },
        },
        manager,
      );

      return saved;
    });

    const [view] = (await this.listGrants(principal, knowledgeBaseId)).filter(
      (entry) => entry.id === grant.id,
    );
    return view;
  }

  async revokeGrant(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
    grantId: string,
  ): Promise<void> {
    const { knowledgeBase } = await this.access.requireKnowledgeBase(
      principal,
      knowledgeBaseId,
      AccessLevel.MANAGE,
    );

    const grant = await this.grantRepository.findOne({
      where: { id: grantId, knowledgeBaseId, organizationId: principal.organizationId },
    });
    if (!grant) throw new NotFoundError(ErrorCode.KNOWLEDGE_BASE_GRANT_NOT_FOUND);

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(KnowledgeBaseGrant).delete({ id: grant.id });
      await this.auditService.record(
        {
          action: AuditAction.KNOWLEDGE_BASE_ACCESS_REVOKED,
          organizationId: principal.organizationId,
          resourceType: 'knowledge_base',
          resourceId: knowledgeBase.id,
          resourceLabel: knowledgeBase.name,
          metadata: {
            subjectType: grant.subjectType,
            subjectId: grant.subjectId,
            accessLevel: grant.accessLevel,
          },
        },
        manager,
      );
    });
  }

  // ── Guard rails ───────────────────────────────────────────────────────────

  private async ensureCreatorGrant(
    manager: EntityManager,
    scope: AccessScope,
    knowledgeBase: KnowledgeBase,
  ): Promise<void> {
    // The owner bypasses compartments already; an API key cannot create bases.
    if (scope.superuser || !scope.principal.membershipId) return;

    const repository = manager.getRepository(KnowledgeBaseGrant);
    const existing = await repository.findOne({
      where: { knowledgeBaseId: knowledgeBase.id, memberId: scope.principal.membershipId },
    });

    if (existing) {
      if (existing.accessLevel !== AccessLevel.MANAGE) {
        existing.accessLevel = AccessLevel.MANAGE;
        await repository.save(existing);
      }
      return;
    }

    await repository.save(
      repository.create({
        organizationId: knowledgeBase.organizationId,
        knowledgeBaseId: knowledgeBase.id,
        roleId: null,
        memberId: scope.principal.membershipId,
        apiKeyId: null,
        accessLevel: AccessLevel.MANAGE,
        grantedById: scope.principal.userId ?? null,
      }),
    );
  }

  /**
   * A grant must name something that exists *in this workspace*. Without the
   * workspace condition, a grant could name another tenant's role id — inert,
   * since the access query is tenant-scoped, but a cross-tenant reference that
   * has no business existing.
   */
  private async assertSubjectExists(
    organizationId: string,
    subjectType: GrantSubjectType,
    subjectId: string,
  ): Promise<void> {
    const sql = {
      [GrantSubjectType.ROLE]:
        'SELECT 1 FROM roles WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [GrantSubjectType.MEMBER]: `SELECT 1 FROM organization_members
          WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND status <> 'REMOVED'`,
      [GrantSubjectType.API_KEY]:
        'SELECT 1 FROM api_keys WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL',
    }[subjectType];

    const rows: unknown[] = await this.dataSource.query(sql, [subjectId, organizationId]);
    if (rows.length === 0) {
      throw new NotFoundError(ErrorCode.RESOURCE_NOT_FOUND, {
        message: `No active ${subjectType.toLowerCase().replace('_', ' ')} with that id exists in this workspace.`,
      });
    }
  }

  private assertWithinClearance(scope: AccessScope, classification: Classification): void {
    if (!dominates(scope.clearance, classification)) {
      throw new ForbiddenError(ErrorCode.CLASSIFICATION_EXCEEDS_CLEARANCE, {
        details: { requested: classification, clearance: scope.clearance },
      });
    }
  }

  /**
   * The overlap must be smaller than the chunk size that will actually apply:
   * a level this base leaves unset is inherited from the workspace, then the
   * platform, exactly as ingestion resolves it. Validating against the platform
   * default alone accepted overlaps that ingestion then silently shrank.
   */
  private async assertChunking(
    organizationId: string,
    chunkSize: number | null,
    chunkOverlap: number | null,
    requested: { chunkSize?: number | null; chunkOverlap?: number | null },
  ): Promise<void> {
    const rows: Array<{ settings: Record<string, unknown> | null }> =
      await this.dataSource.query('SELECT settings FROM organizations WHERE id = $1', [
        organizationId,
      ]);
    const { size, overlap } = effectiveChunking(
      { chunkSize, chunkOverlap },
      rows[0]?.settings,
      {
        chunkSize: this.ingestion.chunkSizeDefault,
        chunkOverlap: this.ingestion.chunkOverlapDefault,
      },
    );

    if (overlap >= size) {
      // Filed under the field the caller sent, so the form can mark it.
      const fields =
        requested.chunkOverlap !== undefined && requested.chunkOverlap !== null
          ? { chunkOverlap: [`must be smaller than the chunk size (${size})`] }
          : { chunkSize: [`must be larger than the chunk overlap (${overlap})`] };

      throw new ValidationError({
        message: `Chunk overlap (${overlap}) must be smaller than chunk size (${size}).`,
        details: { fields },
      });
    }
  }

  private translateUniqueViolation(error: unknown): unknown {
    if ((error as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
      return new ConflictError(ErrorCode.KNOWLEDGE_BASE_NAME_TAKEN);
    }
    return error;
  }

  private toDto(
    knowledgeBase: KnowledgeBase,
    access: AccessLevel,
    stats: KnowledgeBaseStatsDto | undefined,
  ): KnowledgeBaseDto {
    return {
      id: knowledgeBase.id,
      name: knowledgeBase.name,
      description: knowledgeBase.description,
      accessMode: knowledgeBase.accessMode,
      defaultClassification: knowledgeBase.defaultClassification,
      embeddingModel: knowledgeBase.embeddingModel,
      embeddingDimensions: knowledgeBase.embeddingDimensions,
      chunkSize: knowledgeBase.chunkSize,
      chunkOverlap: knowledgeBase.chunkOverlap,
      access,
      stats: stats ?? { documents: 0, ready: 0, processing: 0, failed: 0, totalBytes: '0' },
      createdById: knowledgeBase.createdById,
      createdAt: knowledgeBase.createdAt,
      updatedAt: knowledgeBase.updatedAt,
    };
  }
}

function subjectColumn(type: GrantSubjectType): 'roleId' | 'memberId' | 'apiKeyId' {
  switch (type) {
    case GrantSubjectType.ROLE:
      return 'roleId';
    case GrantSubjectType.MEMBER:
      return 'memberId';
    case GrantSubjectType.API_KEY:
      return 'apiKeyId';
  }
}

/** Escapes LIKE wildcards in user input so `%` and `_` match literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
