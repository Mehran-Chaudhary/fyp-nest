import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository, type EntityManager } from 'typeorm';
import { CacheKeys, CACHE_TTL_SECONDS } from '../../common/constants/cache-keys.constants';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../../common/exceptions/app.exception';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-request.interface';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { PasswordHashingService } from '../../shared/crypto/password-hashing.service';
import { TokenService } from '../../shared/crypto/token.service';
import { RedisService } from '../../shared/redis/redis.service';
import { User, UserStatus } from './entities/user.entity';
import { UserToken, UserTokenType } from './entities/user-token.entity';

export interface CreateUserInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  displayName?: string;
  status?: UserStatus;
  isPlatformAdmin?: boolean;
}

/**
 * User records, credentials and one-time tokens.
 *
 * Deliberately has no knowledge of sign-in flow, sessions or JWTs — those belong
 * to `AuthService`. Keeping the boundary here means the password hash never
 * leaves this service except through {@link verifyPassword}, which returns a
 * boolean rather than the hash.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly security: SecurityConfig;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserToken)
    private readonly userTokenRepository: Repository<UserToken>,
    private readonly passwordHashing: PasswordHashingService,
    private readonly tokenService: TokenService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  /**
   * Canonical form of an email address.
   *
   * Lowercasing only. Deliberately *not* stripping dots or `+tags`: those rules
   * are provider-specific, and applying Gmail's semantics to a corporate mail
   * server would wrongly merge two distinct people into one account.
   */
  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  // ── Lookups ───────────────────────────────────────────────────────────────

  async findById(id: string, manager?: EntityManager): Promise<User | null> {
    const repository = manager ? manager.getRepository(User) : this.userRepository;
    return repository.findOne({ where: { id } });
  }

  async findByIdOrFail(id: string, manager?: EntityManager): Promise<User> {
    const user = await this.findById(id, manager);
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);
    return user;
  }

  async findByEmail(email: string, manager?: EntityManager): Promise<User | null> {
    const repository = manager ? manager.getRepository(User) : this.userRepository;
    return repository.findOne({
      where: { emailNormalized: UsersService.normaliseEmail(email) },
    });
  }

  /**
   * Loads a user together with their password hash.
   *
   * The hash is `select: false` on the entity, so retrieving it requires this
   * explicit call. That makes every place credentials are read greppable, and
   * makes accidental serialisation of a hash into an API response impossible
   * through the ordinary read paths.
   */
  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email_normalized = :email', {
        email: UsersService.normaliseEmail(email),
      })
      .getOne();
  }

  async findByIdWithPassword(id: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id })
      .getOne();
  }

  async emailExists(email: string): Promise<boolean> {
    return this.userRepository.existsBy({
      emailNormalized: UsersService.normaliseEmail(email),
    });
  }

  // ── Creation & mutation ───────────────────────────────────────────────────

  /**
   * Creates a user.
   *
   * Uniqueness is checked here for a clean error message *and* enforced by a
   * partial unique index in the database. Both are necessary: the application
   * check produces a good 409, while the index is what actually prevents two
   * concurrent registrations for the same address from both succeeding.
   */
  async create(input: CreateUserInput, manager?: EntityManager): Promise<User> {
    const repository = manager ? manager.getRepository(User) : this.userRepository;
    const emailNormalized = UsersService.normaliseEmail(input.email);

    const existing = await repository.findOne({ where: { emailNormalized } });
    if (existing) {
      throw new ConflictError(ErrorCode.ACCOUNT_ALREADY_EXISTS);
    }

    const user = repository.create({
      email: input.email.trim(),
      emailNormalized,
      passwordHash: await this.passwordHashing.hash(input.password),
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      displayName: input.displayName?.trim() || null,
      status: input.status ?? UserStatus.PENDING,
      isPlatformAdmin: input.isPlatformAdmin ?? false,
      preferences: {},
    });

    return repository.save(user);
  }

  async updateProfile(
    userId: string,
    changes: Partial<Pick<User, 'firstName' | 'lastName' | 'displayName' | 'avatarUrl'>>,
  ): Promise<User> {
    const user = await this.findByIdOrFail(userId);

    Object.assign(user, changes);
    const saved = await this.userRepository.save(user);

    await this.invalidateCache(userId);
    return saved;
  }

  async updatePreferences(
    userId: string,
    preferences: Record<string, unknown>,
  ): Promise<User> {
    const user = await this.findByIdOrFail(userId);
    user.preferences = { ...user.preferences, ...preferences };
    return this.userRepository.save(user);
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  /**
   * Verifies a password, transparently upgrading the stored hash when policy has
   * moved on.
   *
   * The rehash is best-effort and deliberately non-fatal: a user must not be
   * denied sign-in because a background upgrade failed.
   */
  async verifyPassword(user: User, plaintext: string): Promise<boolean> {
    if (!user.passwordHash) {
      this.logger.warn(
        `verifyPassword called with a user loaded without its hash (${user.id}).`,
      );
      return false;
    }

    const result = await this.passwordHashing.verify(user.passwordHash, plaintext);

    if (result.valid && result.needsRehash) {
      try {
        const upgraded = await this.passwordHashing.hash(plaintext);
        await this.userRepository.update({ id: user.id }, { passwordHash: upgraded });
        this.logger.log(`Upgraded password hash parameters for user ${user.id}.`);
      } catch (error) {
        this.logger.warn(`Password hash upgrade failed for ${user.id}: ${(error as Error).message}`);
      }
    }

    return result.valid;
  }

  /**
   * Sets a new password and invalidates every outstanding credential.
   *
   * `tokensValidFrom` is advanced in the same statement. Changing a password
   * while leaving existing sessions alive is a common and serious mistake: a
   * user who changes their password *because* they suspect compromise expects it
   * to eject the attacker, and if it does not, the attacker simply keeps their
   * session.
   */
  async setPassword(
    userId: string,
    newPassword: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = manager ? manager.getRepository(User) : this.userRepository;

    await repository.update(
      { id: userId },
      {
        passwordHash: await this.passwordHashing.hash(newPassword),
        tokensValidFrom: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    );

    await this.invalidateCache(userId);
  }

  // ── Sign-in bookkeeping ───────────────────────────────────────────────────

  async recordSuccessfulLogin(userId: string, ip: string): Promise<void> {
    await this.userRepository.update(
      { id: userId },
      {
        lastLoginAt: new Date(),
        lastLoginIp: ip.slice(0, 45),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    );
    await this.invalidateCache(userId);
  }

  /**
   * Records a failed attempt and locks the account once the threshold is hit.
   *
   * Counted in PostgreSQL rather than only in Redis so that an attacker who can
   * cause a cache eviction cannot thereby reset the counter. Redis still carries
   * a parallel counter for cheap pre-database rate limiting; this one is the
   * authoritative record.
   *
   * Returns the lock expiry when the account was locked by this attempt.
   */
  async recordFailedLogin(userId: string): Promise<{ locked: boolean; lockedUntil?: Date }> {
    const user = await this.findById(userId);
    if (!user) return { locked: false };

    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= this.security.lockout.maxFailedAttempts;

    const lockedUntil = shouldLock
      ? new Date(Date.now() + this.security.lockout.lockoutDurationMs)
      : user.lockedUntil;

    await this.userRepository.update(
      { id: userId },
      { failedLoginAttempts: attempts, lockedUntil: lockedUntil ?? null },
    );

    await this.invalidateCache(userId);

    return shouldLock
      ? { locked: true, lockedUntil: lockedUntil as Date }
      : { locked: false };
  }

  async unlock(userId: string): Promise<void> {
    await this.userRepository.update(
      { id: userId },
      { failedLoginAttempts: 0, lockedUntil: null },
    );
    await this.invalidateCache(userId);
  }

  // ── Account state ─────────────────────────────────────────────────────────

  async markEmailVerified(userId: string, manager?: EntityManager): Promise<void> {
    const repository = manager ? manager.getRepository(User) : this.userRepository;

    await repository.update(
      { id: userId },
      {
        emailVerifiedAt: new Date(),
        // A PENDING account becomes ACTIVE on verification; a SUSPENDED one
        // stays suspended, because verifying an address must not undo a
        // moderation decision.
        status: UserStatus.ACTIVE,
      },
    );

    await this.invalidateCache(userId);
  }

  async setStatus(userId: string, status: UserStatus): Promise<void> {
    await this.userRepository.update({ id: userId }, { status });
    await this.invalidateCache(userId);
  }

  // ── One-time tokens ───────────────────────────────────────────────────────

  /**
   * Issues a single-use token and invalidates any outstanding one of the same
   * type.
   *
   * Superseding previous tokens matters: if three password-reset emails are
   * outstanding, a leaked older one is as good as the newest, and the user has
   * no way to know which is live.
   */
  async issueToken(
    userId: string,
    type: UserTokenType,
    ttlMs: number,
    metadata: Record<string, unknown> = {},
    requestedIp?: string,
    manager?: EntityManager,
  ): Promise<{ token: string; record: UserToken }> {
    const repository = manager ? manager.getRepository(UserToken) : this.userTokenRepository;

    await repository.update(
      { userId, type, consumedAt: IsNull() },
      { consumedAt: new Date() },
    );

    const generated = this.tokenService.generateToken(32);

    const record = repository.create({
      userId,
      type,
      tokenHash: generated.hash,
      expiresAt: new Date(Date.now() + ttlMs),
      metadata,
      requestedIp: requestedIp?.slice(0, 45) ?? null,
    });

    return { token: generated.token, record: await repository.save(record) };
  }

  /**
   * Redeems a token, returning the record on success.
   *
   * Consumption happens in the same transaction as the lookup, with the row
   * locked, so the same token cannot be redeemed twice concurrently.
   */
  async consumeToken(
    token: string,
    type: UserTokenType,
    manager: EntityManager,
    consumedIp?: string,
  ): Promise<UserToken> {
    const repository = manager.getRepository(UserToken);
    const tokenHash = this.tokenService.hashToken(token);

    const record = await repository
      .createQueryBuilder('token')
      .setLock('pessimistic_write')
      .where('token.token_hash = :tokenHash', { tokenHash })
      .andWhere('token.type = :type', { type })
      .getOne();

    if (!record) {
      throw new UnauthorizedError(ErrorCode.TOKEN_NOT_FOUND);
    }
    if (record.isConsumed) {
      throw new UnauthorizedError(ErrorCode.TOKEN_ALREADY_USED);
    }
    if (record.isExpired) {
      throw new UnauthorizedError(ErrorCode.TOKEN_EXPIRED);
    }

    await repository.update(
      { id: record.id },
      { consumedAt: new Date(), consumedIp: consumedIp?.slice(0, 45) ?? null },
    );

    return record;
  }

  /** Removes expired, unconsumed tokens. Scheduled from phase 5. */
  async purgeExpiredTokens(): Promise<number> {
    const result = await this.userTokenRepository.delete({
      expiresAt: LessThan(new Date(Date.now() - 86_400_000)),
    });
    return result.affected ?? 0;
  }

  // ── Request-scoped projection ─────────────────────────────────────────────

  /**
   * The narrow user projection the authentication guard attaches to a request.
   *
   * Cached briefly in Redis because it is read on every authenticated request;
   * the TTL is short so that a status change takes effect within seconds even if
   * an explicit invalidation is missed. The cache stores only non-sensitive
   * fields — never the password hash, which is excluded by the entity anyway.
   *
   * Returns `null` for an account that must not authenticate, so a suspended or
   * locked user is rejected on their very next request rather than at their next
   * sign-in.
   */
  async getAuthProjection(
    userId: string,
    sessionId: string,
    tokenId: string,
  ): Promise<AuthenticatedUser | null> {
    const cacheKey = CacheKeys.userProfile(userId);

    let cached = await this.redis.getJson<{
      id: string;
      email: string;
      displayName: string;
      isPlatformAdmin: boolean;
      emailVerified: boolean;
      status: UserStatus;
      lockedUntil: string | null;
      tokensValidFrom: string | null;
    }>(cacheKey);

    if (!cached) {
      const user = await this.findById(userId);
      if (!user) return null;

      cached = {
        id: user.id,
        email: user.emailNormalized,
        displayName: user.preferredName,
        isPlatformAdmin: user.isPlatformAdmin,
        emailVerified: user.isEmailVerified,
        status: user.status,
        lockedUntil: user.lockedUntil?.toISOString() ?? null,
        tokensValidFrom: user.tokensValidFrom?.toISOString() ?? null,
      };

      await this.redis.setJson(cacheKey, cached, CACHE_TTL_SECONDS.USER_PROFILE);
    }

    if (cached.status === UserStatus.SUSPENDED || cached.status === UserStatus.DEACTIVATED) {
      return null;
    }
    if (cached.lockedUntil && new Date(cached.lockedUntil).getTime() > Date.now()) {
      return null;
    }

    return {
      id: cached.id,
      email: cached.email,
      displayName: cached.displayName,
      isPlatformAdmin: cached.isPlatformAdmin,
      emailVerified: cached.emailVerified,
      sessionId,
      tokenId,
    };
  }

  /**
   * The durable equivalent of the Redis token epoch.
   *
   * Consulted by the authentication guard so that revocation still works during
   * a Redis outage — see the fail-open note on `JwtTokenService.isTokenRevoked`.
   */
  async getTokensValidFrom(userId: string): Promise<Date | null> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: { id: true, tokensValidFrom: true },
    });
    return user?.tokensValidFrom ?? null;
  }

  async invalidateCache(userId: string): Promise<void> {
    await this.redis.del(CacheKeys.userProfile(userId));
  }
}
