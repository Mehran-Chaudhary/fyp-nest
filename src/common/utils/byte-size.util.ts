/**
 * Byte-size parsing for configuration.
 *
 * Upload ceilings and storage quotas are written the way people think about
 * them — `50mb`, `1gb` — and parsed once at boot. Binary multiples (1 KB = 1024
 * bytes) are used because that is what every storage provider bills in and what
 * `multer`'s limits are compared against.
 */

const BYTE_SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i;

const UNIT_TO_BYTES: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/**
 * Parses `50mb`, `1.5gb`, `512kb` or a bare byte count.
 *
 * Throws on anything else. As with durations, a silently mis-parsed limit is a
 * security bug — an upload ceiling that parsed to `NaN` compares false against
 * everything and so enforces nothing.
 */
export function parseByteSize(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid byte size: ${value}`);
    }
    return Math.floor(value);
  }

  const match = BYTE_SIZE_PATTERN.exec(String(value).trim());
  if (!match) {
    throw new Error(
      `Invalid byte size "${value}". Expected a number with an optional unit: b, kb, mb, gb, tb.`,
    );
  }

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();

  return Math.floor(amount * UNIT_TO_BYTES[unit]);
}

/** Renders a byte count for messages: `52428800` → `50 MB`. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[index]}`;
}
