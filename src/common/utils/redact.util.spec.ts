import { deepRedact, maskEmail, maskSecret, REDACTED_PLACEHOLDER } from './redact.util';

/**
 * Structural redaction runs over every log line, audit record and error payload.
 * On a platform whose stated purpose is privacy preservation, a leak here is the
 * least excusable kind, so these tests lean on the awkward shapes — nesting,
 * cycles, arrays, Buffers — rather than the happy path.
 */
describe('structural redaction', () => {
  describe('deepRedact', () => {
    it('redacts a top-level sensitive key', () => {
      expect(deepRedact({ email: 'a@b.com', password: 'hunter2' })).toEqual({
        email: 'a@b.com',
        password: REDACTED_PLACEHOLDER,
      });
    });

    it('redacts regardless of key casing', () => {
      const result = deepRedact({ Password: 'x', REFRESHTOKEN: 'y', apiKey: 'z' });
      expect(result).toEqual({
        Password: REDACTED_PLACEHOLDER,
        REFRESHTOKEN: REDACTED_PLACEHOLDER,
        apiKey: REDACTED_PLACEHOLDER,
      });
    });

    it('redacts nested values', () => {
      const result = deepRedact({
        user: { name: 'Sara', credentials: { password: 'hunter2' } },
      });
      expect(result).toEqual({
        user: { name: 'Sara', credentials: { password: REDACTED_PLACEHOLDER } },
      });
    });

    it('redacts inside arrays', () => {
      expect(deepRedact({ items: [{ token: 'abc' }, { token: 'def' }] })).toEqual({
        items: [{ token: REDACTED_PLACEHOLDER }, { token: REDACTED_PLACEHOLDER }],
      });
    });

    it('leaves non-sensitive data untouched', () => {
      const input = { id: 1, active: true, tags: ['a', 'b'], nested: { count: 3 } };
      expect(deepRedact(input)).toEqual(input);
    });

    it('does not mutate its input', () => {
      const input = { password: 'hunter2' };
      deepRedact(input);
      expect(input.password).toBe('hunter2');
    });

    it('preserves Date values', () => {
      const date = new Date('2026-01-01T00:00:00.000Z');
      const result = deepRedact({ when: date });
      expect(result.when).toBeInstanceOf(Date);
      expect(result.when.toISOString()).toBe(date.toISOString());
    });

    it('summarises an Error rather than serialising its stack', () => {
      const result = deepRedact({ err: new TypeError('boom') });
      expect(result.err).toEqual({ name: 'TypeError', message: 'boom' });
    });

    it('summarises a Buffer rather than dumping its bytes', () => {
      const result = deepRedact({ file: Buffer.from('hello') }) as unknown as {
        file: string;
      };
      expect(result.file).toBe('[Buffer 5 bytes]');
    });

    it('survives a circular reference', () => {
      // A hostile or merely unusual payload must not turn logging into a crash
      // or an infinite loop.
      const input: Record<string, unknown> = { name: 'root' };
      input.self = input;

      const result = deepRedact(input);
      expect(result.name).toBe('root');
      expect(result.self).toBe('[CIRCULAR]');
    });

    it('truncates beyond the depth limit instead of recursing forever', () => {
      let deep: Record<string, unknown> = { value: 'bottom' };
      for (let i = 0; i < 20; i += 1) deep = { nested: deep };

      expect(() => deepRedact(deep)).not.toThrow();
      expect(JSON.stringify(deepRedact(deep))).toContain('[TRUNCATED]');
    });

    it('handles null and undefined', () => {
      expect(deepRedact(null)).toBeNull();
      expect(deepRedact(undefined)).toBeUndefined();
      expect(deepRedact({ a: null, b: undefined })).toEqual({ a: null, b: undefined });
    });

    it('accepts a custom sensitive-key list', () => {
      expect(deepRedact({ salary: 90000, name: 'X' }, ['salary'])).toEqual({
        salary: REDACTED_PLACEHOLDER,
        name: 'X',
      });
    });

    it('redacts the header names that carry credentials', () => {
      const result = deepRedact({
        authorization: 'Bearer abc',
        cookie: 'session=1',
        'set-cookie': 'a=b',
        'content-type': 'application/json',
      });

      expect(result).toEqual({
        authorization: REDACTED_PLACEHOLDER,
        cookie: REDACTED_PLACEHOLDER,
        'set-cookie': REDACTED_PLACEHOLDER,
        'content-type': 'application/json',
      });
    });
  });

  describe('maskSecret', () => {
    it('keeps a short prefix and suffix for correlation', () => {
      expect(maskSecret('daiap_sk_abcdefghijklmnop')).toBe('daia********op');
    });

    it('fully redacts a value too short to mask safely', () => {
      expect(maskSecret('abc')).toBe(REDACTED_PLACEHOLDER);
    });

    it('returns empty for empty input', () => {
      expect(maskSecret('')).toBe('');
    });
  });

  describe('maskEmail', () => {
    it('keeps the domain and two leading characters', () => {
      expect(maskEmail('ahmad.hanbal@example.com')).toBe('ah**********@example.com');
    });

    it('masks a very short local part', () => {
      expect(maskEmail('a@b.com')).toBe('a**@b.com');
    });

    it('rejects something that is not an address', () => {
      expect(maskEmail('not-an-email')).toBe(REDACTED_PLACEHOLDER);
      expect(maskEmail('@nolocal.com')).toBe(REDACTED_PLACEHOLDER);
    });
  });
});
