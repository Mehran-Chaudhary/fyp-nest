import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../common/exceptions/app.exception';
import type {
  AccessTokenClaims,
  AuthenticationMethod,
  TokenPair,
} from '../../common/interfaces/jwt-payload.interface';
import { maskEmail } from '../../common/utils/redact.util';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { PasswordHashingService } from '../../shared/crypto/password-hashing.service';
import { MailService } from '../../shared/mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserTokenType } from '../users/entities/user-token.entity';
import { Session, SessionRevocationReason } from './entities/session.entity';
import { MfaService, type MfaChallenge, type SecondFactor } from './mfa/mfa.service';
import { BreachedPasswordService } from './services/breached-password.service';
import { JwtTokenService } from './services/jwt-token.service';
import { SessionService } from './services/session.service';

export interface RequestContextInput {
  ip: string;
  userAgent?: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface LoginInput {
  email: string;
  password: string;
  organizationId?: string;
}

export interface AuthResult {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    displayName: string;
    emailVerified: boolean;
    isPlatformAdmin: boolean;
    status: UserStatus;
    mfaEnabled: boolean;
  };
  tokens: TokenPair;
}

/**
 * What a correct password yields: a session, or — on an account with
 * two-step verification — a challenge to complete with a code (phase 5).
 */
export type LoginOutcome =
  | { kind: 'session'; result: AuthResult }
  | { kind: 'mfa'; challenge: MfaChallenge };

