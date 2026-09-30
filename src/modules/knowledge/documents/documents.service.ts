import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { AuditAction, AuditStatus } from '../../../common/enums/audit-action.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import {
  AppException,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/exceptions/app.exception';
import { formatByteSize } from '../../../common/utils/byte-size.util';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import { sanitizeFilename, stripExtension } from '../../../common/utils/text.util';
import { STORAGE_CONFIG_KEY, type StorageConfig } from '../../../config/storage.config';
import { returnedRows } from '../../../database/query.util';
import { ContentEncryptionService } from '../../../shared/crypto/content-encryption.service';
import { ObjectStorageService } from '../../../shared/storage/object-storage.service';
import { AuditService } from '../../audit/audit.service';
import { toDependencyException } from '../dependency-errors';
import {
  AccessLevel,
  atLeast,
  readableKnowledgeBaseIds,
  type AccessPrincipal,
  type AccessScope,
} from '../domain/access';
import {
  type Classification,
  classificationsWithin,
  dominates,
} from '../domain/classification';
import { DocumentStatus } from '../domain/document-status';
import { DocumentChunk } from '../entities/document-chunk.entity';
import { Document } from '../entities/document.entity';
import { MAINTENANCE_JOB } from '../ingestion/knowledge-jobs';
import { KnowledgeJobsService } from '../ingestion/knowledge-jobs.service';
import { KnowledgeBaseAccessService } from '../knowledge-bases/knowledge-base-access.service';
import { escapeLike } from '../knowledge-bases/knowledge-bases.service';
import { KnowledgeReadinessService } from '../knowledge-readiness.service';
import type {
  DocumentChunkDto,
  DocumentDto,
  UpdateDocumentDto,
  UploadDocumentDto,
  UploadedDocumentFile,
} from './dto/document.dto';
import { chunkAad, dataKeyBinding, originalObjectAad } from './content-binding';
import { FileInspectionError, inspectFile, type FileInspection } from './file-inspection';

const PG_UNIQUE_VIOLATION = '23505';
/** Advisory-lock namespace serialising quota checks per workspace. */
const QUOTA_LOCK_NAMESPACE = 918_274;
const SORTABLE = ['createdAt', 'updatedAt', 'title', 'sizeBytes', 'status'] as const;

