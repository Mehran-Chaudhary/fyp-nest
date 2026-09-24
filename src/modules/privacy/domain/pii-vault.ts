import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { inspect } from 'node:util';

/**
 * The reverse mapping from placeholders to real values, sealed for the length
 * of one request.
 *
 * ## Why encrypt a mapping that lives in memory
 *
 * The mapping *is* the personal data. It lives from the moment a prompt is
 * masked until the last token of the answer has been unmasked, which for a
 * slow local model is tens of seconds — long enough to be caught by a heap
 * snapshot, a core dump, or an over-eager error logger that serialises the
 * object it was handed. Each value is therefore sealed with AES-256-GCM, bound
 * by associated data to its placeholder, under a key that exists only in this
 * object.
 *
 * ## Why a per-request key, not the platform master key
 *
 * The implementation plan suggested the phase 1 `EncryptionService`. That key
 * is long-lived: a sealed mapping that leaked into a log would stay decryptable
 * for as long as the platform runs. A random key per request, zeroed by
 * {@link destroy}, makes "never persisted beyond the request" a cryptographic
 * property instead of a promise. After `destroy()` nothing sealed here can be
 * recovered by anyone — crypto-shredding, at the granularity of one answer.
 *
 * The vault serialises to an opaque marker (`toJSON`, `util.inspect`), so even
 * the ciphertext never reaches a log by accident.
 */
export class PiiVault {
  private static readonly IV_LENGTH = 12;
  private static readonly TAG_LENGTH = 16;

  private key: Buffer | null = randomBytes(32);
  private readonly entries = new Map<string, Buffer>();

  get size(): number {
    return this.entries.size;
  }

  get isDestroyed(): boolean {
    return this.key === null;
  }

  has(label: string): boolean {
    return this.entries.has(label);
  }

  seal(label: string, value: string): void {
    const key = this.requireKey();
    const iv = randomBytes(PiiVault.IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: PiiVault.TAG_LENGTH,
    });
    cipher.setAAD(Buffer.from(label, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.entries.set(label, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
  }

  open(label: string): string | undefined {
    const sealed = this.entries.get(label);
    if (!sealed) return undefined;

    const key = this.requireKey();
    const ivEnd = PiiVault.IV_LENGTH;
    const tagEnd = ivEnd + PiiVault.TAG_LENGTH;
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, ivEnd), {
      authTagLength: PiiVault.TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(label, 'utf8'));
    decipher.setAuthTag(sealed.subarray(ivEnd, tagEnd));
    return Buffer.concat([
      decipher.update(sealed.subarray(tagEnd)),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * A keyed digest for equality lookups ("have we seen this value before?")
   * without keeping the value itself as a map key. Meaningless outside this
   * vault and after it is destroyed.
   */
  fingerprint(value: string): string {
    return createHmac('sha256', this.requireKey())
      .update(value, 'utf8')
      .digest('base64url');
  }

  /** Constant-time comparison of two fingerprints. */
  static sameFingerprint(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  /** Zeroes the key and drops every entry. Idempotent. */
  destroy(): void {
    if (this.key) this.key.fill(0);
    this.key = null;
    for (const sealed of this.entries.values()) sealed.fill(0);
    this.entries.clear();
  }

  toJSON(): string {
    return '[PiiVault: sealed]';
  }

  [inspect.custom](): string {
    return `PiiVault <${this.isDestroyed ? 'destroyed' : `${this.entries.size} sealed`}>`;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('The PII vault has been destroyed.');
    return this.key;
  }
}
