import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';

export interface GeneratedToken {
  /** The value handed to the user. Exists in memory exactly once, never stored. */
  token: string;
  /** What actually goes in the database. */
  hash: string;
}

export interface GeneratedApiKey extends GeneratedToken {
  /**
   * Short, non-secret leading segment. Stored in clear so a key can be looked up
   * in one indexed query instead of hashing against every row, and so the
   * dashboard can show `daiap_sk_a1b2c3…` next to each key.
   */
  prefix: string;
}

/**
 * Generation and verification of opaque secrets: email verification links,
 * password reset links, workspace invitations, refresh tokens and API keys.
 *
 * Two rules are applied without exception.
 *
 * **Nothing recoverable is stored.** Every secret is persisted as a hash. A
 * database dump therefore yields no usable invitation link or API key. This is
 * the same reasoning that applies to passwords, and it matters just as much
 * here: a leaked invitation token grants workspace access.
 *
 * **Comparison is constant time.** Lookups hash the candidate and compare
 * digests with `timingSafeEqual`, so an attacker cannot recover a token byte by
 * byte from response timing.
 *
 * Unlike passwords these secrets are full-entropy random values, so a single
 * SHA-256 (keyed by HMAC) is the right primitive — a slow KDF would add latency
 * without adding security, because there is no low-entropy input to protect.
 */
@Injectable()
export class TokenService {
  private readonly apiKeyPrefix: string;
  private readonly hmacKey: string;

  constructor(private readonly configService: ConfigService) {
    const security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    this.apiKeyPrefix = security.apiKeys.prefix;
    this.hmacKey = security.encryptionKey;
  }

  /**
   * Generates a URL-safe random token and its stored digest.
   *
   * 32 bytes gives 256 bits of entropy, which makes online guessing hopeless and
   * leaves plenty of margin even against an offline attacker with the digest.
   */
  generateToken(byteLength = 32): GeneratedToken {
    const token = randomBytes(byteLength).toString('base64url');
    return { token, hash: this.hashToken(token) };
  }

  /**
   * Generates an API key of the form `daiap_sk_<random>`.
   *
   * The visible prefix includes the first characters of the random portion so
   * that operators can identify a key in a list without the platform ever
   * storing enough to reconstruct it.
   */
  generateApiKey(): GeneratedApiKey {
    const random = randomBytes(32).toString('base64url');
    const token = `${this.apiKeyPrefix}_${random}`;

    return {
      token,
      hash: this.hashToken(token),
      prefix: `${this.apiKeyPrefix}_${random.slice(0, 8)}`,
    };
  }

  /**
   * Derives the stored digest for a token.
   *
   * HMAC rather than a bare hash: without the server-side key, an attacker
   * holding only the database cannot precompute candidate digests.
   */
  hashToken(token: string): string {
    return createHmac('sha256', this.hmacKey).update(token).digest('hex');
  }

  /** Unkeyed SHA-256, for non-secret values such as cache keys. */
  digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Constant-time comparison of two hex digests. */
  compareHashes(a: string, b: string): boolean {
    if (a.length !== b.length) return false;

    try {
      return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }

  /** Hashes a candidate token and compares it against a stored digest. */
  verifyToken(candidate: string, storedHash: string): boolean {
    return this.compareHashes(this.hashToken(candidate), storedHash);
  }

  /** Extracts the lookup prefix from a presented API key. */
  extractApiKeyPrefix(presentedKey: string): string | null {
    const parts = presentedKey.split('_');
    // Expected shape: <prefix-part-1>_<prefix-part-2>_<random>, e.g. daiap_sk_xxxxx.
    if (parts.length < 3) return null;

    const random = parts.slice(2).join('_');
    if (random.length < 8) return null;

    return `${parts[0]}_${parts[1]}_${random.slice(0, 8)}`;
  }

  /** A fresh UUID v4, used for `jti`, session and family identifiers. */
  uuid(): string {
    return randomUUID();
  }

  /** Short, human-typable code (no ambiguous characters), for out-of-band flows. */
  generateNumericCode(digits = 6): string {
    const max = 10 ** digits;
    // Rejection-free approach: take enough entropy that modulo bias is negligible.
    const value = randomBytes(8).readBigUInt64BE() % BigInt(max);
    return value.toString().padStart(digits, '0');
  }
}
