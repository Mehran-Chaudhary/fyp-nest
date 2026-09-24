import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { CircuitBreaker, CircuitOpenError } from '../../common/utils/circuit-breaker';
import {
  VECTOR_STORE_CONFIG_KEY,
  type VectorStoreConfig,
} from '../../config/vector-store.config';
import type { SparseVector } from './sparse-encoder';
import {
  matchValue,
  VECTOR_FIELD,
  type VectorFilter,
  type VectorPayload,
} from './vector-filter';

export const DENSE_VECTOR = 'dense';
export const SPARSE_VECTOR = 'lexical';

export interface VectorPoint {
  id: string;
  dense: number[];
  sparse: SparseVector;
  payload: VectorPayload;
}

export interface VectorSearchRequest {
  dense: number[];
  /** Present → hybrid (dense + lexical, fused with RRF). Absent → dense only. */
  sparse?: SparseVector;
  /** Mandatory. There is deliberately no way to search without one. */
  filter: VectorFilter;
  limit: number;
  /** Cosine floor. Only meaningful for dense-only searches. */
  scoreThreshold?: number;
  /** Payload fields to return. Never includes text — there is none to return. */
  withPayload?: Array<(typeof VECTOR_FIELD)[keyof typeof VECTOR_FIELD]>;
}

export interface VectorHit {
  id: string;
  score: number;
  payload: Partial<VectorPayload>;
}

export class VectorStoreError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'VectorStoreError';
  }
}

/**
 * The vector store (Qdrant), behind an interface shaped by the access policy.
 *
 * ## Tenancy at the vector layer
 *
 * Two modes, selected by `QDRANT_TENANCY`:
 *
 *  - `collection` (default) — one collection per workspace. A query addressed
 *    to one workspace's collection physically cannot return another's points.
 *  - `shared` — one collection, with `organization_id` indexed as Qdrant's
 *    tenant key (`is_tenant`) and per-tenant HNSW graphs. This is Qdrant's own
 *    recommendation once workspaces number in the hundreds, where hundreds of
 *    collections would each carry their own overhead.
 *
 * In **both** modes the workspace id is also part of every filter, so the
 * collection boundary and the filter are two independent layers — either one
 * alone would still isolate tenants.
 *
 * ## No search without a filter
 *
 * `search` requires a filter argument, and callers build it only through the
 * retrieval policy. There is no convenience overload that omits it.
 */
