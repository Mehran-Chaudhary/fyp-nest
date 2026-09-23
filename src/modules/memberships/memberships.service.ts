import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, IsNull, Repository, type EntityManager } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/exceptions/app.exception';
import type { RequestMembership } from '../../common/interfaces/authenticated-request.interface';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { SystemRoleSlug } from '../../common/constants/permissions.constants';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { AuditService } from '../audit/audit.service';
import { Organization } from '../organizations/entities/organization.entity';
import { RbacService } from '../rbac/rbac.service';
import { Role } from '../rbac/entities/role.entity';
import {
  MembershipStatus,
  OrganizationMember,
} from './entities/organization-member.entity';

export interface ListMembersQuery {
  page: number;
  limit: number;
  search?: string;
  status?: MembershipStatus;
  roleId?: string;
  sortBy?: string;
  sortDirection?: 'ASC' | 'DESC';
}

export interface MemberView {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  avatarUrl: string | null;
  title: string | null;
  status: MembershipStatus;
  roles: Array<{
    id: string;
    name: string;
    slug: string;
    color: string | null;
    priority: number;
  }>;
  highestRolePriority: number;
  isOwner: boolean;
  joinedAt: Date | null;
  lastActiveAt: Date | null;
  createdAt: Date;
}

/**
 * Workspace membership management (proposal module 6.2).
 *
 * ## The rule that matters
 *
 * Almost every method here calls {@link assertCanActOn}. Permission checks alone
 * are not sufficient for member management, because the permission an
 * administrator legitimately holds — `member:update` — is exactly the permission
 * needed to strip the owner's roles and seize the workspace. Priority ordering
 * closes that: you may only act on a member whose highest role priority is
 * strictly below your own.
 *
 * The second rule, enforced by {@link assertNotLastOwner}, is that a workspace
 * must always retain at least one owner. A workspace with no owner cannot
 * transfer ownership, cannot be deleted and cannot restore its own
 * administration through any API path.
 */
@Injectable()
export class MembershipsService {
  private readonly logger = new Logger(MembershipsService.name);

