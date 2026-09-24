import {
  matchAny,
  matchValue,
  VECTOR_FIELD,
  type VectorFilter,
  type VectorPayload,
} from '../../../shared/vector-store/vector-filter';
import { readableKnowledgeBaseIds, type AccessScope } from '../domain/access';
import {
  type Classification,
  classificationsWithin,
  dominates,
  isClassification,
} from '../domain/classification';

/**
 * The retrieval access policy, as vector-store filters.
 *
 * This is the core of proposal module 6.6. A standard RAG pipeline asks the
 * vector store for the chunks *nearest* the question, and nearness knows
 * nothing about who is asking: the payroll chunk is the nearest answer to
 * "what does the CEO earn?" for every employee alike. Filtering the results
 * afterwards is not a fix — by then the chunk has been loaded, logged and
 * handed to whatever runs next.
 *
 * Here the policy is part of the query. {@link planRetrieval} turns the
 * caller's access scope into a filter the vector store applies *during* the
 * index traversal, so points outside the scope are never scored, never
 * returned, and never enter this process.
 *
 * Three properties the tests hold this module to:
 *
 *  - **Server-constructed.** The filter is built from an `AccessScope` that was
 *    resolved from the database. No part of it is taken from the request.
 *  - **Narrow-only.** A caller may name knowledge bases or documents to search,
 *    and those names can only *remove* things from the scope. Naming a base
 *    outside the scope is refused, not silently ignored.
 *  - **Mandatory conjunction.** Workspace, compartment, clearance, embedding
 *    model and activation are always all present, joined by AND.
 */

export interface RetrievalPlan {
  filter: VectorFilter;
  knowledgeBaseIds: string[];
  classifications: Classification[];
}

/** A request named knowledge bases outside the caller's scope. */
export class RetrievalScopeError extends Error {
  constructor(readonly unresolvable: string[]) {
    super('One or more requested knowledge bases are not available to this caller.');
    this.name = 'RetrievalScopeError';
  }
}

export interface RetrievalNarrowing {
  knowledgeBaseIds?: readonly string[];
  documentIds?: readonly string[];
}

/**
 * Builds the filter for a search, or returns `null` when the caller can read
 * nothing at all — in which case no search should be issued.
 */
export function planRetrieval(
  scope: AccessScope,
  narrowing: RetrievalNarrowing,
  embeddingModel: string,
): RetrievalPlan | null {
  let knowledgeBaseIds = readableKnowledgeBaseIds(scope);

  if (narrowing.knowledgeBaseIds && narrowing.knowledgeBaseIds.length > 0) {
    const requested = [...new Set(narrowing.knowledgeBaseIds)];
    const unresolvable = requested.filter((id) => !scope.knowledgeBases.has(id));
    if (unresolvable.length > 0) throw new RetrievalScopeError(unresolvable);
    knowledgeBaseIds = requested.sort();
  }

  if (knowledgeBaseIds.length === 0) return null;

  const classifications = classificationsWithin(scope.clearance);

  const must = [
    matchValue(VECTOR_FIELD.ORGANIZATION_ID, scope.organizationId),
    matchAny(VECTOR_FIELD.KNOWLEDGE_BASE_ID, knowledgeBaseIds),
    matchAny(VECTOR_FIELD.CLASSIFICATION, classifications),
    matchValue(VECTOR_FIELD.EMBEDDING_MODEL, embeddingModel),
    matchValue(VECTOR_FIELD.ACTIVE, true),
  ];

  if (narrowing.documentIds && narrowing.documentIds.length > 0) {
    must.push(matchAny(VECTOR_FIELD.DOCUMENT_ID, [...new Set(narrowing.documentIds)]));
  }

  return { filter: { must }, knowledgeBaseIds, classifications };
}

/**
 * The complement: everything searchable in this workspace that the caller may
 * *not* see.
 *
 * Used only to write the audit record of what the policy withheld from a query
 * — and even then only ids are fetched, never text. It answers the question a
 * compliance reviewer asks of an access-controlled RAG system: "show me the
 * policy actually doing something".
 */
export function buildWithheldFilter(
  scope: AccessScope,
  embeddingModel: string,
): VectorFilter {
  const base = [
    matchValue(VECTOR_FIELD.ORGANIZATION_ID, scope.organizationId),
    matchValue(VECTOR_FIELD.EMBEDDING_MODEL, embeddingModel),
    matchValue(VECTOR_FIELD.ACTIVE, true),
  ];

  const readable = readableKnowledgeBaseIds(scope);
  if (readable.length === 0) return { must: base };

  return {
    must: base,
    must_not: [
      {
        must: [
          matchAny(VECTOR_FIELD.KNOWLEDGE_BASE_ID, readable),
          matchAny(VECTOR_FIELD.CLASSIFICATION, classificationsWithin(scope.clearance)),
        ],
      },
    ],
  };
}

/** Why a withheld point was withheld: wrong compartment, or above clearance. */
export function withheldReason(
  payload: Partial<VectorPayload>,
  scope: AccessScope,
): 'compartment' | 'clearance' {
  const knowledgeBaseId = payload[VECTOR_FIELD.KNOWLEDGE_BASE_ID];
  if (!knowledgeBaseId || !scope.knowledgeBases.has(knowledgeBaseId)) return 'compartment';

  const classification = payload[VECTOR_FIELD.CLASSIFICATION];
  if (isClassification(classification) && dominates(scope.clearance, classification)) {
    // Should be unreachable given the filter; reported conservatively.
    return 'compartment';
  }
  return 'clearance';
}
