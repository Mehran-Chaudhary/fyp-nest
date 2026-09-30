import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { BEARER_PREFIX, HEADER, METADATA_KEY } from '../constants/app.constants';
import { ActorType, AuthType } from '../enums/auth-type.enum';
import { ErrorCode } from '../enums/error-code.enum';
import { ForbiddenError, UnauthorizedError } from '../exceptions/app.exception';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { hasSecondFactor, issuedAtMs } from '../interfaces/jwt-payload.interface';
import { normaliseIp } from '../utils/ip.util';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { RequestContextService } from '../../shared/context/request-context.service';
import { ApiKeysService } from '../../modules/api-keys/api-keys.service';
import { JwtTokenService } from '../../modules/auth/services/jwt-token.service';
import { UsersService } from '../../modules/users/users.service';

/**
 * Establishes *who* is making the request.
 *
 * Registered globally and **fails closed**: a route with no `@Auth()` or
 * `@Public()` metadata requires a Bearer token. That default is the single most
 * important decision in this file. The recurring failure in guard-based systems
 * is not a broken check — it is a new endpoint nobody remembered to protect.
 * With a fail-closed default, forgetting produces an obvious 401 the first time
 * the endpoint is called, rather than a silent hole discovered later.
 *
 * Runs first among the global guards. The organization-context and permissions
 * guards both depend on the principal this one resolves.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(AuthenticationGuard.name);
  private readonly security: SecurityConfig;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtTokenService: JwtTokenService,
    private readonly usersService: UsersService,
    private readonly apiKeysService: ApiKeysService,
    private readonly requestContext: RequestContextService,
    private readonly configService: ConfigService,
  ) {
    this.security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  onModuleInit(): void {
    this.logger.log('Global authentication guard active (default: Bearer required).');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only HTTP is guarded here. WebSocket authentication arrives with the
    // real-time engine in phase 4 and needs its own handshake-time check.
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const allowedTypes = this.reflector.getAllAndOverride<AuthType[]>(
      METADATA_KEY.AUTH_TYPE,
      [context.getHandler(), context.getClass()],
    ) ?? [AuthType.Bearer];

    if (allowedTypes.includes(AuthType.None)) {
      return true;
    }

    const bearerToken = this.extractBearerToken(request);
    const apiKey = this.extractApiKey(request);

    if (!bearerToken && !apiKey) {
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_MISSING);
    }

    // A caller presenting a credential the route does not accept gets a specific
    // code, so an integration pointed at the wrong endpoint fails legibly rather
    // than looking like a bad key.
    if (bearerToken && !allowedTypes.includes(AuthType.Bearer)) {
      throw new UnauthorizedError(ErrorCode.AUTH_SCHEME_NOT_ALLOWED, {
        message: 'This endpoint does not accept user access tokens.',
      });
    }
    if (apiKey && !allowedTypes.includes(AuthType.ApiKey)) {
      throw new UnauthorizedError(ErrorCode.AUTH_SCHEME_NOT_ALLOWED, {
        message: 'This endpoint does not accept API keys.',
      });
    }

    // A Bearer token wins when both are presented. Ambiguity in authentication
    // is never resolved silently in the caller's favour.
    if (bearerToken) {
      await this.authenticateWithBearer(request, bearerToken);
    } else if (apiKey) {
      await this.authenticateWithApiKey(request, apiKey);
    }

    this.assertEmailVerifiedIfRequired(context, request);

    return true;
  }

  // ── Bearer ────────────────────────────────────────────────────────────────

  private async authenticateWithBearer(
    request: AuthenticatedRequest,
    token: string,
  ): Promise<void> {
    const claims = await this.jwtTokenService.verifyAccessToken(token);

    const user = await this.usersService.getAuthProjection(
      claims.sub,
      claims.sid,
      claims.jti,
    );

    if (!user) {
      // The token verified, but the account is gone, suspended or locked. Not a
      // token problem — an account-state problem — so it is reported as such.
      throw new UnauthorizedError(ErrorCode.ACCOUNT_SUSPENDED, {
        message: 'This account is no longer able to sign in.',
      });
    }

    // Durable revocation check, independent of Redis.
    //
    // `JwtTokenService` consults a Redis denylist and a Redis-held epoch, and
    // fails *open* when Redis is unavailable so a cache outage cannot sign
    // everyone out. This check is the reason that fail-open is acceptable: the
    // authoritative cut-off also lives in PostgreSQL, and is enforced here on
    // every request regardless of Redis' health.
    const validFrom = await this.usersService.getTokensValidFrom(claims.sub);
    if (validFrom && issuedAtMs(claims) < validFrom.getTime()) {
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_REVOKED, {
        message: 'This session ended when the account password or status changed.',
      });
    }

    // The assurance of this session: whether its sign-in passed a second
    // factor. From the verified token, so it cannot be claimed by a client.
    const authenticated = { ...user, mfaVerified: hasSecondFactor(claims.amr) };

    request.user = authenticated;
    request.authType = AuthType.Bearer;
    request.principal = {
      actorType: ActorType.USER,
      actorId: authenticated.id,
      actorLabel: authenticated.displayName || authenticated.email,
      authType: AuthType.Bearer,
      user: authenticated,
    };

    this.requestContext.patch({
      user: authenticated,
      actorType: ActorType.USER,
      actorId: authenticated.id,
      actorLabel: authenticated.displayName || authenticated.email,
      mfaVerified: authenticated.mfaVerified,
    });
  }

  // ── API key ───────────────────────────────────────────────────────────────

  private async authenticateWithApiKey(
    request: AuthenticatedRequest,
    presentedKey: string,
  ): Promise<void> {
    const apiKey = await this.apiKeysService.authenticate(
      presentedKey,
      normaliseIp(request.ip),
    );

    request.apiKey = apiKey;
    request.authType = AuthType.ApiKey;
    request.principal = {
      actorType: ActorType.API_KEY,
      actorId: apiKey.id,
      // Labelled with the key, not its creator: a compromised key's activity
      // must be distinguishable from its owner's in the audit log.
      actorLabel: `${apiKey.name} (${apiKey.prefix})`,
      authType: AuthType.ApiKey,
      apiKey,
    };

    this.requestContext.patch({
      apiKey,
      actorType: ActorType.API_KEY,
      actorId: apiKey.id,
      actorLabel: `${apiKey.name} (${apiKey.prefix})`,
    });
  }

  // ── Extraction ────────────────────────────────────────────────────────────

  private extractBearerToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (!header) return null;

    const [scheme, ...rest] = header.split(' ');
    if (scheme?.toLowerCase() !== BEARER_PREFIX.toLowerCase()) return null;

    const token = rest.join(' ').trim();
    return token.length > 0 ? token : null;
  }

  private extractApiKey(request: AuthenticatedRequest): string | null {
    const header = request.headers[HEADER.API_KEY];
    const value = Array.isArray(header) ? header[0] : header;

    return value && value.trim().length > 0 ? value.trim() : null;
  }

  /**
   * Enforces email verification where the route or global policy requires it.
   *
   * API keys are exempt: a machine identity has no mailbox, and the human who
   * issued it was already verified at issue time if policy demanded it.
   */
  private assertEmailVerifiedIfRequired(
    context: ExecutionContext,
    request: AuthenticatedRequest,
  ): void {
    if (!request.user) return;
    if (request.user.emailVerified) return;

    const routeRequires = this.reflector.getAllAndOverride<boolean>(
      METADATA_KEY.REQUIRE_VERIFIED_EMAIL,
      [context.getHandler(), context.getClass()],
    );

    if (routeRequires || this.security.tokens.requireEmailVerification) {
      throw new ForbiddenError(ErrorCode.ACCOUNT_EMAIL_NOT_VERIFIED);
    }
  }
}
