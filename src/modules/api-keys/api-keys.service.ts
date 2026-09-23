import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CacheKeys, CACHE_TTL_SECONDS } from '../../common/constants/cache-keys.constants';
import { API_KEY_SCOPES } from '../../common/constants/permissions.constants';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../common/exceptions/app.exception';
import type { AuthenticatedApiKey } from '../../common/interfaces/authenticated-request.interface';
import { isIpAllowed, isValidCidr } from '../../common/utils/ip.util';
import { hasPermission, missingPermissions } from '../../common/utils/permission.util';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { TokenService } from '../../shared/crypto/token.service';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { ApiKey } from './entities/api-key.entity';

export interface CreateApiKeyInput {
  organizationId: string;
  createdById: string;
  name: string;
  description?: string;
  scopes: string[];
  expiresAt?: Date;
  allowedIps?: string[];
}

export interface CreatedApiKey {
  record: ApiKey;
  /** Returned exactly once. The platform never sees it again. */
  plaintextKey: string;
}

/**
 * Workspace-scoped machine credentials.
 *
 * These are how the Python AI service — and any future automation — authenticates
 * to this API on behalf of a workspace, satisfying the proposal's requirement for
 * "Zero-Trust authorization" on internal service-to-service traffic rather than a
 * shared static secret.
 *
 * The properties that make this zero-trust rather than a long-lived password are
 * documented on {@link ApiKey}. This service is where two of them are enforced:
 * a key's scopes are intersected with its creator's permissions at issue time,
 * and its optional IP pin is checked on every authentication.
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);
  private readonly security: SecurityConfig;

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly tokenService: TokenService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {
    this.security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  // ── Issuance ──────────────────────────────────────────────────────────────

  /**
   * Issues a key.
   *
   * `creatorPermissions` is the issuing member's effective permission set, and
   * the requested scopes are checked against it. Without that check, a member
   * with `apikey:create` could mint a key carrying permissions they do not hold
   * and then use it to escalate — the key becomes a laundering mechanism for
   * authority its creator never had.
   */
  async create(
    input: CreateApiKeyInput,
    creatorPermissions: readonly string[],
  ): Promise<CreatedApiKey> {
    const scopes = [...new Set(input.scopes)];

    const unsupported = scopes.filter((scope) => !API_KEY_SCOPES.includes(scope));
    if (unsupported.length > 0) {
      throw new BadRequestError(ErrorCode.BAD_REQUEST, {
        message: `These scopes cannot be granted to an API key: ${unsupported.join(', ')}.`,
        details: { unsupportedScopes: unsupported, supportedScopes: API_KEY_SCOPES },
      });
    }

    if (!hasPermission(creatorPermissions, '*:*')) {
      const missing = missingPermissions(creatorPermissions, scopes);
      if (missing.length > 0) {
        throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
          message:
            'An API key cannot be granted scopes beyond your own permissions. ' +
            `You lack: ${missing.join(', ')}.`,
          details: { deniedScopes: missing },
        });
      }
    }

    const allowedIps = (input.allowedIps ?? []).map((entry) => entry.trim()).filter(Boolean);
    const invalidIps = allowedIps.filter((entry) => !isValidCidr(entry));
    if (invalidIps.length > 0) {
      throw new BadRequestError(ErrorCode.BAD_REQUEST, {
        message: `Invalid IP range(s): ${invalidIps.join(', ')}.`,
      });
    }

    const generated = this.tokenService.generateApiKey();

    const record = await this.apiKeyRepository.save(
      this.apiKeyRepository.create({
        organizationId: input.organizationId,
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        prefix: generated.prefix,
        keyHash: generated.hash,
        scopes,
        createdById: input.createdById,
        expiresAt:
          input.expiresAt ?? new Date(Date.now() + this.security.apiKeys.defaultTtlMs),
        allowedIps,
        usageCount: '0',
      }),
    );

    await this.auditService.recordSafe({
      action: AuditAction.API_KEY_CREATED,
      organizationId: input.organizationId,
      resourceType: 'api_key',
      resourceId: record.id,
      resourceLabel: record.name,
      metadata: {
        prefix: record.prefix,
        scopes,
        expiresAt: record.expiresAt?.toISOString(),
        ipPinned: allowedIps.length > 0,
      },
    });

    return { record, plaintextKey: generated.token };
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Resolves a presented key into a principal, or throws.
   *
   * Lookup is by the key's public prefix, which is uniquely indexed, then the
   * full value is verified with a constant-time digest comparison. Looking up by
   * prefix keeps this O(1) — hashing the presented key against every stored row
   * would make the key table a scaling bottleneck on the busiest code path in
   * the system.
   *
   * A brief cache sits in front of the lookup. It stores only what the guard
   * needs and never the hash, and revocation invalidates it explicitly, so the
   * worst case for a revoked key is one minute of continued access — bounded,
   * documented, and the reason {@link CACHE_TTL_SECONDS.API_KEY} is short.
   */
  async authenticate(presentedKey: string, clientIp: string): Promise<AuthenticatedApiKey> {
    const prefix = this.tokenService.extractApiKeyPrefix(presentedKey);

    if (!prefix) {
      throw new UnauthorizedError(ErrorCode.API_KEY_INVALID);
    }

    const cacheKey = CacheKeys.apiKeyByPrefix(prefix);

    let cached = await this.redis.getJson<{
      id: string;
      name: string;
      prefix: string;
      organizationId: string;
      scopes: string[];
      createdById: string;
      keyHash: string;
      expiresAt: string | null;
      revokedAt: string | null;
      allowedIps: string[];
    }>(cacheKey);

    if (!cached) {
      const record = await this.apiKeyRepository.findOne({ where: { prefix } });

      if (!record) {
        // Burn a comparable amount of work so a bad prefix and a bad secret are
        // not distinguishable by timing.
        this.tokenService.hashToken(presentedKey);
        throw new UnauthorizedError(ErrorCode.API_KEY_INVALID);
      }

      cached = {
        id: record.id,
        name: record.name,
        prefix: record.prefix,
        organizationId: record.organizationId,
        scopes: record.scopes ?? [],
        createdById: record.createdById,
        keyHash: record.keyHash,
        expiresAt: record.expiresAt?.toISOString() ?? null,
        revokedAt: record.revokedAt?.toISOString() ?? null,
        allowedIps: record.allowedIps ?? [],
      };

      await this.redis.setJson(cacheKey, cached, CACHE_TTL_SECONDS.API_KEY);
    }

    if (!this.tokenService.verifyToken(presentedKey, cached.keyHash)) {
      await this.recordRejection(cached.organizationId, prefix, 'signature_mismatch');
      throw new UnauthorizedError(ErrorCode.API_KEY_INVALID);
    }

    if (cached.revokedAt) {
      await this.recordRejection(cached.organizationId, prefix, 'revoked');
      throw new UnauthorizedError(ErrorCode.API_KEY_REVOKED);
    }

    if (cached.expiresAt && new Date(cached.expiresAt).getTime() <= Date.now()) {
      await this.recordRejection(cached.organizationId, prefix, 'expired');
      throw new UnauthorizedError(ErrorCode.API_KEY_EXPIRED);
    }

    if (cached.allowedIps.length > 0 && !isIpAllowed(clientIp, cached.allowedIps)) {
      await this.recordRejection(cached.organizationId, prefix, 'ip_not_allowed');
      throw new ForbiddenError(ErrorCode.IP_NOT_ALLOWED, {
        message: 'This API key is restricted to specific network addresses.',
      });
    }

    // Fire and forget: a synchronous UPDATE per authenticated request would
    // serialise every caller of the same key on one row.
    void this.touch(cached.id, clientIp);

    return {
      id: cached.id,
      name: cached.name,
      prefix: cached.prefix,
      organizationId: cached.organizationId,
      scopes: cached.scopes,
      createdById: cached.createdById,
    };
  }

  private async touch(apiKeyId: string, ip: string): Promise<void> {
    try {
      await this.apiKeyRepository
        .createQueryBuilder()
        .update(ApiKey)
        .set({
          lastUsedAt: new Date(),
          lastUsedIp: ip.slice(0, 45),
          usageCount: () => '"usage_count" + 1',
        })
        .where('id = :id', { id: apiKeyId })
        .execute();
    } catch (error) {
      this.logger.debug(`Failed to record API key usage: ${(error as Error).message}`);
    }
  }

  private async recordRejection(
    organizationId: string,
    prefix: string,
    reason: string,
  ): Promise<void> {
    await this.auditService.recordSafe({
      action: AuditAction.API_KEY_REJECTED,
      status: AuditStatus.DENIED,
      organizationId,
      resourceType: 'api_key',
      metadata: { prefix, reason },
    });
  }

  // ── Management ────────────────────────────────────────────────────────────

  async list(organizationId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  async listActive(organizationId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { organizationId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  async findByIdOrFail(organizationId: string, apiKeyId: string): Promise<ApiKey> {
    const record = await this.apiKeyRepository.findOne({
      where: { id: apiKeyId, organizationId },
    });
    if (!record) throw new NotFoundError(ErrorCode.API_KEY_NOT_FOUND);
    return record;
  }

  async revoke(
    organizationId: string,
    apiKeyId: string,
    revokedById: string,
    reason?: string,
  ): Promise<ApiKey> {
    const record = await this.findByIdOrFail(organizationId, apiKeyId);

    if (record.isRevoked) return record;

    record.revokedAt = new Date();
    record.revokedById = revokedById;
    record.revocationReason = reason?.slice(0, 255) ?? null;

    const saved = await this.apiKeyRepository.save(record);

    // Invalidate before returning, so the key stops working immediately rather
    // than at the end of its cache TTL.
    await this.redis.del(CacheKeys.apiKeyByPrefix(record.prefix));

    await this.auditService.recordSafe({
      action: AuditAction.API_KEY_REVOKED,
      organizationId,
      resourceType: 'api_key',
      resourceId: record.id,
      resourceLabel: record.name,
      metadata: { prefix: record.prefix, reason },
    });

    return saved;
  }

  /**
   * Revokes every key a member created.
   *
   * Called when a member is removed from a workspace. Their keys carry authority
   * derived from permissions they no longer have, so leaving them live would be
   * a standing back door.
   */
  async revokeAllCreatedBy(
    organizationId: string,
    userId: string,
    reason: string,
  ): Promise<number> {
    const keys = await this.apiKeyRepository.find({
      where: { organizationId, createdById: userId, revokedAt: IsNull() },
    });

    for (const key of keys) {
      key.revokedAt = new Date();
      key.revocationReason = reason.slice(0, 255);
      await this.apiKeyRepository.save(key);
      await this.redis.del(CacheKeys.apiKeyByPrefix(key.prefix));
    }

    if (keys.length > 0) {
      this.logger.log(
        `Revoked ${keys.length} API key(s) created by ${userId} in workspace ${organizationId}.`,
      );
    }

    return keys.length;
  }

  /** The scopes an API key may be granted. */
  getAvailableScopes(): readonly string[] {
    return API_KEY_SCOPES;
  }
}
