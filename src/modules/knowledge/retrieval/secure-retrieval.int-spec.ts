import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  VECTOR_STORE_CONFIG_KEY,
  type VectorStoreConfig,
} from '../../../config/vector-store.config';
import { encodeDocument, encodeQuery } from '../../../shared/vector-store/sparse-encoder';
import {
  VECTOR_FIELD,
  type VectorPayload,
} from '../../../shared/vector-store/vector-filter';
import { VectorStoreService } from '../../../shared/vector-store/vector-store.service';
import {
  AccessLevel,
  computeAccessScope,
  KnowledgeBaseAccessMode,
  type AccessPrincipal,
} from '../domain/access';
import { Classification } from '../domain/classification';
import { buildWithheldFilter, planRetrieval } from './retrieval-policy';

/**
 * Phase 2 exit criterion, against a real Qdrant:
 *
 *   "A document uploaded to a restricted knowledge base is not retrievable by a
 *    member lacking access, verified by an integration test that asserts on the
 *    vector store's returned payloads, not just on the HTTP response."
 *
 * The filter is built by the production policy code, the search is issued by
 * the production vector store service — collection creation, payload indexes,
 * quantisation, hybrid RRF fusion and all — and the assertions are on the
 * payloads Qdrant itself returned.
 *
 * Runs only when QDRANT_URL is set:
 *
 *   QDRANT_URL=https://<cluster>.cloud.qdrant.io:6333 QDRANT_API_KEY=... npm run test:integration
 */
const QDRANT_URL = process.env.QDRANT_URL;
const describeLive = QDRANT_URL ? describe : describe.skip;

const DIMENSIONS = 8;
const MODEL = 'integration-test-model';

/** A deterministic unit vector per topic, so "nearest" is predictable. */
function topicVector(topic: number): number[] {
  const vector = Array.from({ length: DIMENSIONS }, (_, index) =>
    index === topic ? 1 : 0.01,
  );
  const norm = Math.hypot(...vector);
  return vector.map((component) => component / norm);
}

