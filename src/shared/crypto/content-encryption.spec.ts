import { ConfigService } from '@nestjs/config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { ContentEncryptionService } from './content-encryption.service';
import { EncryptionService } from './encryption.service';

function buildConfig(encryptionKey: string): ConfigService {
  const security = { encryptionKey } as unknown as SecurityConfig;
  return {
    get: (key: string) => (key === SECURITY_CONFIG_KEY ? security : undefined),
    getOrThrow: (key: string) => {
      if (key !== SECURITY_CONFIG_KEY) throw new Error(`unexpected config key ${key}`);
      return security;
    },
  } as unknown as ConfigService;
}

function build(
  key = 'unit-test-encryption-key-at-least-32-chars-long',
): ContentEncryptionService {
  const config = buildConfig(key);
  return new ContentEncryptionService(new EncryptionService(config), config);
}

/**
 * Envelope encryption of document content. The properties under test are the
 * ones the design leans on: confidentiality, binding to location, tamper
 * detection, and crypto-shredding.
 */
describe('ContentEncryptionService', () => {
  const service = build();
  const binding = 'document:6a3c1f2e-0000-4000-8000-000000000001';

  describe('data keys', () => {
    it('generates a fresh 256-bit key per document', () => {
      const a = service.generateDataKey(binding);
      const b = service.generateDataKey(binding);
      expect(a.plaintext).toHaveLength(32);
      expect(a.plaintext.equals(b.plaintext)).toBe(false);
    });

    it('never stores the key in the clear', () => {
      const key = service.generateDataKey(binding);
      expect(key.wrapped).not.toContain(key.plaintext.toString('base64'));
      expect(key.wrapped).not.toContain(key.plaintext.toString('hex'));
    });

    it('unwraps to the same key under the same binding', () => {
      const key = service.generateDataKey(binding);
      expect(service.unwrapDataKey(key.wrapped, binding).equals(key.plaintext)).toBe(true);
    });

    it('refuses to unwrap under another document’s binding', () => {
      const key = service.generateDataKey(binding);
      expect(() => service.unwrapDataKey(key.wrapped, 'document:someone-else')).toThrow();
    });

    it('refuses to unwrap under a different master key', () => {
      const key = service.generateDataKey(binding);
      const other = build('a-completely-different-master-key-of-32-chars');
      expect(() => other.unwrapDataKey(key.wrapped, binding)).toThrow();
    });
  });

  describe('content', () => {
    const { plaintext: key } = service.generateDataKey(binding);
    const file = Buffer.from('CONFIDENTIAL — salary band G7: 185,000');

    it('round-trips', () => {
      const sealed = service.encrypt(key, file, 'document:x:original');
      expect(service.decrypt(key, sealed, 'document:x:original').equals(file)).toBe(true);
    });

    it('does not contain the plaintext', () => {
      const sealed = service.encrypt(key, file, 'document:x:original');
      expect(sealed.includes(Buffer.from('salary'))).toBe(false);
    });

    it('is randomised: the same content encrypts differently each time', () => {
      const a = service.encrypt(key, file, 'aad');
      const b = service.encrypt(key, file, 'aad');
      expect(a.equals(b)).toBe(false);
    });

    it('is bound to its location: a copied ciphertext fails elsewhere', () => {
      const sealed = service.encryptText(key, 'chunk text', 'chunk:A');
      expect(() => service.decryptText(key, sealed, 'chunk:B')).toThrow();
    });

    it('detects tampering with any byte', () => {
      const sealed = service.encrypt(key, file, 'aad');
      for (const position of [5, 20, sealed.length - 1]) {
        const tampered = Buffer.from(sealed);
        tampered[position] ^= 0x01;
        expect(() => service.decrypt(key, tampered, 'aad')).toThrow();
      }
    });

    it('rejects a malformed envelope', () => {
      expect(() => service.decrypt(key, Buffer.from('not an envelope'), 'aad')).toThrow(
        /Malformed/,
      );
    });

    it('crypto-shredding: without the key the content is unrecoverable', () => {
      const sealed = service.encrypt(key, file, 'aad');
      const { plaintext: someOtherKey } = service.generateDataKey(binding);
      expect(() => service.decrypt(someOtherKey, sealed, 'aad')).toThrow();
    });

    it('destroy zeroes the key buffer', () => {
      const { plaintext } = service.generateDataKey(binding);
      service.destroy(plaintext);
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('fingerprints', () => {
    it('are deterministic, so duplicates are detectable', () => {
      expect(service.fingerprint(Buffer.from('same'))).toBe(
        service.fingerprint(Buffer.from('same')),
      );
    });

    it('differ for different content', () => {
      expect(service.fingerprint(Buffer.from('a'))).not.toBe(
        service.fingerprint(Buffer.from('b')),
      );
    });

    it('are keyed: a plain SHA-256 of the file does not match', async () => {
      const { createHash } = await import('node:crypto');
      const content = Buffer.from('a leaked contract');
      expect(service.fingerprint(content)).not.toBe(
        createHash('sha256').update(content).digest('hex'),
      );
    });

    it('depend on the master key', () => {
      const other = build('a-completely-different-master-key-of-32-chars');
      expect(service.fingerprint(Buffer.from('x'))).not.toBe(
        other.fingerprint(Buffer.from('x')),
      );
    });
  });
});