  constructor(
    @InjectRepository(OrganizationMember)
    private readonly memberRepository: Repository<OrganizationMember>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly rbacService: RbacService,
    private readonly auditService: AuditService,
    private readonly apiKeysService: ApiKeysService,
    private readonly dataSource: DataSource,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(
    organizationId: string,
    query: ListMembersQuery,
  ): Promise<PaginatedResult<MemberView>> {
    const sortable: Record<string, string> = {
      createdAt: 'member.created_at',
      joinedAt: 'member.joined_at',
      lastActiveAt: 'member.last_active_at',
      name: 'user.first_name',
      email: 'user.email_normalized',
      status: 'member.status',
    };

    const sortColumn = sortable[query.sortBy ?? 'createdAt'] ?? sortable.createdAt;

    const builder = this.memberRepository
      .createQueryBuilder('member')
      .innerJoinAndSelect('member.user', 'user')
      .leftJoinAndSelect('member.roles', 'role')
      .where('member.organization_id = :organizationId', { organizationId })
      .andWhere('member.deleted_at IS NULL');

    if (query.status) {
      builder.andWhere('member.status = :status', { status: query.status });
    } else {
      // Removed members are retained for audit resolution but are not part of
      // the directory.
      builder.andWhere('member.status != :removed', { removed: MembershipStatus.REMOVED });
    }

    if (query.search) {
      const term = `%${query.search.toLowerCase()}%`;
      builder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(user.first_name) LIKE :term', { term })
            .orWhere('LOWER(user.last_name) LIKE :term', { term })
            .orWhere('user.email_normalized LIKE :term', { term })
            .orWhere("LOWER(COALESCE(member.display_name, '')) LIKE :term", { term });
        }),
      );
    }

    if (query.roleId) {
      // A separate EXISTS rather than a filter on the joined alias: filtering the
      // join would return the member with only the matching role attached, and
      // the directory needs to show every role they hold.
      builder.andWhere(
        `EXISTS (
           SELECT 1 FROM member_roles mr
            WHERE mr.member_id = member.id AND mr.role_id = :roleId
         )`,
        { roleId: query.roleId },
      );
    }

    builder
      .orderBy(sortColumn, query.sortDirection ?? 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);

    const [members, total] = await builder.getManyAndCount();

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, ownerId: true },
    });

    return {
      items: members.map((member) => this.toView(member, organization?.ownerId)),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findByIdOrFail(
    organizationId: string,
    memberId: string,
    manager?: EntityManager,
  ): Promise<OrganizationMember> {
    const repository = manager
      ? manager.getRepository(OrganizationMember)
      : this.memberRepository;

    const member = await repository.findOne({
      where: { id: memberId, organizationId },
      relations: { user: true, roles: true },
    });

    if (!member) throw new NotFoundError(ErrorCode.MEMBERSHIP_NOT_FOUND);
    return member;
  }

  async findByUserId(
    organizationId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<OrganizationMember | null> {
    const repository = manager
      ? manager.getRepository(OrganizationMember)
      : this.memberRepository;

    return repository.findOne({
      where: { organizationId, userId },
      relations: { user: true, roles: true },
    });
  }

  async getMemberView(organizationId: string, memberId: string): Promise<MemberView> {
    const member = await this.findByIdOrFail(organizationId, memberId);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, ownerId: true },
    });

    return this.toView(member, organization?.ownerId);
  }

  // ── Creation ──────────────────────────────────────────────────────────────

  /**
   * Adds a user to a workspace with a given role.
   *
   * Used by the invitation-acceptance flow. A previously removed membership is
   * reactivated rather than duplicated: the unique index on
   * `(organization_id, user_id)` would reject a second row, and reusing the
   * original keeps historical audit references resolvable.
   */
  async addMember(
    organizationId: string,
    userId: string,
    roleIds: string[],
    invitedById: string | null,
    manager: EntityManager,
  ): Promise<OrganizationMember> {
    const repository = manager.getRepository(OrganizationMember);

    const existing = await repository.findOne({
      where: { organizationId, userId },
      withDeleted: true,
      relations: { roles: true },
    });

    if (existing && existing.status === MembershipStatus.ACTIVE && !existing.deletedAt) {
      throw new ConflictError(ErrorCode.MEMBERSHIP_ALREADY_EXISTS);
    }

    const roles = await manager
      .getRepository(Role)
      .find({ where: roleIds.map((id) => ({ id, organizationId })) });

    if (roles.length === 0) {
      throw new NotFoundError(ErrorCode.ROLE_NOT_FOUND);
    }

    let member: OrganizationMember;

    if (existing) {
      existing.deletedAt = null;
      existing.status = MembershipStatus.ACTIVE;
      existing.joinedAt = new Date();
      existing.roles = roles;
      existing.suspendedAt = null;
      existing.suspensionReason = null;
      member = await repository.save(existing);
    } else {
      member = await repository.save(
        repository.create({
          organizationId,
          userId,
          status: MembershipStatus.ACTIVE,
          joinedAt: new Date(),
          invitedById,
          roles,
        }),
      );
    }

    await this.rbacService.recomputeMemberPermissions(member.id, manager);
    await this.refreshMemberCount(organizationId, manager);

    return member;
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  /** Changes a member's roles. */
  async setRoles(
    organizationId: string,
    memberId: string,
    roleIds: string[],
    actor: RequestMembership,
    actorPermissions: readonly string[],
  ): Promise<MemberView> {
    const member = await this.findByIdOrFail(organizationId, memberId);

    this.assertCanActOn(actor, member, 'change the roles of');

    const organization = await this.organizationRepository.findOneOrFail({
      where: { id: organizationId },
    });

    // Removing the owner role from the workspace owner would leave it
    // ownerless, which no API path can repair.
    if (member.userId === organization.ownerId) {
      const roles = await this.dataSource
        .getRepository(Role)
        .find({ where: roleIds.map((id) => ({ id, organizationId })) });

      if (!roles.some((role) => role.slug === (SystemRoleSlug.OWNER as string))) {
        throw new ConflictError(ErrorCode.CANNOT_REMOVE_LAST_OWNER, {
          message:
            'The workspace owner must keep the Owner role. Transfer ownership first.',
        });
      }
    }

    // An administrator must not be able to grant a role carrying permissions
    // they do not themselves hold — otherwise role assignment becomes an
    // escalation path around the role editor's own checks.
    await this.assertCanGrantRoles(organizationId, roleIds, actorPermissions);

    const before = (member.roles ?? []).map((role) => role.slug);

    const updated = await this.rbacService.setMemberRoles(
      memberId,
      organizationId,
      roleIds,
    );

    await this.auditService.recordSafe({
      action: AuditAction.ROLE_ASSIGNED,
      organizationId,
      resourceType: 'member',
      resourceId: memberId,
      resourceLabel: member.user?.emailNormalized,
      metadata: { before, after: roleIds },
    });

    return this.getMemberView(organizationId, updated.id);
  }

  /** Updates the member's workspace-local profile fields. */
  async updateProfile(
    organizationId: string,
    memberId: string,
    changes: { displayName?: string; title?: string },
    actor: RequestMembership,
  ): Promise<MemberView> {
    const member = await this.findByIdOrFail(organizationId, memberId);

    // Editing your own workspace profile needs no elevated permission.
    if (member.id !== actor.id) {
      this.assertCanActOn(actor, member, 'edit the profile of');
    }

    if (changes.displayName !== undefined) {
      member.displayName = changes.displayName?.trim() || null;
    }
    if (changes.title !== undefined) {
      member.title = changes.title?.trim() || null;
    }

    await this.memberRepository.save(member);

    await this.auditService.recordSafe({
      action: AuditAction.MEMBER_UPDATED,
      organizationId,
      resourceType: 'member',
      resourceId: memberId,
      metadata: { changes },
    });

    return this.getMemberView(organizationId, memberId);
  }

  /**
   * Suspends a member without removing them.
   *
   * Reversible, and preserves their roles for reinstatement. Their access stops
   * on their very next request, because the organization-context guard checks
   * membership status against the database rather than trusting the token.
   */
  async suspend(
    organizationId: string,
    memberId: string,
    reason: string | undefined,
    actor: RequestMembership,
  ): Promise<MemberView> {
    const member = await this.findByIdOrFail(organizationId, memberId);

    this.assertCanActOn(actor, member, 'suspend');
    await this.assertNotLastOwner(organizationId, member);

    member.status = MembershipStatus.SUSPENDED;
    member.suspendedAt = new Date();
    member.suspensionReason = reason?.slice(0, 255) ?? null;

    await this.memberRepository.save(member);
    await this.rbacService.invalidateMemberCache(organizationId, member.userId);
    await this.refreshMemberCount(organizationId);

    await this.auditService.recordSafe({
      action: AuditAction.MEMBER_SUSPENDED,
      organizationId,
      resourceType: 'member',
      resourceId: memberId,
      resourceLabel: member.user?.emailNormalized,
      metadata: { reason },
    });

    return this.getMemberView(organizationId, memberId);
  }

  async reactivate(
    organizationId: string,
    memberId: string,
    actor: RequestMembership,
  ): Promise<MemberView> {
    const member = await this.findByIdOrFail(organizationId, memberId);

    this.assertCanActOn(actor, member, 'reactivate');

    member.status = MembershipStatus.ACTIVE;
    member.suspendedAt = null;
    member.suspensionReason = null;

    await this.memberRepository.save(member);
    await this.rbacService.invalidateMemberCache(organizationId, member.userId);
    await this.refreshMemberCount(organizationId);

    await this.auditService.recordSafe({
      action: AuditAction.MEMBER_REACTIVATED,
      organizationId,
      resourceType: 'member',
      resourceId: memberId,
      resourceLabel: member.user?.emailNormalized,
    });

    return this.getMemberView(organizationId, memberId);
  }

  /**
   * Removes a member from a workspace.
   *
   * Three things happen together, in one transaction:
   *
   *  1. The membership is soft-deleted and marked `REMOVED`, so audit records
   *     referencing it stay resolvable.
   *  2. Their cached permission set is dropped, so access stops immediately.
   *  3. Every API key they created is revoked. Those keys carry authority
   *     derived from permissions the member no longer has; leaving them live
   *     would be a standing back door that survives the removal entirely.
   */
  async remove(
    organizationId: string,
    memberId: string,
    actor: RequestMembership,
  ): Promise<{ removed: true; revokedApiKeys: number }> {
    const member = await this.findByIdOrFail(organizationId, memberId);

    this.assertCanActOn(actor, member, 'remove');
    await this.assertNotLastOwner(organizationId, member);

    const revokedApiKeys = await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(OrganizationMember);

      member.status = MembershipStatus.REMOVED;
      await repository.save(member);
      await repository.softDelete({ id: memberId });

      const revoked = await this.apiKeysService.revokeAllCreatedBy(
        organizationId,
        member.userId,
        'Member removed from workspace',
      );

      await this.refreshMemberCount(organizationId, manager);

      await this.auditService.record(
        {
          action: AuditAction.MEMBER_REMOVED,
          organizationId,
          resourceType: 'member',
          resourceId: memberId,
          resourceLabel: member.user?.emailNormalized,
          metadata: { userId: member.userId, revokedApiKeys: revoked },
        },
        manager,
      );

      return revoked;
    });

    await this.rbacService.invalidateMemberCache(organizationId, member.userId);

    this.logger.log(
      `Removed member ${member.userId} from workspace ${organizationId}; ` +
        `revoked ${revokedApiKeys} API key(s).`,
    );

    return { removed: true, revokedApiKeys };
  }

  /** A member leaving of their own accord. */
  async leave(organizationId: string, userId: string): Promise<{ left: true }> {
    const member = await this.findByUserId(organizationId, userId);
    if (!member) throw new NotFoundError(ErrorCode.MEMBERSHIP_NOT_FOUND);

    await this.assertNotLastOwner(organizationId, member);

    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(OrganizationMember);

      member.status = MembershipStatus.REMOVED;
      await repository.save(member);
      await repository.softDelete({ id: member.id });

      await this.apiKeysService.revokeAllCreatedBy(
        organizationId,
        userId,
        'Member left workspace',
      );

      await this.refreshMemberCount(organizationId, manager);

      await this.auditService.record(
        {
          action: AuditAction.MEMBER_LEFT,
          organizationId,
          resourceType: 'member',
          resourceId: member.id,
          metadata: { userId },
        },
        manager,
      );
    });

    await this.rbacService.invalidateMemberCache(organizationId, userId);

    return { left: true };
  }

  /** Records activity, used to populate "last active" in the directory. */
  async touchActivity(organizationId: string, userId: string): Promise<void> {
    await this.memberRepository.update(
      { organizationId, userId },
      { lastActiveAt: new Date() },
    );
  }

  // ── Guard rails ───────────────────────────────────────────────────────────

  /**
   * Refuses an action against a member at or above the actor's own level.
   *
   * See the class comment: without this, `member:update` is a workspace takeover
   * primitive rather than an administrative convenience.
   */
  private assertCanActOn(
    actor: RequestMembership,
    target: OrganizationMember,
    verb: string,
  ): void {
    if (actor.id === target.id) {
      throw new BadRequestError(ErrorCode.CANNOT_MODIFY_SELF, {
        message: `You cannot ${verb} your own membership.`,
      });
    }

    if (target.highestRolePriority >= actor.highestRolePriority) {
      throw new ForbiddenError(ErrorCode.FORBIDDEN, {
        message: `You cannot ${verb} a member whose role ranks at or above your own.`,
        details: {
          yourPriority: actor.highestRolePriority,
          targetPriority: target.highestRolePriority,
        },
      });
    }
  }

  /** Refuses to leave a workspace without an owner. */
  private async assertNotLastOwner(
    organizationId: string,
    member: OrganizationMember,
  ): Promise<void> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, ownerId: true },
    });

    if (organization?.ownerId !== member.userId) return;

    throw new ConflictError(ErrorCode.CANNOT_REMOVE_LAST_OWNER, {
      message: 'This member owns the workspace. Transfer ownership to someone else first.',
    });
  }

  /** Refuses to assign a role granting permissions the actor does not hold. */
  private async assertCanGrantRoles(
    organizationId: string,
    roleIds: string[],
    actorPermissions: readonly string[],
  ): Promise<void> {
    if (actorPermissions.includes('*:*')) return;

    const roles = await this.dataSource
      .getRepository(Role)
      .find({ where: roleIds.map((id) => ({ id, organizationId })) });

    const requested = new Set<string>();
    for (const role of roles) {
      for (const key of role.permissionKeys ?? []) requested.add(key);
    }

    const missing = this.rbacService
      .expandToConcretePermissions(Array.from(requested))
      .filter((permission) => !this.rbacService.can(actorPermissions, permission));

    if (missing.length > 0) {
      throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
        message:
          'That role grants permissions you do not hold, so you cannot assign it: ' +
          missing.slice(0, 10).join(', ') +
          (missing.length > 10 ? `, and ${missing.length - 10} more.` : '.'),
        details: { deniedPermissions: missing },
      });
    }
  }

  private async refreshMemberCount(
    organizationId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const memberRepository = manager
      ? manager.getRepository(OrganizationMember)
      : this.memberRepository;
    const organizationRepository = manager
      ? manager.getRepository(Organization)
      : this.organizationRepository;

    const count = await memberRepository.count({
      where: { organizationId, status: MembershipStatus.ACTIVE, deletedAt: IsNull() },
    });

    await organizationRepository.update({ id: organizationId }, { memberCount: count });
  }

  private toView(member: OrganizationMember, ownerId?: string): MemberView {
    const user = member.user;

    return {
      id: member.id,
      userId: member.userId,
      email: user?.email ?? '',
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      displayName: member.displayName ?? user?.preferredName ?? '',
      avatarUrl: user?.avatarUrl ?? null,
      title: member.title,
      status: member.status,
      roles: (member.roles ?? []).map((role) => ({
        id: role.id,
        name: role.name,
        slug: role.slug,
        color: role.color,
        priority: role.priority,
      })),
      highestRolePriority: member.highestRolePriority,
      isOwner: ownerId !== undefined && member.userId === ownerId,
      joinedAt: member.joinedAt,
      lastActiveAt: member.lastActiveAt,
      createdAt: member.createdAt,
    };
  }
}
