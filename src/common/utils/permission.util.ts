/**
 * Permission matching.
 *
 * Permissions are `resource:action` strings (`agent:create`, `document:read`).
 * Two wildcard forms are supported so that role definitions stay small:
 *
 *   `*:*`      - platform/owner level, grants everything
 *   `agent:*`  - every action on a single resource
 *
 * Wildcards are only ever expanded on the *granted* side. A required permission
 * is always concrete, which keeps the check unambiguous and prevents a route
 * from accidentally demanding "any agent permission".
 */

export const WILDCARD = '*';
export const PERMISSION_SEPARATOR = ':';
export const SUPER_PERMISSION = '*:*';

export interface ParsedPermission {
  resource: string;
  action: string;
}

/** Splits `resource:action`, returning `null` for malformed input. */
export function parsePermission(permission: string): ParsedPermission | null {
  const separatorIndex = permission.indexOf(PERMISSION_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === permission.length - 1) return null;

  return {
    resource: permission.slice(0, separatorIndex).trim().toLowerCase(),
    action: permission.slice(separatorIndex + 1).trim().toLowerCase(),
  };
}

/** True when a single granted permission satisfies a single required permission. */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === SUPER_PERMISSION) return true;

  const grantedParts = parsePermission(granted);
  const requiredParts = parsePermission(required);
  if (!grantedParts || !requiredParts) return false;

  const resourceOk =
    grantedParts.resource === WILDCARD || grantedParts.resource === requiredParts.resource;
  const actionOk =
    grantedParts.action === WILDCARD || grantedParts.action === requiredParts.action;

  return resourceOk && actionOk;
}

/** True when the granted set satisfies the required permission. */
export function hasPermission(granted: Iterable<string>, required: string): boolean {
  for (const permission of granted) {
    if (permissionMatches(permission, required)) return true;
  }
  return false;
}

/** True when the granted set satisfies *every* required permission. */
export function hasAllPermissions(
  granted: Iterable<string>,
  required: readonly string[],
): boolean {
  const grantedArray = Array.from(granted);
  return required.every((permission) => hasPermission(grantedArray, permission));
}

/** True when the granted set satisfies *at least one* required permission. */
export function hasAnyPermission(
  granted: Iterable<string>,
  required: readonly string[],
): boolean {
  const grantedArray = Array.from(granted);
  return required.some((permission) => hasPermission(grantedArray, permission));
}

/** Returns the required permissions the granted set does *not* cover. */
export function missingPermissions(
  granted: Iterable<string>,
  required: readonly string[],
): string[] {
  const grantedArray = Array.from(granted);
  return required.filter((permission) => !hasPermission(grantedArray, permission));
}

/**
 * Expands a granted set against the full permission catalogue.
 *
 * Used when returning an effective permission list to the frontend, which needs
 * concrete keys to drive per-button visibility rather than having to reimplement
 * wildcard matching in the browser.
 */
export function expandPermissions(
  granted: Iterable<string>,
  catalogue: readonly string[],
): string[] {
  const grantedArray = Array.from(granted);
  if (grantedArray.includes(SUPER_PERMISSION)) return [...catalogue];

  const expanded = new Set<string>();
  for (const permission of grantedArray) {
    if (permission.includes(WILDCARD)) {
      for (const candidate of catalogue) {
        if (permissionMatches(permission, candidate)) expanded.add(candidate);
      }
    } else {
      expanded.add(permission);
    }
  }
  return Array.from(expanded).sort();
}
