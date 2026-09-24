import { createHash } from 'node:crypto';

/**
 * Name-based UUIDs (RFC 9562 version 5).
 *
 * Used where an identifier must be *derived* rather than generated: the id of a
 * document chunk is a function of `(document, index version, chunk position)`.
 * Re-running an ingestion step therefore produces the same ids, so writing the
 * same chunk twice — after a worker crash, say — overwrites rather than
 * duplicates, in PostgreSQL and in the vector store alike. Idempotency by
 * construction rather than by bookkeeping.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Derives a v5 UUID for `name` within `namespace` (itself a UUID). */
export function uuidV5(name: string, namespace: string): string {
  if (!isUuid(namespace)) {
    throw new Error(`uuidV5 namespace must be a UUID, received "${namespace}".`);
  }

  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();

  const bytes = hash.subarray(0, 16);
  // Version 5 in the high nibble of byte 6; RFC variant in the top bits of byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
