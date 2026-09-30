import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { AuditAction, AuditStatus } from '../../../common/enums/audit-action.enum';
import { stripControlCharacters } from '../../../common/utils/text.util';
import {
  INGESTION_CONFIG_KEY,
  type IngestionConfig,
} from '../../../config/ingestion.config';
import { STORAGE_CONFIG_KEY, type StorageConfig } from '../../../config/storage.config';
import {
  VECTOR_STORE_CONFIG_KEY,
  type VectorStoreConfig,
} from '../../../config/vector-store.config';
import { AiServiceClient } from '../../../shared/ai-service/ai-service.client';
import {
  AiServiceError,
  type ParsedDocument,
} from '../../../shared/ai-service/ai-service.types';
import { RequestContextService } from '../../../shared/context/request-context.service';
import { ContentEncryptionService } from '../../../shared/crypto/content-encryption.service';
import { QUEUE_NAME } from '../../../shared/queue/queue.constants';
import {
  ObjectStorageError,
  ObjectStorageService,
} from '../../../shared/storage/object-storage.service';
import { encodeDocument } from '../../../shared/vector-store/sparse-encoder';
import {
  VectorStoreError,
  VectorStoreService,
} from '../../../shared/vector-store/vector-store.service';
import { AuditService } from '../../audit/audit.service';
import {
  DocumentStatus,
  FILE_TYPE_DETAILS,
  IN_FLIGHT_STATUSES,
  sourcesOf,
} from '../domain/document-status';
import { chunkId, DocumentChunk } from '../entities/document-chunk.entity';
import { Document, type DocumentProcessingMetrics } from '../entities/document.entity';
import { KnowledgeBase } from '../entities/knowledge-base.entity';
import { resolveChunking } from './chunking';
import { chunkAad, dataKeyBinding, originalObjectAad } from '../documents/content-binding';
import type { IngestionJobData } from './knowledge-jobs';
import { KnowledgeJobsService } from './knowledge-jobs.service';

/** Rows per INSERT when persisting chunks. Keeps each statement well under PostgreSQL's parameter cap. */
const CHUNK_INSERT_BATCH = 500;

/** A failure with a user-facing code and an explicit retry decision. */
export class IngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'IngestionError';
  }
}

/** The document moved on (deleted, or a newer version requested). Not a failure. */
class SupersededError extends Error {
  constructor(readonly reason: string) {
    super(`Ingestion superseded: ${reason}`);
    this.name = 'SupersededError';
  }
}

export interface IngestionOutcome {
  outcome: 'ready' | 'skipped';
  reason?: string;
  chunks?: number;
}

/**
 * Parse → chunk → embed → index, for one version of one document
 * (proposal modules 6.4 and 6.5).
 *
 * ## Crash safety, by construction rather than by bookkeeping
 *
 *  - **Every status change is a compare-and-set** on `(id, index_version,
 *    expected status)`. A job for a superseded version, or for a document
 *    deleted underneath it, finds zero rows to update and stops quietly.
 *  - **Chunks are written in the same transaction as CHUNKING → EMBEDDING.**
 *    After a crash, EMBEDDING means "all chunks are persisted" and anything
 *    earlier means "none are". There is no half-chunked state to repair.
 *  - **Chunk ids are derived** from `(document, version, position)` and double
 *    as vector point ids, so re-embedding after a crash overwrites the same
 *    points. A worker dying mid-embedding cannot produce duplicate chunks —
 *    which is the phase's stated exit criterion.
 *  - **Progress is checkpointed per batch** (`embedded_at`). A retry resumes
 *    from the first un-embedded chunk instead of paying for the whole document
 *    again.
 *  - **Nothing is searchable until everything is.** Points are written with
 *    `active = false` and flipped only after the final batch, so a query can
 *    never retrieve half a document.
 *
 * ## Failure policy
 *
 * Transient failures (a dependency timing out) are retried by BullMQ with
 * exponential backoff; once attempts are exhausted the document is marked
 * FAILED and a metadata-only record goes to the dead-letter queue. Permanent
 * failures (an encrypted PDF, a file with no text) fail immediately with a
 * message the user can act on — retrying them only delays the bad news.
 */
