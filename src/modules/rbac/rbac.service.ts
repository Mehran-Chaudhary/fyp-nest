import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SECURITY_EVENT,
  type AccessChangedEvent,
} from '../../common/constants/security-events';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository, type EntityManager } from 'typeorm';
import { CacheKeys, CACHE_TTL_SECONDS } from '../../common/constants/cache-keys.constants';
import {
  ALL_PERMISSION_KEYS,
  DEFAULT_SYSTEM_ROLE_SLUG,
  PERMISSION_BY_KEY,
  PERMISSION_DEFINITIONS,
  SYSTEM_ROLE_DEFINITIONS,
  SystemRoleSlug,
  type PermissionDefinition,
} from '../../common/constants/permissions.constants';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/exceptions/app.exception';
import {
  expandPermissions,
  hasPermission,
  missingPermissions,
} from '../../common/utils/permission.util';
import { slugify } from '../../common/utils/slug.util';
import { RedisService } from '../../shared/redis/redis.service';
import { OrganizationMember } from '../memberships/entities/organization-member.entity';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';

export interface CreateRoleInput {
  organizationId: string;
  name: string;
  description?: string;
  permissionKeys: string[];
  color?: string;
  priority?: number;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  permissionKeys?: string[];
  color?: string;
  priority?: number;
}

/**
 * Role and permission management (proposal module 6.3, "Strict RBAC").
 *
 * ## Where authority actually lives
 *
 * A member's effective permissions are the union of the permission sets of every
 * role they hold. That union is *materialised* onto the membership row rather
 * than computed per request, because the authorization guard runs on every
 * single request and a three-table join there would dominate the platform's
 * latency profile. This service owns that derived state and is the only thing
 * that writes it; every mutation path below ends in
 * {@link recomputeMemberPermissions}.
 *
 * ## Privilege escalation
 *
 * Two independent rules, because permission checks alone are not enough:
 *
 *  - **You cannot grant what you do not hold.** Otherwise any member with
 *    `role:update` — which every administrator has — could mint a role with
 *    `*:*` and assign it to themselves. Enforced by
 *    {@link assertCanGrantPermissions}.
 *  - **You cannot act above your own priority.** Otherwise an administrator
 *    could strip the owner's roles and take over the workspace. Enforced by
 *    {@link assertCanManageRole} and by the memberships service.
 */