describeLive('secure retrieval against a live Qdrant', () => {
  // A unique workspace id, hence a unique collection in `collection` tenancy.
  const organizationId = randomUUID();
  const handbook = randomUUID();
  const hr = randomUUID();

  const config: VectorStoreConfig = {
    configured: true,
    url: (QDRANT_URL ?? '').replace(/\/+$/, ''),
    apiKey: process.env.QDRANT_API_KEY || undefined,
    collectionPrefix: 'daiap_it_',
    tenancy: 'collection',
    timeoutMs: 30_000,
    quantization: 'scalar',
    circuitBreaker: { failureThreshold: 100, cooldownMs: 1_000 },
    embedding: { model: MODEL, dimensions: DIMENSIONS, batchSize: 16 },
  };

  const vectorStore = new VectorStoreService({
    getOrThrow: (key: string) => {
      if (key !== VECTOR_STORE_CONFIG_KEY) throw new Error(`unexpected key ${key}`);
      return config;
    },
  } as unknown as ConfigService);

  const payroll = { id: randomUUID(), text: 'CEO salary compensation payroll 2026 bonus' };

  const points = [
    {
      id: randomUUID(),
      text: 'Annual leave policy: every employee receives 25 days',
      knowledgeBaseId: handbook,
      classification: Classification.INTERNAL,
      topic: 1,
    },
    {
      id: payroll.id,
      text: payroll.text,
      knowledgeBaseId: hr,
      classification: Classification.RESTRICTED,
      // The payroll chunk is the *nearest* point to the salary question below:
      // exactly the case a naive, unfiltered RAG pipeline gets wrong.
      topic: 0,
    },
    {
      id: randomUUID(),
      text: 'Disciplinary procedure for misconduct',
      knowledgeBaseId: hr,
      classification: Classification.CONFIDENTIAL,
      topic: 2,
    },
  ];

  const rows = [
    { id: handbook, accessMode: KnowledgeBaseAccessMode.WORKSPACE, grantLevel: null },
    { id: hr, accessMode: KnowledgeBaseAccessMode.RESTRICTED, grantLevel: null },
  ];

  const employee: AccessPrincipal = {
    organizationId,
    kind: 'user',
    userId: 'employee',
    membershipId: randomUUID(),
    permissions: ['rag:query', 'clearance:internal'],
  };

  beforeAll(async () => {
    await vectorStore.ensureCollection(organizationId);
    await vectorStore.upsert(
      organizationId,
      points.map((point) => ({
        id: point.id,
        dense: topicVector(point.topic),
        sparse: encodeDocument(point.text),
        payload: {
          organization_id: organizationId,
          knowledge_base_id: point.knowledgeBaseId,
          document_id: point.id,
          index_version: 1,
          chunk_index: 0,
          classification: point.classification,
          embedding_model: MODEL,
          active: true,
        } satisfies VectorPayload,
      })),
    );
  });

  afterAll(async () => {
    await vectorStore.dropOrganization(organizationId);
  });

  it('an unfiltered search would return the payroll chunk first (the threat)', async () => {
    const hits = await vectorStore.search(organizationId, {
      dense: topicVector(0),
      filter: {
        must: [{ key: VECTOR_FIELD.ORGANIZATION_ID, match: { value: organizationId } }],
      },
      limit: 1,
    });
    expect(hits[0]?.id).toBe(payroll.id);
  });

  it('a member without the HR compartment never receives an HR payload', async () => {
    const plan = planRetrieval(computeAccessScope(employee, rows), {}, MODEL)!;

    for (const mode of ['dense', 'hybrid'] as const) {
      const hits = await vectorStore.search(organizationId, {
        dense: topicVector(0),
        sparse: mode === 'hybrid' ? encodeQuery('what is the CEO salary?') : undefined,
        filter: plan.filter,
        limit: 10,
        withPayload: [VECTOR_FIELD.KNOWLEDGE_BASE_ID, VECTOR_FIELD.CLASSIFICATION],
      });

      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.id).not.toBe(payroll.id);
        expect(hit.payload.knowledge_base_id).toBe(handbook);
        expect(hit.payload.classification).not.toBe(Classification.RESTRICTED);
      }
    }
  });

  it('an HR grant without RESTRICTED clearance still withholds payroll', async () => {
    const scope = computeAccessScope(
      { ...employee, permissions: ['rag:query', 'clearance:confidential'] },
      rows.map((row) => (row.id === hr ? { ...row, grantLevel: AccessLevel.READ } : row)),
    );
    const hits = await vectorStore.search(organizationId, {
      dense: topicVector(0),
      filter: planRetrieval(scope, {}, MODEL)!.filter,
      limit: 10,
    });

    expect(hits.some((hit) => hit.payload.knowledge_base_id === hr)).toBe(true);
    expect(hits.some((hit) => hit.id === payroll.id)).toBe(false);
  });

  it('the withheld probe finds the payroll chunk by id — for the audit log only', async () => {
    const scope = computeAccessScope(employee, rows);
    const withheld = await vectorStore.search(organizationId, {
      dense: topicVector(0),
      filter: buildWithheldFilter(scope, MODEL),
      limit: 5,
      withPayload: [VECTOR_FIELD.DOCUMENT_ID],
    });

    expect(withheld.map((hit) => hit.id)).toContain(payroll.id);
  });

  it('deactivated (half-indexed) points are never returned', async () => {
    const draft = randomUUID();
    await vectorStore.upsert(organizationId, [
      {
        id: draft,
        dense: topicVector(1),
        sparse: encodeDocument('draft leave policy'),
        payload: {
          organization_id: organizationId,
          knowledge_base_id: handbook,
          document_id: draft,
          index_version: 1,
          chunk_index: 0,
          classification: Classification.INTERNAL,
          embedding_model: MODEL,
          active: false,
        },
      },
    ]);

    const hits = await vectorStore.search(organizationId, {
      dense: topicVector(1),
      filter: planRetrieval(computeAccessScope(employee, rows), {}, MODEL)!.filter,
      limit: 10,
    });
    expect(hits.some((hit) => hit.id === draft)).toBe(false);
  });
});
