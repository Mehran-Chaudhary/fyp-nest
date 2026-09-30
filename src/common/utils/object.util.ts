/**
 * The entries of a partial update that the caller actually supplied.
 *
 * Request DTOs are classes compiled with ES2022+ class fields, so every
 * property a DTO declares exists on the instance, holding `undefined` when the
 * client did not send it. Spreading such an instance over stored state
 * (`{ ...stored, ...dto }`) therefore overwrites every field the client left
 * out — which, for a settings object, silently switches controls off. Merge
 * through this instead.
 */
export function definedOnly<T extends object>(value: T | null | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/**
 * Applies a partial update to a JSON object: supplied values replace, `null`
 * removes the key (so a client can clear a setting back to its default), and
 * fields the client did not send are left exactly as they were.
 */
export function mergePatch<T extends object>(
  current: T | null | undefined,
  patch: { [K in keyof T]?: T[K] | null } | null | undefined,
): T {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(definedOnly(patch))) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}
