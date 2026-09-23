import { ConfigService } from '@nestjs/config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { EncryptionService } from './encryption.service';
import { PasswordHashingService } from './password-hashing.service';
import { TokenService } from './token.service';

/**
 * A minimal ConfigService stand-in.
 *
 * Argon2 cost parameters are deliberately reduced from the production defaults:
 * at 64 MiB and three passes, a suite that hashes a dozen passwords takes
 * minutes. The parameters under test are the *encoding and verification*
 * behaviour, not the cost itself.
 */
function buildConfig(overrides: Partial<SecurityConfig['hashing']> = {}): ConfigService {
  const security = {
    hashing: {
      algorithm: 'argon2id',
      argon2: { memoryCost: 8192, timeCost: 2, parallelism: 1 },
      pepper: '',
      ...overrides,
    },
    passwordPolicy: {
      minLength: 12,
      maxLength: 128,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: false,
    },
    encryptionKey: 'unit-test-encryption-key-at-least-32-chars-long',
    auditHashSecret: 'unit-test-audit-secret-at-least-32-characters',
    apiKeys: { prefix: 'daiap_sk', defaultTtlMs: 86_400_000 },
  } as unknown as SecurityConfig;

  return {
    get: (key: string) => (key === SECURITY_CONFIG_KEY ? security : undefined),
    getOrThrow: (key: string) => {
      if (key !== SECURITY_CONFIG_KEY) throw new Error(`unexpected config key ${key}`);
      return security;
    },
  } as unknown as ConfigService;
}

describe('PasswordHashingService', () => {
  describe('argon2id', () => {
    const service = new PasswordHashingService(buildConfig());

    it('produces an argon2id encoded hash', async () => {
      const hash = await service.hash('correct-horse-battery-7');
      expect(hash).toMatch(/^\$argon2id\$/);
    });

    it('never returns the plaintext', async () => {
      const hash = await service.hash('correct-horse-battery-7');
      expect(hash).not.toContain('correct-horse-battery-7');
    });

    it('salts, so the same password hashes differently each time', async () => {
      const [a, b] = await Promise.all([
        service.hash('same-password-1'),
        service.hash('same-password-1'),
      ]);
      expect(a).not.toBe(b);
    });

    it('verifies a correct password', async () => {
      const hash = await service.hash('correct-horse-battery-7');
      await expect(service.verify(hash, 'correct-horse-battery-7')).resolves.toMatchObject({
        valid: true,
      });
    });

    it('rejects an incorrect password', async () => {
      const hash = await service.hash('correct-horse-battery-7');
      await expect(service.verify(hash, 'wrong-password')).resolves.toMatchObject({
        valid: false,
      });
    });

    it('treats a malformed stored hash as a failure rather than throwing', async () => {
      await expect(service.verify('not-a-hash', 'anything')).resolves.toEqual({
        valid: false,
        needsRehash: false,
      });
    });

    it('burns comparable time on the no-such-user path', async () => {
      // Guards the anti-enumeration property: this must do real work, not return
      // immediately.
      const started = Date.now();
      await service.burnVerificationTime();
      expect(Date.now() - started).toBeGreaterThan(0);
    });
  });

  describe('scrypt', () => {
    const service = new PasswordHashingService(buildConfig({ algorithm: 'scrypt' }));

    it('produces a scrypt encoded hash', async () => {
      const hash = await service.hash('correct-horse-battery-7');
      expect(hash).toMatch(/^scrypt\$/);
    });

    it('verifies a correct password', async () => {
      const hash = await service.hash('correct-horse-battery-7');
      await expect(service.verify(hash, 'correct-horse-battery-7')).resolves.toMatchObject({
        valid: true,
      });
    });

    it('rejects an incorrect password', async () => {
      const hash = await service.hash('correct-horse-battery-7');
      await expect(service.verify(hash, 'nope')).resolves.toMatchObject({ valid: false });
    });
  });

  describe('algorithm agility', () => {
    it('verifies a scrypt hash while configured for argon2, and flags it for rehash', async () => {
      // This is what lets the platform change algorithms without a mass reset:
      // the old hash still verifies and is upgraded on next sign-in.
      const scryptService = new PasswordHashingService(
        buildConfig({ algorithm: 'scrypt' }),
      );
      const argonService = new PasswordHashingService(buildConfig());

      const legacyHash = await scryptService.hash('correct-horse-battery-7');
      const result = await argonService.verify(legacyHash, 'correct-horse-battery-7');

      expect(result.valid).toBe(true);
      expect(result.needsRehash).toBe(true);
    });

    it('does not flag a current-algorithm hash for rehash', async () => {
      const service = new PasswordHashingService(buildConfig());
      const hash = await service.hash('correct-horse-battery-7');
      await expect(service.verify(hash, 'correct-horse-battery-7')).resolves.toMatchObject({
        needsRehash: false,
      });
    });
  });

  describe('peppering', () => {
    it('makes a hash unverifiable without the pepper', async () => {
      // The point of the pepper: a stolen database alone is not enough.
      const peppered = new PasswordHashingService(
        buildConfig({ pepper: 'server-side-pepper' }),
      );
      const unpeppered = new PasswordHashingService(buildConfig({ pepper: '' }));

      const hash = await peppered.hash('correct-horse-battery-7');

      await expect(peppered.verify(hash, 'correct-horse-battery-7')).resolves.toMatchObject(
        {
          valid: true,
        },
      );
      await expect(
        unpeppered.verify(hash, 'correct-horse-battery-7'),
      ).resolves.toMatchObject({
        valid: false,
      });
    });

    it('applies to scrypt as well', async () => {
      const peppered = new PasswordHashingService(
        buildConfig({ algorithm: 'scrypt', pepper: 'server-side-pepper' }),
      );
      const unpeppered = new PasswordHashingService(buildConfig({ algorithm: 'scrypt' }));

      const hash = await peppered.hash('correct-horse-battery-7');

      await expect(peppered.verify(hash, 'correct-horse-battery-7')).resolves.toMatchObject(
        {
          valid: true,
        },
      );
      await expect(
        unpeppered.verify(hash, 'correct-horse-battery-7'),
      ).resolves.toMatchObject({
        valid: false,
      });
    });
  });
});

