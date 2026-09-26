import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingHttpHeaders } from 'node:http';
import { CacheKeys } from '../../common/constants/cache-keys.constants';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { normaliseIp } from '../../common/utils/ip.util';
import { REALTIME_CONFIG_KEY, type RealtimeConfig } from '../../config/realtime.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { RedisService } from '../../shared/redis/redis.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { AuditService } from '../audit/audit.service';
import { JwtTokenService } from '../auth/services/jwt-token.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';

/** Who a socket is, and in which workspace — established at handshake, re-checked after. */
export interface SocketSession {
  kind: 'user' | 'api_key';
  organizationId: string;
  userId?: string;
  apiKeyId?: string;
  isPlatformAdmin?: boolean;
  permissions: string[];
  /**
   * The presented credential, kept in memory only, so the socket can be
   * re-checked — revocation, expiry, membership — for as long as it lives.
   */
  credential: string;
  /** When the credential stops being valid (epoch ms); null when it does not expire. */
  expiresAt: number | null;
  ip: string;
  connectedAt: number;
  label: string;
}

/** What Socket.IO gives the middleware about a connection attempt. */
export interface HandshakeLike {
  auth: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  query: Record<string, unknown>;
  address: string;
}

/**
 * Authentication and workspace scoping for WebSocket connections (proposal
 * module 6.16).
 *
 * A socket is authenticated once, at the handshake, with the same machinery
 * as an HTTP request: the phase 1 access token (signature, type, revocation
 * denylist, per-user epoch, and the durable `tokens_valid_from`) or an API
 * key; then the workspace, the membership and its permissions, and the
 * workspace's IP allowlist.
 *
 * Then it is re-checked — because a socket can outlive the access it was
 * opened with. Every `REALTIME_REVALIDATE_INTERVAL`, and immediately whenever
 * access changes (a member removed, roles edited, every session revoked, a key
 * revoked), the same checks run again; a socket that fails them is told why
 * and closed. At the access token's expiry the socket closes unless the
 * client has sent a fresh token.
 *
 * Credentials are accepted only in the handshake's `auth` payload, never in the
 * URL, where proxies and servers log them.
 */
@Injectable()
export class RealtimeAuthService {
  private readonly logger = new Logger(RealtimeAuthService.name);
  private readonly config: RealtimeConfig;
  private readonly security: SecurityConfig;

  constructor(
    private readonly jwtTokens: JwtTokenService,
    private readonly users: UsersService,
    private readonly apiKeys: ApiKeysService,
    private readonly organizations: OrganizationsService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<RealtimeConfig>(REALTIME_CONFIG_KEY);
    this.security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Whether a browser origin may open a socket (CSWSH defence, independent of auth). */
  isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true; // not a browser: authenticates by token like any client
    if (this.security.cors.allowAnyOrigin) return true;
    return this.security.cors.origins.includes(origin.replace(/\/+$/, ''));
  }

