import {
  Classification,
  classificationRank,
  dominates,
  isClassification,
} from '../../knowledge/domain/classification';

/**
 * Information-flow labels for conversation messages.
 *
 * Retrieval enforces the access lattice on documents (ADR 0002). But once a
 * RESTRICTED passage has been read into an answer, the answer *contains* it —
 * and an answer is stored, shown again, read by supervisors, and fed back to
 * the model as history. Without labels, conversation history is a way around
 * every control retrieval applies: the payroll figure an HR manager asked about
 * would be readable by an auditor who could never retrieve payroll, and by the
 * HR manager themselves after losing HR access.
 *
 * So derived data carries the label of what it was derived from — the
 * high-water mark of the lattice (Weissman, 1969; the *-property of
 * Bell–LaPadula applied to derived artefacts):
 *
 *  - an **assistant** message is labelled with the join of every input to its
 *    prompt: the classifications and compartments of the passages retrieved,
 *    and the labels of the history messages included;
 *  - a **user** message is labelled with the conversation's high-water mark at
 *    the time it was written, because the user may be quoting anything they
 *    were shown before.
 *
 * A label is checked on every read and every time a message is considered for
 * a prompt, against the reader's *current* access: clearance, compartments,
 * and whether the source documents still exist. Deleting a document therefore
 * withdraws the answers that quoted it, too.
 */
export interface InformationLabel {
  classification: Classification;
  knowledgeBaseIds: string[];
  documentIds: string[];
}

/** Most documents a label records; beyond this, compartment and clearance still apply. */
export const MAX_LABEL_DOCUMENTS = 200;

export const PUBLIC_LABEL: InformationLabel = Object.freeze({
  classification: Classification.PUBLIC,
  knowledgeBaseIds: [],
  documentIds: [],
});

/** The least upper bound of several labels. */
export function joinLabels(
  ...labels: ReadonlyArray<Partial<InformationLabel> | null | undefined>
): InformationLabel {
  let classification = Classification.PUBLIC;
  const knowledgeBaseIds = new Set<string>();
  const documentIds = new Set<string>();

  for (const label of labels) {
    if (!label) continue;
    if (
      label.classification &&
      isClassification(label.classification) &&
      classificationRank(label.classification) > classificationRank(classification)
    ) {
      classification = label.classification;
    }
    for (const id of label.knowledgeBaseIds ?? []) knowledgeBaseIds.add(id);
    for (const id of label.documentIds ?? []) documentIds.add(id);
  }

  return {
    classification,
    knowledgeBaseIds: [...knowledgeBaseIds].sort(),
    documentIds: [...documentIds].sort().slice(0, MAX_LABEL_DOCUMENTS),
  };
}

export type WithholdReason = 'CLEARANCE' | 'COMPARTMENT' | 'SOURCE_DELETED';

/** What a reader's current access looks like, for label checks. */
export interface LabelReader {
  clearance: Classification;
  /** Knowledge bases the reader can currently read. A deleted base is absent. */
  readableKnowledgeBaseIds: ReadonlySet<string>;
  /** Source documents that no longer exist. */
  deletedDocumentIds: ReadonlySet<string>;
}

/** Null when the reader may see content with this label; otherwise why not. */
export function withholdReason(
  label: InformationLabel,
  reader: LabelReader,
): WithholdReason | null {
  const classification = isClassification(label.classification)
    ? label.classification
    : Classification.RESTRICTED; // unknown label: fail closed
  if (!dominates(reader.clearance, classification)) return 'CLEARANCE';
  if (label.knowledgeBaseIds.some((id) => !reader.readableKnowledgeBaseIds.has(id))) {
    return 'COMPARTMENT';
  }
  if (label.documentIds.some((id) => reader.deletedDocumentIds.has(id)))
    return 'SOURCE_DELETED';
  return null;
}
