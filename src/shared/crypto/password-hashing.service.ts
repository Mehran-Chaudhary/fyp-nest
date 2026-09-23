import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * A password hashing implementation.
 *
 * Two are provided. Which one *produces* new hashes is configuration; both can
 * always *verify*, so switching algorithms never locks existing users out —
 * their password is silently upgraded on their next successful sign-in.
 *
 * Each strategy applies the configured pepper in whichever way is correct for
 * its primitive, which is why peppering is the strategy's concern rather than
 * the caller's.
 */
interface HashingStrategy {
  readonly id: string;
  hash(plaintext: string): Promise<string>;
  verify(storedHash: string, plaintext: string): Promise<boolean>;
  /** True when the stored hash was produced with weaker parameters than current policy. */
  needsRehash(storedHash: string): boolean;
  /** True when this strategy recognises the encoded format. */
  canVerify(storedHash: string): boolean;
}

/**
 * Argon2id — the OWASP first choice for password storage, and the default here.
 * Memory-hard, so GPU and ASIC attacks gain far less than they do against
 * iterated-hash schemes.
 *
 * The pepper is supplied through Argon2's native `secret` parameter, which keys
 * the hash function itself. That is meaningfully better than appending the
 * pepper to the password: it cannot interact with password length limits, and it
 * keeps the pepper out of the input whose entropy is being measured.
 */
class Argon2Strategy implements HashingStrategy {
  readonly id = 'argon2id';

  private readonly secret?: Buffer;

  constructor(
    private readonly memoryCost: number,
    private readonly timeCost: number,
    private readonly parallelism: number,
    pepper: string,
  ) {
    this.secret = pepper ? Buffer.from(pepper, 'utf8') : undefined;
  }

  canVerify(storedHash: string): boolean {
    return storedHash.startsWith('$argon2');
  }

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, {
      type: argon2.argon2id,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
      parallelism: this.parallelism,
      ...(this.secret ? { secret: this.secret } : {}),
    });
  }

  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(storedHash, plaintext, {
        ...(this.secret ? { secret: this.secret } : {}),
      });
    } catch {
      // A malformed hash is a verification failure, not an exception to surface.
      return false;
    }
  }

  needsRehash(storedHash: string): boolean {
    try {
      // `needsRehash` compares cost parameters only; it takes no `type` or `secret`.
      return argon2.needsRehash(storedHash, {
        memoryCost: this.memoryCost,
        timeCost: this.timeCost,
        parallelism: this.parallelism,
      });
    } catch {
      return true;
    }
  }
}

/**
 * scrypt — Node's built-in, zero-native-dependency fallback.
 *
 * Retained as a supported option because argon2 is a compiled addon; if a
 * deployment target cannot build or load it, flipping
 * `PASSWORD_HASH_ALGORITHM=scrypt` keeps the platform on an OWASP-approved KDF
 * rather than dropping to something unsuitable like a bare SHA hash.
 *
 * Node's scrypt exposes no keyed mode, so the pepper is concatenated here. The
 * input is already length-unbounded, so the usual objection to concatenation
 * does not apply.
 *
 * Encoded as `scrypt$N$r$p$salt$derived`, all base64url.
 */
class ScryptStrategy implements HashingStrategy {
  readonly id = 'scrypt';

  private readonly cost = 2 ** 16;
  private readonly blockSize = 8;
  private readonly parallelisation = 1;
  private readonly keyLength = 64;
  private readonly saltLength = 16;

  constructor(private readonly pepper: string) {}

  canVerify(storedHash: string): boolean {
    return storedHash.startsWith('scrypt$');
  }

  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(this.saltLength);
    const derived = await scrypt(this.withPepper(plaintext), salt, this.keyLength);

    return [
      'scrypt',
      this.cost,
      this.blockSize,
      this.parallelisation,
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    try {
      const salt = Buffer.from(parts[4], 'base64url');
      const expected = Buffer.from(parts[5], 'base64url');
      const actual = await scrypt(this.withPepper(plaintext), salt, expected.length);

      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  needsRehash(storedHash: string): boolean {
    const parts = storedHash.split('$');
    if (parts.length !== 6) return true;
    return Number(parts[1]) < this.cost;
  }

  private withPepper(plaintext: string): string {
    return this.pepper ? `${plaintext}${this.pepper}` : plaintext;
  }
}

export interface PasswordVerificationResult {
  valid: boolean;
  /** True when the caller should re-hash and persist the password. */
  needsRehash: boolean;
}

/**
 * The platform's password hashing facade (proposal module 6.1, "password hashing
 * and security protocols").
 *
 * Three properties matter and are each handled explicitly:
 *
 *  - **Algorithm agility.** New hashes use the configured algorithm; old hashes
 *    remain verifiable and are transparently upgraded on next sign-in.
 *  - **Peppering.** A secret that lives outside the database is mixed into every
 *    hash, so a stolen dump alone cannot be attacked offline.
 *  - **Constant-time failure.** Verifying against a non-existent user still
 *    performs real work, so response timing does not disclose whether an email
 *    address is registered.
 */
@Injectable()
export class PasswordHashingService {
  private readonly logger = new Logger(PasswordHashingService.name);
  private readonly strategies: HashingStrategy[];
  private readonly primary: HashingStrategy;

  /**
   * A real hash of a random value, used to burn a comparable amount of CPU when
   * no user record exists. Computed lazily on first use and then reused.
   */
  private dummyHash: string | null = null;

  constructor(private readonly configService: ConfigService) {
    const security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    const pepper = security.hashing.pepper;

    const argon2Strategy = new Argon2Strategy(
      security.hashing.argon2.memoryCost,
      security.hashing.argon2.timeCost,
      security.hashing.argon2.parallelism,
      pepper,
    );
    const scryptStrategy = new ScryptStrategy(pepper);

    this.strategies = [argon2Strategy, scryptStrategy];
    this.primary = security.hashing.algorithm === 'scrypt' ? scryptStrategy : argon2Strategy;

    this.logger.log(
      `Password hashing: ${this.primary.id}${pepper ? ' (peppered)' : ' (no pepper configured)'}`,
    );
  }

  /** Hashes a plaintext password for storage. */
  async hash(plaintext: string): Promise<string> {
    return this.primary.hash(plaintext);
  }

  /**
   * Verifies a password and reports whether the stored hash is stale.
   *
   * Callers should persist a fresh hash when `needsRehash` is true; this is how
   * an existing user base migrates to stronger parameters without a reset email.
   */
  async verify(storedHash: string, plaintext: string): Promise<PasswordVerificationResult> {
    const strategy = this.strategies.find((candidate) => candidate.canVerify(storedHash));

    if (!strategy) {
      this.logger.warn('Encountered a password hash in an unrecognised format.');
      return { valid: false, needsRehash: false };
    }

    const valid = await strategy.verify(storedHash, plaintext);
    if (!valid) return { valid: false, needsRehash: false };

    return {
      valid: true,
      needsRehash: strategy.id !== this.primary.id || strategy.needsRehash(storedHash),
    };
  }

  /**
   * Burns roughly the same CPU as a real verification.
   *
   * Called on the "user not found" branch of sign-in so an attacker cannot
   * enumerate registered addresses by measuring response time. Without it, a
   * missing user returns in microseconds while a real one takes tens of
   * milliseconds — a trivially observable difference.
   */
  async burnVerificationTime(): Promise<void> {
    if (!this.dummyHash) {
      this.dummyHash = await this.primary.hash(randomBytes(24).toString('base64url'));
    }
    await this.primary.verify(this.dummyHash, 'incorrect-password-placeholder');
  }
}
