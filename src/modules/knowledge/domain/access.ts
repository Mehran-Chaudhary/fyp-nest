import { SUPER_PERMISSION, hasPermission } from '../../../common/utils/permission.util';
import { type Classification, resolveClearance } from './classification';

/**
 * Knowledge-base compartments and how a principal's access to them is derived.
 *
 * ## Two access modes
 *
 *  - **WORKSPACE** — the base behaves like any other workspace resource: what a
 *    member may do in it is decided by their role permissions alone
 *    (`document:create`, `knowledgebase:update`, …).
 *  - **RESTRICTED** — a compartment. On top of role permissions, the principal
 *    needs an explicit grant — to them, to one of their roles, or to their API
 *    key — at a sufficient level. Without one the base is invisible: it does
 *    not appear in lists, and addressing it by id returns 404, not 403, so its
 *    existence is not disclosed.
 *
 * ## Levels
 *
 * `READ` (list, read, retrieve) < `WRITE` (upload, edit, reindex, delete
 * documents) < `MANAGE` (edit the base, manage its grants, delete it). A level
 * says *where* a principal may act; the role permission still says *what* they
 * may do. Both are required.
 *
 * ## Who bypasses compartments
 *
 * Only holders of `*:*` — the workspace owner and, through their audited
 * break-glass path, platform administrators. Deliberately *not* the
 * administrator role: running a workspace is a different entitlement from
 * reading its HR files. Note that `knowledgebase:*` does not match `*:*`, so an
 * administrator's wildcards do not accidentally confer the bypass.
 */
export enum KnowledgeBaseAccessMode {
  WORKSPACE = 'WORKSPACE',
  RESTRICTED = 'RESTRICTED',
}

export enum AccessLevel {
  READ = 'READ',
  WRITE = 'WRITE',
  MANAGE = 'MANAGE',
}

const ACCESS_LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  [AccessLevel.READ]: 1,
  [AccessLevel.WRITE]: 2,
  [AccessLevel.MANAGE]: 3,
};

const LEVEL_BY_RANK: Readonly<Record<number, AccessLevel>> = {
  1: AccessLevel.READ,
  2: AccessLevel.WRITE,
  3: AccessLevel.MANAGE,
};

export function accessLevelRank(level: AccessLevel): number {
  return ACCESS_LEVEL_RANK[level];
}

export function accessLevelFromRank(rank: number | null | undefined): AccessLevel | null {
  return rank ? (LEVEL_BY_RANK[rank] ?? null) : null;
}

export function atLeast(
  level: AccessLevel | undefined | null,
  required: AccessLevel,
): boolean {
  return level ? ACCESS_LEVEL_RANK[level] >= ACCESS_LEVEL_RANK[required] : false;
}

/** Who is asking, as far as the knowledge layer is concerned. */
export interface AccessPrincipal {
  organizationId: string;
  kind: 'user' | 'api_key';
  userId?: string;
  /**
   * The caller's real membership id. Absent for API keys, and absent for a
   * platform administrator acting through the break-glass path, who has no
   * membership row (and needs none: they hold `*:*`).
   */
  membershipId?: string;
  apiKeyId?: string;
  permissions: readonly string[];
}

/** One knowledge base, as returned by the access query. */
export interface KnowledgeBaseAccessRow {
  id: string;
  accessMode: KnowledgeBaseAccessMode;
  /** The strongest grant the principal holds on it, if any. */
  grantLevel: AccessLevel | null;
}

/**
 * Everything the knowledge layer needs to authorise a request, computed once
 * per request from the database — never from the token, never from the client.
 */
export interface AccessScope {
  organizationId: string;
  principal: AccessPrincipal;
  superuser: boolean;
  clearance: Classification;
  /** Every base the principal may at least READ, with its effective level. */
  knowledgeBases: ReadonlyMap<string, AccessLevel>;
}

export function computeAccessScope(
  principal: AccessPrincipal,
  rows: readonly KnowledgeBaseAccessRow[],
): AccessScope {
  const superuser = hasPermission(principal.permissions, SUPER_PERMISSION);
  const knowledgeBases = new Map<string, AccessLevel>();

  for (const row of rows) {
    if (superuser) {
      knowledgeBases.set(row.id, AccessLevel.MANAGE);
    } else if (row.accessMode === KnowledgeBaseAccessMode.WORKSPACE) {
      // Not a compartment: role permissions alone decide what may be done.
      knowledgeBases.set(row.id, AccessLevel.MANAGE);
    } else if (row.grantLevel) {
      knowledgeBases.set(row.id, row.grantLevel);
    }
    // RESTRICTED without a grant: absent, and therefore invisible.
  }

  return {
    organizationId: principal.organizationId,
    principal,
    superuser,
    clearance: resolveClearance(principal.permissions),
    knowledgeBases,
  };
}

/** Bases the principal may at least read, in a stable order. */
export function readableKnowledgeBaseIds(scope: AccessScope): string[] {
  return [...scope.knowledgeBases.keys()].sort();
}