@Injectable()
export class IngestionPipeline {
  private readonly logger = new Logger(IngestionPipeline.name);
  private readonly config: IngestionConfig;
  private readonly storageConfig: StorageConfig;
  private readonly vectorConfig: VectorStoreConfig;

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(DocumentChunk)
    private readonly chunkRepository: Repository<DocumentChunk>,
    @InjectRepository(KnowledgeBase)
    private readonly knowledgeBaseRepository: Repository<KnowledgeBase>,
    private readonly dataSource: DataSource,
    private readonly storage: ObjectStorageService,
    private readonly vectorStore: VectorStoreService,
    private readonly aiService: AiServiceClient,
    private readonly contentEncryption: ContentEncryptionService,
    private readonly jobs: KnowledgeJobsService,
    private readonly auditService: AuditService,
    private readonly requestContext: RequestContextService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<IngestionConfig>(INGESTION_CONFIG_KEY);
    this.storageConfig = configService.getOrThrow<StorageConfig>(STORAGE_CONFIG_KEY);
    this.vectorConfig =
      configService.getOrThrow<VectorStoreConfig>(VECTOR_STORE_CONFIG_KEY);
  }

  /** BullMQ processor entry point. */
  async process(job: Job<IngestionJobData>): Promise<IngestionOutcome> {
    // Carry the upload's correlation id into every log line and audit record
    // this job produces, so one id traces the document end to end.
    return this.requestContext.run(
      {
        requestId: job.data.requestId ?? `job-${job.id}`,
        startTime: Date.now(),
        ip: 'internal',
        actorLabel: 'ingestion worker',
      },
      () => this.run(job),
    );
  }

  private async run(job: Job<IngestionJobData>): Promise<IngestionOutcome> {
    const { data } = job;
    const startedAt = Date.now();
    const deadline = startedAt + this.config.jobTimeoutMs;

    const document = await this.loadDocument(data.documentId);
    // From here on the job works for the document's workspace only: every
    // connection it checks out is scoped to it by row-level security (phase 5).
    if (document) this.requestContext.bindTenant(document.organizationId);
    const skip = this.skipReason(document, data);
    if (skip) {
      this.logger.debug(
        `Skipping ingestion of ${data.documentId} v${data.indexVersion}: ${skip}.`,
      );
      return { outcome: 'skipped', reason: skip };
    }

    const current = document as Document & { wrappedDataKey: string };
    const knowledgeBase = await this.knowledgeBaseRepository.findOne({
      where: { id: current.knowledgeBaseId },
    });
    if (!knowledgeBase) return { outcome: 'skipped', reason: 'knowledge base deleted' };
    const chunking = await this.resolveChunking(current.organizationId, knowledgeBase);

    const metrics: DocumentProcessingMetrics = {
      ...(current.status === DocumentStatus.EMBEDDING ? current.processingMetrics : {}),
      queueWaitMs: Math.max(startedAt - data.enqueuedAt, 0),
      attempts: job.attemptsMade + 1,
    };

    try {
      // EMBEDDING with chunks on disk means a previous attempt got past the
      // chunking transaction: resume, rather than parse and pay again.
      const persisted = await this.chunkRepository.count({
        where: { documentId: current.id, indexVersion: data.indexVersion },
      });
      const resuming = current.status === DocumentStatus.EMBEDDING && persisted > 0;

      if (resuming) {
        await this.transition(current, DocumentStatus.EMBEDDING, {
          attempts: () => 'attempts + 1',
        });
        this.logger.log(
          `Resuming embedding for document ${current.id} v${data.indexVersion}.`,
        );
      } else {
        await this.transition(current, DocumentStatus.PARSING, {
          attempts: () => 'attempts + 1',
          processingStartedAt: new Date(),
          statusMessage: null,
          failureCode: null,
        });

        const content = await this.timed(metrics, 'downloadMs', () =>
          this.readPlaintext(current),
        );
        const parsed = await this.timed(metrics, 'parseMs', () =>
          this.aiService.parseDocument({
            organizationId: current.organizationId,
            documentId: current.id,
            fileType: FILE_TYPE_DETAILS[current.fileType].wire,
            filename: current.originalFilename,
            content,
            chunkSize: chunking.size,
            chunkOverlap: chunking.overlap,
            maxChunks: this.config.maxChunksPerDocument,
            signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
          }),
        );

        if (parsed.chunks.length === 0) {
          throw new IngestionError(
            'DOCUMENT_EMPTY',
            'No extractable text was found. Scanned documents need OCR support in the AI service.',
            false,
          );
        }

        await this.transition(current, DocumentStatus.CHUNKING);
        await this.timed(metrics, 'persistMs', () => this.persistChunks(current, parsed));

        await this.auditService.recordSafe({
          action: AuditAction.DOCUMENT_PARSED,
          organizationId: current.organizationId,
          resourceType: 'document',
          resourceId: current.id,
          resourceLabel: current.title,
          metadata: {
            indexVersion: data.indexVersion,
            chunks: parsed.chunks.length,
            pages: parsed.pageCount,
            parser: parsed.parser,
            parseMs: metrics.parseMs,
          },
        });
      }

      const embedded = await this.timed(metrics, 'embedMs', () =>
        this.embedPending(current, deadline),
      );
      metrics.embeddingTokens = (metrics.embeddingTokens ?? 0) + embedded.tokens;

      const chunkCount = await this.timed(metrics, 'indexMs', () =>
        this.activate(current, metrics, startedAt),
      );

      await this.auditService.recordSafe({
        action: AuditAction.DOCUMENT_EMBEDDED,
        organizationId: current.organizationId,
        resourceType: 'document',
        resourceId: current.id,
        resourceLabel: current.title,
        metadata: {
          indexVersion: data.indexVersion,
          chunks: chunkCount,
          embeddingModel: this.vectorConfig.embedding.model,
          resumed: resuming,
          metrics,
        },
      });

      return { outcome: 'ready', chunks: chunkCount };
    } catch (error) {
      if (error instanceof SupersededError) {
        return { outcome: 'skipped', reason: error.reason };
      }
      throw await this.handleFailure(job, current, error, metrics);
    }
  }

  // ── Stages ────────────────────────────────────────────────────────────────

  private async loadDocument(documentId: string): Promise<Document | null> {
    return this.documentRepository
      .createQueryBuilder('document')
      .withDeleted()
      .addSelect('document.wrappedDataKey')
      .where('document.id = :documentId', { documentId })
      .getOne();
  }

  private skipReason(document: Document | null, data: IngestionJobData): string | null {
    if (!document || document.deletedAt || !document.wrappedDataKey)
      return 'document deleted';
    if (document.indexVersion !== data.indexVersion) return 'superseded by a newer version';
    if (
      document.status === DocumentStatus.READY &&
      document.activeIndexVersion === data.indexVersion
    ) {
      return 'already complete';
    }
    if (document.status === DocumentStatus.FAILED) return 'already failed';
    return null;
  }

  /** Downloads, unwraps and authenticates the original upload. */
  private async readPlaintext(
    document: Document & { wrappedDataKey: string },
  ): Promise<Buffer> {
    const sealed = await this.storage.get(
      document.storageKey,
      this.storageConfig.uploads.maxFileSizeBytes + 1024,
    );
    const key = this.contentEncryption.unwrapDataKey(
      document.wrappedDataKey,
      dataKeyBinding(document.id),
    );

    try {
      return this.contentEncryption.decrypt(key, sealed, originalObjectAad(document.id));
    } catch (error) {
      throw new IngestionError(
        'CONTENT_INTEGRITY_FAILURE',
        'The stored file failed its integrity check and was not processed.',
        false,
        { cause: error },
      );
    } finally {
      this.contentEncryption.destroy(key);
    }
  }

  /** Chunking for this document: knowledge base, else workspace, else platform. */
  private async resolveChunking(
    organizationId: string,
    knowledgeBase: KnowledgeBase,
  ): Promise<{ size: number; overlap: number }> {
    const rows: Array<{ settings: Record<string, unknown> | null }> =
      await this.dataSource.query('SELECT settings FROM organizations WHERE id = $1', [
        organizationId,
      ]);
    return resolveChunking(knowledgeBase, rows[0]?.settings, {
      chunkSize: this.config.chunkSizeDefault,
      chunkOverlap: this.config.chunkOverlapDefault,
    });
  }

  /**
   * Encrypts and stores every chunk, and moves the document to EMBEDDING, in
   * one transaction. Either all of it happened or none of it did.
   */
  private async persistChunks(
    document: Document & { wrappedDataKey: string },
    parsed: ParsedDocument,
  ): Promise<void> {
    const version = document.indexVersion;
    const key = this.contentEncryption.unwrapDataKey(
      document.wrappedDataKey,
      dataKeyBinding(document.id),
    );

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(DocumentChunk).delete({
          documentId: document.id,
          indexVersion: version,
        });

        const rows = parsed.chunks.map((chunk) => {
          const id = chunkId(document.id, version, chunk.index);
          return {
            id,
            organizationId: document.organizationId,
            documentId: document.id,
            indexVersion: version,
            chunkIndex: chunk.index,
            contentCiphertext: this.contentEncryption.encryptText(
              key,
              chunk.text,
              chunkAad(id),
            ),
            tokenCount: chunk.tokenCount,
            charCount: chunk.text.length,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            embeddedAt: null,
          };
        });

        for (let offset = 0; offset < rows.length; offset += CHUNK_INSERT_BATCH) {
          await manager
            .createQueryBuilder()
            .insert()
            .into(DocumentChunk)
            .values(rows.slice(offset, offset + CHUNK_INSERT_BATCH))
            .execute();
        }

        const moved = await manager
          .createQueryBuilder()
          .update(Document)
          .set({
            status: DocumentStatus.EMBEDDING,
            lastStatusAt: new Date(),
            chunkCount: rows.length,
            tokenCount: parsed.chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
            pageCount: parsed.pageCount,
            language: parsed.language,
            parser: parsed.parser,
          })
          .where(
            'id = :id AND index_version = :version AND status = :status AND deleted_at IS NULL',
            {
              id: document.id,
              version,
              status: DocumentStatus.CHUNKING,
            },
          )
          .execute();

        if (!moved.affected) throw new SupersededError('document changed during chunking');
      });
    } finally {
      this.contentEncryption.destroy(key);
    }
  }

  /**
   * Embeds and indexes every chunk not yet embedded, batch by batch.
   *
   * Each batch is checkpointed only after its vectors are durably stored
   * (`wait: true`), so a crash between the two re-embeds at most one batch.
   */
  private async embedPending(
    document: Document & { wrappedDataKey: string },
    deadline: number,
  ): Promise<{ tokens: number }> {
    const version = document.indexVersion;
    let tokens = 0;

    for (;;) {
      if (Date.now() > deadline) {
        throw new IngestionError(
          'INGESTION_TIMEOUT',
          'Processing exceeded its time budget and will be retried.',
          true,
        );
      }

      // Re-read per batch: stop promptly if the document was deleted or
      // superseded, and label vectors with its *current* classification.
      const fresh = await this.documentRepository.findOne({
        where: { id: document.id },
        select: { id: true, indexVersion: true, classification: true, deletedAt: true },
        withDeleted: true,
      });
      if (!fresh || fresh.deletedAt) throw new SupersededError('document deleted');
      if (fresh.indexVersion !== version)
        throw new SupersededError('newer version requested');

      const batch = await this.chunkRepository.find({
        where: { documentId: document.id, indexVersion: version, embeddedAt: IsNull() },
        order: { chunkIndex: 'ASC' },
        take: this.vectorConfig.embedding.batchSize,
      });
      if (batch.length === 0) break;

      const key = this.contentEncryption.unwrapDataKey(
        document.wrappedDataKey,
        dataKeyBinding(document.id),
      );
      let texts: string[];
      try {
        texts = batch.map((chunk) =>
          this.contentEncryption.decryptText(
            key,
            chunk.contentCiphertext,
            chunkAad(chunk.id),
          ),
        );
      } finally {
        this.contentEncryption.destroy(key);
      }

      const embeddings = await this.aiService.embed({
        inputs: texts,
        inputType: 'document',
        organizationId: document.organizationId,
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      });
      tokens += embeddings.tokens ?? 0;

      await this.vectorStore.upsert(
        document.organizationId,
        batch.map((chunk, position) => ({
          id: chunk.id,
          dense: embeddings.embeddings[position],
          sparse: encodeDocument(texts[position]),
          payload: {
            organization_id: document.organizationId,
            knowledge_base_id: document.knowledgeBaseId,
            document_id: document.id,
            index_version: version,
            chunk_index: chunk.chunkIndex,
            classification: fresh.classification,
            embedding_model: embeddings.model,
            active: false,
          },
        })),
      );

      await this.chunkRepository.update(
        { id: In(batch.map((chunk) => chunk.id)) },
        { embeddedAt: new Date() },
      );
      // Heartbeat: the sweep reads a stale `last_status_at` as a stalled job.
      await this.documentRepository.update(
        { id: document.id },
        { lastStatusAt: new Date() },
      );
    }

    return { tokens };
  }

  /**
   * Makes the new version searchable and retires the previous one.
   *
   * Order matters. Vectors are activated first, so for a moment both versions
   * are active in the vector store; the database still names the old version
   * as active, and retrieval's hydration step serves only that. Then the
   * database flips. Readers see the old version, then the new — never neither.
   */
  private async activate(
    document: Document,
    metrics: DocumentProcessingMetrics,
    startedAt: number,
  ): Promise<number> {
    const version = document.indexVersion;
    await this.vectorStore.activateVersion(document.organizationId, document.id, version);

    return this.dataSource.transaction(async (manager) => {
      const completed = await manager
        .createQueryBuilder()
        .update(Document)
        .set({
          status: DocumentStatus.READY,
          activeIndexVersion: version,
          embeddingModel: this.vectorConfig.embedding.model,
          statusMessage: null,
          failureCode: null,
          lastStatusAt: new Date(),
          processingCompletedAt: new Date(),
          processingMetrics: { ...metrics, totalMs: Date.now() - startedAt },
        })
        .where(
          'id = :id AND index_version = :version AND status = :status AND deleted_at IS NULL',
          {
            id: document.id,
            version,
            status: DocumentStatus.EMBEDDING,
          },
        )
        .execute();

      if (!completed.affected)
        throw new SupersededError('document changed during activation');

      // The previous version's text is no longer served by anything.
      await manager.query(
        'DELETE FROM document_chunks WHERE document_id = $1 AND index_version <> $2',
        [document.id, version],
      );

      return manager.getRepository(DocumentChunk).count({
        where: { documentId: document.id, indexVersion: version },
      });
    });
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * Compare-and-set status transition. Throws {@link SupersededError} when the
   * document is no longer in a state this job may move it from.
   */
  private async transition(
    document: Document,
    to: DocumentStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const result = await this.documentRepository
      .createQueryBuilder()
      .update(Document)
      .set({ ...extra, status: to, lastStatusAt: new Date() })
      .where('id = :id', { id: document.id })
      .andWhere('index_version = :version', { version: document.indexVersion })
      .andWhere('deleted_at IS NULL')
      .andWhere('status IN (:...from)', { from: sourcesOf(to) })
      .execute();

    if (!result.affected) {
      throw new SupersededError(`could not move to ${to}`);
    }
    document.status = to;
  }

  /**
   * Decides what a failure means, records it, and returns what to throw back
   * to BullMQ: the original error to retry, or an `UnrecoverableError` to stop.
   */
  private async handleFailure(
    job: Job<IngestionJobData>,
    document: Document,
    error: unknown,
    metrics: DocumentProcessingMetrics,
  ): Promise<Error> {
    const failure = classifyFailure(error);
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const final = !failure.retryable || attempt >= maxAttempts;

    this.logger.warn(
      `Ingestion of ${document.id} v${document.indexVersion} failed (attempt ${attempt}/${maxAttempts}, ` +
        `${failure.code}${final ? ', final' : ', will retry'}): ${(error as Error)?.message}`,
    );

    if (!final) {
      await this.documentRepository
        .update(
          { id: document.id, indexVersion: document.indexVersion },
          {
            statusMessage: `Attempt ${attempt} of ${maxAttempts} failed (${failure.code}); retrying.`,
            lastStatusAt: new Date(),
          },
        )
        .catch(() => undefined);
      return error instanceof Error ? error : new Error(String(error));
    }

    const marked = await this.documentRepository
      .createQueryBuilder()
      .update(Document)
      .set({
        status: DocumentStatus.FAILED,
        failureCode: failure.code,
        statusMessage: failure.message,
        lastStatusAt: new Date(),
        processingMetrics: metrics,
      })
      .where('id = :id AND index_version = :version AND deleted_at IS NULL', {
        id: document.id,
        version: document.indexVersion,
      })
      .andWhere('status IN (:...inFlight)', { inFlight: [...IN_FLIGHT_STATUSES] })
      .execute()
      .catch(() => ({ affected: 0 }));

    if (marked.affected) {
      await this.discardFailedVersion(document);

      await this.auditService.recordSafe({
        action: AuditAction.DOCUMENT_INGESTION_FAILED,
        status: AuditStatus.FAILURE,
        organizationId: document.organizationId,
        resourceType: 'document',
        resourceId: document.id,
        resourceLabel: document.title,
        errorCode: failure.code,
        errorMessage: failure.message,
        metadata: {
          indexVersion: document.indexVersion,
          attempts: attempt,
          retryable: failure.retryable,
        },
      });

      // Retries exhausted on a transient failure: that is what the dead-letter
      // queue is for. A permanent document problem is not dead-lettered — it is
      // already surfaced to the user as FAILED with a reason.
      if (failure.retryable) {
        await this.jobs.deadLetter({
          sourceQueue: QUEUE_NAME.INGESTION,
          jobId: String(job.id),
          jobName: job.name,
          organizationId: document.organizationId,
          documentId: document.id,
          indexVersion: document.indexVersion,
          failureCode: failure.code,
          attempts: attempt,
          failedAt: new Date().toISOString(),
        });
        await this.auditService.recordSafe({
          action: AuditAction.DOCUMENT_INGESTION_DEAD_LETTERED,
          status: AuditStatus.FAILURE,
          organizationId: document.organizationId,
          resourceType: 'document',
          resourceId: document.id,
          errorCode: failure.code,
          metadata: { jobId: String(job.id), attempts: attempt },
        });
      }
    }

    return new UnrecoverableError(`${failure.code}: ${failure.message}`);
  }

  /** Removes a failed run's partial output. The previously active version is untouched. */
  private async discardFailedVersion(document: Document): Promise<void> {
    if (document.activeIndexVersion === document.indexVersion) return;

    await this.chunkRepository
      .delete({ documentId: document.id, indexVersion: document.indexVersion })
      .catch((error: Error) => this.logger.warn(`Chunk cleanup failed: ${error.message}`));

    if (this.vectorStore.isConfigured) {
      await this.vectorStore
        .deleteDocument(document.organizationId, document.id, document.indexVersion)
        .catch((error: Error) =>
          this.logger.warn(`Vector cleanup failed: ${error.message}`),
        );
    }
  }

  private async timed<T>(
    metrics: DocumentProcessingMetrics,
    field: keyof DocumentProcessingMetrics,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      return await operation();
    } finally {
      metrics[field] = (metrics[field] ?? 0) + (Date.now() - started);
    }
  }
}

