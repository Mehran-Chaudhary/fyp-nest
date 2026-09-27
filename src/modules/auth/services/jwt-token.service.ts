import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import {
  CacheKeys,
  CACHE_TTL_SECONDS,
} from '../../../common/constants/cache-keys.constants';
import {
  SECURITY_EVENT,
  type AccessChangedEvent,
} from '../../../common/constants/security-events';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { UnauthorizedError } from '../../../common/exceptions/app.exception';
import {
  TokenType,
  type AccessTokenClaims,
  type AuthenticationMethod,
  type RefreshTokenClaims,
  type TokenPair,
} from '../../../common/interfaces/jwt-payload.interface';
import { JWT_CONFIG_KEY, type JwtConfig } from '../../../config/jwt.config';
import { RedisService } from '../../../shared/redis/redis.service';

export interface AccessTokenSubject {
  id: string;
  emailNormalized: string;
  isPlatformAdmin: boolean;
}

/**
 * Signing and verification of the platform's JWTs.
 *
 * ## Why two secrets
 *
 * Access and refresh tokens are signed with different keys. If they shared one,
 * a stolen refresh token could be presented as an access token — it would verify
 * — and the entire rotation-and-reuse-detection design would be bypassed. The
 * `type` claim is also checked on every decode as a second, independent barrier,
 * so a key-management mistake alone is not sufficient to break the separation.
 *
 * ## Revocation
 *
 * JWTs are self-contained, so a plain bearer check cannot revoke one before it
 * expires. That is unacceptable for a platform whose core promise is strict
 * access control: a member removed from a workspace must lose access *now*, not
 * in up to fifteen minutes. Two Redis-backed mechanisms close the gap:
 *
 *  - **Per-token denylist** (`jti`), for signing out a single session. Each
 *    entry expires exactly when the token would have, so the denylist stays
 *    bounded by the access token lifetime no matter how much traffic passes
 *    through it.
 *  - **Per-user epoch**, a timestamp before which every token for that user is
 *    invalid. One key invalidates every outstanding token at once, which is what
 *    "sign out everywhere", "password changed" and "account suspended" need.
 *
 * Both are checked on every authenticated request. That is one Redis round trip
 * per request — deliberate, and the reason `maxRetriesPerRequest` is low: the
 * cost is bounded and the alternative is a window in which a revoked credential
 * still works.
 */
