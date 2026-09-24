import {
  matchesFilter,
  VECTOR_FIELD,
  type VectorFilter,
  type VectorPayload,
} from '../../../shared/vector-store/vector-filter';
import {
  AccessLevel,
  computeAccessScope,
  KnowledgeBaseAccessMode,
  type AccessPrincipal,
  type KnowledgeBaseAccessRow,
} from '../domain/access';
import { Classification } from '../domain/classification';
import {
  buildWithheldFilter,
  planRetrieval,
  RetrievalScopeError,
  withheldReason,
} from './retrieval-policy';

/**
 * The secure retrieval policy — the core claim of proposal module 6.6.
 *
 * These tests do not merely inspect the filter's structure. They run the
 * *real* filters, as built for real principals, against a corpus of vector
 * payloads using an evaluator with Qdrant's filter semantics, and assert on
 * which payloads get through. That is the property that matters: "a member
 * without access to HR never receives an HR chunk", stated over data.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const MODEL = 'nomic-embed-text';

const HANDBOOK = 'aaaaaaaa-0000-4000-8000-000000000001';
const HR = 'aaaaaaaa-0000-4000-8000-000000000002';
const FINANCE = 'aaaaaaaa-0000-4000-8000-000000000003';

const ROWS: KnowledgeBaseAccessRow[] = [
  { id: HANDBOOK, accessMode: KnowledgeBaseAccessMode.WORKSPACE, grantLevel: null },
  { id: HR, accessMode: KnowledgeBaseAccessMode.RESTRICTED, grantLevel: null },
  { id: FINANCE, accessMode: KnowledgeBaseAccessMode.RESTRICTED, grantLevel: null },
];

function principal(permissions: string[]): AccessPrincipal {
  return { organizationId: ORG, kind: 'user', userId: 'u', membershipId: 'm', permissions };
}

function withGrant(
  rows: KnowledgeBaseAccessRow[],
  id: string,
  level: AccessLevel,
): KnowledgeBaseAccessRow[] {
  return rows.map((row) => (row.id === id ? { ...row, grantLevel: level } : row));
}

let sequence = 0;
function point(overrides: Partial<VectorPayload>): VectorPayload {
  sequence += 1;
  return {
    organization_id: ORG,
    knowledge_base_id: HANDBOOK,
    document_id: `doc-${sequence}`,
    index_version: 1,
    chunk_index: 0,
    classification: Classification.INTERNAL,
    embedding_model: MODEL,
    active: true,
    ...overrides,
  };
}

/** A workspace's worth of vectors, plus some that must never match anyone here. */
const CORPUS: VectorPayload[] = [
  point({ knowledge_base_id: HANDBOOK, classification: Classification.PUBLIC }),
  point({ knowledge_base_id: HANDBOOK, classification: Classification.INTERNAL }),
  point({ knowledge_base_id: HANDBOOK, classification: Classification.CONFIDENTIAL }),
  point({ knowledge_base_id: HR, classification: Classification.INTERNAL }),
  point({ knowledge_base_id: HR, classification: Classification.CONFIDENTIAL }),
  point({
    knowledge_base_id: HR,
    classification: Classification.RESTRICTED,
    document_id: 'payroll',
  }),
  point({ knowledge_base_id: FINANCE, classification: Classification.CONFIDENTIAL }),
  // Another tenant's point that happens to reuse a knowledge-base id.
  point({ organization_id: OTHER_ORG, knowledge_base_id: HANDBOOK }),
  // A half-indexed document version.
  point({ knowledge_base_id: HANDBOOK, active: false }),
  // A vector from a different embedding model.
  point({ knowledge_base_id: HANDBOOK, embedding_model: 'other-model' }),
];

function admitted(filter: VectorFilter): VectorPayload[] {
  return CORPUS.filter((payload) =>
    matchesFilter(payload as unknown as Record<string, unknown>, filter),
  );
}