/**
 * Authentication flows (proposal module 6.1).
 *
 * Three cross-cutting decisions shape almost every method here.
 *
 * **User enumeration is treated as a real vulnerability.** Sign-in, password
 * reset and resend-verification all behave identically whether or not the
 * address exists: same response, same status, comparable timing. An attacker who
 * can confirm which addresses are registered has a list of valid usernames for
 * credential stuffing and a map of who works where — which, for an enterprise
 * platform, is itself sensitive. The one deliberate exception is registration,
 * where returning a conflict is unavoidable if the signup form is to be usable;
 * that trade-off is noted at the call site.
 *
 * **Credential changes end sessions.** Changing or resetting a password revokes
 * every outstanding token. A user who changes their password because they
 * suspect compromise expects it to eject the attacker; if it does not, the
 * attacker simply keeps their session and the user believes they are safe.
 *
 * **Everything is audited.** Successful and failed sign-ins, lockouts, resets
 * and reuse detections all produce records. The failures are the ones that
 * matter for detection.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly security: SecurityConfig;

  constructor(
    private readonly usersService: UsersService,
    private readonly sessionService: SessionService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly mfa: MfaService,
    private readonly breachedPasswords: BreachedPasswordService,
  ) {
    this.security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Creates an account and signs the user straight in.
   *
   * The account is `PENDING` until its address is verified. Whether that blocks
   * anything is policy (`REQUIRE_EMAIL_VERIFICATION`): the default is to let a
   * user explore immediately, because an enterprise evaluator who cannot get
   * past a mail gateway is an evaluator who stops evaluating.
   */
  async register(input: RegisterInput, context: RequestContextInput): Promise<AuthResult> {
    // A conflict here does disclose that the address is registered. The
    // alternative — accepting the registration silently and emailing "you
    // already have an account" — is more private but produces a signup form that
    // cannot tell the user why nothing happened. The exposure is limited to the
    // registration endpoint, which is rate limited under the strict `auth`
    // policy for exactly this reason.
    await this.breachedPasswords.assertAcceptable(input.password, {
      purpose: 'registration',
    });
    const user = await this.usersService.create({
      email: input.email,
      password: input.password,
      firstName: input.firstName,
      lastName: input.lastName,
      status: UserStatus.PENDING,
    });

    const tokens = await this.startSession(user, context, undefined);

    await this.auditService.recordSafe({
      action: AuditAction.USER_REGISTERED,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: maskEmail(user.emailNormalized),
      actor: { type: ActorType.USER, id: user.id, label: maskEmail(user.emailNormalized) },
      metadata: { emailDomain: user.emailNormalized.split('@')[1] },
    });

    await this.sendVerificationEmail(user, context.ip);

    this.logger.log(`Registered new account ${maskEmail(user.emailNormalized)}.`);

    return { user: this.toProfile(user), tokens };
  }

  // ── Sign-in ───────────────────────────────────────────────────────────────

  /**
   * Verifies credentials and starts a session.
   *
   * The ordering below is deliberate: the "no such user" branch performs a real
   * hash verification against a dummy value before returning. Without that, a
   * missing account returns in microseconds while a real one takes tens of
   * milliseconds, and the difference is trivially measurable over a handful of
   * requests.
   */
  async login(input: LoginInput, context: RequestContextInput): Promise<LoginOutcome> {
    const user = await this.usersService.findByEmailWithPassword(input.email);

    if (!user) {
      // Real hashing work on the "no such account" branch, so that a missing
      // account and a wrong password are indistinguishable by response time.
      await this.passwordHashing.burnVerificationTime();
      await this.recordFailedLogin(input.email, context, 'no_such_account');
      throw new UnauthorizedError(ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    if (user.isLocked) {
      await this.recordFailedLogin(input.email, context, 'account_locked', user.id);
      throw new ForbiddenError(ErrorCode.ACCOUNT_LOCKED, {
        details: { lockedUntil: user.lockedUntil?.toISOString() },
      });
    }

    if (user.status === UserStatus.SUSPENDED) {
      await this.recordFailedLogin(input.email, context, 'account_suspended', user.id);
      throw new ForbiddenError(ErrorCode.ACCOUNT_SUSPENDED);
    }

    if (user.status === UserStatus.DEACTIVATED) {
      await this.recordFailedLogin(input.email, context, 'account_deactivated', user.id);
      throw new ForbiddenError(ErrorCode.ACCOUNT_DEACTIVATED);
    }

    const passwordValid = await this.usersService.verifyPassword(user, input.password);

    if (!passwordValid) {
      const lockResult = await this.usersService.recordFailedLogin(user.id);

      await this.recordFailedLogin(input.email, context, 'wrong_password', user.id);

      if (lockResult.locked) {
        await this.auditService.recordSafe({
          action: AuditAction.USER_ACCOUNT_LOCKED,
          status: AuditStatus.DENIED,
          resourceType: 'user',
          resourceId: user.id,
          actor: { type: ActorType.SYSTEM, label: 'lockout policy' },
          metadata: {
            lockedUntil: lockResult.lockedUntil?.toISOString(),
            threshold: this.security.lockout.maxFailedAttempts,
          },
        });

        throw new ForbiddenError(ErrorCode.ACCOUNT_LOCKED, {
          details: { lockedUntil: lockResult.lockedUntil?.toISOString() },
        });
      }

      throw new UnauthorizedError(ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    // Phase 5: the password was right, but it is only the first factor. No
    // session exists until a code completes the challenge, and the failed-
    // attempt counter is not reset until then either.
    if (user.mfaEnabled) {
      return {
        kind: 'mfa',
        challenge: await this.mfa.issueChallenge(user.id, input.organizationId),
      };
    }

    const tokens = await this.startSession(user, context, input.organizationId);

    await this.usersService.recordSuccessfulLogin(user.id, context.ip);

    await this.auditService.recordSafe({
      action: AuditAction.USER_LOGIN_SUCCEEDED,
      organizationId: input.organizationId,
      resourceType: 'user',
      resourceId: user.id,
      actor: { type: ActorType.USER, id: user.id, label: maskEmail(user.emailNormalized) },
      metadata: { emailVerified: user.isEmailVerified, mfa: false },
    });

    return { kind: 'session', result: { user: this.toProfile(user), tokens } };
  }

  /**
   * The second step of signing in to an account with MFA (phase 5): a TOTP
   * code or a recovery code exchanged, with the challenge, for a session.
   *
   * A wrong code counts against the account lockout exactly like a wrong
   * password, so the six digits cannot be guessed faster than a password can.
   */
  async completeMfaLogin(
    challengeToken: string,
    factor: SecondFactor,
    context: RequestContextInput,
  ): Promise<AuthResult> {
    const challenge = await this.mfa.redeemChallenge(challengeToken);
    const user = await this.usersService.findById(challenge.userId);
    if (!user || !user.mfaEnabled) {
      throw new UnauthorizedError(ErrorCode.MFA_CHALLENGE_INVALID);
    }
    if (user.isLocked) {
      throw new ForbiddenError(ErrorCode.ACCOUNT_LOCKED, {
        details: { lockedUntil: user.lockedUntil?.toISOString() },
      });
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenError(ErrorCode.ACCOUNT_SUSPENDED);
    }
    if (user.status === UserStatus.DEACTIVATED) {
      throw new ForbiddenError(ErrorCode.ACCOUNT_DEACTIVATED);
    }

    let method: 'otp' | 'rec';
    try {
      method = await this.mfa.verifySecondFactor(user.id, factor);
    } catch (error) {
      const lockResult = await this.usersService.recordFailedLogin(user.id);
      await this.mfa.recordChallengeFailure(
        user.id,
        user.emailNormalized,
        factor.recoveryCode ? 'invalid_recovery_code' : 'invalid_code',
        context,
      );
      if (lockResult.locked) {
        await this.mfa.completeChallenge(challenge.challengeId);
        throw new ForbiddenError(ErrorCode.ACCOUNT_LOCKED, {
          details: { lockedUntil: lockResult.lockedUntil?.toISOString() },
        });
      }
      throw error;
    }

    await this.mfa.completeChallenge(challenge.challengeId);
    const amr: AuthenticationMethod[] = ['pwd', method, 'mfa'];
    const tokens = await this.startSession(user, context, challenge.organizationId, {
      amr,
      mfaVerifiedAt: new Date(),
    });
    await this.usersService.recordSuccessfulLogin(user.id, context.ip);

    await this.auditService.recordSafe({
      action: AuditAction.USER_LOGIN_SUCCEEDED,
      organizationId: challenge.organizationId,
      resourceType: 'user',
      resourceId: user.id,
      actor: { type: ActorType.USER, id: user.id, label: maskEmail(user.emailNormalized) },
      metadata: { emailVerified: user.isEmailVerified, mfa: true, method },
    });

    if (method === 'rec') {
      const remaining = await this.mfa.recoveryCodesRemaining(user.id);
      await this.auditService.recordSafe({
        action: AuditAction.USER_MFA_RECOVERY_CODE_USED,
        resourceType: 'user',
        resourceId: user.id,
        actor: { type: ActorType.USER, id: user.id, label: maskEmail(user.emailNormalized) },
        metadata: { remaining },
      });
      await this.mailService.sendSecurityAlert(
        user.email,
        user.preferredName,
        'A recovery code was used',
        `You signed in with a recovery code; ${remaining} remain. If this was not you, ` +
          'reset your password and your two-step verification now.',
      );
    }

    return { user: this.toProfile(user), tokens };
  }

  /**
   * Confirms MFA enrolment, and hands back an access token for the calling
   * session that carries the second factor it just proved — so a workspace
   * that requires MFA opens without signing in again.
   */
  async enableMfa(
    userId: string,
    code: string,
    sessionId: string | undefined,
    organizationId?: string,
  ): Promise<{ recoveryCodes: string[]; accessToken?: string; expiresIn?: number }> {
    const outcome = await this.mfa.confirmEnrollment(userId, code, sessionId);
    if (!outcome.sessionId) return { recoveryCodes: outcome.recoveryCodes };

    const user = await this.usersService.findByIdOrFail(userId);
    const accessToken = await this.jwtTokenService.signAccessToken(
      {
        id: user.id,
        emailNormalized: user.emailNormalized,
        isPlatformAdmin: user.isPlatformAdmin,
      },
      outcome.sessionId,
      organizationId,
      ['pwd', 'otp', 'mfa'],
    );
    return {
      recoveryCodes: outcome.recoveryCodes,
      accessToken,
      expiresIn: this.jwtTokenService.accessTokenTtlSeconds,
    };
  }

  /**
   * Mints a token pair and persists the session that backs it.
   *
   * The refresh token is signed *before* the session row is written, because the
   * row stores the token's digest. Both happen in one transaction so a token can
   * never exist without its session, which would make it unrotatable.
   */
  private async startSession(
    user: User,
    context: RequestContextInput,
    organizationId?: string,
    assurance: { amr: AuthenticationMethod[]; mfaVerifiedAt: Date | null } = {
      amr: ['pwd'],
      mfaVerifiedAt: null,
    },
  ): Promise<TokenPair> {
    const sessionId = randomUUID();
    const familyId = randomUUID();

    const tokens = await this.jwtTokenService.issueTokenPair(
      {
        id: user.id,
        emailNormalized: user.emailNormalized,
        isPlatformAdmin: user.isPlatformAdmin,
      },
      sessionId,
      familyId,
      organizationId,
      assurance.amr,
    );

    await this.sessionService.create({
      id: sessionId,
      userId: user.id,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + this.jwtTokenService.refreshTokenTtlMs),
      familyId,
      ipAddress: context.ip,
      userAgent: context.userAgent,
      organizationId: organizationId ?? null,
      mfaVerifiedAt: assurance.mfaVerifiedAt,
    });

    return tokens;
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  /**
   * Exchanges a refresh token for a new pair.
   *
   * The reuse case is the interesting one. If the presented token has already
   * been rotated, two parties hold it, so the entire family is revoked and the
   * user is notified by email. Both the revocation and the notification matter:
   * revocation stops the attacker, and the email is the legitimate user's only
   * signal that something happened.
   */
  async refresh(refreshToken: string, context: RequestContextInput): Promise<TokenPair> {
    const claims = await this.jwtTokenService.verifyRefreshToken(refreshToken);

    const user = await this.usersService.findById(claims.sub);
    if (!user || !user.canAuthenticate) {
      throw new UnauthorizedError(ErrorCode.ACCOUNT_SUSPENDED);
    }

    const newSessionId = randomUUID();

    // Signed up front because the session row stores its digest, and both must
    // land in the same transaction.
    const newRefreshToken = await this.jwtTokenService.signRefreshToken(
      user.id,
      newSessionId,
      claims.fam,
    );

    try {
      const rotated = await this.dataSource.transaction(async (manager) =>
        this.sessionService.rotate(
          manager,
          refreshToken,
          newRefreshToken,
          new Date(Date.now() + this.jwtTokenService.refreshTokenTtlMs),
          { ipAddress: context.ip, userAgent: context.userAgent },
          newSessionId,
        ),
      );

      const accessToken = await this.jwtTokenService.signAccessToken(
        {
          id: user.id,
          emailNormalized: user.emailNormalized,
          isPlatformAdmin: user.isPlatformAdmin,
        },
        rotated.session.id,
        rotated.session.organizationId ?? undefined,
        // The refreshed token has the assurance of the sign-in it descends from.
        rotated.session.mfaVerifiedAt ? ['pwd', 'mfa'] : ['pwd'],
      );

      await this.auditService.recordSafe({
        action: AuditAction.USER_TOKEN_REFRESHED,
        resourceType: 'session',
        resourceId: rotated.session.id,
        actor: {
          type: ActorType.USER,
          id: user.id,
          label: maskEmail(user.emailNormalized),
        },
        metadata: { familyId: rotated.familyId },
      });

      return {
        accessToken,
        refreshToken: newRefreshToken,
        tokenType: 'Bearer',
        expiresIn: this.jwtTokenService.accessTokenTtlSeconds,
        expiresAt: new Date(
          Date.now() + this.jwtTokenService.accessTokenTtlSeconds * 1000,
        ).toISOString(),
        refreshExpiresIn: Math.floor(this.jwtTokenService.refreshTokenTtlMs / 1000),
      };
    } catch (error) {
      if (
        error instanceof UnauthorizedError &&
        error.code === ErrorCode.AUTH_REFRESH_TOKEN_REUSED
      ) {
        await this.handleTokenReuse(user, claims.fam, context);
      }
      throw error;
    }
  }

  /**
   * Responds to detected refresh token reuse.
   *
   * The family is already revoked by the time this runs. What is left is to make
   * the event impossible to miss: a `CRITICAL` audit record and an email to the
   * account owner. Every *other* session is revoked too, because a leaked
   * refresh token usually means the device or the client storage is compromised,
   * and the other sessions on that device are no safer.
   */
  private async handleTokenReuse(
    user: User,
    familyId: string,
    context: RequestContextInput,
  ): Promise<void> {
    this.logger.error(
      `SECURITY: refresh token reuse detected for user ${user.id} (family ${familyId}) ` +
        `from ${context.ip}. All sessions revoked.`,
    );

    await this.sessionService.revokeAllForUser(
      user.id,
      SessionRevocationReason.REUSE_DETECTED,
    );
    await this.jwtTokenService.revokeAllUserTokens(user.id);

    await this.auditService.recordSafe({
      action: AuditAction.USER_TOKEN_REUSE_DETECTED,
      status: AuditStatus.DENIED,
      resourceType: 'user',
      resourceId: user.id,
      actor: { type: ActorType.USER, id: user.id, label: maskEmail(user.emailNormalized) },
      metadata: { familyId, sourceIp: context.ip, userAgent: context.userAgent },
    });

    await this.mailService.sendSecurityAlert(
      user.email,
      user.preferredName,
      'Suspicious sign-in activity',
      'A sign-in token for your account was used twice, which can indicate that it was copied ' +
        'by someone else.',
    );
  }

  // ── Sign-out ──────────────────────────────────────────────────────────────

  /** Ends the current session, leaving other devices signed in. */
  async logout(
    claims: AccessTokenClaims,
    refreshToken?: string,
  ): Promise<{ revokedSessions: number }> {
    await this.jwtTokenService.revokeAccessToken(claims);

    let revoked = 0;

    if (refreshToken) {
      const session = await this.sessionService.findByToken(refreshToken);
      if (session) {
        revoked = await this.sessionService.revokeFamily(
          session.familyId,
          SessionRevocationReason.LOGOUT,
        );
      }
    } else {
      // No refresh token supplied (a client that keeps it in an httpOnly cookie
      // that did not travel, for instance). The access token's `sid` still
      // identifies the session.
      await this.sessionService.revoke(claims.sid, SessionRevocationReason.LOGOUT);
      revoked = 1;
    }

    await this.auditService.recordSafe({
      action: AuditAction.USER_LOGGED_OUT,
      resourceType: 'session',
      resourceId: claims.sid,
      actor: { type: ActorType.USER, id: claims.sub, label: claims.email },
      metadata: { revokedSessions: revoked },
    });

    return { revokedSessions: revoked };
  }

  /** Signs out everywhere. Used after a suspected compromise. */
  async logoutAll(
    userId: string,
    exceptFamilyId?: string,
  ): Promise<{ revokedSessions: number }> {
    const revoked = await this.sessionService.revokeAllForUser(
      userId,
      SessionRevocationReason.LOGOUT_ALL,
      exceptFamilyId,
    );

    await this.jwtTokenService.revokeAllUserTokens(userId);

    await this.auditService.recordSafe({
      action: AuditAction.USER_LOGGED_OUT_ALL,
      resourceType: 'user',
      resourceId: userId,
      metadata: { revokedSessions: revoked, keptFamily: exceptFamilyId },
    });

    return { revokedSessions: revoked };
  }

  // ── Email verification ────────────────────────────────────────────────────

  private async sendVerificationEmail(user: User, ip: string): Promise<void> {
    const { token } = await this.usersService.issueToken(
      user.id,
      UserTokenType.EMAIL_VERIFICATION,
      this.security.tokens.emailVerificationTtlMs,
      {},
      ip,
    );

    await this.mailService.sendEmailVerification(user.email, user.preferredName, token);

    await this.auditService.recordSafe({
      action: AuditAction.USER_EMAIL_VERIFICATION_SENT,
      resourceType: 'user',
      resourceId: user.id,
      actor: { type: ActorType.SYSTEM, label: 'registration' },
    });
  }

  async verifyEmail(
    token: string,
    context: RequestContextInput,
  ): Promise<{ verified: boolean }> {
    const record = await this.dataSource.transaction(async (manager) => {
      const consumed = await this.usersService.consumeToken(
        token,
        UserTokenType.EMAIL_VERIFICATION,
        manager,
        context.ip,
      );

      await this.usersService.markEmailVerified(consumed.userId, manager);
      return consumed;
    });

    await this.auditService.recordSafe({
      action: AuditAction.USER_EMAIL_VERIFIED,
      resourceType: 'user',
      resourceId: record.userId,
      actor: { type: ActorType.USER, id: record.userId },
    });

    return { verified: true };
  }

  /**
   * Re-sends a verification email.
   *
   * Always reports success. Reporting "no such account" would turn this endpoint
   * into an address oracle, and one that is easier to script than sign-in
   * because it needs no password guesses at all.
   */
  async resendVerification(
    email: string,
    context: RequestContextInput,
  ): Promise<{ sent: true }> {
    const user = await this.usersService.findByEmail(email);

    if (user && !user.isEmailVerified && user.canAuthenticate) {
      await this.sendVerificationEmail(user, context.ip);
    }

    return { sent: true };
  }

  // ── Password reset ────────────────────────────────────────────────────────

  /**
   * Starts a password reset.
   *
   * Always reports success, for the same anti-enumeration reason as
   * {@link resendVerification}.
   */
  async requestPasswordReset(
    email: string,
    context: RequestContextInput,
  ): Promise<{ sent: true }> {
    const user = await this.usersService.findByEmail(email);

    if (user && user.status !== UserStatus.DEACTIVATED) {
      const { token } = await this.usersService.issueToken(
        user.id,
        UserTokenType.PASSWORD_RESET,
        this.security.tokens.passwordResetTtlMs,
        {},
        context.ip,
      );

      await this.mailService.sendPasswordReset(
        user.email,
        user.preferredName,
        token,
        context.ip,
      );

      await this.auditService.recordSafe({
        action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
        resourceType: 'user',
        resourceId: user.id,
        actor: {
          type: ActorType.USER,
          id: user.id,
          label: maskEmail(user.emailNormalized),
        },
        metadata: { requestIp: context.ip },
      });
    } else {
      // Logged, not returned. Useful for spotting an enumeration sweep, useless
      // to the person making it.
      this.logger.debug(
        `Password reset requested for an unknown or deactivated address from ${context.ip}.`,
      );
    }

    return { sent: true };
  }

  /**
   * Completes a password reset.
   *
   * Consumes the token, sets the password and revokes every session, all in one
   * transaction. Whoever requested the reset is now the only party with access.
   */
  async resetPassword(
    token: string,
    newPassword: string,
    context: RequestContextInput,
  ): Promise<{ reset: true }> {
    // Screened before the token is consumed, so a refused password leaves the
    // reset link usable for a second attempt.
    await this.breachedPasswords.assertAcceptable(newPassword, { purpose: 'reset' });

    const userId = await this.dataSource.transaction(async (manager) => {
      const record = await this.usersService.consumeToken(
        token,
        UserTokenType.PASSWORD_RESET,
        manager,
        context.ip,
      );

      await this.usersService.setPassword(record.userId, newPassword, manager);

      await this.sessionService.revokeAllForUser(
        record.userId,
        SessionRevocationReason.PASSWORD_CHANGED,
        undefined,
        manager,
      );

      return record.userId;
    });

    await this.jwtTokenService.revokeAllUserTokens(userId);

    const user = await this.usersService.findById(userId);

    await this.auditService.recordSafe({
      action: AuditAction.USER_PASSWORD_RESET_COMPLETED,
      resourceType: 'user',
      resourceId: userId,
      actor: { type: ActorType.USER, id: userId },
      metadata: { resetIp: context.ip },
    });

    if (user) {
      await this.mailService.sendPasswordChangedNotice(
        user.email,
        user.preferredName,
        context.ip,
      );
    }

    return { reset: true };
  }

  /**
   * Changes a password for a signed-in user.
   *
   * Requires the current password even though the caller is authenticated: an
   * unattended session would otherwise be enough for a passer-by to take
   * permanent ownership of the account.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentFamilyId: string | undefined,
    context: RequestContextInput,
  ): Promise<{ changed: true; revokedSessions: number }> {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);

    const valid = await this.usersService.verifyPassword(user, currentPassword);
    if (!valid) {
      await this.auditService.recordSafe({
        action: AuditAction.USER_PASSWORD_CHANGED,
        status: AuditStatus.FAILURE,
        resourceType: 'user',
        resourceId: userId,
        errorCode: ErrorCode.AUTH_PASSWORD_MISMATCH,
        metadata: { reason: 'current_password_incorrect' },
      });

      throw new UnauthorizedError(ErrorCode.AUTH_PASSWORD_MISMATCH);
    }

    if (currentPassword === newPassword) {
      throw new BadRequestError(ErrorCode.AUTH_PASSWORD_REUSED);
    }
    await this.breachedPasswords.assertAcceptable(newPassword, { userId, purpose: 'change' });

    const revoked = await this.dataSource.transaction(async (manager) => {
      await this.usersService.setPassword(userId, newPassword, manager);

      // Every session except the one making the change. Signing the user out of
      // the device they are currently using would be hostile; signing out every
      // *other* device is the point.
      return this.sessionService.revokeAllForUser(
        userId,
        SessionRevocationReason.PASSWORD_CHANGED,
        currentFamilyId,
        manager,
      );
    });

    await this.auditService.recordSafe({
      action: AuditAction.USER_PASSWORD_CHANGED,
      resourceType: 'user',
      resourceId: userId,
      actor: { type: ActorType.USER, id: userId, label: maskEmail(user.emailNormalized) },
      metadata: { revokedSessions: revoked, changeIp: context.ip },
    });

    await this.mailService.sendPasswordChangedNotice(
      user.email,
      user.preferredName,
      context.ip,
    );

    return { changed: true, revokedSessions: revoked };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async listSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<
    Array<{
      id: string;
      deviceLabel: string | null;
      ipAddress: string | null;
      createdAt: Date;
      lastUsedAt: Date | null;
      expiresAt: Date;
      isCurrent: boolean;
    }>
  > {
    const sessions = await this.sessionService.listActiveDevices(userId);

    return sessions.map((session: Session) => ({
      id: session.id,
      deviceLabel: session.deviceLabel,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      isCurrent: session.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<{ revoked: number }> {
    const session = await this.sessionService.findOwnedById(sessionId, userId);

    // Scoped to the owner, so a session id belonging to someone else reads as
    // "not found" rather than being revocable.
    if (!session) throw new NotFoundError(ErrorCode.AUTH_SESSION_NOT_FOUND);

    const revoked = await this.sessionService.revokeFamily(
      session.familyId,
      SessionRevocationReason.ADMIN_REVOKED,
    );

    await this.auditService.recordSafe({
      action: AuditAction.USER_SESSION_REVOKED,
      resourceType: 'session',
      resourceId: sessionId,
      actor: { type: ActorType.USER, id: userId },
      metadata: { familyId: session.familyId, revokedSessions: revoked },
    });

    return { revoked };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async recordFailedLogin(
    email: string,
    context: RequestContextInput,
    reason: string,
    userId?: string,
  ): Promise<void> {
    await this.auditService.recordSafe({
      action: AuditAction.USER_LOGIN_FAILED,
      status: AuditStatus.FAILURE,
      resourceType: 'user',
      resourceId: userId,
      actor: {
        type: ActorType.USER,
        id: userId ?? null,
        // The attempted address is recorded masked. An unmasked audit log full of
        // attempted addresses is itself a harvestable list.
        label: maskEmail(email),
      },
      metadata: { reason, sourceIp: context.ip, userAgent: context.userAgent },
    });
  }

  private toProfile(user: User): AuthResult['user'] {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      displayName: user.preferredName,
      emailVerified: user.isEmailVerified,
      isPlatformAdmin: user.isPlatformAdmin,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
    };
  }
}
