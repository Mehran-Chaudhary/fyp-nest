import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  hotp,
  matchTotp,
  normalizeRecoveryCode,
  otpauthUri,
  totpAt,
  totpStep,
} from './totp';

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), checked against the RFCs' own test
 * vectors: an implementation that agrees with them agrees with every
 * authenticator app.
 */
describe('TOTP (phase 5)', () => {
  // RFC 6238 Appendix B: the SHA-1 seed is the ASCII string "12345678901234567890".
  const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
  const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches the RFC 6238 SHA-1 test vectors (8 digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(expected);
    }
  });

  it('matches the RFC 4226 HOTP vectors (6 digits)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => {
      expect(hotp(RFC_SECRET, BigInt(counter))).toBe(code);
    });
  });

  it('round-trips base32 and decodes the RFC secret', () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_BASE32);
    expect(base32Decode(RFC_SECRET_BASE32).equals(RFC_SECRET)).toBe(true);
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====').equals(RFC_SECRET)).toBe(
      true,
    );
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('generates 160-bit secrets', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('accepts the current code and one step of drift either side, and no more', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 8, 26, 12, 0, 15);
    const step = totpStep(now);
    expect(matchTotp(secret, totpAt(secret, now), now)).toBe(step);
    expect(matchTotp(secret, totpAt(secret, now - 30_000), now)).toBe(step - 1n);
    expect(matchTotp(secret, totpAt(secret, now + 30_000), now)).toBe(step + 1n);
    expect(matchTotp(secret, totpAt(secret, now - 90_000), now)).toBeNull();
  });

  it('tolerates a space in the middle, refuses anything that is not six digits', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = totpAt(secret, now);
    expect(matchTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).not.toBeNull();
    expect(matchTotp(secret, '12345', now)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth URI authenticator apps import', () => {
    const uri = otpauthUri(RFC_SECRET_BASE32, 'ayesha@acme.test', 'DAIAP');
    expect(uri).toMatch(/^otpauth:\/\/totp\/DAIAP:ayesha%40acme\.test\?/);
    const parameters = new URL(uri).searchParams;
    expect(parameters.get('secret')).toBe(RFC_SECRET_BASE32);
    expect(parameters.get('issuer')).toBe('DAIAP');
    expect(parameters.get('digits')).toBe('6');
    expect(parameters.get('period')).toBe('30');
  });

  it('makes recovery codes without look-alike characters, normalised for comparison', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    expect(normalizeRecoveryCode('ABCDE-fghjk')).toBe('abcdefghjk');
    expect(normalizeRecoveryCode(' abcde fghjk ')).toBe('abcdefghjk');
  });
});
