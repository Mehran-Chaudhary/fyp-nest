import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import { Organization } from './organization.entity';
import { User } from '../../users/entities/user.entity';

/**
 * One entry in a workspace's network allowlist.
 *
 * Implements the "IP-whitelisting at the workspace level" requirement of
 * proposal module 6.1. When enforcement is enabled on the workspace, a request
 * whose client IP matches no rule is refused before any handler runs, and the
 * rejection is recorded as a `CRITICAL` audit event.
 *
 * Rules are stored as CIDR text rather than PostgreSQL's native `inet`/`cidr`
 * types so that matching happens in application code. That keeps the check
 * available to the guard without a database round trip — the rule set is cached
 * in Redis — and keeps the same matching implementation usable from the queue
 * consumers that will need it in phase 4.
 */
@Entity('organization_ip_rules')
@Index('idx_org_ip_rules_organization', ['organizationId'])
export class OrganizationIpRule extends BaseEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, (organization) => organization.ipRules, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  /** An address or CIDR range: `203.0.113.7`, `203.0.113.0/24`, `2001:db8::/32`. */
  @Column({ type: 'varchar', length: 64, name: 'cidr' })
  cidr: string;

  /** Human label, e.g. "Head office VPN". */
  @Column({ type: 'varchar', length: 120, name: 'label', nullable: true })
  label: string | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_id' })
  createdBy?: User | null;

  /** Lets an operator disable a rule without losing its definition. */
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', name: 'last_matched_at', nullable: true })
  lastMatchedAt: Date | null;
}