describe('TokenService', () => {
  const service = new TokenService(buildConfig());

  it('generates a URL-safe token', () => {
    const { token } = service.generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('never returns the same token twice', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => service.generateToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it('returns a digest that is not the token', () => {
    const { token, hash } = service.generateToken();
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a token against its digest', () => {
    const { token, hash } = service.generateToken();
    expect(service.verifyToken(token, hash)).toBe(true);
    expect(service.verifyToken('some-other-token', hash)).toBe(false);
  });

  it('keys the digest, so it cannot be precomputed without the secret', () => {
    const other = new TokenService({
      getOrThrow: () => ({
        apiKeys: { prefix: 'daiap_sk' },
        encryptionKey: 'a-completely-different-key-at-least-32-chars',
      }),
    } as unknown as ConfigService);

    const { token, hash } = service.generateToken();
    expect(other.hashToken(token)).not.toBe(hash);
  });

  describe('API keys', () => {
    it('generates a key with the configured prefix', () => {
      const { token, prefix } = service.generateApiKey();
      expect(token.startsWith('daiap_sk_')).toBe(true);
      expect(prefix.startsWith('daiap_sk_')).toBe(true);
    });

    it('produces a prefix that is a strict, non-recoverable leading segment', () => {
      const { token, prefix } = service.generateApiKey();
      expect(token.startsWith(prefix)).toBe(true);
      expect(prefix.length).toBeLessThan(token.length);
    });

    it('recovers the lookup prefix from a presented key', () => {
      const { token, prefix } = service.generateApiKey();
      expect(service.extractApiKeyPrefix(token)).toBe(prefix);
    });

    it('rejects a malformed key rather than guessing a prefix', () => {
      expect(service.extractApiKeyPrefix('garbage')).toBeNull();
      expect(service.extractApiKeyPrefix('daiap_sk')).toBeNull();
      expect(service.extractApiKeyPrefix('daiap_sk_short')).toBeNull();
    });
  });

  describe('compareHashes', () => {
    it('matches identical digests', () => {
      expect(service.compareHashes('ab'.repeat(32), 'ab'.repeat(32))).toBe(true);
    });

    it('rejects differing digests', () => {
      expect(service.compareHashes('ab'.repeat(32), 'cd'.repeat(32))).toBe(false);
    });

    it('rejects length mismatches without throwing', () => {
      expect(service.compareHashes('abcd', 'ab')).toBe(false);
    });
  });

  describe('numeric codes', () => {
    it('produces a zero-padded code of the requested length', () => {
      for (let i = 0; i < 50; i += 1) {
        expect(service.generateNumericCode(6)).toMatch(/^\d{6}$/);
      }
    });
  });
});

describe('EncryptionService', () => {
  const service = new EncryptionService(buildConfig());

  it('round-trips a value', () => {
    const plaintext = 'salary: 95000 GBP';
    expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
  });

  it('produces a versioned envelope', () => {
    expect(service.encrypt('x').startsWith('v1.')).toBe(true);
    expect(service.encrypt('x').split('.')).toHaveLength(4);
  });

  it('uses a fresh IV, so the same plaintext encrypts differently each time', () => {
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('round-trips unicode and empty strings', () => {
    expect(service.decrypt(service.encrypt(''))).toBe('');
    expect(service.decrypt(service.encrypt('گلاب — 花 — 🎯'))).toBe('گلاب — 花 — 🎯');
  });

  it('rejects a tampered ciphertext instead of returning altered plaintext', () => {
    // The reason GCM is used rather than CBC: authentication is built in.
    const encrypted = service.encrypt('original value');
    const segments = encrypted.split('.');
    const bytes = Buffer.from(segments[3], 'base64url');
    bytes[0] ^= 0xff;
    segments[3] = bytes.toString('base64url');

    expect(() => service.decrypt(segments.join('.'))).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const encrypted = service.encrypt('original value');
    const segments = encrypted.split('.');
    const tag = Buffer.from(segments[2], 'base64url');
    tag[0] ^= 0xff;
    segments[2] = tag.toString('base64url');

    expect(() => service.decrypt(segments.join('.'))).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() => service.decrypt('not-encrypted')).toThrow(/Malformed ciphertext/);
    expect(() => service.decrypt('v2.a.b.c')).toThrow(/Malformed ciphertext/);
  });

  describe('associated data', () => {
    it('round-trips when the associated data matches', () => {
      const encrypted = service.encrypt('secret', 'row-id-123');
      expect(service.decrypt(encrypted, 'row-id-123')).toBe('secret');
    });

    it('fails when the associated data differs', () => {
      // Binds a ciphertext to its row, so a value copied between records fails
      // rather than silently decrypting.
      const encrypted = service.encrypt('secret', 'row-id-123');
      expect(() => service.decrypt(encrypted, 'row-id-456')).toThrow();
    });

    it('fails when associated data is omitted on decrypt', () => {
      const encrypted = service.encrypt('secret', 'row-id-123');
      expect(() => service.decrypt(encrypted)).toThrow();
    });
  });

  describe('tryDecrypt', () => {
    it('returns the plaintext on success', () => {
      expect(service.tryDecrypt(service.encrypt('value'))).toBe('value');
    });

    it('returns null rather than throwing on failure', () => {
      expect(service.tryDecrypt('corrupt')).toBeNull();
      expect(service.tryDecrypt(null)).toBeNull();
      expect(service.tryDecrypt(undefined)).toBeNull();
    });
  });

  describe('key derivation', () => {
    it('accepts a 64-character hex key', () => {
      const hexService = new EncryptionService({
        getOrThrow: () => ({ encryptionKey: 'a1'.repeat(32) }),
      } as unknown as ConfigService);

      expect(hexService.decrypt(hexService.encrypt('value'))).toBe('value');
    });

    it('derives deterministically from a passphrase', () => {
      // Must be stable across process restarts, or nothing previously written
      // could be decrypted.
      const first = new EncryptionService(buildConfig());
      const second = new EncryptionService(buildConfig());
      expect(second.decrypt(first.encrypt('value'))).toBe('value');
    });

    it('cannot decrypt a value encrypted under a different key', () => {
      const other = new EncryptionService({
        getOrThrow: () => ({
          encryptionKey: 'a-totally-different-key-of-sufficient-length',
        }),
      } as unknown as ConfigService);

      expect(() => other.decrypt(service.encrypt('value'))).toThrow();
    });
  });

  describe('blindIndex', () => {
    it('is deterministic, so an encrypted column stays searchable by equality', () => {
      expect(service.blindIndex('Ahmad@Example.COM')).toBe(
        service.blindIndex('ahmad@example.com'),
      );
    });

    it('differs for different values', () => {
      expect(service.blindIndex('a@b.com')).not.toBe(service.blindIndex('c@d.com'));
    });
  });

  describe('isEncrypted', () => {
    it('recognises its own output', () => {
      expect(service.isEncrypted(service.encrypt('x'))).toBe(true);
    });

    it('rejects anything else', () => {
      expect(service.isEncrypted('plain text')).toBe(false);
      expect(service.isEncrypted(null)).toBe(false);
      expect(service.isEncrypted(undefined)).toBe(false);
    });
  });
});
