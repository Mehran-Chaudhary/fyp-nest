/**
 * JWT payload contracts.
 *
 * Access and refresh tokens are deliberately different shapes signed with
 * different secrets. Reusing one secret for both is a common mistake that lets a
 * stolen refresh token be replayed as an access token, so the two are kept
 * structurally and cryptographically distinct, and the `type` claim is verified
 * on every decode as defence in depth.
 */

export enum TokenType {
  ACCESS = 'access',
  REFRESH = 'refresh',
}

/** Claims shared by every token the platform issues. */
export interface BaseJwtClaims {
  /** Subject — the user id. */
  sub: string;
  /** Token type discriminator, validated on decode. */
  type: TokenType;
  /** Unique token id. Enables targeted revocation via the Redis denylist. */
  jti: string;
  /** Issued-at, seconds since epoch (set by the signer). */
  iat?: number;
  /** Expiry, seconds since epoch (set by the signer). */
  exp?: number;
  iss?: string;
  aud?: string;
}

/**
 * Access token claims.
 *
 * Note what is *not* here: permissions. Embedding a permission set in the token
 * would make revocation take up to a full token lifetime to apply, which defeats
 * the "strict RBAC" requirement. Permissions are resolved per request from the
 * database with a short-lived Redis cache instead.
 */
export interface AccessTokenClaims extends BaseJwtClaims {
  type: TokenType.ACCESS;
  /** Normalised email, carried for logging and support tooling. */
  email: string;
  /** True when the user holds platform-administrator status. */
  isPlatformAdmin: boolean;
  /**
   * The workspace the token was minted for, when the client selected one at
   * sign-in. Advisory only: the organization context guard always re-verifies
   * membership against the database.
   */
  org?: string;
  /** Session (refresh token family) this access token belongs to. */
  sid: string;
  /**
   * Authentication methods the session was established with (RFC 8176):
   * `pwd` always, `otp` when a TOTP code was verified, `rec` when a recovery
   * code was. Phase 5 policies that require a second factor read this.
   */
  amr?: AuthenticationMethod[];
}

/**
 * RFC 8176 authentication method references this platform issues: `pwd` for
 * the password, `otp` for a TOTP code, `rec` for a recovery code, and `mfa`
 * whenever more than one factor was used — which is all a refreshed token can
 * say, since rotation carries the assurance but not the method.
 */
export type AuthenticationMethod = 'pwd' | 'otp' | 'rec' | 'mfa';

/** Whether a token's methods include a second factor. */
export function hasSecondFactor(amr: readonly string[] | undefined): boolean {
  return !!amr && (amr.includes('mfa') || amr.includes('otp') || amr.includes('rec'));
}

export interface RefreshTokenClaims extends BaseJwtClaims {
  type: TokenType.REFRESH;
  /** Session id. Refresh rotation replaces the token but keeps the family. */
  sid: string;
  /** Family id, shared by every token descended from one sign-in. */
  fam: string;
}

export type JwtClaims = AccessTokenClaims | RefreshTokenClaims;

/** The token pair handed to a client after sign-in or refresh. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
  /** Absolute access token expiry, convenient for clients that pre-emptively refresh. */
  expiresAt: string;
  /** Refresh token lifetime in seconds. */
  refreshExpiresIn: number;
}
