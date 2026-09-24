import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { EncryptionService } from './encryption.service';

export interface DataKey {
  /** The raw 256-bit key. Lives only in memory, only for as long as it is needed. */
  plaintext: Buffer;
  /** The key encrypted under the platform master key. This is what is stored. */
  wrapped: string;
}

/**
 * Envelope encryption for document content.
 *
 * Every document gets its own random 256-bit data key. The file in object
 * storage and every chunk of text extracted from it are encrypted under that
 * key; the key itself is stored only in wrapped form, encrypted under the
 * platform master key by the phase 1 {@link EncryptionService}.
 *
 * Three properties follow, each of which a single master key applied directly
 * to the content would not give:
 *
 *  - **Cloud providers hold ciphertext.** The object store and the database are
 *    both third-party hosted. A leaked bucket, a leaked database dump, or a
 *    provider employee with console access yields nothing readable without the
 *    master key, which lives only in this service's environment.
 *  - **Crypto-shredding.** Deleting a document destroys its wrapped key. Every
 *    copy of its content — the stored object, the chunk rows, and every backup
 *    and replica of either, including ones the platform cannot reach to delete —
 *    becomes permanently unreadable at that instant. That is what makes a
 *    deletion request honourable against point-in-time database backups and
 *    versioned buckets.
 *  - **Rotation without re-encryption.** Rotating the master key means
 *    re-wrapping a few hundred bytes per document, not re-encrypting gigabytes.
 *
 * Content is sealed with AES-256-GCM and bound by associated data to where it
 * belongs (`document:<id>:original`, `chunk:<id>`), so a ciphertext copied from
 * one row or object into another fails authentication instead of decrypting.
 *
 * Envelope layout: `DAE1 || iv(12) || tag(16) || ciphertext`.
 */
@Injectable()
export class ContentEncryptionService {
  private static readonly MAGIC = Buffer.from('DAE1', 'ascii');
  private static readonly IV_LENGTH = 12;
  private static readonly TAG_LENGTH = 16;
  private static readonly KEY_LENGTH = 32;
  private static readonly HEADER_LENGTH =
    ContentEncryptionService.MAGIC.length +
    ContentEncryptionService.IV_LENGTH +
    ContentEncryptionService.TAG_LENGTH;

  /**
   * Keyed fingerprint for duplicate detection, derived from the master secret
   * with HKDF so it is independent of every other key in the system.
   */
  private readonly fingerprintKey: Buffer;

  constructor(
    private readonly encryption: EncryptionService,
    configService: ConfigService,
  ) {
    const security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    this.fingerprintKey = Buffer.from(
      hkdfSync(
        'sha256',
        security.encryptionKey,
        'daiap-content-fingerprint',
        'daiap/document-fingerprint/v1',
        32,
      ),
    );
  }

  // ── Data keys ─────────────────────────────────────────────────────────────

  /** A fresh data key, bound to `binding` (e.g. `document:<id>`) when wrapped. */
  generateDataKey(binding: string): DataKey {
    const plaintext = randomBytes(ContentEncryptionService.KEY_LENGTH);
    return {
      plaintext,
      wrapped: this.encryption.encrypt(plaintext.toString('base64'), `dek:${binding}`),
    };
  }

  /** Throws if the wrapped key was tampered with or belongs to another binding. */
  unwrapDataKey(wrapped: string, binding: string): Buffer {
    const key = Buffer.from(this.encryption.decrypt(wrapped, `dek:${binding}`), 'base64');

    if (key.length !== ContentEncryptionService.KEY_LENGTH) {
      throw new Error('Unwrapped data key has an unexpected length.');
    }

    return key;
  }

  /** Overwrites a key buffer. Best effort — the runtime may hold other copies. */
  destroy(key: Buffer): void {
    key.fill(0);
  }

  // ── Binary content ────────────────────────────────────────────────────────

  encrypt(key: Buffer, plaintext: Buffer, associatedData: string): Buffer {
    const iv = randomBytes(ContentEncryptionService.IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: ContentEncryptionService.TAG_LENGTH,
    });
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return Buffer.concat([
      ContentEncryptionService.MAGIC,
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  /**
   * Decrypts and authenticates an envelope.
   *
   * The whole plaintext is produced only after the tag verifies, so a tampered
   * object can never be partially served — which is why downloads decrypt fully
   * before sending rather than streaming.
   */
  decrypt(key: Buffer, envelope: Buffer, associatedData: string): Buffer {
    const header = ContentEncryptionService.HEADER_LENGTH;
    const magic = ContentEncryptionService.MAGIC;

    if (envelope.length < header || !envelope.subarray(0, magic.length).equals(magic)) {
      throw new Error('Malformed content envelope.');
    }

    const ivEnd = magic.length + ContentEncryptionService.IV_LENGTH;
    const iv = envelope.subarray(magic.length, ivEnd);
    const tag = envelope.subarray(ivEnd, header);

    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: ContentEncryptionService.TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(envelope.subarray(header)), decipher.final()]);
  }

  // ── Text content ──────────────────────────────────────────────────────────

  /** Encrypts UTF-8 text for a `text` column, base64 encoded. */
  encryptText(key: Buffer, text: string, associatedData: string): string {
    return this.encrypt(key, Buffer.from(text, 'utf8'), associatedData).toString('base64');
  }

  decryptText(key: Buffer, encoded: string, associatedData: string): string {
    return this.decrypt(key, Buffer.from(encoded, 'base64'), associatedData).toString(
      'utf8',
    );
  }

  // ── Fingerprints ──────────────────────────────────────────────────────────

  /**
   * A keyed digest of file content, for duplicate detection.
   *
   * Keyed rather than a bare SHA-256 on purpose. A plain hash in the database
   * lets anyone holding a dump confirm whether the workspace holds a specific
   * file they already have a copy of — a leaked contract, a known payslip
   * template. Without the key, the digest confirms nothing.
   */
  fingerprint(content: Buffer): string {
    return createHmac('sha256', this.fingerprintKey).update(content).digest('hex');
  }
}