describe('secure retrieval policy', () => {
  describe('an ordinary member (INTERNAL clearance, no grants)', () => {
    const scope = computeAccessScope(principal(['rag:query', 'clearance:internal']), ROWS);
    const plan = planRetrieval(scope, {}, MODEL);

    it('searches only the workspace-mode base', () => {
      expect(plan?.knowledgeBaseIds).toEqual([HANDBOOK]);
    });

    it('never receives a chunk from a restricted compartment', () => {
      const results = admitted(plan!.filter);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((payload) => payload.knowledge_base_id === HANDBOOK)).toBe(true);
    });

    it('never receives a chunk above its clearance', () => {
      const results = admitted(plan!.filter);
      expect(results.map((payload) => payload.classification).sort()).toEqual([
        Classification.INTERNAL,
        Classification.PUBLIC,
      ]);
    });

    it('never receives the payroll document — the proposal’s own example', () => {
      expect(
        admitted(plan!.filter).some((payload) => payload.document_id === 'payroll'),
      ).toBe(false);
    });
  });

  describe('tenant isolation', () => {
    it('never admits another workspace’s points, whatever else matches', () => {
      const scope = computeAccessScope(principal(['*:*']), ROWS);
      const results = admitted(planRetrieval(scope, {}, MODEL)!.filter);
      expect(results.every((payload) => payload.organization_id === ORG)).toBe(true);
    });
  });

  describe('versions and models', () => {
    const scope = computeAccessScope(principal(['*:*']), ROWS);
    const results = admitted(planRetrieval(scope, {}, MODEL)!.filter);

    it('never admits a half-indexed version', () => {
      expect(results.every((payload) => payload.active)).toBe(true);
    });

    it('never compares vectors from another embedding model', () => {
      expect(results.every((payload) => payload.embedding_model === MODEL)).toBe(true);
    });
  });

  describe('compartment grants and clearance combine', () => {
    it('an HR grant without clearance still withholds RESTRICTED payroll', () => {
      const scope = computeAccessScope(
        principal(['rag:query', 'clearance:confidential']),
        withGrant(ROWS, HR, AccessLevel.READ),
      );
      const results = admitted(planRetrieval(scope, {}, MODEL)!.filter);

      expect(results.some((payload) => payload.knowledge_base_id === HR)).toBe(true);
      expect(results.some((payload) => payload.document_id === 'payroll')).toBe(false);
      // Finance remains a compartment the member was never admitted to.
      expect(results.some((payload) => payload.knowledge_base_id === FINANCE)).toBe(false);
    });

    it('high clearance without a grant still withholds the compartment', () => {
      const scope = computeAccessScope(
        principal(['rag:query', 'clearance:restricted']),
        ROWS,
      );
      const results = admitted(planRetrieval(scope, {}, MODEL)!.filter);
      expect(results.some((payload) => payload.knowledge_base_id !== HANDBOOK)).toBe(false);
    });

    it('grant plus clearance admits payroll', () => {
      const scope = computeAccessScope(
        principal(['rag:query', 'clearance:restricted']),
        withGrant(ROWS, HR, AccessLevel.READ),
      );
      const results = admitted(planRetrieval(scope, {}, MODEL)!.filter);
      expect(results.some((payload) => payload.document_id === 'payroll')).toBe(true);
    });
  });

  describe('the administrator role', () => {
    it('does not bypass compartments, despite knowledgebase:* and document:*', () => {
      const scope = computeAccessScope(
        principal(['knowledgebase:*', 'document:*', 'rag:query', 'clearance:confidential']),
        ROWS,
      );
      expect(scope.superuser).toBe(false);
      expect([...scope.knowledgeBases.keys()]).toEqual([HANDBOOK]);
    });
  });

  describe('the owner (*:*)', () => {
    it('bypasses compartments and holds RESTRICTED clearance', () => {
      const scope = computeAccessScope(principal(['*:*']), ROWS);
      expect(scope.superuser).toBe(true);
      expect(scope.clearance).toBe(Classification.RESTRICTED);
      expect(scope.knowledgeBases.size).toBe(3);
    });
  });

  describe('caller-supplied narrowing', () => {
    const scope = computeAccessScope(
      principal(['rag:query', 'clearance:internal']),
      withGrant(ROWS, HR, AccessLevel.READ),
    );

    it('narrows to a named base', () => {
      const plan = planRetrieval(scope, { knowledgeBaseIds: [HR] }, MODEL)!;
      expect(plan.knowledgeBaseIds).toEqual([HR]);
      expect(
        admitted(plan.filter).every((payload) => payload.knowledge_base_id === HR),
      ).toBe(true);
    });

    it('can never widen: naming an inaccessible base is refused, not ignored', () => {
      expect(() =>
        planRetrieval(scope, { knowledgeBaseIds: [HANDBOOK, FINANCE] }, MODEL),
      ).toThrow(RetrievalScopeError);
    });

    it('reports exactly which requested bases were unresolvable', () => {
      try {
        planRetrieval(scope, { knowledgeBaseIds: [FINANCE, 'nonexistent'] }, MODEL);
        throw new Error('expected a scope error');
      } catch (error) {
        expect((error as RetrievalScopeError).unresolvable.sort()).toEqual(
          [FINANCE, 'nonexistent'].sort(),
        );
      }
    });

    it('narrowing by document still keeps every other condition', () => {
      const payroll = CORPUS.find((payload) => payload.document_id === 'payroll')!;
      const plan = planRetrieval(scope, { documentIds: [payroll.document_id] }, MODEL)!;
      // Asking for the payroll document by id does not make it visible.
      expect(admitted(plan.filter)).toEqual([]);
    });
  });

  describe('a principal who can read nothing', () => {
    it('gets no plan, so no search is issued at all', () => {
      const scope = computeAccessScope(principal(['rag:query']), [
        { id: HR, accessMode: KnowledgeBaseAccessMode.RESTRICTED, grantLevel: null },
      ]);
      expect(planRetrieval(scope, {}, MODEL)).toBeNull();
    });
  });

  describe('an API key', () => {
    it('reaches a restricted base only through an explicit grant', () => {
      const key: AccessPrincipal = {
        organizationId: ORG,
        kind: 'api_key',
        apiKeyId: 'k',
        permissions: ['rag:query', 'clearance:internal'],
      };
      expect([...computeAccessScope(key, ROWS).knowledgeBases.keys()]).toEqual([HANDBOOK]);
      expect(
        [
          ...computeAccessScope(
            key,
            withGrant(ROWS, HR, AccessLevel.READ),
          ).knowledgeBases.keys(),
        ].sort(),
      ).toEqual([HANDBOOK, HR].sort());
    });
  });

  describe('the filter is a strict conjunction', () => {
    it('always carries all five mandatory conditions', () => {
      const scope = computeAccessScope(
        principal(['rag:query', 'clearance:internal']),
        ROWS,
      );
      const plan = planRetrieval(scope, {}, MODEL)!;
      const keys = (plan.filter.must ?? []).map((condition) =>
        'key' in condition ? condition.key : null,
      );

      expect(keys).toEqual(
        expect.arrayContaining([
          VECTOR_FIELD.ORGANIZATION_ID,
          VECTOR_FIELD.KNOWLEDGE_BASE_ID,
          VECTOR_FIELD.CLASSIFICATION,
          VECTOR_FIELD.EMBEDDING_MODEL,
          VECTOR_FIELD.ACTIVE,
        ]),
      );
      expect(plan.filter.should).toBeUndefined();
    });
  });

  describe('the withheld-content probe', () => {
    const scope = computeAccessScope(principal(['rag:query', 'clearance:internal']), ROWS);
    const allowed = admitted(planRetrieval(scope, {}, MODEL)!.filter);
    const withheld = admitted(buildWithheldFilter(scope, MODEL));

    it('is exactly the complement of what the caller can see, within the workspace', () => {
      const searchable = CORPUS.filter(
        (payload) =>
          payload.organization_id === ORG &&
          payload.active &&
          payload.embedding_model === MODEL,
      );
      expect(allowed.length + withheld.length).toBe(searchable.length);
      expect(allowed.some((payload) => withheld.includes(payload))).toBe(false);
    });

    it('explains each withheld point', () => {
      const reasons = withheld.map((payload) => withheldReason(payload, scope));
      expect(reasons).toContain('compartment');
      expect(reasons).toContain('clearance');
    });

    it('treats a caller with no readable bases as withholding everything', () => {
      const nobody = computeAccessScope(principal([]), [
        { id: HR, accessMode: KnowledgeBaseAccessMode.RESTRICTED, grantLevel: null },
      ]);
      expect(admitted(buildWithheldFilter(nobody, MODEL)).length).toBe(
        CORPUS.filter(
          (payload) =>
            payload.organization_id === ORG &&
            payload.active &&
            payload.embedding_model === MODEL,
        ).length,
      );
    });
  });
});
