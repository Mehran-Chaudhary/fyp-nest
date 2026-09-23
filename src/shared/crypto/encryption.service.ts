import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';

/**
 * Authenticated symmetric encryption for sensitive values stored at rest.
 *
 * Used in phase 1 for outbound SMTP credentials and tool secrets, and in later
 * phases for anything the PII redaction engine needs to reverse — most notably
 * the mapping from a placeholder such as `[PERSON_1]` back to the real value,
 * which must survive a round trip through the LLM but must never be readable
 * from a database dump.
 *
 * AES-256-GCM is used rather than AES-CBC because it is authenticated: a
 * tampered ciphertext fails to decrypt instead of yielding attacker-influenced
 * plaintext. Every encryption uses a fresh 96-bit IV, which is the size GCM is
 * specified for and the only size at which IV reuse risk is well understood.
 *
 * Encoded output: `v1.<iv>.<authTag>.<ciphertext>`, each segment base64url.
 * The version prefix exists so a future key rotation or algorithm change can be
 * rolled out while old ciphertexts remain readable.
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);

  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12;
  private static readonly AUTH_TAG_LENGTH = 16;
  private static readonly KEY_LENGTH = 32;
  private static readonly VERSION = 'v1';

  /**
   * Fixed salt for passphrase-derived keys.
   *
   * A constant salt would be unacceptable for password hashing, where the point
   * is to make each user's hash unique. Here the input is already a
   * high-entropy configured secret and the requirement is determinism: the same
   * `ENCRYPTION_KEY` must derive the same AES key on every process start, or
   * nothing previously written could be decrypted.
   */
  private static readonly KDF_SALT = 'daiap-encryption-key-derivation-v1';

  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    this.key = EncryptionService.deriveKey(security.encryptionKey);
  }

  /**
   * Accepts a 32-byte key as hex or base64, or any other string as a passphrase
   * to stretch with scrypt. Operators can therefore paste `openssl rand -hex 32`
   * output directly, without the service silently truncating a short secret.
   */
  private static deriveKey(configured: string): Buffer {
    if (/^[0-9a-f]{64}$/i.test(configured)) {
      return Buffer.from(configured, 'hex');
    }

    const asBase64 = Buffer.from(configured, 'base64');
    if (asBase64.length === EncryptionService.KEY_LENGTH) {
      return asBase64;
    }

    return scryptSync(configured, EncryptionService.KDF_SALT, EncryptionService.KEY_LENGTH);
  }

  /**
   * Encrypts a UTF-8 string.
   *
   * `associatedData` is authenticated but not encrypted. Passing a row's id
   * binds the ciphertext to that row, so a value copied from one record into
   * another fails to decrypt rather than silently succeeding.
   */
  encrypt(plaintext: string, associatedData?: string): string {
    const iv = randomBytes(EncryptionService.IV_LENGTH);
    const cipher = createCipheriv(EncryptionService.ALGORITHM, this.key, iv, {
      authTagLength: EncryptionService.AUTH_TAG_LENGTH,
    });

    if (associatedData) {
      cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    }

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      EncryptionService.VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * Decrypts a value produced by {@link encrypt}.
   *
   * Throws on any tampering, truncation or wrong associated data. Callers should
   * treat a throw as data corruption or attack, never as "empty value".
   */
  decrypt(encoded: string, associatedData?: string): string {
    const segments = encoded.split('.');

    if (segments.length !== 4 || segments[0] !== EncryptionService.VERSION) {
      throw new Error('Malformed ciphertext: unexpected envelope format.');
    }

    const [, ivPart, authTagPart, ciphertextPart] = segments;

    const decipher = createDecipheriv(
      EncryptionService.ALGORITHM,
      this.key,
      Buffer.from(ivPart, 'base64url'),
      { authTagLength: EncryptionService.AUTH_TAG_LENGTH },
    );

    decipher.setAuthTag(Buffer.from(authTagPart, 'base64url'));
    if (associatedData) {
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    }

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  }

  /** Decrypts, returning `null` instead of throwing. For best-effort display paths. */
  tryDecrypt(encoded: string | null | undefined, associatedData?: string): string | null {
    if (!encoded) return null;

    try {
      return this.decrypt(encoded, associatedData);
    } catch (error) {
      this.logger.warn(
        `Failed to decrypt a stored value: ${(error as Error).message}. ` +
          'This usually means ENCRYPTION_KEY changed after the value was written.',
      );
      return null;
    }
  }

  /** True when a string looks like output of this service. */
  isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(`${EncryptionService.VERSION}.`);
  }

  /**
   * Deterministic keyed digest, for values that must stay searchable while
   * encrypted — an email address that needs an equality lookup, for example.
   * Deterministic output leaks equality by construction, so this is only for
   * columns where that is acceptable.
   */
  blindIndex(value: string): string {
    return createHmac('sha256', this.key).update(value.toLowerCase().trim()).digest('hex');
  }
}
