import { hasPermission } from '../../../common/utils/permission.util';

/**
 * Document sensitivity tiers.
 *
 * Together with knowledge-base compartments (see `access.ts`) this forms a
 * lattice-based access model in the Bell–LaPadula tradition, mapped onto the
 * phase 1 RBAC system:
 *
 *  - a **classification** is a document's level (how sensitive it is),
 *  - a **clearance** is a principal's level (how sensitive a document they may
 *    read), held as `clearance:*` permissions,
 *  - a **compartment** is a knowledge base (need-to-know: HR, Finance), held
 *    as grants.
 *
 * A principal reads a document only if its clearance dominates the document's
 * classification **and** it has access to the document's compartment. Neither
 * alone suffices: a CONFIDENTIAL-cleared engineer still cannot read the HR
 * base, and an HR member with only INTERNAL clearance still cannot read the
 * RESTRICTED payroll file inside it.
 */
export enum Classification {
  PUBLIC = 'PUBLIC',
  INTERNAL = 'INTERNAL',
  CONFIDENTIAL = 'CONFIDENTIAL',
  RESTRICTED = 'RESTRICTED',
}

/** Lowest to highest. The order *is* the dominance relation. */
export const CLASSIFICATION_ORDER: readonly Classification[] = [
  Classification.PUBLIC,
  Classification.INTERNAL,
  Classification.CONFIDENTIAL,
  Classification.RESTRICTED,
];

/** The permission that confers each level. PUBLIC needs none. */
export const CLEARANCE_PERMISSION: Readonly<Record<Classification, string | null>> = {
  [Classification.PUBLIC]: null,
  [Classification.INTERNAL]: 'clearance:internal',
  [Classification.CONFIDENTIAL]: 'clearance:confidential',
  [Classification.RESTRICTED]: 'clearance:restricted',
};

export function classificationRank(classification: Classification): number {
  const rank = CLASSIFICATION_ORDER.indexOf(classification);
  if (rank < 0) throw new Error(`Unknown classification "${String(classification)}".`);
  return rank;
}

export function isClassification(value: unknown): value is Classification {
  return CLASSIFICATION_ORDER.includes(value as Classification);
}

/**
 * The highest level whose clearance permission the principal holds.
 *
 * Hierarchical by construction: the scan runs from the top, so holding
 * `clearance:restricted` alone yields RESTRICTED, which dominates everything
 * beneath it. Wildcards (`clearance:*`, `*:*`) are honoured by the same matcher
 * the permissions guard uses.
 */
export function resolveClearance(permissions: readonly string[]): Classification {
  for (let rank = CLASSIFICATION_ORDER.length - 1; rank > 0; rank -= 1) {
    const level = CLASSIFICATION_ORDER[rank];
    const permission = CLEARANCE_PERMISSION[level];
    if (permission && hasPermission(permissions, permission)) return level;
  }
  return Classification.PUBLIC;
}

/** True when `clearance` dominates `classification`. */
export function dominates(
  clearance: Classification,
  classification: Classification,
): boolean {
  return classificationRank(clearance) >= classificationRank(classification);
}

/**
 * Every classification a clearance may read, as an explicit allowlist.
 *
 * Filters use this list (`classification IN (...)`, `match: { any: [...] }`)
 * rather than a numeric range. An allowlist fails closed: a document carrying a
 * value nobody anticipated matches nothing, whereas a range comparison would
 * depend on how that value happened to sort.
 */
export function classificationsWithin(clearance: Classification): Classification[] {
  return CLASSIFICATION_ORDER.slice(0, classificationRank(clearance) + 1);
}
