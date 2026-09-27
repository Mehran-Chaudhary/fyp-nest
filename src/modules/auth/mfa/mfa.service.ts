import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { DataSource, IsNull, Repository, type EntityManager } from 'typeorm';
import { CacheKeys } from '../../../common/constants/cache-keys.constants';
import { AuditAction, AuditStatus } from '../../../common/enums/audit-action.enum';
import { ActorType } from '../../../common/enums/auth-type.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../../../common/exceptions/app.exception';
import { maskEmail } from '../../../common/utils/redact.util';
import { JWT_CONFIG_KEY, type JwtConfig } from '../../../config/jwt.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../../config/security.config';
import { returnedRows } from '../../../database/query.util';
import { MetricsService } from '../../../observability/metrics.service';
import { EncryptionService } from '../../../shared/crypto/encryption.service';
import { MailService } from '../../../shared/mail/mail.service';
import { RedisService } from '../../../shared/redis/redis.service';
import { AuditService } from '../../audit/audit.service';
import { User } from '../../users/entities/user.entity';
import { UsersService } from '../../users/users.service';
import { SessionRevocationReason } from '../entities/session.entity';
import { UserRecoveryCode } from '../entities/user-recovery-code.entity';
import { SessionService } from '../services/session.service';
import {
  generateRecoveryCode,
  generateTotpSecret,
  matchTotp,
  normalizeRecoveryCode,
  otpauthUri,
} from './totp';

/** A second factor as presented at sign-in or for a sensitive change. */
export interface SecondFactor {
  code?: string;
  recoveryCode?: string;
}

export type SecondFactorMethod = 'otp' | 'rec';

export interface MfaChallenge {
  /** Opaque, signed, single-use; exchanged with a code at `POST /auth/mfa/verify`. */
  token: string;
  expiresAt: string;
  methods: Array<'totp' | 'recovery_code'>;
}

interface ChallengeClaims {
  sub: string;
  typ: 'mfa_challenge';
  jti: string;
  org?: string;
}