@Injectable()
export class JwtTokenService {
  private readonly logger = new Logger(JwtTokenService.name);
  private readonly config: JwtConfig;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
    @Optional() private readonly events?: EventEmitter2,
  ) {
    this.config = this.configService.getOrThrow<JwtConfig>(JWT_CONFIG_KEY);
  }

  // ── Issuance ──────────────────────────────────────────────────────────────

  /**
   * Mints an access/refresh pair for a freshly authenticated session.
   *
   * `sessionId` and `familyId` are supplied by the caller rather than generated
   * here, because the corresponding `sessions` row must be written in the same
   * transaction as the sign-in; generating ids here would mean issuing a token
   * whose session row might fail to persist.
   */
  async issueTokenPair(
    user: AccessTokenSubject,
    sessionId: string,
    familyId: string,
    organizationId?: string,
    amr: AuthenticationMethod[] = ['pwd'],
  ): Promise<TokenPair> {
    const now = Math.floor(Date.now() / 1000);

    const accessToken = await this.signAccessToken(user, sessionId, organizationId, amr);
    const refreshToken = await this.signRefreshToken(user.id, sessionId, familyId);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.accessTtlSeconds,
      expiresAt: new Date((now + this.config.accessTtlSeconds) * 1000).toISOString(),
      refreshExpiresIn: this.config.refreshTtlSeconds,
    };
  }

  async signAccessToken(
    user: AccessTokenSubject,
    sessionId: string,
    organizationId?: string,
    amr: AuthenticationMethod[] = ['pwd'],
  ): Promise<string> {
    const claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'> = {
      sub: user.id,
      type: TokenType.ACCESS,
      jti: randomUUID(),
      email: user.emailNormalized,
      isPlatformAdmin: user.isPlatformAdmin,
      sid: sessionId,
      amr,
      ...(organizationId ? { org: organizationId } : {}),
    };

    return this.jwtService.signAsync(claims, {
      secret: this.config.accessSecret,
      expiresIn: this.config.accessTtlSeconds,
      issuer: this.config.issuer,
      audience: this.config.audience,
      algorithm: this.config.algorithm,
    });
  }

  async signRefreshToken(
    userId: string,
    sessionId: string,
    familyId: string,
  ): Promise<string> {
    const claims: Omit<RefreshTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'> = {
      sub: userId,
      type: TokenType.REFRESH,
      jti: randomUUID(),
      sid: sessionId,
      fam: familyId,
    };

    return this.jwtService.signAsync(claims, {
      secret: this.config.refreshSecret,
      expiresIn: this.config.refreshTtlSeconds,
      issuer: this.config.issuer,
      audience: this.config.audience,
      algorithm: this.config.algorithm,
    });
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Verifies an access token's signature, claims and revocation state.
   *
   * Throws {@link UnauthorizedError} with a specific error code for each failure
   * mode, so the frontend can distinguish "refresh and retry" (expired) from
   * "sign in again" (revoked) from "something is wrong" (invalid).
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const claims = await this.verify<AccessTokenClaims>(token, this.config.accessSecret);

    // Read through a widened type: the token is attacker-supplied, so its
    // `type` claim really can be any value, even though `AccessTokenClaims`
    // narrows it to one.
    const presentedType = (claims as { type: TokenType }).type;

    if (presentedType !== TokenType.ACCESS) {
      // A refresh token presented as an access token. Worth noticing.
      this.logger.warn(
        `Token of type "${presentedType}" presented on the access path (sub=${claims.sub}).`,
      );
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_INVALID);
    }

    if (await this.isTokenRevoked(claims)) {
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_REVOKED);
    }

    return claims;
  }

  /**
   * Verifies a refresh token's signature and claims.
   *
   * Deliberately does *not* consult the denylist. Whether a refresh token is
   * still live is determined by its `sessions` row, which is also where reuse is
   * detected — a revoked row must reach the reuse-detection path rather than
   * being rejected early as "revoked", or the compromise would go unnoticed.
   */
  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    const claims = await this.verify<RefreshTokenClaims>(token, this.config.refreshSecret);

    if (claims.type !== TokenType.REFRESH) {
      throw new UnauthorizedError(ErrorCode.AUTH_REFRESH_TOKEN_INVALID);
    }

    return claims;
  }

  private async verify<T extends object>(token: string, secret: string): Promise<T> {
    try {
      return await this.jwtService.verifyAsync<T>(token, {
        secret,
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: [this.config.algorithm],
        clockTolerance: this.config.clockToleranceSeconds,
      });
    } catch (error) {
      const name = (error as Error).name;

      if (name === 'TokenExpiredError') {
        throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_EXPIRED);
      }
      if (name === 'NotBeforeError') {
        throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_INVALID);
      }
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_INVALID);
    }
  }

  // ── Revocation ────────────────────────────────────────────────────────────

  /**
   * Revokes a single access token.
   *
   * The denylist entry is given a TTL equal to the token's own remaining life,
   * so it disappears the moment it stops mattering.
   */
  async revokeAccessToken(claims: AccessTokenClaims): Promise<void> {
    const remainingSeconds = (claims.exp ?? 0) - Math.floor(Date.now() / 1000);
    if (remainingSeconds <= 0) return;

    await this.redis.set(CacheKeys.revokedAccessToken(claims.jti), '1', remainingSeconds);
  }

  /**
   * Invalidates every token issued to a user before now.
   *
   * Used for "sign out everywhere", password change and account suspension.
   * A one-second forward offset covers the case where a token is minted in the
   * same second the epoch is written — without it, a token issued during a
   * password change could survive it.
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    const epoch = Math.floor(Date.now() / 1000) + 1;
    await this.redis.set(
      CacheKeys.userTokenEpoch(userId),
      String(epoch),
      CACHE_TTL_SECONDS.USER_TOKEN_EPOCH,
    );
    // Long-lived connections authenticated with those tokens close now.
    this.events?.emit(SECURITY_EVENT.ACCESS_CHANGED, {
      userId,
    } satisfies AccessChangedEvent);
  }

  /** Clears a user's epoch. Only used when reactivating a suspended account. */
  async clearUserTokenEpoch(userId: string): Promise<void> {
    await this.redis.del(CacheKeys.userTokenEpoch(userId));
  }

  /**
   * True when a token has been revoked individually or by a user-wide epoch.
   *
   * On a Redis failure this returns `false` — fail *open*. That is a considered
   * trade-off: Redis holds only the revocation overlay, while the authoritative
   * checks (account status, membership status, and `tokensValidFrom` in
   * PostgreSQL) still run on every request. Failing closed would mean a Redis
   * outage signs out every user on the platform, turning a cache incident into a
   * total outage. The durable `users.tokens_valid_from` column, checked by the
   * authentication guard, is what bounds the exposure.
   */
  private async isTokenRevoked(claims: AccessTokenClaims): Promise<boolean> {
    try {
      const [denied, epochRaw] = await Promise.all([
        this.redis.exists(CacheKeys.revokedAccessToken(claims.jti)),
        this.redis.get(CacheKeys.userTokenEpoch(claims.sub)),
      ]);

      if (denied) return true;

      if (epochRaw) {
        const epoch = Number(epochRaw);
        if (Number.isFinite(epoch) && (claims.iat ?? 0) < epoch) return true;
      }

      return false;
    } catch (error) {
      this.logger.warn(
        `Revocation check unavailable (${(error as Error).message}); ` +
          'falling back to database-backed checks for this request.',
      );
      return false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Decodes without verifying.
   *
   * Only for logging and diagnostics. Never use the result for an authorization
   * decision — the payload is attacker-controlled until the signature is checked.
   */
  decodeUnsafe<T extends object>(token: string): T | null {
    try {
      return this.jwtService.decode(token);
    } catch {
      return null;
    }
  }

  get accessTokenTtlSeconds(): number {
    return this.config.accessTtlSeconds;
  }

  get refreshTokenTtlMs(): number {
    return this.config.refreshTtlMs;
  }
}