export interface DocumentDownload {
  content: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * The Document Vault (proposal module 6.4).
 *
 * ## What an upload does, in order
 *
 *  1. **Authorises** — WRITE on the knowledge base, and a classification within
 *     the uploader's clearance.
 *  2. **Inspects** the bytes (see `file-inspection.ts`). The client's
 *     `Content-Type` is never consulted.
 *  3. **Encrypts** under a fresh per-document key and writes the ciphertext to
 *     object storage.
 *  4. **Records** the document, its wrapped key and an audit entry in one
 *     transaction, after a quota check under a per-workspace lock.
 *  5. **Enqueues** ingestion. If that fails the upload still succeeds: the row
 *     is the source of truth and the maintenance sweep enqueues it later.
 *
 * Step 3 precedes step 4 so that a committed row always has its object. The
 * reverse failure — an object whose row never committed — is cleaned up on the
 * spot, best effort; any survivor is unreadable ciphertext whose key was never
 * stored.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly storageConfig: StorageConfig;

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(DocumentChunk)
    private readonly chunkRepository: Repository<DocumentChunk>,
    private readonly dataSource: DataSource,
    private readonly access: KnowledgeBaseAccessService,
    private readonly readiness: KnowledgeReadinessService,
    private readonly storage: ObjectStorageService,
    private readonly contentEncryption: ContentEncryptionService,
    private readonly jobs: KnowledgeJobsService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.storageConfig = configService.getOrThrow<StorageConfig>(STORAGE_CONFIG_KEY);
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  async upload(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
    file: UploadedDocumentFile | undefined,
    input: UploadDocumentDto,
  ): Promise<DocumentDto> {
    this.readiness.assert('ingestion');

    if (!file?.buffer) {
      throw new BadRequestError(ErrorCode.BAD_REQUEST, {
        message: 'Attach the document as a multipart field named "file".',
      });
    }

    const { scope, knowledgeBase } = await this.access.requireKnowledgeBase(
      principal,
      knowledgeBaseId,
      AccessLevel.WRITE,
    );

    const filename = sanitizeFilename(file.originalname);
    const inspection = await this.inspect(principal, knowledgeBaseId, file, filename);

    const classification = input.classification ?? knowledgeBase.defaultClassification;
    this.assertWithinClearance(scope, classification);

    const fingerprint = this.contentEncryption.fingerprint(file.buffer);
    await this.assertNotDuplicate(scope, knowledgeBaseId, fingerprint);

    const documentId = randomUUID();
    const storageKey = this.storage.key(
      'orgs',
      principal.organizationId,
      'kbs',
      knowledgeBaseId,
      'documents',
      documentId,
      'original',
    );

    const dataKey = this.contentEncryption.generateDataKey(dataKeyBinding(documentId));
    try {
      const sealed = this.contentEncryption.encrypt(
        dataKey.plaintext,
        file.buffer,
        originalObjectAad(documentId),
      );
      // Deliberately generic content type and minimal metadata: the provider
      // learns the object's size and nothing about what it is.
      await this.storage.put(storageKey, sealed, {
        contentType: 'application/octet-stream',
        metadata: { 'daiap-envelope': 'DAE1' },
      });
    } catch (error) {
      throw toDependencyException(error);
    } finally {
      this.contentEncryption.destroy(dataKey.plaintext);
    }

    let document: Document;
    try {
      document = await this.dataSource.transaction(async (manager) => {
        await this.assertQuota(manager, principal.organizationId, file.buffer.length);

        const saved = await manager.getRepository(Document).save(
          manager.getRepository(Document).create({
            id: documentId,
            organizationId: principal.organizationId,
            knowledgeBaseId,
            title: input.title ?? stripExtension(filename).slice(0, 255),
            description: input.description || null,
            tags: input.tags ?? [],
            originalFilename: filename,
            fileType: inspection.fileType,
            mimeType: inspection.mimeType,
            sizeBytes: String(file.buffer.length),
            contentFingerprint: fingerprint,
            storageKey,
            wrappedDataKey: dataKey.wrapped,
            classification,
            status: DocumentStatus.UPLOADED,
            lastStatusAt: new Date(),
            indexVersion: 1,
            activeIndexVersion: null,
            processingMetrics: {},
            uploadedById: principal.kind === 'user' ? (principal.userId ?? null) : null,
            uploadedByApiKeyId: principal.apiKeyId ?? null,
          }),
        );

        await this.auditService.record(
          {
            action: AuditAction.DOCUMENT_UPLOADED,
            organizationId: principal.organizationId,
            resourceType: 'document',
            resourceId: saved.id,
            resourceLabel: saved.title,
            metadata: {
              knowledgeBaseId,
              fileType: inspection.fileType,
              sizeBytes: file.buffer.length,
              classification,
              declaredMimeType: file.mimetype,
            },
          },
          manager,
        );

        return saved;
      });
    } catch (error) {
      await this.storage
        .delete(storageKey)
        .catch((cleanup: Error) =>
          this.logger.warn(
            `Orphaned object ${storageKey} could not be removed: ${cleanup.message}`,
          ),
        );

      if ((error as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError(ErrorCode.DOCUMENT_DUPLICATE);
      }
      throw error;
    }

    if (await this.jobs.enqueueIngestion(document)) {
      await this.documentRepository.update({ id: document.id }, { enqueuedAt: new Date() });
    }

    return this.toDto(document);
  }

  /** Runs content inspection, auditing and translating any refusal. */
  private async inspect(
    principal: AccessPrincipal,
    knowledgeBaseId: string,
    file: UploadedDocumentFile,
    filename: string,
  ): Promise<FileInspection> {
    try {
      return inspectFile(file.buffer, filename, {
        allowedTypes: this.storageConfig.uploads.allowedTypes,
        maxUncompressedBytes: Math.max(
          this.storageConfig.uploads.maxFileSizeBytes * 10,
          256 * 1024 ** 2,
        ),
        maxCompressionRatio: 100,
      });
    } catch (error) {
      if (!(error instanceof FileInspectionError)) throw error;

      // A refused upload is a security signal — a disguised executable, a
      // macro-laden document — so it is recorded, not just rejected.
      await this.auditService.recordSafe({
        action: AuditAction.DOCUMENT_UPLOAD_REJECTED,
        status: AuditStatus.DENIED,
        organizationId: principal.organizationId,
        resourceType: 'knowledge_base',
        resourceId: knowledgeBaseId,
        metadata: {
          filename,
          reason: error.reason,
          detected: error.detected,
          declaredMimeType: file.mimetype,
          sizeBytes: file.buffer.length,
        },
      });

      const code =
        error.reason === 'EMPTY'
          ? ErrorCode.DOCUMENT_EMPTY
          : error.reason === 'CONTENT_MISMATCH'
            ? ErrorCode.DOCUMENT_CONTENT_MISMATCH
            : ErrorCode.DOCUMENT_TYPE_NOT_ALLOWED;

      throw new AppException(code, HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
        message: error.message,
        details: {
          reason: error.reason,
          allowedTypes: this.storageConfig.uploads.allowedTypes,
        },
      });
    }
  }

