import {
  AccessLevel,
  accessLevelFromRank,
  atLeast,
  computeAccessScope,
  KnowledgeBaseAccessMode,
} from './access';
import {
  Classification,
  classificationsWithin,
  dominates,
  resolveClearance,
} from './classification';
import { canTransition, DocumentStatus, sourcesOf } from './document-status';

describe('knowledge domain', () => {
  describe('clearance', () => {
    it('is PUBLIC with no clearance permission', () => {
      expect(resolveClearance(['document:read', 'rag:query'])).toBe(Classification.PUBLIC);
    });

    it('takes the highest level held', () => {
      expect(resolveClearance(['clearance:internal', 'clearance:confidential'])).toBe(
        Classification.CONFIDENTIAL,
      );
    });

    it('is hierarchical: a higher level alone implies the lower ones', () => {
      const clearance = resolveClearance(['clearance:restricted']);
      expect(clearance).toBe(Classification.RESTRICTED);
      expect(classificationsWithin(clearance)).toEqual([
        Classification.PUBLIC,
        Classification.INTERNAL,
        Classification.CONFIDENTIAL,
        Classification.RESTRICTED,
      ]);
    });

    it('honours wildcards the same way the permissions guard does', () => {
      expect(resolveClearance(['clearance:*'])).toBe(Classification.RESTRICTED);
      expect(resolveClearance(['*:*'])).toBe(Classification.RESTRICTED);
    });

    it('is not conferred by unrelated wildcards', () => {
      expect(resolveClearance(['document:*', 'knowledgebase:*'])).toBe(
        Classification.PUBLIC,
      );
    });
  });

  describe('dominance', () => {
    it('allows reading at or below the clearance', () => {
      expect(dominates(Classification.CONFIDENTIAL, Classification.CONFIDENTIAL)).toBe(
        true,
      );
      expect(dominates(Classification.CONFIDENTIAL, Classification.PUBLIC)).toBe(true);
    });

    it('refuses reading above it', () => {
      expect(dominates(Classification.INTERNAL, Classification.CONFIDENTIAL)).toBe(false);
      expect(dominates(Classification.PUBLIC, Classification.INTERNAL)).toBe(false);
    });

    it('produces an allowlist, not a range', () => {
      expect(classificationsWithin(Classification.INTERNAL)).toEqual([
        Classification.PUBLIC,
        Classification.INTERNAL,
      ]);
    });
  });

  describe('access levels', () => {
    it('orders READ < WRITE < MANAGE', () => {
      expect(atLeast(AccessLevel.MANAGE, AccessLevel.WRITE)).toBe(true);
      expect(atLeast(AccessLevel.WRITE, AccessLevel.WRITE)).toBe(true);
      expect(atLeast(AccessLevel.READ, AccessLevel.WRITE)).toBe(false);
      expect(atLeast(undefined, AccessLevel.READ)).toBe(false);
    });

    it('maps SQL grant ranks back to levels', () => {
      expect(accessLevelFromRank(3)).toBe(AccessLevel.MANAGE);
      expect(accessLevelFromRank(1)).toBe(AccessLevel.READ);
      expect(accessLevelFromRank(null)).toBeNull();
      expect(accessLevelFromRank(9)).toBeNull();
    });

    it('uses the grant level inside a restricted base', () => {
      const scope = computeAccessScope(
        { organizationId: 'o', kind: 'user', permissions: ['knowledgebase:read'] },
        [
          {
            id: 'kb',
            accessMode: KnowledgeBaseAccessMode.RESTRICTED,
            grantLevel: AccessLevel.READ,
          },
        ],
      );
      expect(scope.knowledgeBases.get('kb')).toBe(AccessLevel.READ);
    });
  });

  describe('document status machine', () => {
    it('follows the documented pipeline', () => {
      expect(canTransition(DocumentStatus.UPLOADED, DocumentStatus.PARSING)).toBe(true);
      expect(canTransition(DocumentStatus.PARSING, DocumentStatus.CHUNKING)).toBe(true);
      expect(canTransition(DocumentStatus.CHUNKING, DocumentStatus.EMBEDDING)).toBe(true);
      expect(canTransition(DocumentStatus.EMBEDDING, DocumentStatus.READY)).toBe(true);
    });

    it('supports crash recovery: re-parse and resume embedding', () => {
      expect(canTransition(DocumentStatus.PARSING, DocumentStatus.PARSING)).toBe(true);
      expect(canTransition(DocumentStatus.CHUNKING, DocumentStatus.PARSING)).toBe(true);
      expect(canTransition(DocumentStatus.EMBEDDING, DocumentStatus.EMBEDDING)).toBe(true);
    });

    it('cannot skip stages', () => {
      expect(canTransition(DocumentStatus.UPLOADED, DocumentStatus.READY)).toBe(false);
      expect(canTransition(DocumentStatus.PARSING, DocumentStatus.EMBEDDING)).toBe(false);
    });

    it('cannot move a finished document except back to UPLOADED', () => {
      expect(canTransition(DocumentStatus.READY, DocumentStatus.PARSING)).toBe(false);
      expect(canTransition(DocumentStatus.READY, DocumentStatus.UPLOADED)).toBe(true);
      expect(canTransition(DocumentStatus.FAILED, DocumentStatus.UPLOADED)).toBe(true);
    });

    it('derives compare-and-set sources from the same table', () => {
      expect(sourcesOf(DocumentStatus.PARSING).sort()).toEqual(
        [DocumentStatus.UPLOADED, DocumentStatus.PARSING, DocumentStatus.CHUNKING].sort(),
      );
      expect(sourcesOf(DocumentStatus.READY)).toEqual([DocumentStatus.EMBEDDING]);
    });
  });
});
