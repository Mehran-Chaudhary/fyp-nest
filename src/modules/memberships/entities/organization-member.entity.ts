import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Role } from '../../rbac/entities/role.entity';
import { User } from '../../users/entities/user.entity';

export enum MembershipStatus {
  ACTIVE = 'ACTIVE',
  /** Access revoked without destroying history. Reversible. */
  SUSPENDED = 'SUSPENDED',
  /** Left or was removed. Retained so audit records stay resolvable. */
  REMOVED = 'REMOVED',
}

/**
 * The join between a {@link User} and an {@link Organization}: the object that
 * actually carries authority.
 *
 * Every tenant-scoped authorization decision resolves to a membership. A user
 * with no membership of a workspace has no access to it whatsoever, regardless
 * of their platform-level attributes — the one exception being platform
 * administrators, whose access is granted by a separate, explicit code path so
 * that it is auditable rather than implicit.
 *
 * Roles are many-to-many: a member can hold several at once and receives the
 * union of their permissions. This is what lets an administrator who is also a
 * "Compliance Auditor" hold both sets without either role having to duplicate
 * the other.
 *
 * Supports proposal modules 6.2 and 6.3.
 */
@Entity('organization_members')
// (organization_id, user_id) uniqueness is a partial index (`WHERE deleted_at IS NULL`).
@Index('idx_org_members_organization', ['organizationId'])
@Index('idx_org_members_user', ['userId'])
@Index('idx_org_members_status', ['organizationId', 'status'])
export class OrganizationMember extends SoftDeletableEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, (organization) => organization.members, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, (user) => user.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'varchar', length: 32, name: 'status', default: MembershipStatus.ACTIVE })
  status: MembershipStatus;

  /** Per-workspace display name, so one person can appear differently per tenant. */
  @Column({ type: 'varchar', length: 120, name: 'display_name', nullable: true })
  displayName: string | null;

  /** Free-text job title, shown in the member directory. */
  @Column({ type: 'varchar', length: 120, name: 'title', nullable: true })
  title: string | null;

  @Column({ type: 'timestamptz', name: 'joined_at', nullable: true })
  joinedAt: Date | null;

  @Column({ type: 'uuid', name: 'invited_by_id', nullable: true })
  invitedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invited_by_id' })
  invitedBy?: User | null;

  @Column({ type: 'timestamptz', name: 'last_active_at', nullable: true })
  lastActiveAt: Date | null;

  @Column({ type: 'timestamptz', name: 'suspended_at', nullable: true })
  suspendedAt: Date | null;

  @Column({ type: 'varchar', length: 255, name: 'suspension_reason', nullable: true })
  suspensionReason: string | null;

  @ManyToMany(() => Role, (role) => role.members, { cascade: false })
  @JoinTable({
    name: 'member_roles',
    joinColumn: { name: 'member_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  roles?: Role[];

  /**
   * Union of every permission key granted by this member's roles, wildcards
   * included.
   *
   * A materialised projection of `member_roles -> roles.permission_keys`,
   * recomputed inside the same transaction whenever the member's roles change or
   * any role they hold is re-permissioned. It exists so the authorization guard
   * can answer "may this principal do X?" from a single indexed row rather than
   * a three-table join on every request.
   *
   * Because it is derived state, it is never written outside the RBAC service,
   * and `RbacService.recomputeMemberPermissions` is the only method that does so.
   */
  @Column({ type: 'jsonb', name: 'effective_permissions', default: () => "'[]'::jsonb" })
  effectivePermissions: string[];

  /**
   * Highest `priority` among this member's roles. Cached for the same reason as
   * `effectivePermissions`, and used to stop a lower-privileged administrator
   * from acting on a higher-privileged member.
   */
  @Column({ type: 'integer', name: 'highest_role_priority', default: 0 })
  highestRolePriority: number;

  get isActive(): boolean {
    return this.status === MembershipStatus.ACTIVE;
  }
}
