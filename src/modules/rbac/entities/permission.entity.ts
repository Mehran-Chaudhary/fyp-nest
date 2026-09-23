import { Column, Entity, Index, ManyToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import type { PermissionCategory } from '../../../common/constants/permissions.constants';
import type { Role } from './role.entity';

/**
 * One entry in the platform permission catalogue.
 *
 * The catalogue is global, not per-tenant: every workspace draws its custom
 * roles from the same vocabulary. Rows are seeded from
 * `PERMISSION_DEFINITIONS` and reconciled on every deploy, so the table is a
 * projection of code rather than something administrators edit directly. That
 * matters because `@RequirePermissions('agent:create')` in a controller is
 * useless if the key does not exist, and a mismatch between code and database
 * would silently deny or — far worse — silently allow.
 *
 * Supports proposal module 6.3 (Strict RBAC).
 */
@Entity('permissions')
@Index('idx_permissions_key', ['key'], { unique: true })
@Index('idx_permissions_category', ['category'])
export class Permission extends BaseEntity {
  /** Canonical `resource:action` key, e.g. `document:read`. */
  @Column({ type: 'varchar', length: 100, name: 'key' })
  key: string;

  @Column({ type: 'varchar', length: 50, name: 'resource' })
  resource: string;

  @Column({ type: 'varchar', length: 50, name: 'action' })
  action: string;

  @Column({ type: 'varchar', length: 50, name: 'category' })
  category: PermissionCategory;

  @Column({ type: 'text', name: 'description' })
  description: string;

  /**
   * Granting this permission is itself a privilege escalation risk, so the RBAC
   * service refuses to let an administrator grant it unless they hold it too.
   */
  @Column({ type: 'boolean', name: 'is_dangerous', default: false })
  isDangerous: boolean;

  /** The implementation phase that begins enforcing this permission. */
  @Column({ type: 'smallint', name: 'phase', default: 1 })
  phase: number;

  @ManyToMany('Role', 'permissions')
  roles?: Role[];
}
