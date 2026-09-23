import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { VersionedEntity } from '../../../database/base/base.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Permission } from './permission.entity';
import type { OrganizationMember } from '../../memberships/entities/organization-member.entity';

/**
 * A named bundle of permissions inside a workspace.
 *
 * Every workspace is seeded with four immutable system roles (Owner,
 * Administrator, Member, Viewer) and may define any number of custom ones —
 * the "HR Manager" and "Standard Employee" examples from proposal module 6.3.
 *
 * Two design points are worth spelling out.
 *
 * **Roles are tenant-scoped.** `organizationId` is part of the identity of a
 * role, and its uniqueness constraint is `(organization_id, slug)`. Two
 * workspaces can each have an "auditor" role with entirely different
 * permissions, and neither can see the other's.
 *
 * **Priority is not decoration.** It answers "may this member act on that
 * one?". An administrator (80) cannot suspend or re-role an owner (100). Without
 * an ordering, any member holding `member:update` could strip the owner's roles
 * and take over the workspace — a privilege escalation that permission checks
 * alone do not prevent, because `member:update` is exactly the permission an
 * administrator is supposed to have.
 *
 * Extends {@link VersionedEntity}: two administrators editing the same
 * permission set concurrently must not silently overwrite one another, since
 * the lost edit could be a permission removal.
 */
@Entity('roles')
// Uniqueness of (organization_id, slug) is a partial index (`WHERE deleted_at IS NULL`).
@Index('idx_roles_organization', ['organizationId'])
@Index('idx_roles_slug', ['slug'])
export class Role extends VersionedEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'varchar', length: 60, name: 'name' })
  name: string;

  @Column({ type: 'varchar', length: 60, name: 'slug' })
  slug: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  /**
   * Built-in role. Cannot be renamed, re-permissioned or deleted, which
   * guarantees a workspace can never lock itself out of its own administration.
   */
  @Column({ type: 'boolean', name: 'is_system', default: false })
  isSystem: boolean;

  /** Assigned to members who join by accepting an invitation without an explicit role. */
  @Column({ type: 'boolean', name: 'is_default', default: false })
  isDefault: boolean;

  /** Higher wins. See the class comment for why this exists. */
  @Column({ type: 'integer', name: 'priority', default: 0 })
  priority: number;

  /** Hex colour used by the role chip in the dashboard. */
  @Column({ type: 'varchar', length: 16, name: 'color', nullable: true })
  color: string | null;

  /**
   * Permission keys stored inline, including wildcards such as `member:*`.
   *
   * Deliberately duplicated alongside the `role_permissions` join table. The
   * join table is the normalised, referentially-sound record and is what the
   * role editor writes; this column is what the hot authorization path reads,
   * because resolving a member's effective permissions on every request through
   * two joins is the single most frequent query in the system. The RBAC service
   * writes both inside one transaction.
   *
   * Wildcards cannot be represented in the join table at all — there is no
   * `member:*` row in the catalogue — which is the other reason this exists.
   */
  @Column({ type: 'jsonb', name: 'permission_keys', default: () => "'[]'::jsonb" })
  permissionKeys: string[];

  @ManyToMany(() => Permission, (permission) => permission.roles, { cascade: false })
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'role_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permission_id', referencedColumnName: 'id' },
  })
  permissions?: Permission[];

  @ManyToMany('OrganizationMember', 'roles')
  members?: OrganizationMember[];

  /** True for the role that confers full control of the workspace. */
  get isOwnerRole(): boolean {
    return this.isSystem && this.slug === 'owner';
  }
}