  clientIp(handshake: HandshakeLike): string {
    const remote = normaliseIp(handshake.address);
    const trust = this.security.trustProxy;
    const forwarded = handshake.headers['x-forwarded-for'];
    const chain = [
      ...(Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      remote,
    ];
    if (trust === true) return normaliseIp(chain[0]);
    if (typeof trust === 'number' && trust > 0) {
      return normaliseIp(chain[Math.max(0, chain.length - 1 - trust)]);
    }
    return remote;
  }

  async authenticate(handshake: HandshakeLike): Promise<SocketSession> {
    if (!this.config.enabled) {
      throw new AppException(ErrorCode.REALTIME_DISABLED, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const ip = this.clientIp(handshake);
    if (!this.isOriginAllowed(handshake.headers.origin)) {
      throw new AppException(ErrorCode.REALTIME_ORIGIN_NOT_ALLOWED, HttpStatus.FORBIDDEN);
    }
    await this.throttleHandshake(ip);

    if (handshake.query.token !== undefined || handshake.query.apiKey !== undefined) {
      throw new AppException(ErrorCode.AUTH_SCHEME_NOT_ALLOWED, HttpStatus.UNAUTHORIZED, {
        message: 'Send credentials in the handshake auth payload, never in the URL.',
      });
    }

    const token =
      typeof handshake.auth.token === 'string'
        ? handshake.auth.token.replace(/^Bearer\s+/i, '').trim()
        : '';
    const apiKey =
      typeof handshake.auth.apiKey === 'string' ? handshake.auth.apiKey.trim() : '';
    let session: SocketSession;

    try {
      if (token) {
        const organization =
          typeof handshake.auth.organizationId === 'string'
            ? handshake.auth.organizationId.trim()
            : '';
        if (!organization) {
          throw new AppException(
            ErrorCode.ORGANIZATION_CONTEXT_REQUIRED,
            HttpStatus.BAD_REQUEST,
            {
              message: 'Pass the workspace as auth.organizationId (a UUID or a slug).',
            },
          );
        }
        session = await this.userSession(token, organization, ip);
      } else if (apiKey) {
        session = await this.apiKeySession(apiKey, ip);
      } else {
        throw new AppException(ErrorCode.AUTH_TOKEN_MISSING, HttpStatus.UNAUTHORIZED);
      }
    } catch (error) {
      await this.recordRejection(error, ip);
      throw error;
    }

    await this.claimConnection(session);
    return session;
  }

  /** The same checks again, with the credential held in memory. Throws when access is gone. */
  async revalidate(session: SocketSession): Promise<SocketSession> {
    if (session.expiresAt !== null && session.expiresAt <= Date.now()) {
      throw new AppException(ErrorCode.AUTH_TOKEN_EXPIRED, HttpStatus.UNAUTHORIZED);
    }
    const fresh =
      session.kind === 'user'
        ? await this.userSession(session.credential, session.organizationId, session.ip)
        : await this.apiKeySession(session.credential, session.ip);
    return { ...fresh, connectedAt: session.connectedAt };
  }

  /** A client's new access token, for the same user and workspace. */
  async refresh(session: SocketSession, token: string): Promise<SocketSession> {
    if (session.kind !== 'user') {
      throw new AppException(ErrorCode.AUTH_SCHEME_NOT_ALLOWED, HttpStatus.UNAUTHORIZED);
    }
    const fresh = await this.userSession(
      token.replace(/^Bearer\s+/i, '').trim(),
      session.organizationId,
      session.ip,
    );
    if (fresh.userId !== session.userId) {
      throw new AppException(ErrorCode.AUTH_TOKEN_INVALID, HttpStatus.UNAUTHORIZED, {
        message: 'A socket cannot change who it belongs to.',
      });
    }
    return { ...fresh, connectedAt: session.connectedAt };
  }

  async releaseConnection(session: SocketSession): Promise<void> {
    try {
      await this.redis.redis.decr(CacheKeys.realtimeConnections(this.subject(session)));
    } catch {
      // The counter expires on its own.
    }
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  private async userSession(
    token: string,
    organization: string,
    ip: string,
  ): Promise<SocketSession> {
    const claims = await this.jwtTokens.verifyAccessToken(token);
    const user = await this.users.getAuthProjection(claims.sub, claims.sid, claims.jti);
    if (!user) {
      throw new AppException(ErrorCode.ACCOUNT_SUSPENDED, HttpStatus.UNAUTHORIZED);
    }
    // The durable revocation cut-off, independent of Redis — as for every HTTP request.
    const validFrom = await this.users.getTokensValidFrom(claims.sub);
    if (validFrom && (claims.iat ?? 0) * 1000 < validFrom.getTime()) {
      throw new AppException(ErrorCode.AUTH_TOKEN_REVOKED, HttpStatus.UNAUTHORIZED);
    }

    const context = await this.organizations.resolveAccessContext(organization, user.id, {
      isPlatformAdmin: user.isPlatformAdmin,
    });
    await this.assertIp(context.organization.id, ip);

    return {
      kind: 'user',
      organizationId: context.organization.id,
      userId: user.id,
      isPlatformAdmin: user.isPlatformAdmin,
      permissions: context.permissions,
      credential: token,
      expiresAt: claims.exp ? claims.exp * 1000 : null,
      ip,
      connectedAt: Date.now(),
      label: user.displayName || user.email,
    };
  }

  private async apiKeySession(presented: string, ip: string): Promise<SocketSession> {
    const key = await this.apiKeys.authenticate(presented, ip);
    const organization = await this.organizations.findById(key.organizationId);
    if (!organization?.isActive) {
      throw new AppException(ErrorCode.ORGANIZATION_SUSPENDED, HttpStatus.FORBIDDEN);
    }
    await this.assertIp(organization.id, ip);
    return {
      kind: 'api_key',
      organizationId: organization.id,
      apiKeyId: key.id,
      permissions: key.scopes,
      credential: presented,
      expiresAt: null,
      ip,
      connectedAt: Date.now(),
      label: `${key.name} (${key.prefix})`,
    };
  }

  private async assertIp(organizationId: string, ip: string): Promise<void> {
    if (await this.organizations.isIpPermitted(organizationId, ip)) return;
    await this.organizations.recordIpRejection(organizationId, ip);
    throw new AppException(ErrorCode.IP_NOT_ALLOWED, HttpStatus.FORBIDDEN);
  }

  // ── Limits ────────────────────────────────────────────────────────────────

  private async throttleHandshake(ip: string): Promise<void> {
    try {
      const { value, ttl } = await this.redis.increment(
        CacheKeys.realtimeHandshakes(ip),
        60,
      );
      if (value > this.config.maxHandshakesPerMinute) {
        throw new AppException(
          ErrorCode.RATE_LIMIT_EXCEEDED,
          HttpStatus.TOO_MANY_REQUESTS,
          {
            retryAfterSeconds: Math.max(ttl, 1),
          },
        );
      }
    } catch (error) {
      if (error instanceof AppException) throw error;
      // Redis unavailable: the per-request checks still apply; the limiter fails open.
    }
  }

  private subject(session: Pick<SocketSession, 'kind' | 'userId' | 'apiKeyId'>): string {
    return session.kind === 'user' ? `user:${session.userId}` : `key:${session.apiKeyId}`;
  }

  private async claimConnection(session: SocketSession): Promise<void> {
    const key = CacheKeys.realtimeConnections(this.subject(session));
    try {
      const { value } = await this.redis.increment(key, 3_600);
      await this.redis.expire(key, 3_600);
      if (value > this.config.maxConnectionsPerUser) {
        await this.redis.redis.decr(key);
        throw new AppException(
          ErrorCode.REALTIME_CONNECTION_LIMIT,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof AppException) throw error;
    }
  }

  private async recordRejection(error: unknown, ip: string): Promise<void> {
    const code = error instanceof AppException ? error.code : ErrorCode.AUTH_TOKEN_INVALID;
    this.logger.debug(`Rejected a real-time connection from ${ip}: ${code}.`);
    await this.auditService.recordSafe({
      action: AuditAction.REALTIME_CONNECTION_REJECTED,
      status: AuditStatus.DENIED,
      organizationId: null,
      resourceType: 'realtime',
      errorCode: code,
      actor: { type: ActorType.SYSTEM, label: 'real-time handshake' },
      context: { ipAddress: ip },
      metadata: { code },
    });
  }
}
