import {
  durationFromNow,
  formatDuration,
  parseDuration,
  parseDurationToSeconds,
} from './duration.util';

/**
 * Every TTL in the platform — token lifetimes, lockout windows, rate-limit
 * windows — is parsed here. A silently mis-parsed value is a security bug rather
 * than a cosmetic one, which is why the parser throws instead of defaulting.
 */
describe('duration parsing', () => {
  describe('parseDuration', () => {
    it('treats a bare number as milliseconds', () => {
      expect(parseDuration('1500')).toBe(1500);
      expect(parseDuration(2000)).toBe(2000);
    });

    it.each([
      ['500ms', 500],
      ['45s', 45_000],
      ['15m', 900_000],
      ['12h', 43_200_000],
      ['7d', 604_800_000],
      ['2w', 1_209_600_000],
    ])('parses %s', (input, expected) => {
      expect(parseDuration(input)).toBe(expected);
    });

    it('accepts fractional amounts', () => {
      expect(parseDuration('1.5s')).toBe(1500);
      expect(parseDuration('0.5h')).toBe(1_800_000);
    });

    it('tolerates whitespace and case', () => {
      expect(parseDuration(' 15M ')).toBe(900_000);
      expect(parseDuration('30 S')).toBe(30_000);
    });

    it('throws on an unrecognised unit rather than guessing', () => {
      expect(() => parseDuration('5y')).toThrow(/Invalid duration/);
      expect(() => parseDuration('5 fortnights')).toThrow(/Invalid duration/);
    });

    it('throws on nonsense', () => {
      expect(() => parseDuration('')).toThrow();
      expect(() => parseDuration('abc')).toThrow();
      expect(() => parseDuration('-5s')).toThrow();
    });

    it('rejects a negative or non-finite number', () => {
      expect(() => parseDuration(-1)).toThrow();
      expect(() => parseDuration(Number.NaN)).toThrow();
      expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow();
    });
  });

  describe('parseDurationToSeconds', () => {
    it('converts to whole seconds', () => {
      expect(parseDurationToSeconds('15m')).toBe(900);
      expect(parseDurationToSeconds('30d')).toBe(2_592_000);
    });

    it('rounds down rather than up', () => {
      // Rounding a token lifetime up would extend it past its intended expiry.
      expect(parseDurationToSeconds('1500ms')).toBe(1);
      expect(parseDurationToSeconds('999ms')).toBe(0);
    });
  });

  describe('durationFromNow', () => {
    it('offsets from the supplied instant', () => {
      const base = new Date('2026-01-01T00:00:00.000Z');
      expect(durationFromNow('1h', base).toISOString()).toBe('2026-01-01T01:00:00.000Z');
    });

    it('defaults to the current time', () => {
      const before = Date.now();
      const result = durationFromNow('10s').getTime();
      expect(result).toBeGreaterThanOrEqual(before + 10_000);
      expect(result).toBeLessThanOrEqual(Date.now() + 10_000);
    });
  });

  describe('formatDuration', () => {
    it.each([
      [500, '500ms'],
      [1_000, '1s'],
      [1_500, '1.5s'],
      [90_000, '2m'],
      [7_200_000, '2h'],
      [172_800_000, '2d'],
    ])('formats %i as %s', (input, expected) => {
      expect(formatDuration(input)).toBe(expected);
    });
  });

  describe('round-tripping', () => {
    it('parses the defaults used in .env.example', () => {
      // Guards against a typo in the shipped configuration template producing a
      // boot failure the first time someone copies it.
      const defaults = ['10s', '30s', '15m', '30d', '24h', '1h', '7d', '365d', '60s', '2w'];
      for (const value of defaults) {
        expect(() => parseDuration(value)).not.toThrow();
        expect(parseDuration(value)).toBeGreaterThan(0);
      }
    });
  });
});
