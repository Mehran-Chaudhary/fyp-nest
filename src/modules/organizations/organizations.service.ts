import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, IsNull, Repository, type EntityManager } from 'typeorm';
import { CacheKeys, CACHE_TTL_SECONDS } from '../../common/constants/cache-keys.constants';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/exceptions/app.exception';
import { isIpAllowed, isValidCidr } from '../../common/utils/ip.util';
import {
  isReservedSlug,
  slugifyOrRandom,
  withRandomSuffix,
} from '../../common/utils/slug.util';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { APP_CONFIG_KEY, type AppConfig } from '../../config/app.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import {
  MembershipStatus,
  OrganizationMember,
} from '../memberships/entities/organization-member.entity';
import { RbacService } from '../rbac/rbac.service';
import { OrganizationIpRule } from './entities/organization-ip-rule.entity';
import {
  Organization,
  OrganizationStatus,
  type OrganizationSettings,
} from './entities/organization.entity';

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  description?: string;
}

export interface UpdateOrganizationInput {
  name?: string;
  description?: string;
  logoUrl?: string;
  settings?: Partial<OrganizationSettings>;
}

/**
 * The security context the organization-context guard attaches to a request.
 */
export interface OrganizationAccessContext {
  organization: Organization;
  membership: OrganizationMember;
  permissions: string[];
  roleSlugs: string[];
  priority: number;
  isOwner: boolean;
}

