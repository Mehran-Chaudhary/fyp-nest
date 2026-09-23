import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import { User } from '../../users/entities/user.entity';
import type { OrganizationMember } from '../../memberships/entities/organization-member.entity';
import type { OrganizationIpRule } from './organization-ip-rule.entity';

export enum OrganizationStatus {
  ACTIVE = 'ACTIVE',
  /** Suspended by a platform administrator. Read access is refused entirely. */
  SUSPENDED = 'SUSPENDED',
  /** Marked for deletion; retained during a grace period. */
  ARCHIVED = 'ARCHIVED',
}

export enum OrganizationPlan {
  FREE = 'FREE',
  PRO = 'PRO',
  ENTERPRISE = 'ENTERPRISE',
}

/**
 * Per-workspace settings.
 *
 * Typed rather than an untyped `jsonb` blob so that additions are visible in
 * code review and so the settings endpoint can validate them. Fields for later
 * phases are declared now because the shape is part of the workspace contract
 * the frontend reads.
 */
export interface OrganizationSettings {
  /** Default local model for new agents, e.g. `llama3:8b`. Phase 3. */
  defaultLlmModel?: string;
  /** Default chunk size, in tokens, for document ingestion. Phase 2. */
  defaultChunkSize?: number;
  defaultChunkOverlap?: number;
  /** Entity types the PII engine masks before inference. Phase 3. */
  piiEntityTypes?: string[];
  /** Refuse inference entirely if redaction fails, rather than degrading. Phase 3. */
  piiFailClosed?: boolean;
  /** Monthly token allowance across the workspace. Phase 5. */
  monthlyTokenQuota?: number;
  /** Days to retain audit records before archival. */
  auditRetentionDays?: number;
  /** Require every member to have a verified email address. */
  requireVerifiedEmail?: boolean;
  /** Restrict invitations to these email domains. */
  allowedEmailDomains?: string[];
}

/**
 * A tenant: the isolation boundary for everything in the platform.
 *
 * Proposal module 6.2 calls for "database schema separation so data from one
 * organization cannot be accessed by another". This implementation uses a
 * shared schema with a mandatory `organization_id` discriminator and enforcement
 * at several independent layers, rather than a physical schema per tenant. The
 * reasoning, and the isolation guarantees that replace physical separation, are
 * documented in `docs/adr/0001-multi-tenancy.md`.
 *
 * In short: schema-per-tenant multiplies every migration by the tenant count and
 * exhausts connection pools, while giving no protection against the failure mode
 * that actually occurs in practice — a query that forgets its tenant filter.
 * Layered enforcement addresses that failure mode directly.
 */
@Entity('organizations')
// Slug uniqueness is a partial index (`WHERE deleted_at IS NULL`) in the migration.
@Index('idx_organizations_slug', ['slug'])
@Index('idx_organizations_owner', ['ownerId'])
@Index('idx_organizations_status', ['status'])
export class Organization extends SoftDeletableEntity {
  @Column({ type: 'varchar', length: 120, name: 'name' })
  name: string;

  /** URL-safe identifier. Stable: renaming the workspace does not change it. */
  @Column({ type: 'varchar', length: 60, name: 'slug' })
  slug: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  @Column({ type: 'text', name: 'logo_url', nullable: true })
  logoUrl: string | null;

  @Column({ type: 'varchar', length: 32, name: 'status', default: OrganizationStatus.ACTIVE })
  status: OrganizationStatus;

  @Column({ type: 'varchar', length: 32, name: 'plan', default: OrganizationPlan.FREE })
  plan: OrganizationPlan;

  /**
   * Denormalised pointer to the current owner.
   *
   * Authoritative ownership lives on the membership's roles; this column exists
   * so the common "who owns this workspace?" query does not require a join
   * through memberships and roles. Ownership transfer updates both in one
   * transaction.
   */
  @Column({ type: 'uuid', name: 'owner_id' })
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id' })
  owner?: User;

  @Column({ type: 'jsonb', name: 'settings', default: () => "'{}'::jsonb" })
  settings: OrganizationSettings;

  /**
   * Master switch for the workspace IP allowlist (proposal module 6.1).
   *
   * Kept separate from "are there any rules?" on purpose: enabling enforcement
   * with an empty rule set would lock every member out, so the two are distinct
   * decisions and the service refuses the combination.
   */
  @Column({ type: 'boolean', name: 'ip_allowlist_enabled', default: false })
  ipAllowlistEnabled: boolean;

  /** Denormalised counters, maintained transactionally with the rows they count. */
  @Column({ type: 'integer', name: 'member_count', default: 0 })
  memberCount: number;

  @Column({ type: 'timestamptz', name: 'suspended_at', nullable: true })
  suspendedAt: Date | null;

  @Column({ type: 'varchar', length: 255, name: 'suspension_reason', nullable: true })
  suspensionReason: string | null;

  @OneToMany('OrganizationMember', 'organization')
  members?: OrganizationMember[];

  @OneToMany('OrganizationIpRule', 'organization')
  ipRules?: OrganizationIpRule[];

  get isActive(): boolean {
    return this.status === OrganizationStatus.ACTIVE;
  }
}