  private async assertNotDuplicate(
    scope: AccessScope,
    knowledgeBaseId: string,
    fingerprint: string,
  ): Promise<void> {
    const existing = await this.documentRepository.findOne({
      where: { knowledgeBaseId, contentFingerprint: fingerprint },
      select: { id: true, classification: true, title: true },
    });
    if (!existing) return;

    // Name the existing copy only to someone cleared to see it; otherwise the
    // error would confirm the existence of a document above their clearance.
    const visible = dominates(scope.clearance, existing.classification);
    throw new ConflictError(ErrorCode.DOCUMENT_DUPLICATE, {
      details: visible
        ? { existingDocumentId: existing.id, existingTitle: existing.title }
        : {},
    });
  }

  /**
   * Enforces the per-workspace storage quota.
   *
   * The check and the insert that follows share a transaction holding a
   * workspace-scoped advisory lock, so two concurrent uploads cannot both see
   * "just enough room left".
   */
  private async assertQuota(
    manager: EntityManager,
    organizationId: string,
    incomingBytes: number,
  ): Promise<void> {
    const quota = this.storageConfig.quotaBytesPerOrganization;
    if (quota <= 0) return;

    await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      QUOTA_LOCK_NAMESPACE,
      organizationId,
    ]);

    const [{ used }]: Array<{ used: string }> = await manager.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::text AS used
         FROM documents WHERE organization_id = $1 AND deleted_at IS NULL`,
      [organizationId],
    );

    if (Number(used) + incomingBytes > quota) {
      throw new ForbiddenError(ErrorCode.STORAGE_QUOTA_EXCEEDED, {
        message: `This upload would exceed the workspace's ${formatByteSize(quota)} storage quota.`,
        details: { quotaBytes: quota, usedBytes: Number(used), incomingBytes },
      });
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(
    principal: AccessPrincipal,
    query: {
      page: number;
      limit: number;
      knowledgeBaseId?: string;
      status?: DocumentStatus[];
      classification?: Classification;
      search?: string;
      sortBy?: string;
      sortDirection: 'ASC' | 'DESC';
    },
  ): Promise<PaginatedResult<DocumentDto>> {
    const scope = await this.access.resolveScope(principal);
    const empty = { items: [], meta: buildPaginationMeta(0, query.page, query.limit) };

    let knowledgeBaseIds = readableKnowledgeBaseIds(scope);
    if (query.knowledgeBaseId) {
      if (!scope.knowledgeBases.has(query.knowledgeBaseId)) {
        await this.access.recordHiddenProbe(
          principal,
          'knowledge_base',
          query.knowledgeBaseId,
        );
        throw new NotFoundError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND);
      }
      knowledgeBaseIds = [query.knowledgeBaseId];
    }

    let classifications = classificationsWithin(scope.clearance);
    if (query.classification) {
      if (!classifications.includes(query.classification)) return empty;
      classifications = [query.classification];
    }

    if (knowledgeBaseIds.length === 0) return empty;

    const sortBy = SORTABLE.includes(query.sortBy as (typeof SORTABLE)[number])
      ? (query.sortBy as (typeof SORTABLE)[number])
      : 'createdAt';

    const builder = this.documentRepository
      .createQueryBuilder('document')
      .where('document.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      })
      .andWhere('document.knowledge_base_id IN (:...knowledgeBaseIds)', {
        knowledgeBaseIds,
      })
      .andWhere('document.classification IN (:...classifications)', { classifications });

    if (query.status?.length) {
      builder.andWhere('document.status IN (:...statuses)', { statuses: query.status });
    }
    if (query.search) {
      builder.andWhere('document.title ILIKE :search', {
        search: `%${escapeLike(query.search)}%`,
      });
    }

    const [documents, total] = await builder
      .orderBy(`document.${sortBy}`, query.sortDirection)
      .addOrderBy('document.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    return {
      items: documents.map((document) => this.toDto(document)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async get(principal: AccessPrincipal, documentId: string): Promise<DocumentDto> {
    const { document } = await this.loadVisible(principal, documentId, AccessLevel.READ);
    return this.toDto(document);
  }

  /**
   * The decrypted chunks of the version retrieval currently serves.
   *
   * Lets a user see exactly what the model will be shown — which is also the
   * most direct way to debug a poor answer.
   */
  async listChunks(
    principal: AccessPrincipal,
    documentId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<DocumentChunkDto>> {
    const { document } = await this.loadVisible(
      principal,
      documentId,
      AccessLevel.READ,
      true,
    );

    if (document.activeIndexVersion === null || !document.wrappedDataKey) {
      return { items: [], meta: buildPaginationMeta(0, page, limit) };
    }

    const [chunks, total] = await this.chunkRepository.findAndCount({
      where: { documentId: document.id, indexVersion: document.activeIndexVersion },
      order: { chunkIndex: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const key = this.contentEncryption.unwrapDataKey(
      document.wrappedDataKey,
      dataKeyBinding(document.id),
    );

    try {
      return {
        items: chunks.map((chunk) => ({
          id: chunk.id,
          chunkIndex: chunk.chunkIndex,
          text: this.contentEncryption.decryptText(
            key,
            chunk.contentCiphertext,
            chunkAad(chunk.id),
          ),
          tokenCount: chunk.tokenCount,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        })),
        meta: buildPaginationMeta(total, page, limit),
      };
    } finally {
      this.contentEncryption.destroy(key);
    }
  }

  /**
   * Returns the original file, decrypted and authenticated.
   *
   * Decrypted in full before a byte is sent: the GCM tag is only verifiable at
   * the end, and streaming first would mean serving a tampered file right up to
   * the moment the tampering was detected.
   */
  async download(
    principal: AccessPrincipal,
    documentId: string,
  ): Promise<DocumentDownload> {
    this.readiness.assert('download');

    const { document } = await this.loadVisible(
      principal,
      documentId,
      AccessLevel.READ,
      true,
    );

    if (!document.wrappedDataKey) {
      throw new AppException(ErrorCode.DOCUMENT_CONTENT_UNAVAILABLE, HttpStatus.GONE);
    }

    let sealed: Buffer;
    try {
      sealed = await this.storage.get(
        document.storageKey,
        this.storageConfig.uploads.maxFileSizeBytes + 1024,
      );
    } catch (error) {
      throw toDependencyException(error);
    }

    const key = this.contentEncryption.unwrapDataKey(
      document.wrappedDataKey,
      dataKeyBinding(document.id),
    );

    let content: Buffer;
    try {
      content = this.contentEncryption.decrypt(key, sealed, originalObjectAad(document.id));
    } catch (error) {
      this.logger.error(
        `Integrity check failed for document ${document.id}: ${(error as Error).message}`,
      );
      throw new AppException(ErrorCode.DOCUMENT_CONTENT_UNAVAILABLE, HttpStatus.CONFLICT, {
        message: 'The stored file failed its integrity check and will not be served.',
      });
    } finally {
      this.contentEncryption.destroy(key);
    }

    await this.auditService.recordSafe({
      action: AuditAction.DOCUMENT_DOWNLOADED,
      organizationId: principal.organizationId,
      resourceType: 'document',
      resourceId: document.id,
      resourceLabel: document.title,
      metadata: { classification: document.classification, sizeBytes: content.length },
    });

    return { content, filename: document.originalFilename, mimeType: document.mimeType };
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async update(
    principal: AccessPrincipal,
    documentId: string,
    input: UpdateDocumentDto,
  ): Promise<DocumentDto> {
    const { scope, document } = await this.loadVisible(
      principal,
      documentId,
      AccessLevel.WRITE,
    );

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.title !== undefined && input.title !== document.title) {
      changes.title = { from: document.title, to: input.title };
      document.title = input.title;
    }
    // An empty description is no description.
    const description = input.description === '' ? null : input.description;
    if (description !== undefined && description !== document.description) {
      changes.description = { from: document.description, to: description };
      document.description = description;
    }
    if (input.tags !== undefined) {
      changes.tags = { from: document.tags, to: input.tags };
      document.tags = input.tags;
    }

    const reclassified =
      input.classification !== undefined && input.classification !== document.classification
        ? { from: document.classification, to: input.classification }
        : null;

    if (reclassified) {
      // Clearance over the current level is implied by visibility; the new
      // level must be within clearance too, or the caller could classify a
      // document up and out of their own sight, or down to leak it.
      this.assertWithinClearance(scope, reclassified.to);
      document.classification = reclassified.to;
      document.vectorSyncRequired = true;
    }

    if (Object.keys(changes).length === 0 && !reclassified) return this.toDto(document);

    const saved = await this.dataSource.transaction(async (manager) => {
      const result = await manager.getRepository(Document).save(document);

      if (Object.keys(changes).length > 0) {
        await this.auditService.record(
          {
            action: AuditAction.DOCUMENT_UPDATED,
            organizationId: principal.organizationId,
            resourceType: 'document',
            resourceId: document.id,
            resourceLabel: document.title,
            metadata: { changes },
          },
          manager,
        );
      }

      if (reclassified) {
        await this.auditService.record(
          {
            action: AuditAction.DOCUMENT_RECLASSIFIED,
            organizationId: principal.organizationId,
            resourceType: 'document',
            resourceId: document.id,
            resourceLabel: document.title,
            metadata: reclassified,
          },
          manager,
        );
      }

      return result;
    });

    // PostgreSQL is already authoritative — retrieval re-checks classification
    // there — so updating the vector payloads can safely happen afterwards.
    if (reclassified) {
      await this.jobs.enqueueMaintenance(
        MAINTENANCE_JOB.SYNC_DOCUMENT_VECTORS,
        { organizationId: principal.organizationId, documentId: document.id },
        document.id,
      );
    }

    return this.toDto(saved);
  }

  /**
   * Deletes a document and destroys its content.
   *
   * The data key is nulled and the chunk rows deleted inside the transaction,
   * so the content is unrecoverable — from backups too — the moment this
   * returns. The row remains as a tombstone for the audit trail; vectors and the
   * stored object are removed by a background purge.
   */
  async remove(principal: AccessPrincipal, documentId: string): Promise<void> {
    const { document } = await this.loadVisible(principal, documentId, AccessLevel.WRITE);

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(DocumentChunk).delete({ documentId: document.id });
      await manager.query(
        `UPDATE documents
            SET deleted_at = now(), wrapped_data_key = NULL
          WHERE id = $1 AND deleted_at IS NULL`,
        [document.id],
      );

      await this.auditService.record(
        {
          action: AuditAction.DOCUMENT_DELETED,
          organizationId: principal.organizationId,
          resourceType: 'document',
          resourceId: document.id,
          resourceLabel: document.title,
          metadata: {
            knowledgeBaseId: document.knowledgeBaseId,
            classification: document.classification,
            keyShredded: true,
          },
        },
        manager,
      );
    });

    await this.jobs.enqueueMaintenance(
      MAINTENANCE_JOB.PURGE_DOCUMENT,
      { organizationId: principal.organizationId, documentId: document.id },
      document.id,
    );
  }

  /**
   * Re-runs ingestion as a new index version.
   *
   * A compare-and-set on the status makes this safe against double clicks and
   * against a run already in progress: only a READY or FAILED document moves,
   * and only once. The current version keeps serving retrieval until the new
   * one completes.
   */
  async reindex(principal: AccessPrincipal, documentId: string): Promise<DocumentDto> {
    this.readiness.assert('ingestion');
    const { document } = await this.loadVisible(principal, documentId, AccessLevel.WRITE);

    const bumped = returnedRows<{ index_version: number }>(
      await this.dataSource.query(
        `UPDATE documents
          SET index_version = index_version + 1,
              status = 'UPLOADED',
              status_message = NULL,
              failure_code = NULL,
              attempts = 0,
              enqueued_at = NULL,
              processing_metrics = '{}'::jsonb,
              last_status_at = now()
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
          AND status IN ('READY','FAILED')
      RETURNING index_version`,
        [document.id, principal.organizationId],
      ),
    );

    const [row] = bumped;
    if (!row) {
      throw new ConflictError(ErrorCode.DOCUMENT_PROCESSING, {
        details: { status: document.status },
      });
    }

    const indexVersion = Number(row.index_version);

    await this.auditService.recordSafe({
      action: AuditAction.DOCUMENT_REINDEX_REQUESTED,
      organizationId: principal.organizationId,
      resourceType: 'document',
      resourceId: document.id,
      resourceLabel: document.title,
      metadata: { indexVersion, previousStatus: document.status },
    });

    if (await this.jobs.enqueueIngestion({ ...document, indexVersion })) {
      await this.documentRepository.update({ id: document.id }, { enqueuedAt: new Date() });
    }

    return this.get(principal, documentId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Loads a document the principal may act on, or throws.
   *
   * Out-of-compartment and above-clearance documents are both reported as not
   * found — the response for a nonexistent id — while the attempt is audited.
   */
  private async loadVisible(
    principal: AccessPrincipal,
    documentId: string,
    required: AccessLevel,
    withKey = false,
  ): Promise<{ scope: AccessScope; document: Document }> {
    const scope = await this.access.resolveScope(principal);

    const builder = this.documentRepository
      .createQueryBuilder('document')
      .where('document.id = :documentId', { documentId })
      .andWhere('document.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });
    if (withKey) builder.addSelect('document.wrappedDataKey');

    const document = await builder.getOne();
    if (!document) throw new NotFoundError(ErrorCode.DOCUMENT_NOT_FOUND);

    const level = scope.knowledgeBases.get(document.knowledgeBaseId);
    const cleared = dominates(scope.clearance, document.classification);

    if (!level || !cleared) {
      await this.access.recordHiddenProbe(
        principal,
        'document',
        document.id,
        level ? 'clearance' : 'compartment',
      );
      throw new NotFoundError(ErrorCode.DOCUMENT_NOT_FOUND);
    }

    if (!atLeast(level, required)) {
      throw new ForbiddenError(ErrorCode.KNOWLEDGE_BASE_ACCESS_DENIED, {
        details: { required, granted: level },
      });
    }

    return { scope, document };
  }

  private assertWithinClearance(scope: AccessScope, classification: Classification): void {
    if (!dominates(scope.clearance, classification)) {
      throw new ForbiddenError(ErrorCode.CLASSIFICATION_EXCEEDS_CLEARANCE, {
        details: { requested: classification, clearance: scope.clearance },
      });
    }
  }

  toDto(document: Document): DocumentDto {
    return {
      id: document.id,
      knowledgeBaseId: document.knowledgeBaseId,
      title: document.title,
      description: document.description,
      tags: document.tags ?? [],
      originalFilename: document.originalFilename,
      fileType: document.fileType,
      mimeType: document.mimeType,
      sizeBytes: String(document.sizeBytes),
      classification: document.classification,
      status: document.status,
      statusMessage: document.statusMessage,
      failureCode: document.failureCode,
      isSearchable: document.activeIndexVersion !== null && !document.deletedAt,
      indexVersion: document.indexVersion,
      activeIndexVersion: document.activeIndexVersion,
      chunkCount: document.chunkCount,
      tokenCount: document.tokenCount,
      pageCount: document.pageCount,
      language: document.language,
      embeddingModel: document.embeddingModel,
      processingMetrics: (document.processingMetrics ?? {}) as Record<string, number>,
      uploadedById: document.uploadedById,
      lastStatusAt: document.lastStatusAt,
      processingCompletedAt: document.processingCompletedAt,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }
}