@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name);

  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(OrganizationMember)
    private readonly memberRepository: Repository<OrganizationMember>,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  // ── Permission catalogue ──────────────────────────────────────────────────

  /** The full catalogue, for the role editor. */
  async listPermissions(): Promise<Permission[]> {
    return this.permissionRepository.find({ order: { category: 'ASC', key: 'ASC' } });
  }

  /** The catalogue as static definitions; no database round trip. */
  getPermissionDefinitions(): readonly PermissionDefinition[] {
    return PERMISSION_DEFINITIONS;
  }

  /**
   * Expands wildcards against the catalogue.
   *
   * The frontend needs concrete keys to decide whether to render a button, and
   * should not have to reimplement wildcard matching in the browser — where a
   * subtly different implementation would produce UI that disagrees with the
   * server.
   */
  expandToConcretePermissions(granted: readonly string[]): string[] {
    return expandPermissions(granted, ALL_PERMISSION_KEYS);
  }

  // ── Roles ─────────────────────────────────────────────────────────────────

  async listRoles(organizationId: string): Promise<Role[]> {
    return this.roleRepository.find({
      where: { organizationId },
      order: { priority: 'DESC', name: 'ASC' },
    });
  }

  async findRoleById(roleId: string, organizationId: string): Promise<Role | null> {
    // Scoped by organization on purpose: a role id from another workspace must
    // read as "not found", never as "forbidden", so ids cannot be probed.
    return this.roleRepository.findOne({ where: { id: roleId, organizationId } });
  }

  async findRoleByIdOrFail(roleId: string, organizationId: string): Promise<Role> {
    const role = await this.findRoleById(roleId, organizationId);
    if (!role) throw new NotFoundError(ErrorCode.ROLE_NOT_FOUND);
    return role;
  }

  async findRoleBySlug(
    organizationId: string,
    slug: string,
    manager?: EntityManager,
  ): Promise<Role | null> {
    const repository = manager ? manager.getRepository(Role) : this.roleRepository;
    return repository.findOne({ where: { organizationId, slug } });
  }

  /** The role new members receive when an invitation names none. */
  async getDefaultRole(organizationId: string, manager?: EntityManager): Promise<Role> {
    const repository = manager ? manager.getRepository(Role) : this.roleRepository;

    const role =
      (await repository.findOne({ where: { organizationId, isDefault: true } })) ??
      (await repository.findOne({
        where: { organizationId, slug: DEFAULT_SYSTEM_ROLE_SLUG },
      }));

    if (!role) {
      // Only reachable if a workspace was created without its system roles,
      // which the creation transaction makes impossible.
      throw new NotFoundError(ErrorCode.ROLE_NOT_FOUND, {
        message: 'This workspace has no default role configured.',
      });
    }

    return role;
  }

  /**
   * Creates the four built-in roles for a brand-new workspace.
   *
   * Must run inside the workspace-creation transaction: a workspace that exists
   * without roles cannot be administered, and cannot be repaired through the API
   * because every repair endpoint requires a role to authorise it.
   */
  async seedSystemRoles(organizationId: string, manager: EntityManager): Promise<Role[]> {
    const roleRepository = manager.getRepository(Role);
    const permissionRepository = manager.getRepository(Permission);

    const allPermissions = await permissionRepository.find();
    const permissionByKey = new Map(allPermissions.map((p) => [p.key, p]));

    const created: Role[] = [];

    for (const definition of SYSTEM_ROLE_DEFINITIONS) {
      const role = roleRepository.create({
        organizationId,
        name: definition.name,
        slug: definition.slug,
        description: definition.description,
        isSystem: true,
        isDefault: definition.isDefault ?? false,
        priority: definition.priority,
        permissionKeys: [...definition.permissions],
        permissions: this.resolveConcretePermissions(
          definition.permissions,
          permissionByKey,
        ),
      });

      created.push(await roleRepository.save(role));
    }

    this.logger.log(
      `Seeded ${created.length} system roles for workspace ${organizationId}.`,
    );

    return created;
  }

  /**
   * Resolves a possibly-wildcarded key list to concrete `Permission` rows for the
   * join table.
   *
   * The join table cannot represent `member:*`, which is exactly why
   * `role.permissionKeys` exists alongside it: the join table is the normalised,
   * referentially-sound record used by the role editor and by reporting, while
   * the JSONB column carries the authoritative grant including wildcards.
   */
  private resolveConcretePermissions(
    keys: readonly string[],
    catalogue: Map<string, Permission>,
  ): Permission[] {
    const resolved = new Set<Permission>();

    for (const key of expandPermissions(keys, ALL_PERMISSION_KEYS)) {
      const permission = catalogue.get(key);
      if (permission) resolved.add(permission);
    }

    return Array.from(resolved);
  }

  async createRole(
    input: CreateRoleInput,
    actorPermissions: readonly string[],
    actorPriority: number,
  ): Promise<Role> {
    this.assertPermissionsExist(input.permissionKeys);
    this.assertCanGrantPermissions(actorPermissions, input.permissionKeys);

    const priority = input.priority ?? 40;
    if (priority >= actorPriority) {
      throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
        message:
          'You cannot create a role with a priority equal to or above your own; ' +
          'it could then be used to act on your own membership.',
        details: { requestedPriority: priority, yourPriority: actorPriority },
      });
    }

    const slug = slugify(input.name);
    if (!slug) {
      throw new BadRequestError(ErrorCode.BAD_REQUEST, {
        message: 'Role name must contain at least one alphanumeric character.',
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const roleRepository = manager.getRepository(Role);

      const existing = await roleRepository.findOne({
        where: { organizationId: input.organizationId, slug },
      });
      if (existing) throw new ConflictError(ErrorCode.ROLE_ALREADY_EXISTS);

      const permissions = await manager.getRepository(Permission).find();
      const permissionByKey = new Map(permissions.map((p) => [p.key, p]));

      const role = roleRepository.create({
        organizationId: input.organizationId,
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? null,
        isSystem: false,
        isDefault: false,
        priority,
        color: input.color ?? null,
        permissionKeys: [...new Set(input.permissionKeys)],
        permissions: this.resolveConcretePermissions(input.permissionKeys, permissionByKey),
      });

      return roleRepository.save(role);
    });
  }

  async updateRole(
    roleId: string,
    organizationId: string,
    input: UpdateRoleInput,
    actorPermissions: readonly string[],
    actorPriority: number,
  ): Promise<Role> {
    const role = await this.findRoleByIdOrFail(roleId, organizationId);

    this.assertCanManageRole(role, actorPriority);

    if (input.permissionKeys) {
      this.assertPermissionsExist(input.permissionKeys);
      this.assertCanGrantPermissions(actorPermissions, input.permissionKeys);
    }

    if (input.priority !== undefined && input.priority >= actorPriority) {
      throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
        message: 'You cannot raise a role to a priority at or above your own.',
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const roleRepository = manager.getRepository(Role);
      const target = await roleRepository.findOneOrFail({
        where: { id: roleId },
        relations: { permissions: true },
      });

      if (input.name !== undefined) {
        target.name = input.name.trim();
        // The slug is intentionally not regenerated. It is referenced by
        // invitations, API integrations and saved dashboard filters; silently
        // changing it on a rename would break all of them.
      }
      if (input.description !== undefined)
        target.description = input.description?.trim() ?? null;
      if (input.color !== undefined) target.color = input.color ?? null;
      if (input.priority !== undefined) target.priority = input.priority;

      if (input.permissionKeys) {
        const permissions = await manager.getRepository(Permission).find();
        const permissionByKey = new Map(permissions.map((p) => [p.key, p]));

        target.permissionKeys = [...new Set(input.permissionKeys)];
        target.permissions = this.resolveConcretePermissions(
          input.permissionKeys,
          permissionByKey,
        );
      }

      const saved = await roleRepository.save(target);

      // Every member holding this role now has a stale materialised permission
      // set. Recomputing inside the same transaction means no request can ever
      // observe the role and the membership disagreeing.
      if (input.permissionKeys || input.priority !== undefined) {
        await this.recomputeMembersWithRole(roleId, manager);
      }

      return saved;
    });
  }

  async deleteRole(
    roleId: string,
    organizationId: string,
    actorPriority: number,
  ): Promise<void> {
    const role = await this.findRoleByIdOrFail(roleId, organizationId);

    this.assertCanManageRole(role, actorPriority);

    const holders = await this.memberRepository
      .createQueryBuilder('member')
      .innerJoin('member_roles', 'mr', 'mr.member_id = member.id')
      .where('mr.role_id = :roleId', { roleId })
      .andWhere('member.deleted_at IS NULL')
      .getCount();

    if (holders > 0) {
      throw new ConflictError(ErrorCode.ROLE_IN_USE, {
        details: { memberCount: holders },
        message: `This role is assigned to ${holders} member(s). Reassign them before deleting it.`,
      });
    }

    await this.roleRepository.softDelete({ id: roleId });
  }

  // ── Role assignment ───────────────────────────────────────────────────────

  /**
   * Replaces a member's roles and recomputes their effective permissions.
   *
   * Transactional, because a membership whose `member_roles` rows and
   * `effective_permissions` column disagree is an authorization bug: the guard
   * reads the column, so a half-applied change would leave a member holding
   * permissions they were just stripped of.
   */
  async setMemberRoles(
    memberId: string,
    organizationId: string,
    roleIds: string[],
    manager?: EntityManager,
  ): Promise<OrganizationMember> {
    const run = async (transactionManager: EntityManager): Promise<OrganizationMember> => {
      const memberRepository = transactionManager.getRepository(OrganizationMember);
      const roleRepository = transactionManager.getRepository(Role);

      const member = await memberRepository.findOne({
        where: { id: memberId, organizationId },
        relations: { roles: true },
      });
      if (!member) throw new NotFoundError(ErrorCode.MEMBERSHIP_NOT_FOUND);

      const roles = await roleRepository.find({
        where: { id: In(roleIds), organizationId },
      });

      if (roles.length !== new Set(roleIds).size) {
        // A role id that belongs to another workspace, or does not exist.
        throw new NotFoundError(ErrorCode.ROLE_NOT_FOUND, {
          message: 'One or more roles do not exist in this workspace.',
        });
      }

      member.roles = roles;
      await memberRepository.save(member);

      return this.recomputeMemberPermissions(member.id, transactionManager);
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Recomputes and persists a member's materialised permission set.
   *
   * The only writer of `effective_permissions` and `highest_role_priority`.
   */
  async recomputeMemberPermissions(
    memberId: string,
    manager: EntityManager,
  ): Promise<OrganizationMember> {
    const memberRepository = manager.getRepository(OrganizationMember);

    const member = await memberRepository.findOne({
      where: { id: memberId },
      relations: { roles: true },
    });
    if (!member) throw new NotFoundError(ErrorCode.MEMBERSHIP_NOT_FOUND);

    const permissions = new Set<string>();
    let highestPriority = 0;

    for (const role of member.roles ?? []) {
      for (const key of role.permissionKeys ?? []) permissions.add(key);
      if (role.priority > highestPriority) highestPriority = role.priority;
    }

    member.effectivePermissions = Array.from(permissions).sort();
    member.highestRolePriority = highestPriority;

    const saved = await memberRepository.save(member);

    await this.invalidateMemberCache(member.organizationId, member.userId);

    return saved;
  }

  /** Recomputes every member holding a given role, after that role changed. */
  private async recomputeMembersWithRole(
    roleId: string,
    manager: EntityManager,
  ): Promise<void> {
    const memberIds: Array<{ member_id: string }> = await manager.query(
      `SELECT mr.member_id
         FROM member_roles mr
         JOIN organization_members m ON m.id = mr.member_id
        WHERE mr.role_id = $1 AND m.deleted_at IS NULL`,
      [roleId],
    );

    for (const row of memberIds) {
      await this.recomputeMemberPermissions(row.member_id, manager);
    }

    this.logger.log(
      `Recomputed effective permissions for ${memberIds.length} member(s) after a role change.`,
    );
  }

  /**
   * Recomputes every member of a workspace.
   *
   * Used after a bulk change, and available as a repair operation if the
   * materialised state is ever suspected of drifting.
   */
  async recomputeOrganization(organizationId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const members = await manager.getRepository(OrganizationMember).find({
        where: { organizationId, deletedAt: IsNull() },
        select: { id: true },
      });

      for (const member of members) {
        await this.recomputeMemberPermissions(member.id, manager);
      }

      return members.length;
    });
  }

  // ── Effective permission lookup ───────────────────────────────────────────

  /**
   * The effective permission set for a member, read through a short Redis cache.
   *
   * On the hot path for every workspace-scoped request. The cache TTL is short
   * (five minutes) and every mutation path invalidates explicitly, so the TTL is
   * a safety net rather than the primary consistency mechanism.
   */
  async getEffectivePermissions(
    organizationId: string,
    userId: string,
  ): Promise<{ permissions: string[]; priority: number; roleSlugs: string[] } | null> {
    const cacheKey = CacheKeys.memberPermissions(organizationId, userId);

    const cached = await this.redis.getJson<{
      permissions: string[];
      priority: number;
      roleSlugs: string[];
    }>(cacheKey);
    if (cached) return cached;

    const member = await this.memberRepository.findOne({
      where: { organizationId, userId },
      relations: { roles: true },
    });
    if (!member) return null;

    const resolved = {
      permissions: member.effectivePermissions ?? [],
      priority: member.highestRolePriority ?? 0,
      roleSlugs: (member.roles ?? []).map((role) => role.slug),
    };

    await this.redis.setJson(cacheKey, resolved, CACHE_TTL_SECONDS.MEMBER_PERMISSIONS);

    return resolved;
  }

  async invalidateMemberCache(organizationId: string, userId: string): Promise<void> {
    await this.redis.del(CacheKeys.memberPermissions(organizationId, userId));
    // Live connections (real-time sockets) re-check this member now.
    this.events?.emit(SECURITY_EVENT.ACCESS_CHANGED, {
      organizationId,
      userId,
    } satisfies AccessChangedEvent);
  }

  /** Drops every cached permission set in a workspace. */
  async invalidateOrganizationCache(organizationId: string): Promise<void> {
    await this.redis.deleteByPattern(CacheKeys.memberPermissionsPattern(organizationId));
    this.events?.emit(SECURITY_EVENT.ACCESS_CHANGED, {
      organizationId,
    } satisfies AccessChangedEvent);
  }

  // ── Guard rails ───────────────────────────────────────────────────────────

  /** Rejects permission keys that are not in the catalogue. */
  private assertPermissionsExist(keys: readonly string[]): void {
    const unknown = keys.filter((key) => !PERMISSION_BY_KEY.has(key) && !key.includes('*'));

    if (unknown.length > 0) {
      throw new BadRequestError(ErrorCode.PERMISSION_NOT_FOUND, {
        message: `Unknown permission key(s): ${unknown.join(', ')}.`,
        details: { unknownPermissions: unknown },
      });
    }
  }

  /**
   * Rejects an attempt to grant a permission the actor does not hold.
   *
   * The check runs against the *expanded* set on both sides, so it cannot be
   * bypassed by asking for `agent:*` when you only hold `agent:read`.
   */
  private assertCanGrantPermissions(
    actorPermissions: readonly string[],
    requested: readonly string[],
  ): void {
    if (hasPermission(actorPermissions, '*:*')) return;

    const expandedRequest = expandPermissions(requested, ALL_PERMISSION_KEYS);
    const missing = missingPermissions(actorPermissions, expandedRequest);

    if (missing.length > 0) {
      throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
        message:
          'You cannot grant permissions you do not hold yourself: ' +
          missing.join(', ') +
          '.',
        details: { deniedPermissions: missing },
      });
    }
  }

  /** Rejects edits to built-in roles and to roles at or above the actor's level. */
  private assertCanManageRole(role: Role, actorPriority: number): void {
    if (role.isSystem) {
      throw new ForbiddenError(ErrorCode.ROLE_IMMUTABLE, {
        message:
          `"${role.name}" is a built-in role and cannot be modified. ` +
          'Create a custom role instead.',
      });
    }

    if (role.priority >= actorPriority) {
      throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
        message: 'You cannot modify a role whose priority is at or above your own.',
        details: { rolePriority: role.priority, yourPriority: actorPriority },
      });
    }
  }

  /** True when a set of granted permissions satisfies a requirement. */
  can(granted: readonly string[], required: string): boolean {
    return hasPermission(granted, required);
  }

  /**
   * Reconciles the `permissions` table with the code-level catalogue.
   *
   * Run by the seeder on every deploy. Permissions are inserted and updated but
   * never deleted: a key removed from the code may still be referenced by a
   * workspace's custom role, and dropping the row would cascade that role's
   * grant away silently.
   */
  async syncPermissionCatalogue(): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    for (const definition of PERMISSION_DEFINITIONS) {
      // Split on the first colon only: `pii:policy:read` is resource `pii`,
      // action `policy:read` — the same rule the permission matcher applies.
      const separator = definition.key.indexOf(':');
      const resource = definition.key.slice(0, separator);
      const action = definition.key.slice(separator + 1);

      const existing = await this.permissionRepository.findOne({
        where: { key: definition.key },
      });

      if (!existing) {
        await this.permissionRepository.save(
          this.permissionRepository.create({
            key: definition.key,
            resource,
            action,
            category: definition.category,
            description: definition.description,
            isDangerous: definition.dangerous ?? false,
            phase: definition.phase,
          }),
        );
        created += 1;
        continue;
      }

      const changed =
        existing.description !== definition.description ||
        existing.category !== definition.category ||
        existing.isDangerous !== (definition.dangerous ?? false) ||
        existing.phase !== definition.phase ||
        existing.resource !== resource ||
        existing.action !== action;

      if (changed) {
        existing.description = definition.description;
        existing.category = definition.category;
        existing.isDangerous = definition.dangerous ?? false;
        existing.phase = definition.phase;
        existing.resource = resource;
        existing.action = action;
        await this.permissionRepository.save(existing);
        updated += 1;
      }
    }

    return { created, updated };
  }

  /**
   * Brings every workspace's built-in roles in line with their code definitions.
   *
   * System roles are seeded when a workspace is created and are immutable
   * through the API, so without this a permission added to, say, the Member
   * role in a later phase would reach new workspaces only. Phase 2 is the first
   * time that matters: every existing Member needs `clearance:internal` to read
   * ordinary documents.
   *
   * Idempotent. Each changed role and the effective permissions of its holders
   * are updated in one transaction per role. Custom roles are never touched —
   * they belong to the workspace, not to the platform.
   */
  async syncSystemRoles(): Promise<{ rolesUpdated: number; membersRecomputed: number }> {
    const definitions = new Map(
      SYSTEM_ROLE_DEFINITIONS.map((definition) => [definition.slug, definition]),
    );
    const systemRoles = await this.roleRepository.find({
      where: { isSystem: true, slug: In([...definitions.keys()]) },
    });

    const catalogue = new Map(
      (await this.permissionRepository.find()).map((p) => [p.key, p]),
    );
    let rolesUpdated = 0;
    let membersRecomputed = 0;

    for (const role of systemRoles) {
      const definition = definitions.get(role.slug as SystemRoleSlug);
      if (!definition) continue;

      const current = [...(role.permissionKeys ?? [])].sort();
      const desired = [...definition.permissions].sort();
      if (
        current.length === desired.length &&
        current.every((key, index) => key === desired[index])
      ) {
        continue;
      }

      await this.dataSource.transaction(async (manager) => {
        role.permissionKeys = [...definition.permissions];
        role.permissions = this.resolveConcretePermissions(
          definition.permissions,
          catalogue,
        );
        await manager.getRepository(Role).save(role);

        const holders: Array<{ member_id: string }> = await manager.query(
          `SELECT mr.member_id FROM member_roles mr
             JOIN organization_members m ON m.id = mr.member_id
            WHERE mr.role_id = $1 AND m.deleted_at IS NULL`,
          [role.id],
        );
        await this.recomputeMembersWithRole(role.id, manager);
        membersRecomputed += holders.length;
      });

      rolesUpdated += 1;
    }

    return { rolesUpdated, membersRecomputed };
  }

  /** Convenience accessor used by the workspace-creation flow. */
  async getOwnerRole(organizationId: string, manager: EntityManager): Promise<Role> {
    const role = await manager
      .getRepository(Role)
      .findOne({ where: { organizationId, slug: SystemRoleSlug.OWNER } });

    if (!role) {
      throw new NotFoundError(ErrorCode.ROLE_NOT_FOUND, {
        message: 'The owner role is missing from this workspace.',
      });
    }

    return role;
  }
}
