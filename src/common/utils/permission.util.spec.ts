import {
  expandPermissions,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  missingPermissions,
  parsePermission,
  permissionMatches,
} from './permission.util';

/**
 * Permission matching is the innermost authorization primitive: every
 * `@RequirePermissions()` check bottoms out here. A false positive is a
 * privilege escalation, so the negative cases below matter more than the
 * positive ones.
 */
describe('permission matching', () => {
  describe('parsePermission', () => {
    it('splits a well-formed key', () => {
      expect(parsePermission('document:read')).toEqual({
        resource: 'document',
        action: 'read',
      });
    });

    it('normalises case', () => {
      expect(parsePermission('Document:READ')).toEqual({
        resource: 'document',
        action: 'read',
      });
    });

    it('rejects malformed keys rather than guessing', () => {
      expect(parsePermission('document')).toBeNull();
      expect(parsePermission(':read')).toBeNull();
      expect(parsePermission('document:')).toBeNull();
      expect(parsePermission('')).toBeNull();
    });

    it('treats only the first colon as the separator', () => {
      // `pii:policy:update` is a real key in the catalogue.
      expect(parsePermission('pii:policy:update')).toEqual({
        resource: 'pii',
        action: 'policy:update',
      });
    });
  });

  describe('permissionMatches', () => {
    it('matches an exact key', () => {
      expect(permissionMatches('document:read', 'document:read')).toBe(true);
    });

    it('does not match a different action on the same resource', () => {
      expect(permissionMatches('document:read', 'document:delete')).toBe(false);
    });

    it('does not match the same action on a different resource', () => {
      expect(permissionMatches('document:read', 'agent:read')).toBe(false);
    });

    it('honours a resource wildcard', () => {
      expect(permissionMatches('document:*', 'document:delete')).toBe(true);
      expect(permissionMatches('document:*', 'agent:delete')).toBe(false);
    });

    it('honours the super wildcard', () => {
      expect(permissionMatches('*:*', 'anything:at-all')).toBe(true);
    });

    it('does not let a wildcard on the REQUIRED side widen a grant', () => {
      // A route must never demand "any document permission"; requirements are
      // always concrete. Granting `document:read` must not satisfy `document:*`.
      expect(permissionMatches('document:read', 'document:*')).toBe(false);
    });
  });

  describe('hasPermission', () => {
    const granted = ['workspace:read', 'document:*', 'member:read'];

    it('finds a concrete grant', () => {
      expect(hasPermission(granted, 'workspace:read')).toBe(true);
    });

    it('finds a grant through a wildcard', () => {
      expect(hasPermission(granted, 'document:delete')).toBe(true);
    });

    it('denies what is not granted', () => {
      expect(hasPermission(granted, 'role:create')).toBe(false);
      expect(hasPermission(granted, 'member:remove')).toBe(false);
    });

    it('denies everything for an empty grant set', () => {
      expect(hasPermission([], 'workspace:read')).toBe(false);
    });
  });

  describe('hasAllPermissions / hasAnyPermission', () => {
    const granted = ['document:read', 'agent:execute'];

    it('requires every permission for ALL-of', () => {
      expect(hasAllPermissions(granted, ['document:read', 'agent:execute'])).toBe(true);
      expect(hasAllPermissions(granted, ['document:read', 'agent:delete'])).toBe(false);
    });

    it('requires one permission for ANY-of', () => {
      expect(hasAnyPermission(granted, ['document:read', 'agent:delete'])).toBe(true);
      expect(hasAnyPermission(granted, ['role:create', 'agent:delete'])).toBe(false);
    });

    it('treats an empty requirement list as satisfied for ALL-of', () => {
      expect(hasAllPermissions(granted, [])).toBe(true);
    });

    it('treats an empty requirement list as unsatisfied for ANY-of', () => {
      // "at least one of nothing" is false, which is the fail-closed reading.
      expect(hasAnyPermission(granted, [])).toBe(false);
    });
  });

  describe('missingPermissions', () => {
    it('reports only what is absent', () => {
      expect(
        missingPermissions(['document:read'], ['document:read', 'document:delete']),
      ).toEqual(['document:delete']);
    });

    it('reports nothing when a wildcard covers the requirement', () => {
      expect(missingPermissions(['*:*'], ['anything:goes'])).toEqual([]);
    });
  });

  describe('expandPermissions', () => {
    const catalogue = [
      'document:read',
      'document:create',
      'document:delete',
      'agent:read',
      'agent:execute',
    ];

    it('expands a resource wildcard against the catalogue', () => {
      expect(expandPermissions(['document:*'], catalogue)).toEqual([
        'document:create',
        'document:delete',
        'document:read',
      ]);
    });

    it('expands the super wildcard to the whole catalogue', () => {
      expect(expandPermissions(['*:*'], catalogue)).toEqual(catalogue);
    });

    it('passes concrete keys through and de-duplicates', () => {
      expect(expandPermissions(['agent:read', 'agent:read'], catalogue)).toEqual([
        'agent:read',
      ]);
    });

    it('combines wildcards and concrete keys', () => {
      expect(expandPermissions(['agent:*', 'document:read'], catalogue)).toEqual([
        'agent:execute',
        'agent:read',
        'document:read',
      ]);
    });
  });
});
