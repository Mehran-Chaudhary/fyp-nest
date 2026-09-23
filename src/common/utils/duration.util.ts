/**
 * Duration parsing helpers.
 *
 * The platform expresses every TTL / lifetime in configuration using a compact,
 * human readable syntax (`15m`, `7d`, `500ms`). Centralising the parser keeps the
 * configuration declarative and prevents "is this seconds or milliseconds?" bugs
 * from leaking into security sensitive code such as token expiry.
 */

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i;

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parses a duration expression into milliseconds.
 *
 * Accepted formats: `1500` (bare number, treated as milliseconds), `500ms`,
 * `45s`, `15m`, `12h`, `7d`, `2w`.
 *
 * Throws when the expression cannot be understood. Failing loudly at boot time
 * is deliberate: a silently mis-parsed token lifetime is a security bug.
 */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${value}`);
    }
    return Math.floor(value);
  }

  const raw = String(value).trim();
  const match = DURATION_PATTERN.exec(raw);

  if (!match) {
    throw new Error(
      `Invalid duration expression "${value}". Expected one of: 1500, 500ms, 45s, 15m, 12h, 7d, 2w.`,
    );
  }

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();

  return Math.floor(amount * UNIT_TO_MS[unit]);
}

/** Parses a duration expression into whole seconds (rounded down). */
export function parseDurationToSeconds(value: string | number): number {
  return Math.floor(parseDuration(value) / 1000);
}

/** Returns a Date offset from `from` by the supplied duration expression. */
export function durationFromNow(value: string | number, from: Date = new Date()): Date {
  return new Date(from.getTime() + parseDuration(value));
}

/** Formats a millisecond count into a compact human readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms % 1_000 === 0 ? 0 : 1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
