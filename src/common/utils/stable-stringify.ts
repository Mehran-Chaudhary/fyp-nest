/**
 * Deterministic JSON serialisation with recursively sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * metadata objects built in different orders would hash differently and a
 * re-verification could fail on a record nobody touched.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}