/** Maps any error from the pipeline onto a failure code and a retry decision. */
export function classifyFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof IngestionError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }

  if (error instanceof AiServiceError) {
    return error.retryable
      ? {
          code: 'AI_SERVICE_UNAVAILABLE',
          message: 'The AI service was unavailable.',
          retryable: true,
        }
      : {
          code: error.code,
          // The AI service's own explanation ("the PDF is password protected")
          // is the useful part — already sanitised by the client.
          message: stripControlCharacters(error.message).slice(0, 480),
          retryable: false,
        };
  }

  if (error instanceof VectorStoreError) {
    return {
      code: 'VECTOR_STORE_UNAVAILABLE',
      message: error.retryable
        ? 'The vector store was unavailable.'
        : 'The vector store rejected the document’s vectors.',
      retryable: error.retryable,
    };
  }

  if (error instanceof ObjectStorageError) {
    return error.notFound
      ? {
          code: 'CONTENT_MISSING',
          message: 'The stored file could not be found.',
          retryable: false,
        }
      : {
          code: 'OBJECT_STORAGE_UNAVAILABLE',
          message: 'Document storage was unavailable.',
          retryable: true,
        };
  }

  return {
    code: 'INGESTION_ERROR',
    message: 'An unexpected error occurred while processing the document.',
    retryable: true,
  };
}
