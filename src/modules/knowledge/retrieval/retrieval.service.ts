import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Repository } from 'typeorm';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { AppException, NotFoundError } from '../../../common/exceptions/app.exception';
import { RAG_CONFIG_KEY, type RagConfig } from '../../../config/rag.config';
import { AiServiceClient } from '../../../shared/ai-service/ai-service.client';
import { ContentEncryptionService } from '../../../shared/crypto/content-encryption.service';
import { encodeQuery } from '../../../shared/vector-store/sparse-encoder';
import { VECTOR_FIELD } from '../../../shared/vector-store/vector-filter';
import {
  VectorStoreService,
  type VectorHit,
} from '../../../shared/vector-store/vector-store.service';
import { AuditService } from '../../audit/audit.service';
import { toDependencyException } from '../dependency-errors';
import type { AccessLevel, AccessPrincipal, AccessScope } from '../domain/access';
import { classificationsWithin, type Classification } from '../domain/classification';
import { chunkAad, dataKeyBinding } from '../documents/content-binding';
import { DocumentChunk } from '../entities/document-chunk.entity';
import { Document } from '../entities/document.entity';
import { KnowledgeBase } from '../entities/knowledge-base.entity';
import { KnowledgeBaseAccessService } from '../knowledge-bases/knowledge-base-access.service';
import { KnowledgeReadinessService } from '../knowledge-readiness.service';
import type {
  AccessScopeDto,
  RetrievalQueryDto,
  RetrievalResponseDto,
  RetrievedChunkDto,
} from './dto/retrieval.dto';
import {
  buildWithheldFilter,
  planRetrieval,
  RetrievalScopeError,
  withheldReason,
  type RetrievalPlan,
} from './retrieval-policy';

interface HydratedRow {
  chunkId: string;
  ciphertext: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  documentId: string;
  documentTitle: string;
  classification: Classification;
  wrappedDataKey: string | null;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
}

interface Candidate extends Omit<RetrievedChunkDto, 'rank'> {
  retrievalScore: number;
}