@Injectable()
export class VectorStoreService {
  private readonly logger = new Logger(VectorStoreService.name);
  private readonly config: VectorStoreConfig;
  private readonly breaker: CircuitBreaker;
  /** Collections known to exist, keyed by name. Holds the in-flight promise to dedupe races. */
  private readonly ensured = new Map<string, Promise<void>>();
  private client?: QdrantClient;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<VectorStoreConfig>(VECTOR_STORE_CONFIG_KEY);
    this.breaker = new CircuitBreaker('vector-store', this.config.circuitBreaker);
  }

  get isConfigured(): boolean {
    return this.config.configured;
  }

  get embeddingModel(): string {
    return this.config.embedding.model;
  }

  get embeddingDimensions(): number {
    return this.config.embedding.dimensions;
  }

  get circuit(): ReturnType<CircuitBreaker['describe']> {
    return this.breaker.describe();
  }

  collectionName(organizationId: string): string {
    return this.config.tenancy === 'shared'
      ? `${this.config.collectionPrefix}shared`
      : `${this.config.collectionPrefix}ws_${organizationId.replace(/-/g, '')}`;
  }

  // ── Collections ───────────────────────────────────────────────────────────

  /**
   * Creates the workspace's collection and payload indexes if missing.
   *
   * Idempotent and race-safe: concurrent callers in one process share a single
   * attempt, and a collision with another process ("already exists") counts as
   * success.
   */
  async ensureCollection(organizationId: string): Promise<void> {
    const name = this.collectionName(organizationId);

    let pending = this.ensured.get(name);
    if (!pending) {
      pending = this.run('ensure collection', () => this.createIfMissing(name));
      this.ensured.set(name, pending);
      // A failed attempt must not be cached, or the next call would never retry.
      pending.catch(() => this.ensured.delete(name));
    }

    return pending;
  }

  private async createIfMissing(name: string): Promise<void> {
    const client = this.getClient();
    const { exists } = await client.collectionExists(name);

    if (exists) {
      await this.assertDimensions(name);
      return;
    }

    const shared = this.config.tenancy === 'shared';

    try {
      await client.createCollection(name, {
        vectors: {
          [DENSE_VECTOR]: {
            size: this.config.embedding.dimensions,
            distance: 'Cosine',
          },
        },
        sparse_vectors: {
          // IDF is computed by Qdrant from the collection's own statistics —
          // the corpus half of BM25 (see sparse-encoder.ts).
          [SPARSE_VECTOR]: { modifier: 'idf' },
        },
        // Shared mode: no global graph, one HNSW graph per tenant value. Every
        // query filters on the tenant anyway, so a global graph is pure cost.
        hnsw_config: shared ? { m: 0, payload_m: 16 } : undefined,
        quantization_config:
          this.config.quantization === 'scalar'
            ? { scalar: { type: 'int8', quantile: 0.99, always_ram: true } }
            : undefined,
      });
    } catch (error) {
      const { exists: nowExists } = await client.collectionExists(name);
      if (!nowExists) throw error;
      // Another process created it between our check and our create.
    }

    const keyword = 'keyword' as const;
    const indexes: Array<
      [string, Parameters<QdrantClient['createPayloadIndex']>[1]['field_schema']]
    > = [
      [VECTOR_FIELD.ORGANIZATION_ID, shared ? { type: keyword, is_tenant: true } : keyword],
      [VECTOR_FIELD.KNOWLEDGE_BASE_ID, keyword],
      [VECTOR_FIELD.DOCUMENT_ID, keyword],
      [VECTOR_FIELD.CLASSIFICATION, keyword],
      [VECTOR_FIELD.EMBEDDING_MODEL, keyword],
      [VECTOR_FIELD.ACTIVE, 'bool'],
      [VECTOR_FIELD.INDEX_VERSION, 'integer'],
    ];

    for (const [field, schema] of indexes) {
      await client.createPayloadIndex(name, {
        field_name: field,
        field_schema: schema,
        wait: true,
      });
    }

    this.logger.log(
      `Created vector collection "${name}" (${this.config.tenancy} tenancy).`,
    );
  }

  /** Refuses to write into a collection built for a different embedding size. */
  private async assertDimensions(name: string): Promise<void> {
    const info = await this.getClient().getCollection(name);
    const vectors = info.config?.params?.vectors as
      Record<string, { size?: number }> | undefined;
    const size = vectors?.[DENSE_VECTOR]?.size;

    if (size !== undefined && size !== this.config.embedding.dimensions) {
      throw new VectorStoreError(
        `Collection "${name}" holds ${size}-dimensional vectors but EMBEDDING_DIMENSIONS is ` +
          `${this.config.embedding.dimensions}. Changing the embedding model requires re-indexing ` +
          'into a new collection; see docs/CLOUD_SETUP.md.',
        false,
      );
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Upserts points and waits until they are durable.
   *
   * Point ids are derived from `(document, version, chunk)`, so upserting the
   * same batch twice — a retried job — overwrites instead of duplicating.
   */
  async upsert(organizationId: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.ensureCollection(organizationId);

    await this.run('upsert', () =>
      this.getClient().upsert(this.collectionName(organizationId), {
        wait: true,
        points: points.map((point) => ({
          id: point.id,
          vector:
            point.sparse.indices.length > 0
              ? { [DENSE_VECTOR]: point.dense, [SPARSE_VECTOR]: point.sparse }
              : { [DENSE_VECTOR]: point.dense },
          payload: { ...point.payload },
        })),
      }),
    );
  }

  /**
   * Makes a fully indexed document version searchable, then removes every
   * other version of it.
   *
   * Two steps, in this order, so that a reader between them sees both versions
   * (harmless: the database hydration step keeps only the active one) rather
   * than neither.
   */
  async activateVersion(
    organizationId: string,
    documentId: string,
    indexVersion: number,
  ): Promise<void> {
    const collection = this.collectionName(organizationId);
    const scope = this.documentScope(organizationId, documentId);

    await this.run('activate version', () =>
      this.getClient().setPayload(collection, {
        payload: { [VECTOR_FIELD.ACTIVE]: true },
        filter: { must: [...scope, matchValue(VECTOR_FIELD.INDEX_VERSION, indexVersion)] },
        wait: true,
      }),
    );

    await this.run('remove superseded versions', () =>
      this.getClient().delete(collection, {
        filter: {
          must: scope,
          must_not: [matchValue(VECTOR_FIELD.INDEX_VERSION, indexVersion)],
        },
        wait: true,
      }),
    );
  }

  /** Removes one version of a document (a failed run's partial output) or all of it. */
  async deleteDocument(
    organizationId: string,
    documentId: string,
    indexVersion?: number,
  ): Promise<void> {
    const must = this.documentScope(organizationId, documentId);
    if (indexVersion !== undefined) {
      must.push(matchValue(VECTOR_FIELD.INDEX_VERSION, indexVersion));
    }
    await this.deleteWhere(organizationId, { must });
  }

  async deleteKnowledgeBase(
    organizationId: string,
    knowledgeBaseId: string,
  ): Promise<void> {
    await this.deleteWhere(organizationId, {
      must: [
        matchValue(VECTOR_FIELD.ORGANIZATION_ID, organizationId),
        matchValue(VECTOR_FIELD.KNOWLEDGE_BASE_ID, knowledgeBaseId),
      ],
    });
  }

  /** Removes everything a workspace has in the vector store. */
  async dropOrganization(organizationId: string): Promise<void> {
    const collection = this.collectionName(organizationId);

    if (this.config.tenancy === 'shared') {
      await this.deleteWhere(organizationId, {
        must: [matchValue(VECTOR_FIELD.ORGANIZATION_ID, organizationId)],
      });
      return;
    }

    await this.run('drop collection', async () => {
      const { exists } = await this.getClient().collectionExists(collection);
      if (exists) await this.getClient().deleteCollection(collection);
    });
    this.ensured.delete(collection);
  }

  /** Re-labels a document's points after it is reclassified. */
  async setDocumentClassification(
    organizationId: string,
    documentId: string,
    classification: string,
  ): Promise<void> {
    await this.run('set classification', () =>
      this.getClient().setPayload(this.collectionName(organizationId), {
        payload: { [VECTOR_FIELD.CLASSIFICATION]: classification },
        filter: { must: this.documentScope(organizationId, documentId) },
        wait: true,
      }),
    ).catch((error: unknown) => {
      if (isMissingCollection(error)) return;
      throw error;
    });
  }

  private async deleteWhere(organizationId: string, filter: VectorFilter): Promise<void> {
    await this.run('delete', () =>
      this.getClient().delete(this.collectionName(organizationId), { filter, wait: true }),
    ).catch((error: unknown) => {
      // Nothing was ever indexed for this workspace: nothing to delete.
      if (isMissingCollection(error)) return;
      throw error;
    });
  }

  private documentScope(organizationId: string, documentId: string) {
    return [
      matchValue(VECTOR_FIELD.ORGANIZATION_ID, organizationId),
      matchValue(VECTOR_FIELD.DOCUMENT_ID, documentId),
    ];
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Filtered nearest-neighbour search.
   *
   * The filter is applied *inside* the index traversal — Qdrant's filterable
   * HNSW — not to a result list afterwards, so points the caller may not see
   * are never scored, never returned and never enter this process.
   *
   * Hybrid mode prefetches dense and lexical candidates, each under the filter,
   * fuses them with reciprocal rank fusion, and re-applies the filter at the
   * fusion stage.
   */
  async search(organizationId: string, request: VectorSearchRequest): Promise<VectorHit[]> {
    const collection = this.collectionName(organizationId);
    const withPayload = request.withPayload ?? [
      VECTOR_FIELD.DOCUMENT_ID,
      VECTOR_FIELD.KNOWLEDGE_BASE_ID,
      VECTOR_FIELD.INDEX_VERSION,
      VECTOR_FIELD.CHUNK_INDEX,
    ];
    const params =
      this.config.quantization === 'scalar'
        ? { quantization: { rescore: true, oversampling: 2 } }
        : undefined;

    const hybrid = request.sparse !== undefined && request.sparse.indices.length > 0;
    const prefetchLimit = Math.min(Math.max(request.limit * 4, 20), 400);

    try {
      const response = await this.run('search', () =>
        hybrid
          ? this.getClient().query(collection, {
              prefetch: [
                {
                  query: request.dense,
                  using: DENSE_VECTOR,
                  filter: request.filter,
                  limit: prefetchLimit,
                  params,
                },
                {
                  query: request.sparse,
                  using: SPARSE_VECTOR,
                  filter: request.filter,
                  limit: prefetchLimit,
                },
              ],
              query: { fusion: 'rrf' },
              filter: request.filter,
              limit: request.limit,
              with_payload: withPayload,
            })
          : this.getClient().query(collection, {
              query: request.dense,
              using: DENSE_VECTOR,
              filter: request.filter,
              limit: request.limit,
              score_threshold: request.scoreThreshold,
              params,
              with_payload: withPayload,
            }),
      );

      return response.points.map((point) => ({
        id: String(point.id),
        score: point.score,
        payload: point.payload ?? {},
      }));
    } catch (error) {
      // No collection yet means nothing has been indexed for this workspace.
      if (isMissingCollection(error)) return [];
      throw error;
    }
  }

  /** Readiness probe. */
  async ping(): Promise<boolean> {
    try {
      await this.getClient().versionInfo();
      return true;
    } catch (error) {
      this.logger.debug(`Vector store ping failed: ${(error as Error).message}`);
      return false;
    }
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private getClient(): QdrantClient {
    if (!this.config.configured) {
      throw new VectorStoreError(
        'The vector store is not configured. Set QDRANT_URL (and QDRANT_API_KEY for Qdrant Cloud).',
        false,
      );
    }

    this.client ??= new QdrantClient({
      url: this.config.url,
      apiKey: this.config.apiKey,
      timeout: this.config.timeoutMs,
      // Our own health checks cover this, without a console warning per boot.
      checkCompatibility: false,
    });

    return this.client;
  }

  /** Routes a call through the circuit breaker and normalises its errors. */
  private async run<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.execute(call, (error) => isTransient(error));
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      if (error instanceof CircuitOpenError) {
        throw new VectorStoreError(
          'The vector store is failing; requests are paused briefly to let it recover.',
          true,
          { cause: error },
        );
      }
      if (isMissingCollection(error)) throw error;

      throw new VectorStoreError(
        `Vector store ${operation} failed: ${(error as Error)?.message?.split('\n')[0] ?? 'error'}`,
        isTransient(error),
        { cause: error },
      );
    }
  }
}

function statusOf(error: unknown): number | undefined {
  const direct = (error as { status?: unknown })?.status;
  if (typeof direct === 'number') return direct;

  const match = /Unexpected Response: (\d{3})/.exec((error as Error)?.message ?? '');
  return match ? Number(match[1]) : undefined;
}

function isMissingCollection(error: unknown): boolean {
  if (statusOf(error) === 404) return true;
  return /not found|doesn't exist|does not exist/i.test((error as Error)?.message ?? '');
}

/** Network failures, timeouts, 429 and 5xx reflect the store's health; 4xx does not. */
function isTransient(error: unknown): boolean {
  if (error instanceof VectorStoreError) return error.retryable;

  const status = statusOf(error);
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}
