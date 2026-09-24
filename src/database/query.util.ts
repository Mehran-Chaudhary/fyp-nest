/**
 * Normalises the result of a raw `manager.query()`.
 *
 * TypeORM's PostgreSQL driver returns plain rows for SELECT but
 * `[rows, affectedCount]` for UPDATE and DELETE — including `... RETURNING`.
 * Reading `.length` off the latter silently yields 2, whatever was updated;
 * this unwraps it so callers see rows either way.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}