/**
 * Secure retrieval (proposal module 6.6).
 *
 *     question ─▶ resolve scope ─▶ embed ─▶ filtered search ─▶ policy-filtered
 *                  (database)                (vector store)     text fetch ─▶ (rerank) ─▶ answer
 *
 * ## Two independent enforcement points
 *
 *  1. **In the vector search.** The filter from `retrieval-policy.ts` bounds
 *     the index traversal itself. This is the primary control.
 *  2. **In the text fetch.** The vector store holds no text. Turning hits into
 *     passages means reading encrypted chunks from PostgreSQL through a query
 *     that independently re-applies workspace, compartment, clearance,
 *     liveness and active-version conditions. A hit that fails any of them —
 *     a document reclassified a moment ago whose vector payload has not caught
 *     up, one deleted while its purge is pending — returns no row, so its text
 *     is never decrypted.
 *
 * Either layer alone would enforce the policy. Together they make it hold even
 * while the two stores are momentarily inconsistent, which in a system spread
 * across three cloud providers is the normal state of affairs, not an edge
 * case.
 *
 * ## Auditing
 *
 * Every query writes `rag.query.executed` with the documents and chunks it
 * drew on — answering "what was this answer based on?" — but never the query
 * text, which may itself be sensitive; a keyed fingerprint lets identical
 * queries be correlated instead. When the policy withheld relevant material,
 * `rag.access.filtered` records which documents and why, by id only.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);
  private readonly config: RagConfig;

  constructor(
    @InjectRepository(DocumentChunk)
    private readonly chunkRepository: Repository<DocumentChunk>,
    private readonly access: KnowledgeBaseAccessService,
    private readonly readiness: KnowledgeReadinessService,
    private readonly vectorStore: VectorStoreService,
    private readonly aiService: AiServiceClient,
    private readonly contentEncryption: ContentEncryptionService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<RagConfig>(RAG_CONFIG_KEY);
  }

  async retrieve(
    principal: AccessPrincipal,
    request: RetrievalQueryDto,
  ): Promise<RetrievalResponseDto> {
    this.readiness.assert('retrieval');

    const retrievalId = randomUUID();
    const started = performance.now();
    const timings = {
      accessMs: 0,
      embedMs: 0,
      searchMs: 0,
      hydrateMs: 0,
      rerankMs: 0,
      totalMs: 0,
    };

    if (request.query.length > this.config.maxQueryLength) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, {
        message: `The query exceeds ${this.config.maxQueryLength} characters.`,
      });
    }

    const topK = Math.min(request.topK ?? this.config.defaultTopK, this.config.maxTopK);
    const mode = request.mode ?? this.config.searchMode;
    const rerank = (request.rerank ?? this.config.rerankEnabled) === true;
    const model = this.vectorStore.embeddingModel;

    // ── Scope ───────────────────────────────────────────────────────────────
    const scope = await this.measure(timings, 'accessMs', () =>
      this.access.resolveScope(principal),
    );

    let plan: RetrievalPlan | null;
    try {
      plan = planRetrieval(scope, request, model);
    } catch (error) {
      if (error instanceof RetrievalScopeError) {
        for (const id of error.unresolvable) {
          await this.access.recordHiddenProbe(principal, 'knowledge_base', id);
        }
        throw new NotFoundError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, {
          details: { knowledgeBaseIds: error.unresolvable },
        });
      }
      throw error;
    }

    const respond = (
      results: RetrievedChunkDto[],
      reranked: boolean,
    ): RetrievalResponseDto => {
      timings.totalMs = Math.round(performance.now() - started);
      return {
        retrievalId,
        mode,
        topK,
        reranked,
        embeddingModel: model,
        knowledgeBasesSearched: plan?.knowledgeBaseIds.length ?? 0,
        clearance: scope.clearance,
        results,
        timings,
      };
    };

    if (!plan) {
      const response = respond([], false);
      await this.auditExecuted(principal, scope, request, response, 0);
      return response;
    }

    try {
      // ── Embed ─────────────────────────────────────────────────────────────
      const embedding = await this.measure(timings, 'embedMs', () =>
        this.aiService.embed({
          inputs: [request.query],
          inputType: 'query',
          organizationId: principal.organizationId,
        }),
      );
      const dense = embedding.embeddings[0];
      const sparse = mode === 'hybrid' ? encodeQuery(request.query) : undefined;

      // ── Search (and, in parallel, the withheld audit probe) ───────────────
      const candidateLimit = rerank ? topK * this.config.candidateMultiplier : topK;
      const activePlan = plan;

      const [hits, withheld] = await this.measure(timings, 'searchMs', () =>
        Promise.all([
          this.vectorStore.search(principal.organizationId, {
            dense,
            sparse,
            filter: activePlan.filter,
            limit: candidateLimit,
            scoreThreshold: mode === 'dense' ? request.minScore : undefined,
          }),
          this.config.auditWithheld
            ? this.findWithheld(scope, dense, topK, model)
            : Promise.resolve(null),
        ]),
      );

      // ── Hydrate through the second enforcement point ──────────────────────
      const candidates = await this.measure(timings, 'hydrateMs', () =>
        this.hydrate(scope, activePlan, hits),
      );
      const drift = hits.length - candidates.length;

      // ── Rerank ────────────────────────────────────────────────────────────
      let ordered = candidates;
      let reranked = false;
      if (rerank && candidates.length > 1) {
        const result = await this.measure(timings, 'rerankMs', () =>
          this.rerank(principal, request.query, candidates, topK),
        );
        ordered = result.candidates;
        reranked = result.reranked;
      }

      const results: RetrievedChunkDto[] = ordered
        .slice(0, topK)
        .map((candidate, index) => ({
          chunkId: candidate.chunkId,
          documentId: candidate.documentId,
          documentTitle: candidate.documentTitle,
          knowledgeBaseId: candidate.knowledgeBaseId,
          knowledgeBaseName: candidate.knowledgeBaseName,
          classification: candidate.classification,
          chunkIndex: candidate.chunkIndex,
          pageStart: candidate.pageStart,
          pageEnd: candidate.pageEnd,
          rank: index + 1,
          score: candidate.score,
          text: candidate.text,
        }));

      const response = respond(results, reranked);
      await this.auditExecuted(principal, scope, request, response, drift);
      await this.auditWithheld(principal, scope, retrievalId, withheld, drift);

      return response;
    } catch (error) {
      throw toDependencyException(error);
    }
  }

  /** What the caller can reach, for the UI and for explaining an empty answer. */
  async describeScope(principal: AccessPrincipal): Promise<AccessScopeDto> {
    const scope = await this.access.resolveScope(principal);
    const ids = [...scope.knowledgeBases.keys()];

    const bases =
      ids.length === 0
        ? []
        : await this.chunkRepository.manager.getRepository(KnowledgeBase).find({
            where: ids.map((id) => ({ id, organizationId: principal.organizationId })),
            order: { name: 'ASC' },
          });

    return {
      clearance: scope.clearance,
      readableClassifications: classificationsWithin(scope.clearance),
      bypassesCompartments: scope.superuser,
      knowledgeBases: bases.map((base) => ({
        id: base.id,
        name: base.name,
        accessMode: base.accessMode,
        access: scope.knowledgeBases.get(base.id) as AccessLevel,
      })),
    };
  }

  // ── Stages ────────────────────────────────────────────────────────────────

  /**
   * Turns vector hits into passages via the second enforcement point.
   *
   * The query below restates the whole policy in SQL. Only rows that satisfy it
   * come back, so only their ciphertext is ever decrypted. Rank order from the
   * vector store is preserved.
   */
  private async hydrate(
    scope: AccessScope,
    plan: RetrievalPlan,
    hits: VectorHit[],
  ): Promise<Candidate[]> {
    if (hits.length === 0) return [];

    const rows = await this.chunkRepository
      .createQueryBuilder('chunk')
      .innerJoin(Document, 'document', 'document.id = chunk.document_id')
      .innerJoin(KnowledgeBase, 'kb', 'kb.id = document.knowledge_base_id')
      .select('chunk.id', 'chunkId')
      .addSelect('chunk.content_ciphertext', 'ciphertext')
      .addSelect('chunk.chunk_index', 'chunkIndex')
      .addSelect('chunk.page_start', 'pageStart')
      .addSelect('chunk.page_end', 'pageEnd')
      .addSelect('document.id', 'documentId')
      .addSelect('document.title', 'documentTitle')
      .addSelect('document.classification', 'classification')
      .addSelect('document.wrapped_data_key', 'wrappedDataKey')
      .addSelect('kb.id', 'knowledgeBaseId')
      .addSelect('kb.name', 'knowledgeBaseName')
      .where('chunk.id IN (:...ids)', { ids: hits.map((hit) => hit.id) })
      .andWhere('chunk.organization_id = :organizationId')
      .andWhere('document.organization_id = :organizationId')
      .andWhere('document.deleted_at IS NULL')
      .andWhere('kb.deleted_at IS NULL')
      .andWhere('document.knowledge_base_id IN (:...knowledgeBaseIds)')
      .andWhere('document.classification IN (:...classifications)')
      .andWhere('chunk.index_version = document.active_index_version')
      .setParameters({
        organizationId: scope.organizationId,
        knowledgeBaseIds: plan.knowledgeBaseIds,
        classifications: plan.classifications,
      })
      .getRawMany<HydratedRow>();

    const byChunk = new Map(rows.map((row) => [row.chunkId, row]));
    const keys = new Map<string, Buffer>();

    try {
      const candidates: Candidate[] = [];

      for (const hit of hits) {
        const row = byChunk.get(hit.id);
        if (!row?.wrappedDataKey) continue;

        let key = keys.get(row.documentId);
        if (!key) {
          key = this.contentEncryption.unwrapDataKey(
            row.wrappedDataKey,
            dataKeyBinding(row.documentId),
          );
          keys.set(row.documentId, key);
        }

        candidates.push({
          chunkId: row.chunkId,
          documentId: row.documentId,
          documentTitle: row.documentTitle,
          knowledgeBaseId: row.knowledgeBaseId,
          knowledgeBaseName: row.knowledgeBaseName,
          classification: row.classification,
          chunkIndex: Number(row.chunkIndex),
          pageStart: row.pageStart === null ? null : Number(row.pageStart),
          pageEnd: row.pageEnd === null ? null : Number(row.pageEnd),
          score: round(hit.score),
          retrievalScore: hit.score,
          text: this.contentEncryption.decryptText(
            key,
            row.ciphertext,
            chunkAad(row.chunkId),
          ),
        });
      }

      return candidates;
    } finally {
      for (const key of keys.values()) this.contentEncryption.destroy(key);
    }
  }

  /**
   * Cross-encoder reranking. A failure degrades to the fused order rather than
   * failing the query: reranking improves precision, it is not required for a
   * correct answer.
   */
  private async rerank(
    principal: AccessPrincipal,
    query: string,
    candidates: Candidate[],
    topK: number,
  ): Promise<{ candidates: Candidate[]; reranked: boolean }> {
    try {
      const result = await this.aiService.rerank({
        query,
        documents: candidates.map((candidate) => candidate.text),
        topN: Math.min(topK, candidates.length),
        organizationId: principal.organizationId,
      });

      return {
        candidates: result.results.map(({ index, score }) => ({
          ...candidates[index],
          score: round(score),
        })),
        reranked: true,
      };
    } catch (error) {
      this.logger.warn(
        `Reranking unavailable, using fused order: ${(error as Error).message}`,
      );
      return { candidates, reranked: false };
    }
  }

  /**
   * Ids of relevant points the policy excluded. Best effort: a failure here
   * must never fail the user's query, only leave the audit record without it.
   */
  private async findWithheld(
    scope: AccessScope,
    dense: number[],
    limit: number,
    model: string,
  ): Promise<VectorHit[] | null> {
    try {
      return await this.vectorStore.search(scope.organizationId, {
        dense,
        filter: buildWithheldFilter(scope, model),
        limit,
        scoreThreshold: this.config.withheldScoreThreshold,
        withPayload: [
          VECTOR_FIELD.DOCUMENT_ID,
          VECTOR_FIELD.KNOWLEDGE_BASE_ID,
          VECTOR_FIELD.CLASSIFICATION,
        ],
      });
    } catch (error) {
      this.logger.debug(`Withheld-content probe failed: ${(error as Error).message}`);
      return null;
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  private async auditExecuted(
    principal: AccessPrincipal,
    scope: AccessScope,
    request: RetrievalQueryDto,
    response: RetrievalResponseDto,
    drift: number,
  ): Promise<void> {
    await this.auditService.recordSafe({
      action: AuditAction.RAG_QUERY_EXECUTED,
      organizationId: principal.organizationId,
      resourceType: 'retrieval',
      resourceId: response.retrievalId,
      durationMs: response.timings.totalMs,
      metadata: {
        // Never the query itself: it may contain exactly the kind of data the
        // platform exists to protect. The keyed fingerprint correlates repeats.
        queryFingerprint: this.contentEncryption
          .fingerprint(Buffer.from(request.query, 'utf8'))
          .slice(0, 32),
        queryLength: request.query.length,
        mode: response.mode,
        topK: response.topK,
        reranked: response.reranked,
        clearance: scope.clearance,
        knowledgeBasesSearched: response.knowledgeBasesSearched,
        narrowedTo: request.knowledgeBaseIds?.length ? request.knowledgeBaseIds : undefined,
        results: response.results.map((result) => ({
          rank: result.rank,
          documentId: result.documentId,
          chunkId: result.chunkId,
          score: result.score,
        })),
        consistencyDropped: drift || undefined,
        timings: response.timings,
      },
    });
  }

  private async auditWithheld(
    principal: AccessPrincipal,
    scope: AccessScope,
    retrievalId: string,
    withheld: VectorHit[] | null,
    drift: number,
  ): Promise<void> {
    if ((!withheld || withheld.length === 0) && drift === 0) return;

    const documents = new Map<string, { knowledgeBaseId?: string; reason: string }>();
    for (const hit of withheld ?? []) {
      const documentId = hit.payload.document_id;
      if (!documentId || documents.has(documentId)) continue;
      documents.set(documentId, {
        knowledgeBaseId: hit.payload.knowledge_base_id,
        reason: withheldReason(hit.payload, scope),
      });
    }

    await this.auditService.recordSafe({
      action: AuditAction.RAG_ACCESS_FILTERED,
      organizationId: principal.organizationId,
      resourceType: 'retrieval',
      resourceId: retrievalId,
      metadata: {
        withheldCandidates: withheld?.length ?? 0,
        withheldDocuments: [...documents.entries()]
          .slice(0, 20)
          .map(([documentId, detail]) => ({ documentId, ...detail })),
        // Hits the vector filter admitted but the database gate refused: a sign
        // the two stores briefly disagreed (a pending reclassification sync or
        // purge). The gate is why that is harmless.
        consistencyDropped: drift,
        clearance: scope.clearance,
      },
    });
  }

  private async measure<T, K extends keyof RetrievalResponseDto['timings']>(
    timings: RetrievalResponseDto['timings'],
    field: K,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      timings[field] = Math.round(performance.now() - started);
    }
  }
}

function round(score: number): number {
  return Math.round(score * 1e6) / 1e6;
}
