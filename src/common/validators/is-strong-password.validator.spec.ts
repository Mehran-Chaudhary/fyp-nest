import { evaluatePasswordStrength } from './is-strong-password.validator';
import type { PasswordPolicy } from '../../config/security.config';

const POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
};

/**
 * Password policy enforcement.
 *
 * The interesting cases are the ones that satisfy every composition rule and are
 * still terrible — `Password123` is the canonical example, and it is exactly
 * what a naive "one upper, one lower, one digit, 12 characters" check accepts.
 */
describe('password strength', () => {
  const evaluate = (password: string, personal: string[] = []) =>
    evaluatePasswordStrength(password, POLICY, personal);

  describe('composition rules', () => {
    it('accepts a password meeting every rule', () => {
      expect(evaluate('Tr0ubador-Quiet-Harbour').valid).toBe(true);
    });

    it('rejects one that is too short', () => {
      const result = evaluate('Ab1cdefg');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must be at least 12 characters long.');
    });

    it('rejects one that is too long', () => {
      const result = evaluate(`Aa1${'x'.repeat(200)}`);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('no more than'))).toBe(true);
    });

    it('requires a lowercase letter', () => {
      expect(evaluate('ABCDEFGH1234').errors).toContain(
        'Password must contain a lowercase letter.',
      );
    });

    it('requires an uppercase letter', () => {
      expect(evaluate('abcdefgh1234').errors).toContain(
        'Password must contain an uppercase letter.',
      );
    });

    it('requires a number', () => {
      expect(evaluate('AbcdefghIjkl').errors).toContain('Password must contain a number.');
    });

    it('requires a symbol only when the policy asks for one', () => {
      expect(evaluate('Quiet-Harbour9').valid).toBe(true);

      const strict = { ...POLICY, requireSymbol: true };
      const result = evaluatePasswordStrength('QuietHarbour9x', strict);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain a symbol.');
    });
  });

  describe('patterns that pass composition rules but are still weak', () => {
    it('rejects a known-common password', () => {
      // Satisfies every composition rule and sits near the top of every
      // credential-stuffing list.
      const result = evaluate('Password123!');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('too common'))).toBe(true);
    });

    it('scores a common password at zero', () => {
      expect(evaluate('Password123!').score).toBe(0);
    });

    it('rejects long runs of the same character', () => {
      const result = evaluate('Abcdeeeee1111');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('runs of the same character'))).toBe(
        true,
      );
    });

    it('rejects ascending sequences', () => {
      const result = evaluate('Abc12345678Z');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('sequences'))).toBe(true);
    });

    it('rejects descending sequences', () => {
      const result = evaluate('Zyxwvu987654A');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('sequences'))).toBe(true);
    });

    it('rejects a password containing the user’s own email', () => {
      // Trivially guessable by anyone who knows them, which in an enterprise
      // workspace is everyone.
      const result = evaluate('Ahmad.Hanbal99X', ['ahmad.hanbal@example.com']);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('your name or email'))).toBe(true);
    });

    it('rejects a password containing the user’s name', () => {
      const result = evaluate('MehranChaudhary1', ['Mehran', 'Chaudhary']);
      expect(result.valid).toBe(false);
    });

    it('ignores personal fragments too short to be meaningful', () => {
      // A two-character first name must not ban every password containing it.
      expect(evaluate('Quiet-Harbour9', ['Li']).valid).toBe(true);
    });
  });

  describe('scoring', () => {
    it('rewards length over character variety', () => {
      const long = evaluate('quiet harbour lantern moth7A').score;
      const short = evaluate('P@s1wordXy9Z').score;
      expect(long).toBeGreaterThan(short);
    });

    it('caps the score at 4', () => {
      expect(evaluate('Quiet-Harbour-Lantern-Moth-9A').score).toBeLessThanOrEqual(4);
    });
  });

  describe('degenerate input', () => {
    it('rejects an empty password', () => {
      const result = evaluate('');
      expect(result.valid).toBe(false);
      expect(result.score).toBe(0);
    });

    it('rejects a non-string without throwing', () => {
      const result = evaluatePasswordStrength(undefined as unknown as string, POLICY);
      expect(result.valid).toBe(false);
    });
  });

  describe('accumulation', () => {
    it('reports every failure at once rather than stopping at the first', () => {
      // A form that reveals one rule at a time is a form people abandon.
      const result = evaluate('abc');
      expect(result.errors.length).toBeGreaterThan(2);
    });
  });
});
