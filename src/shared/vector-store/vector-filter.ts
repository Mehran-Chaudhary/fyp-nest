/**
 * Vector payload schema and the filter language used against it.
 *
 * Every point in the vector store carries this payload and nothing more. In
 * particular it carries **no text**: chunk content lives encrypted in
 * PostgreSQL and is fetched through a policy-filtered query only after search.
 * A compromise of the (third-party hosted) vector store therefore exposes ids
 * and vectors, not documents.
 */

export const VECTOR_FIELD = {
  ORGANIZATION_ID: 'organization_id',
  KNOWLEDGE_BASE_ID: 'knowledge_base_id',
  DOCUMENT_ID: 'document_id',
  INDEX_VERSION: 'index_version',
  CHUNK_INDEX: 'chunk_index',
  CLASSIFICATION: 'classification',
  EMBEDDING_MODEL: 'embedding_model',
  /**
   * False while a document version is being indexed; flipped to true only once
   * every chunk of that version is in place. A half-indexed document is never
   * retrievable.
   */
  ACTIVE: 'active',
} as const;

export interface VectorPayload {
  [VECTOR_FIELD.ORGANIZATION_ID]: string;
  [VECTOR_FIELD.KNOWLEDGE_BASE_ID]: string;
  [VECTOR_FIELD.DOCUMENT_ID]: string;
  [VECTOR_FIELD.INDEX_VERSION]: number;
  [VECTOR_FIELD.CHUNK_INDEX]: number;
  [VECTOR_FIELD.CLASSIFICATION]: string;
  [VECTOR_FIELD.EMBEDDING_MODEL]: string;
  [VECTOR_FIELD.ACTIVE]: boolean;
}

// ── Filter language ─────────────────────────────────────────────────────────
//
// A strict subset of Qdrant's filter DSL — exactly the constructs the access
// policy needs, and structurally assignable to the client's own type. Keeping
// the subset small is deliberate: it is what makes the in-process evaluator
// below a faithful model of the server's behaviour, and therefore what lets the
// tests prove properties of the real filters.

export interface MatchValueCondition {
  key: string;
  match: { value: string | number | boolean };
}

export interface MatchAnyCondition {
  key: string;
  match: { any: string[] };
}

export type FieldCondition = MatchValueCondition | MatchAnyCondition;

export interface VectorFilter {
  must?: VectorCondition[];
  must_not?: VectorCondition[];
  should?: VectorCondition[];
}

export type VectorCondition = FieldCondition | VectorFilter;

export const matchValue = (
  key: string,
  value: string | number | boolean,
): MatchValueCondition => ({ key, match: { value } });

export const matchAny = (key: string, values: readonly string[]): MatchAnyCondition => ({
  key,
  match: { any: [...values] },
});

function isFieldCondition(condition: VectorCondition): condition is FieldCondition {
  return 'key' in condition;
}

function fieldMatches(
  payload: Record<string, unknown>,
  condition: FieldCondition,
): boolean {
  const raw = payload[condition.key];
  // Qdrant semantics: an array-valued field matches if any element matches.
  const values = Array.isArray(raw) ? (raw as unknown[]) : [raw];

  if ('value' in condition.match) {
    const expected = condition.match.value;
    return values.some((value) => value === expected);
  }

  const allowed = new Set<unknown>(condition.match.any);
  return values.some((value) => allowed.has(value));
}

function conditionMatches(
  payload: Record<string, unknown>,
  condition: VectorCondition,
): boolean {
  return isFieldCondition(condition)
    ? fieldMatches(payload, condition)
    : matchesFilter(payload, condition);
}

/**
 * Evaluates a filter against a payload with Qdrant's semantics.
 *
 * Not used on the request path — Qdrant evaluates filters server-side. It
 * exists so tests can run the *real* access filters against a corpus of
 * payloads and assert on which ones get through.
 */
export function matchesFilter(
  payload: Record<string, unknown>,
  filter: VectorFilter,
): boolean {
  if (
    filter.must &&
    !filter.must.every((condition) => conditionMatches(payload, condition))
  ) {
    return false;
  }
  if (filter.must_not?.some((condition) => conditionMatches(payload, condition))) {
    return false;
  }
  if (filter.should && filter.should.length > 0) {
    return filter.should.some((condition) => conditionMatches(payload, condition));
  }
  return true;
}