/**
 * Two-step verification with time-based one-time passwords (phase 5).
 *
 * ## Enrolment
 *
 * Setup requires the account password again: a stolen session alone must
 * not be enough to attach an attacker's authenticator to the account (which
 * would lock the owner out of their own second factor). The seed is stored
 * encrypted and bound to the user by associated data; it becomes active only
 * once a first code proves the authenticator holds it. Ten single-use
 * recovery codes are issued then, shown once, and stored only as keyed
 * digests.
 *
 * ## Sign-in
 *
 * A correct password on an account with MFA yields not a session but a
 * *challenge*: a short-lived (MFA_CHALLENGE_TTL) token signed with a key
 * derived for this purpose alone. Exchanging it for a session requires a
 * current TOTP code or a recovery code. The challenge is single-use and
 * allows MFA_MAX_ATTEMPTS wrong codes; every wrong code also counts towards
 * the account lockout in PostgreSQL, so guessing six digits is bounded by the
 * same control that bounds guessing passwords.
 *
 * ## Codes cannot be replayed
 *
 * A TOTP code is valid for its 30-second step and one step either side. The
 * last accepted step is recorded, and a step at or before it is refused —
 * atomically, in the same statement that accepts it — so a code seen over a
 * shoulder, or captured by a phishing proxy, is worth nothing once used.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly config: SecurityConfig['mfa'];
  private readonly jwt: JwtConfig;
  private readonly challengeSecret: string;
  private readonly recoveryKey: Buffer;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserRecoveryCode)
    private readonly recoveryCodes: Repository<UserRecoveryCode>,
    private readonly usersService: UsersService,
    private readonly sessions: SessionService,
    private readonly encryption: EncryptionService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly dataSource: DataSource,
    configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    this.config = security.mfa;
    this.jwt = configService.getOrThrow<JwtConfig>(JWT_CONFIG_KEY);
    // Independent keys for independent purposes: a challenge can never be
    // confused with an access or refresh token, whatever its claims say.
    this.challengeSecret = Buffer.from(
      hkdfSync('sha256', this.jwt.refreshSecret, 'daiap-mfa', 'daiap/mfa-challenge/v1', 32),
    ).toString('base64url');
    this.recoveryKey = Buffer.from(
      hkdfSync('sha256', security.encryptionKey, 'daiap-mfa', 'daiap/recovery-codes/v1', 32),
    );
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async status(userId: string): Promise<{
    enabled: boolean;
    enrolledAt: Date | null;
    recoveryCodesRemaining: number;
  }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);
    const remaining = user.mfaEnabled
      ? await this.recoveryCodes.count({ where: { userId, usedAt: IsNull() } })
      : 0;
    return {
      enabled: user.mfaEnabled,
      enrolledAt: user.mfaEnrolledAt,
      recoveryCodesRemaining: remaining,
    };
  }

  // ── Enrolment ─────────────────────────────────────────────────────────────

  async beginEnrollment(
    userId: string,
    password: string,
  ): Promise<{ secret: string; otpauthUri: string; issuer: string; account: string }> {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);
    if (user.mfaEnabled) throw new ConflictError(ErrorCode.MFA_ALREADY_ENABLED);
    if (!(await this.usersService.verifyPassword(user, password))) {
      throw new UnauthorizedError(ErrorCode.AUTH_PASSWORD_MISMATCH);
    }

    const secret = generateTotpSecret();
    await this.users.update(
      { id: userId },
      { mfaSecret: this.encryption.encrypt(secret, this.aad(userId)), mfaLastUsedStep: null },
    );
    await this.auditService.recordSafe({
      action: AuditAction.USER_MFA_ENROLLMENT_STARTED,
      resourceType: 'user',
      resourceId: userId,
      actor: { type: ActorType.USER, id: userId, label: maskEmail(user.emailNormalized) },
    });

    return {
      secret,
      otpauthUri: otpauthUri(secret, user.email, this.config.issuer),
      issuer: this.config.issuer,
      account: user.email,
    };
  }

  /**
   * Activates the pending seed once a code proves the authenticator holds it.
   * The session making the change is marked as verified with a second factor
   * (it just proved one); every other session is signed out, since none of
   * them passed the stronger sign-in the account now requires.
   */
  async confirmEnrollment(
    userId: string,
    code: string,
    sessionId?: string,
  ): Promise<{ recoveryCodes: string[]; sessionId: string | null }> {
    const user = await this.loadWithSecret(userId);
    if (user.mfaEnabled) throw new ConflictError(ErrorCode.MFA_ALREADY_ENABLED);
    if (!user.mfaSecret) throw new ConflictError(ErrorCode.MFA_NOT_ENROLLING);

    const secret = this.encryption.decrypt(user.mfaSecret, this.aad(userId));
    const step = matchTotp(secret, code, Date.now());
    if (step === null) {
      this.metrics?.mfaVerifications.inc({ method: 'totp', outcome: 'invalid' });
      throw new UnauthorizedError(ErrorCode.MFA_CODE_INVALID);
    }

    const codes = this.freshRecoveryCodes();
    const tip = await this.dataSource.transaction(async (manager) => {
      const enabled = returnedRows(
        await manager.query(
          `UPDATE users
              SET mfa_enabled = true, mfa_enrolled_at = now(), mfa_last_used_step = $2
            WHERE id = $1 AND mfa_enabled = false
              AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $2)
            RETURNING id`,
          [userId, step.toString()],
        ),
      );
      if (enabled.length === 0) throw new UnauthorizedError(ErrorCode.MFA_CODE_INVALID);

      await this.replaceRecoveryCodes(manager, userId, codes);
      const family = sessionId ? await this.markFamilyVerified(manager, userId, sessionId) : null;
      await this.sessions.revokeAllForUser(
        userId,
        SessionRevocationReason.MFA_CHANGED,
        family?.familyId,
        manager,
      );
      await this.auditService.record(
        {
          action: AuditAction.USER_MFA_ENABLED,
          resourceType: 'user',
          resourceId: userId,
          actor: { type: ActorType.USER, id: userId, label: maskEmail(user.emailNormalized) },
          metadata: { recoveryCodes: codes.length },
        },
        manager,
      );
      return family?.tipId ?? null;
    });

    this.metrics?.mfaVerifications.inc({ method: 'totp', outcome: 'enrolled' });
    await this.usersService.invalidateCache(userId);
    await this.mailService.sendSecurityAlert(
      user.email,
      user.preferredName,
      'Two-step verification enabled',
      'Two-step verification is now on for your account. Your other devices were signed ' +
        'out and will ask for a code when you sign in again.',
    );

    return { recoveryCodes: codes, sessionId: tip };
  }

  /** Turns MFA off. Requires the password and a second factor: it is a downgrade. */
  async disable(userId: string, password: string, factor: SecondFactor): Promise<void> {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);
    if (!user.mfaEnabled) throw new ConflictError(ErrorCode.MFA_NOT_ENABLED);
    if (!(await this.usersService.verifyPassword(user, password))) {
      throw new UnauthorizedError(ErrorCode.AUTH_PASSWORD_MISMATCH);
    }
    await this.verifySecondFactor(userId, factor);

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_enrolled_at = NULL,
                          mfa_last_used_step = NULL
          WHERE id = $1`,
        [userId],
      );
      await manager.delete(UserRecoveryCode, { userId });
      // No session keeps an assurance the account no longer offers.
      await manager.query(`UPDATE sessions SET mfa_verified_at = NULL WHERE user_id = $1`, [
        userId,
      ]);
      await this.auditService.record(
        {
          action: AuditAction.USER_MFA_DISABLED,
          resourceType: 'user',
          resourceId: userId,
          actor: { type: ActorType.USER, id: userId, label: maskEmail(user.emailNormalized) },
        },
        manager,
      );
    });

    await this.usersService.invalidateCache(userId);
    await this.mailService.sendSecurityAlert(
      user.email,
      user.preferredName,
      'Two-step verification turned off',
      'Two-step verification was turned off for your account. If this was not you, reset ' +
        'your password immediately and contact your administrator.',
    );
  }

  /** New recovery codes, invalidating the old ones. Requires the password and a TOTP code. */
  async regenerateRecoveryCodes(
    userId: string,
    password: string,
    code: string,
  ): Promise<string[]> {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);
    if (!user.mfaEnabled) throw new ConflictError(ErrorCode.MFA_NOT_ENABLED);
    if (!(await this.usersService.verifyPassword(user, password))) {
      throw new UnauthorizedError(ErrorCode.AUTH_PASSWORD_MISMATCH);
    }
    await this.verifySecondFactor(userId, { code });

    const codes = this.freshRecoveryCodes();
    await this.dataSource.transaction(async (manager) => {
      await this.replaceRecoveryCodes(manager, userId, codes);
      await this.auditService.record(
        {
          action: AuditAction.USER_MFA_RECOVERY_CODES_REGENERATED,
          resourceType: 'user',
          resourceId: userId,
          actor: { type: ActorType.USER, id: userId, label: maskEmail(user.emailNormalized) },
          metadata: { recoveryCodes: codes.length },
        },
        manager,
      );
    });
    return codes;
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Accepts a TOTP code (single-use by time step) or a recovery code
   * (single-use by row), or throws `MFA_CODE_INVALID`.
   */
  async verifySecondFactor(
    userId: string,
    factor: SecondFactor,
  ): Promise<SecondFactorMethod> {
    if (factor.recoveryCode) {
      const [used] = returnedRows<{ id: string }>(
        await this.dataSource.query(
          `UPDATE user_recovery_codes SET used_at = now()
            WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
            RETURNING id`,
          [userId, this.hashRecoveryCode(userId, factor.recoveryCode)],
        ),
      );
      if (!used) {
        this.metrics?.mfaVerifications.inc({ method: 'recovery_code', outcome: 'invalid' });
        throw new UnauthorizedError(ErrorCode.MFA_CODE_INVALID);
      }
      this.metrics?.mfaVerifications.inc({ method: 'recovery_code', outcome: 'valid' });
      return 'rec';
    }

    const user = await this.loadWithSecret(userId);
    if (!user.mfaEnabled || !user.mfaSecret || !factor.code) {
      this.metrics?.mfaVerifications.inc({ method: 'totp', outcome: 'invalid' });
      throw new UnauthorizedError(ErrorCode.MFA_CODE_INVALID);
    }
    const secret = this.encryption.decrypt(user.mfaSecret, this.aad(userId));
    const step = matchTotp(secret, factor.code, Date.now());
    const accepted =
      step !== null &&
      returnedRows(
        await this.dataSource.query(
          `UPDATE users SET mfa_last_used_step = $2
            WHERE id = $1 AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $2)
            RETURNING id`,
          [userId, step.toString()],
        ),
      ).length === 1;

    this.metrics?.mfaVerifications.inc({
      method: 'totp',
      outcome: accepted ? 'valid' : step === null ? 'invalid' : 'replayed',
    });
    if (!accepted) throw new UnauthorizedError(ErrorCode.MFA_CODE_INVALID);
    return 'otp';
  }

  async recoveryCodesRemaining(userId: string): Promise<number> {
    return this.recoveryCodes.count({ where: { userId, usedAt: IsNull() } });
  }

  // ── Sign-in challenges ────────────────────────────────────────────────────

  async issueChallenge(userId: string, organizationId?: string): Promise<MfaChallenge> {
    const ttlSeconds = Math.max(30, Math.floor(this.config.challengeTtlMs / 1000));
    const claims: ChallengeClaims = {
      sub: userId,
      typ: 'mfa_challenge',
      jti: randomUUID(),
      ...(organizationId ? { org: organizationId } : {}),
    };
    const token = await this.jwtService.signAsync(claims, {
      secret: this.challengeSecret,
      expiresIn: ttlSeconds,
      issuer: this.jwt.issuer,
      audience: `${this.jwt.audience}:mfa`,
      algorithm: this.jwt.algorithm,
    });
    return {
      token,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      methods: ['totp', 'recovery_code'],
    };
  }

  /**
   * Validates a challenge and counts an attempt against it. Throws
   * `MFA_CHALLENGE_INVALID` for a forged, expired, used or exhausted one.
   */
  async redeemChallenge(
    token: string,
  ): Promise<{ userId: string; organizationId?: string; challengeId: string }> {
    let claims: ChallengeClaims & { exp?: number };
    try {
      claims = await this.jwtService.verifyAsync<ChallengeClaims & { exp?: number }>(token, {
        secret: this.challengeSecret,
        issuer: this.jwt.issuer,
        audience: `${this.jwt.audience}:mfa`,
        algorithms: [this.jwt.algorithm],
      });
    } catch {
      throw new UnauthorizedError(ErrorCode.MFA_CHALLENGE_INVALID);
    }
    if (claims.typ !== 'mfa_challenge' || !claims.jti || !claims.sub) {
      throw new UnauthorizedError(ErrorCode.MFA_CHALLENGE_INVALID);
    }

    // Redis bounds attempts per challenge and makes it single-use. If Redis
    // is down both checks fail open: the TOTP step and the recovery code are
    // single-use in PostgreSQL, and wrong codes still count towards the
    // account lockout there.
    const ttlSeconds = Math.max(1, (claims.exp ?? 0) - Math.floor(Date.now() / 1000));
    try {
      if (await this.redis.exists(CacheKeys.mfaChallengeUsed(claims.jti))) {
        throw new UnauthorizedError(ErrorCode.MFA_CHALLENGE_INVALID);
      }
      const { value: attempts } = await this.redis.increment(
        CacheKeys.mfaChallengeAttempts(claims.jti),
        ttlSeconds,
      );
      if (attempts > this.config.maxAttempts) {
        await this.completeChallenge(claims.jti, ttlSeconds);
        throw new UnauthorizedError(ErrorCode.MFA_CHALLENGE_INVALID, {
          message: 'Too many wrong codes for this sign-in attempt. Sign in again.',
        });
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      this.logger.warn(`MFA challenge bookkeeping unavailable: ${(error as Error).message}`);
    }

    return { userId: claims.sub, organizationId: claims.org, challengeId: claims.jti };
  }

  /** Marks a challenge used, so it cannot be exchanged twice. */
  async completeChallenge(challengeId: string, ttlSeconds?: number): Promise<void> {
    try {
      await this.redis.set(
        CacheKeys.mfaChallengeUsed(challengeId),
        '1',
        ttlSeconds ?? Math.ceil(this.config.challengeTtlMs / 1000),
      );
    } catch (error) {
      this.logger.warn(`Could not mark an MFA challenge used: ${(error as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async loadWithSecret(userId: string): Promise<User> {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect(['user.mfaSecret', 'user.mfaLastUsedStep'])
      .where('user.id = :userId', { userId })
      .getOne();
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);
    return user;
  }

  private freshRecoveryCodes(): string[] {
    return Array.from({ length: this.config.recoveryCodes }, () => generateRecoveryCode());
  }

  private async replaceRecoveryCodes(
    manager: EntityManager,
    userId: string,
    codes: string[],
  ): Promise<void> {
    await manager.delete(UserRecoveryCode, { userId });
    await manager.insert(
      UserRecoveryCode,
      codes.map((code) => ({ userId, codeHash: this.hashRecoveryCode(userId, code) })),
    );
  }

  /**
   * Marks the caller's session family as verified with a second factor, and
   * returns the family and its live tip (the session a new access token
   * should name).
   */
  private async markFamilyVerified(
    manager: EntityManager,
    userId: string,
    sessionId: string,
  ): Promise<{ familyId: string; tipId: string | null } | null> {
    const [session]: Array<{ family_id: string }> = await manager.query(
      `SELECT family_id FROM sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (!session) return null;
    const tips = returnedRows<{ id: string }>(
      await manager.query(
        `UPDATE sessions SET mfa_verified_at = now()
          WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING id`,
        [session.family_id, userId],
      ),
    );
    return { familyId: session.family_id, tipId: tips[0]?.id ?? null };
  }

  private hashRecoveryCode(userId: string, code: string): string {
    return createHmac('sha256', this.recoveryKey)
      .update(`${userId}:${normalizeRecoveryCode(code)}`)
      .digest('hex');
  }

  private aad(userId: string): string {
    return `mfa-secret:${userId}`;
  }

  /** For the sign-in flow: a denied second factor, audited without the code. */
  async recordChallengeFailure(
    userId: string,
    email: string,
    reason: string,
    context: { ip: string; userAgent?: string },
  ): Promise<void> {
    await this.auditService.recordSafe({
      action: AuditAction.USER_MFA_CHALLENGE_FAILED,
      status: AuditStatus.DENIED,
      resourceType: 'user',
      resourceId: userId,
      actor: { type: ActorType.USER, id: userId, label: maskEmail(email) },
      metadata: { reason, sourceIp: context.ip, userAgent: context.userAgent },
    });
  }
}
