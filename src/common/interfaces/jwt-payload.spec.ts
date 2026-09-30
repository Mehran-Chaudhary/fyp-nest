import { issuedAtMs } from './jwt-payload.interface';

describe('issuedAtMs', () => {
  it('uses the millisecond claim when it agrees with iat', () => {
    expect(issuedAtMs({ iat: 1_790_714_100, iatMs: 1_790_714_100_734 })).toBe(
      1_790_714_100_734,
    );
  });

  it('falls back to the start of the second for tokens without iatMs', () => {
    expect(issuedAtMs({ iat: 1_790_714_100 })).toBe(1_790_714_100_000);
  });

  it('ignores an iatMs outside iat’s own second, reading the token as older', () => {
    // A later iatMs must never make a token look newer than its signed iat.
    expect(issuedAtMs({ iat: 1_790_714_100, iatMs: 1_790_714_105_000 })).toBe(
      1_790_714_100_000,
    );
    expect(issuedAtMs({ iat: 1_790_714_100, iatMs: 1_790_714_099_999 })).toBe(
      1_790_714_100_000,
    );
    expect(issuedAtMs({ iat: 1_790_714_100, iatMs: Number.NaN })).toBe(1_790_714_100_000);
  });

  it('is what lets a token minted just after a password change through', () => {
    const changedAt = 1_790_714_100_500; // tokensValidFrom, in the middle of a second
    const before = { iat: 1_790_714_100, iatMs: 1_790_714_100_200 };
    const after = { iat: 1_790_714_100, iatMs: 1_790_714_100_800 };
    expect(issuedAtMs(before) < changedAt).toBe(true); // revoked
    expect(issuedAtMs(after) < changedAt).toBe(false); // accepted
  });
});