/**
 * Workspace lifecycle and tenant resolution (proposal module 6.2).
 *
 * The most important method here is {@link resolveAccessContext}: it runs on
 * every workspace-scoped request and is the single point at which the platform
 * decides that a given principal may operate inside a given tenant. Everything
 * downstream — permission checks, repository filters, audit attribution —
 * depends on it being correct, so it performs every check itself rather than
 * trusting anything the client supplied.
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);
  private readonly appConfig: AppConfig;
  private readonly securityConfig: SecurityConfig;

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(OrganizationMember)
    private readonly memberRepository: Repository<OrganizationMember>,
    @InjectRepository(OrganizationIpRule)
    private readonly ipRuleRepository: Repository<OrganizationIpRule>,
    private readonly dataSource: DataSource,
    private readonly rbacService: RbacService,
    private readonly auditService: AuditService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    this.securityConfig =
      this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  // ── Creation ──────────────────────────────────────────────────────────────

  /**
   * Creates a workspace and everything it needs to be usable.
   *
   * One transaction covering the workspace, its four system roles, the owner's
   * membership and that membership's materialised permissions. Any partial
   * failure would leave a workspace nobody can administer — and, because every
   * administrative endpoint requires a role to authorise it, one that cannot be
   * repaired through the API either.
   */
  async create(ownerId: string, input: CreateOrganizationInput): Promise<Organization> {
    await this.assertOwnershipQuotaAvailable(ownerId);

    const organization = await this.dataSource.transaction(async (manager) => {
      const organizationRepository = manager.getRepository(Organization);

      const slug = await this.resolveAvailableSlug(
        input.slug ?? slugifyOrRandom(input.name),
        manager,
      );

      const created = organizationRepository.create({
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? null,
        status: OrganizationStatus.ACTIVE,
        ownerId,
        settings: {},
        memberCount: 1,
      });

      const saved = await organizationRepository.save(created);

      await this.rbacService.seedSystemRoles(saved.id, manager);
      const ownerRole = await this.rbacService.getOwnerRole(saved.id, manager);

      const membership = manager.getRepository(OrganizationMember).create({
        organizationId: saved.id,
        userId: ownerId,
        status: MembershipStatus.ACTIVE,
        joinedAt: new Date(),
        roles: [ownerRole],
      });

      const savedMembership = await manager
        .getRepository(OrganizationMember)
        .save(membership);

      await this.rbacService.recomputeMemberPermissions(savedMembership.id, manager);

      await this.auditService.record(
        {
          action: AuditAction.ORGANIZATION_CREATED,
          organizationId: saved.id,
          resourceType: 'organization',
          resourceId: saved.id,
          resourceLabel: saved.name,
          metadata: { slug: saved.slug },
        },
        manager,
      );

      return saved;
    });

    this.logger.log(`Workspace "${organization.name}" (${organization.slug}) created.`);

    return organization;
  }

  /**
   * Finds a free slug, appending a random discriminator if needed.
   *
   * Bounded retries rather than an unbounded loop: if several attempts collide,
   * something is wrong (a race storm, or a pathological name) and looping
   * forever would turn that into a hung request.
   */
  private async resolveAvailableSlug(
    desired: string,
    manager: EntityManager,
  ): Promise<string> {
    const repository = manager.getRepository(Organization);
    const base = slugifyOrRandom(desired);

    if (isReservedSlug(base)) {
      throw new ConflictError(ErrorCode.ORGANIZATION_SLUG_RESERVED, {
        details: { slug: base },
      });
    }

    if (!(await repository.findOne({ where: { slug: base } }))) return base;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = withRandomSuffix(base);
      if (!(await repository.findOne({ where: { slug: candidate } }))) return candidate;
    }

    throw new ConflictError(ErrorCode.ORGANIZATION_SLUG_TAKEN, {
      message: 'Could not allocate a unique workspace URL. Please choose a different name.',
    });
  }

  private async assertOwnershipQuotaAvailable(ownerId: string): Promise<void> {
    const limit = this.appConfig.limits.maxOwnedOrganizations;
    if (limit <= 0) return;

    const owned = await this.organizationRepository.count({
      where: { ownerId, deletedAt: IsNull() },
    });

    if (owned >= limit) {
      throw new ForbiddenError(ErrorCode.ORGANIZATION_LIMIT_REACHED, {
        message: `You can own at most ${limit} workspaces.`,
        details: { limit, current: owned },
      });
    }
  }

  // ── Lookups ───────────────────────────────────────────────────────────────

  async findById(id: string, manager?: EntityManager): Promise<Organization | null> {
    const repository = manager
      ? manager.getRepository(Organization)
      : this.organizationRepository;
    return repository.findOne({ where: { id } });
  }

  async findByIdOrFail(id: string): Promise<Organization> {
    const organization = await this.findById(id);
    if (!organization) throw new NotFoundError(ErrorCode.ORGANIZATION_NOT_FOUND);
    return organization;
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    return this.organizationRepository.findOne({ where: { slug: slug.toLowerCase() } });
  }

  /** Workspaces the user belongs to, with their role in each. */
  async listForUser(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<
    PaginatedResult<{ organization: Organization; membership: OrganizationMember }>
  > {
    const [memberships, total] = await this.memberRepository.findAndCount({
      where: { userId, status: MembershipStatus.ACTIVE, deletedAt: IsNull() },
      relations: { organization: true, roles: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const items = memberships
      // Defensive: a workspace soft-deleted while a membership row survives.
      .filter((membership) => membership.organization && !membership.organization.deletedAt)
      .map((membership) => ({
        organization: membership.organization as Organization,
        membership,
      }));

    return { items, meta: buildPaginationMeta(total, page, limit) };
  }

  // ── Tenant resolution ─────────────────────────────────────────────────────

  /**
   * Resolves and authorises a principal's access to a workspace.
   *
   * Runs on every workspace-scoped request. The checks, in order, and why each
   * one is here rather than somewhere more convenient:
   *
   *  1. **The workspace exists and is active.** A suspended tenant is refused
   *     entirely, including reads — suspension that still allows reads is not
   *     suspension.
   *  2. **The principal is a member, and that membership is active.** This is the
   *     tenant isolation boundary. It is checked against the database (through a
   *     short cache) rather than trusted from the token's `org` claim, because a
   *     token minted before a removal would otherwise keep working until it
   *     expired.
   *  3. **A suspended membership is rejected** with a distinct code, so the UI
   *     can say "your access to this workspace was suspended" rather than
   *     "workspace not found".
   *
   * A non-member receives {@link ErrorCode.ORGANIZATION_NOT_FOUND}, not a 403.
   * Distinguishing "exists but you may not see it" from "does not exist" would
   * let anyone enumerate the platform's tenants.
   */
  async resolveAccessContext(
    identifier: string,
    userId: string,
    options: { isPlatformAdmin?: boolean } = {},
  ): Promise<OrganizationAccessContext> {
    const organization = await this.resolveOrganization(identifier);

    if (!organization) {
      throw new NotFoundError(ErrorCode.ORGANIZATION_NOT_FOUND);
    }

    if (organization.status === OrganizationStatus.SUSPENDED) {
      throw new ForbiddenError(ErrorCode.ORGANIZATION_SUSPENDED, {
        details: { reason: organization.suspensionReason },
      });
    }

    if (organization.status === OrganizationStatus.ARCHIVED) {
      throw new NotFoundError(ErrorCode.ORGANIZATION_NOT_FOUND);
    }

    const membership = await this.memberRepository.findOne({
      where: { organizationId: organization.id, userId },
      relations: { roles: true },
    });

    if (!membership) {
      // Platform administrators may operate inside any workspace, but only
      // through this explicit branch — never by silently synthesising a
      // membership, which would make their access indistinguishable from a
      // member's in the audit log.
      if (options.isPlatformAdmin) {
        return this.buildPlatformAdminContext(organization);
      }
      throw new NotFoundError(ErrorCode.ORGANIZATION_NOT_FOUND);
    }

    if (membership.status === MembershipStatus.SUSPENDED) {
      throw new ForbiddenError(ErrorCode.MEMBERSHIP_SUSPENDED, {
        details: { reason: membership.suspensionReason },
      });
    }

    if (membership.status === MembershipStatus.REMOVED) {
      throw new NotFoundError(ErrorCode.ORGANIZATION_NOT_FOUND);
    }

    const effective = await this.rbacService.getEffectivePermissions(
      organization.id,
      userId,
    );

    return {
      organization,
      membership,
      permissions: effective?.permissions ?? membership.effectivePermissions ?? [],
      roleSlugs: effective?.roleSlugs ?? (membership.roles ?? []).map((role) => role.slug),
      priority: effective?.priority ?? membership.highestRolePriority ?? 0,
      isOwner: organization.ownerId === userId,
    };
  }

  /**
   * Synthetic context for a platform administrator operating inside a workspace
   * they are not a member of.
   *
   * Granted `*:*` because platform administration necessarily spans everything,
   * but with a membership object that is explicitly not persisted, so no code
   * path can mistake it for real membership and no `member_roles` row is created.
   */
  private buildPlatformAdminContext(organization: Organization): OrganizationAccessContext {
    const synthetic = this.memberRepository.create({
      id: `platform-admin:${organization.id}`,
      organizationId: organization.id,
      userId: 'platform-admin',
      status: MembershipStatus.ACTIVE,
      effectivePermissions: ['*:*'],
      highestRolePriority: 1000,
    });

    return {
      organization,
      membership: synthetic,
      permissions: ['*:*'],
      roleSlugs: ['platform-admin'],
      priority: 1000,
      isOwner: false,
    };
  }

  /**
   * Accepts either a UUID or a slug, cached briefly.
   *
   * Supporting both means the frontend can use readable URLs
   * (`/w/acme-corp/agents`) without an extra lookup round trip on every request.
   */
  private async resolveOrganization(identifier: string): Promise<Organization | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      identifier,
    );

    const cacheKey = isUuid
      ? CacheKeys.organization(identifier)
      : CacheKeys.organizationSlug(identifier.toLowerCase());

    const cached = await this.redis.getJson<Organization>(cacheKey);
    if (cached) {
      // Dates survive JSON as strings; rehydrate the ones behaviour depends on.
      return this.organizationRepository.create({
        ...cached,
        deletedAt: cached.deletedAt ? new Date(cached.deletedAt) : null,
      });
    }

    const organization = isUuid
      ? await this.findById(identifier)
      : await this.findBySlug(identifier);

    if (organization) {
      await this.redis.setJson(cacheKey, organization, CACHE_TTL_SECONDS.ORGANIZATION);
    }

    return organization;
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  async update(
    organizationId: string,
    input: UpdateOrganizationInput,
  ): Promise<Organization> {
    const organization = await this.findByIdOrFail(organizationId);

    if (input.name !== undefined) organization.name = input.name.trim();
    if (input.description !== undefined) {
      organization.description = input.description?.trim() ?? null;
    }
    if (input.logoUrl !== undefined) organization.logoUrl = input.logoUrl || null;
    if (input.settings) {
      organization.settings = { ...organization.settings, ...input.settings };
    }

    const saved = await this.organizationRepository.save(organization);
    await this.invalidateCache(saved);

    return saved;
  }

  /**
   * Soft-deletes a workspace.
   *
   * Never a hard delete. The audit log for this workspace must survive — the
   * deletion is itself one of the most significant events it records — and a
   * cascade would destroy exactly the evidence a reviewer would come looking
   * for. Physical erasure, where a data-protection request requires it, is a
   * separate deliberate operation rather than a side effect of pressing Delete.
   */
  async softDelete(organizationId: string, actorId: string): Promise<void> {
    const organization = await this.findByIdOrFail(organizationId);

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(Organization).softDelete({ id: organizationId });

      // Memberships go too, so the workspace stops appearing in every member's
      // sidebar; the rows remain (soft-deleted) for audit resolution.
      await manager.getRepository(OrganizationMember).softDelete({ organizationId });

      await this.auditService.record(
        {
          action: AuditAction.ORGANIZATION_DELETED,
          organizationId,
          resourceType: 'organization',
          resourceId: organizationId,
          resourceLabel: organization.name,
          metadata: { slug: organization.slug, deletedBy: actorId },
        },
        manager,
      );
    });

    await this.invalidateCache(organization);
    await this.rbacService.invalidateOrganizationCache(organizationId);
  }

  /**
   * Moves ownership to another active member.
   *
   * Both role changes happen in one transaction. A partial application would
   * leave a workspace with two owners or none, and "none" is unrecoverable
   * through the API.
   */
  async transferOwnership(
    organizationId: string,
    currentOwnerId: string,
    newOwnerUserId: string,
  ): Promise<Organization> {
    if (currentOwnerId === newOwnerUserId) {
      throw new BadRequestError(ErrorCode.BAD_REQUEST, {
        message: 'That member is already the owner.',
      });
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const organizationRepository = manager.getRepository(Organization);
      const memberRepository = manager.getRepository(OrganizationMember);

      const organization = await organizationRepository.findOne({
        where: { id: organizationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!organization) throw new NotFoundError(ErrorCode.ORGANIZATION_NOT_FOUND);

      if (organization.ownerId !== currentOwnerId) {
        throw new ForbiddenError(ErrorCode.FORBIDDEN, {
          message: 'Only the current owner can transfer ownership.',
        });
      }

      const newOwnerMembership = await memberRepository.findOne({
        where: { organizationId, userId: newOwnerUserId },
        relations: { roles: true },
      });

      if (!newOwnerMembership || newOwnerMembership.status !== MembershipStatus.ACTIVE) {
        throw new NotFoundError(ErrorCode.MEMBERSHIP_NOT_FOUND, {
          message: 'The intended owner must be an active member of this workspace.',
        });
      }

      const currentOwnerMembership = await memberRepository.findOne({
        where: { organizationId, userId: currentOwnerId },
        relations: { roles: true },
      });

      const ownerRole = await this.rbacService.getOwnerRole(organizationId, manager);
      const adminRole = await this.rbacService.findRoleBySlug(
        organizationId,
        'admin',
        manager,
      );

      newOwnerMembership.roles = [ownerRole];
      await memberRepository.save(newOwnerMembership);
      await this.rbacService.recomputeMemberPermissions(newOwnerMembership.id, manager);

      if (currentOwnerMembership) {
        // The outgoing owner is demoted to administrator rather than stripped of
        // access: silently ejecting them from their own workspace would be a
        // surprising and unrecoverable outcome.
        currentOwnerMembership.roles = adminRole ? [adminRole] : [];
        await memberRepository.save(currentOwnerMembership);
        await this.rbacService.recomputeMemberPermissions(
          currentOwnerMembership.id,
          manager,
        );
      }

      organization.ownerId = newOwnerUserId;
      const saved = await organizationRepository.save(organization);

      await this.auditService.record(
        {
          action: AuditAction.ORGANIZATION_OWNERSHIP_TRANSFERRED,
          organizationId,
          resourceType: 'organization',
          resourceId: organizationId,
          resourceLabel: organization.name,
          metadata: { from: currentOwnerId, to: newOwnerUserId },
        },
        manager,
      );

      return saved;
    });

    await this.invalidateCache(result);
    await this.rbacService.invalidateOrganizationCache(organizationId);

    return result;
  }

  async setStatus(
    organizationId: string,
    status: OrganizationStatus,
    reason?: string,
  ): Promise<Organization> {
    const organization = await this.findByIdOrFail(organizationId);

    organization.status = status;
    organization.suspendedAt = status === OrganizationStatus.SUSPENDED ? new Date() : null;
    organization.suspensionReason =
      status === OrganizationStatus.SUSPENDED ? (reason ?? null) : null;

    const saved = await this.organizationRepository.save(organization);
    await this.invalidateCache(saved);

    return saved;
  }

  /** Keeps the denormalised member count aligned with reality. */
  async refreshMemberCount(
    organizationId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repository = manager
      ? manager.getRepository(OrganizationMember)
      : this.memberRepository;

    const count = await repository.count({
      where: { organizationId, status: MembershipStatus.ACTIVE, deletedAt: IsNull() },
    });

    const organizationRepository = manager
      ? manager.getRepository(Organization)
      : this.organizationRepository;

    await organizationRepository.update({ id: organizationId }, { memberCount: count });

    return count;
  }

  /** Whether the workspace can accept another member. */
  async assertSeatAvailable(organizationId: string): Promise<void> {
    const limit = this.appConfig.limits.maxMembersPerOrganization;
    if (limit <= 0) return;

    const count = await this.memberRepository.count({
      where: { organizationId, status: MembershipStatus.ACTIVE, deletedAt: IsNull() },
    });

    if (count >= limit) {
      throw new ForbiddenError(ErrorCode.SEAT_LIMIT_REACHED, {
        details: { limit, current: count },
      });
    }
  }

  // ── IP allowlist (proposal module 6.1) ────────────────────────────────────

  async listIpRules(organizationId: string): Promise<OrganizationIpRule[]> {
    return this.ipRuleRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  async addIpRule(
    organizationId: string,
    cidr: string,
    label: string | undefined,
    createdById: string,
  ): Promise<OrganizationIpRule> {
    const normalised = cidr.trim();

    if (!isValidCidr(normalised)) {
      throw new BadRequestError(ErrorCode.BAD_REQUEST, {
        message: `"${cidr}" is not a valid IP address or CIDR range.`,
      });
    }

    const existing = await this.ipRuleRepository.findOne({
      where: { organizationId, cidr: normalised },
    });
    if (existing) {
      throw new ConflictError(ErrorCode.RESOURCE_CONFLICT, {
        message: 'That range is already on the allowlist.',
      });
    }

    const rule = await this.ipRuleRepository.save(
      this.ipRuleRepository.create({
        organizationId,
        cidr: normalised,
        label: label?.trim() ?? null,
        createdById,
        isActive: true,
      }),
    );

    await this.invalidateIpAllowlistCache(organizationId);

    return rule;
  }

  async removeIpRule(organizationId: string, ruleId: string): Promise<void> {
    const rule = await this.ipRuleRepository.findOne({
      where: { id: ruleId, organizationId },
    });
    if (!rule) throw new NotFoundError(ErrorCode.RESOURCE_NOT_FOUND);

    const organization = await this.findByIdOrFail(organizationId);

    // Removing the last rule while enforcement is on would lock every member
    // out, with no way back in through the API.
    if (organization.ipAllowlistEnabled) {
      const remaining = await this.ipRuleRepository.count({
        where: { organizationId, isActive: true },
      });
      if (remaining <= 1) {
        throw new ConflictError(ErrorCode.RESOURCE_CONFLICT, {
          message:
            'This is the last active rule and enforcement is enabled. ' +
            'Disable IP enforcement first, or add another rule.',
        });
      }
    }

    await this.ipRuleRepository.delete({ id: ruleId });
    await this.invalidateIpAllowlistCache(organizationId);
  }

  /**
   * Turns enforcement on or off.
   *
   * Refuses to enable with an empty rule set, for the same lockout reason.
   */
  async setIpEnforcement(organizationId: string, enabled: boolean): Promise<Organization> {
    if (enabled) {
      const activeRules = await this.ipRuleRepository.count({
        where: { organizationId, isActive: true },
      });

      if (activeRules === 0) {
        throw new BadRequestError(ErrorCode.BAD_REQUEST, {
          message:
            'Add at least one allowed range before enabling IP enforcement, ' +
            'otherwise every member would be locked out.',
        });
      }
    }

    const organization = await this.findByIdOrFail(organizationId);
    organization.ipAllowlistEnabled = enabled;

    const saved = await this.organizationRepository.save(organization);
    await this.invalidateCache(saved);
    await this.invalidateIpAllowlistCache(organizationId);

    return saved;
  }

  /**
   * Checks a client IP against the workspace allowlist.
   *
   * Returns `true` when enforcement is off or the address matches. The rule set
   * is cached because this runs on every request for workspaces that enable it.
   *
   * Fails **open** if the allowlist cannot be read. This is the opposite of the
   * usual instinct and is the right call here: a database blip would otherwise
   * lock every member of an IP-restricted workspace out entirely, and the
   * request is still subject to authentication and full permission checks. The
   * allowlist is a network-level narrowing of an already-authorised request, not
   * the authorisation itself.
   */
  async isIpPermitted(organizationId: string, ip: string): Promise<boolean> {
    if (!this.securityConfig.enforceIpAllowlist) return true;

    try {
      const organization = await this.resolveOrganization(organizationId);
      if (!organization?.ipAllowlistEnabled) return true;

      const cacheKey = CacheKeys.organizationIpAllowlist(organizationId);
      let cidrs = await this.redis.getJson<string[]>(cacheKey);

      if (!cidrs) {
        const rules = await this.ipRuleRepository.find({
          where: { organizationId, isActive: true },
          select: { cidr: true },
        });
        cidrs = rules.map((rule) => rule.cidr);
        await this.redis.setJson(cacheKey, cidrs, CACHE_TTL_SECONDS.IP_ALLOWLIST);
      }

      if (cidrs.length === 0) return true;

      return isIpAllowed(ip, cidrs);
    } catch (error) {
      this.logger.error(
        `IP allowlist check failed for workspace ${organizationId}: ${(error as Error).message}. ` +
          'Allowing the request; authentication and permission checks still apply.',
      );
      return true;
    }
  }

  private async invalidateIpAllowlistCache(organizationId: string): Promise<void> {
    await this.redis.del(CacheKeys.organizationIpAllowlist(organizationId));
  }

  async invalidateCache(organization: Organization): Promise<void> {
    await this.redis.del(
      CacheKeys.organization(organization.id),
      CacheKeys.organizationSlug(organization.slug),
    );
  }

  /** Platform-administrator listing across every tenant. */
  async listAll(
    page: number,
    limit: number,
    search?: string,
  ): Promise<PaginatedResult<Organization>> {
    const [items, total] = await this.organizationRepository.findAndCount({
      where: search ? [{ name: ILike(`%${search}%`) }, { slug: ILike(`%${search}%`) }] : {},
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items, meta: buildPaginationMeta(total, page, limit) };
  }

  /** Records that an IP was refused, for the security dashboard. */
  async recordIpRejection(organizationId: string, ip: string): Promise<void> {
    await this.auditService.recordSafe({
      action: AuditAction.ORGANIZATION_IP_BLOCKED,
      status: AuditStatus.DENIED,
      organizationId,
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: { blockedIp: ip },
    });
  }
}
