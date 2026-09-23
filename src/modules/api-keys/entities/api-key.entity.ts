import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A workspace-scoped machine credential.
 *
 * This is the mechanism by which the Python AI service — which performs
 * embedding, retrieval and local LLM inference from phase 2 onward — calls back
 * into this API on behalf of a workspace. The proposal's objective of a "heavily
 * secured communication layer between distributed AI agents ... utilizing
 * Zero-Trust authorization" requires exactly this: a service identity that is
 * scoped, revocable and attributable, rather than a shared static secret.
 *
 * Three properties make it zero-trust rather than a bearer password:
 *
 *  - **Scoped.** A key carries an explicit scope list and is additionally capped
 *    by the permissions of the member who issued it, so it can never exceed its
 *    creator's authority. Revoking the creator's role narrows the key too.
 *  - **Tenant-bound.** `organizationId` is immutable on the key, so a key issued
 *    for one workspace cannot address another regardless of what it asks for.
 *  - **Attributable.** Every request authenticated by a key is audited with the
 *    key as actor, not the human who created it, so a compromised key's activity
 *    is distinguishable from its owner's.
 *
 * Only the HMAC digest is stored. The plaintext key is returned exactly once, at
 * creation.
 */
@Entity('api_keys')
@Index('idx_api_keys_prefix', ['prefix'], { unique: true })
@Index('idx_api_keys_hash', ['keyHash'], { unique: true })
@Index('idx_api_keys_organization', ['organizationId'])
export class ApiKey extends BaseEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'varchar', length: 120, name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  /**
   * Non-secret leading segment, e.g. `daiap_sk_a1b2c3d4`.
   *
   * Stored in clear and uniquely indexed so an inbound key resolves in one
   * indexed lookup. The alternative — hashing the presented key against every
   * row — is O(n) per request and would make the key table a scaling bottleneck
   * on the busiest code path in the system.
   */
  @Column({ type: 'varchar', length: 64, name: 'prefix' })
  prefix: string;

  @Column({ type: 'varchar', length: 128, name: 'key_hash' })
  keyHash: string;

  /** Permission keys this key may exercise, intersected with its creator's set. */
  @Column({ type: 'jsonb', name: 'scopes', default: () => "'[]'::jsonb" })
  scopes: string[];

  @Column({ type: 'uuid', name: 'created_by_id' })
  createdById: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy?: User;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'uuid', name: 'revoked_by_id', nullable: true })
  revokedById: string | null;

  @Column({ type: 'varchar', length: 255, name: 'revocation_reason', nullable: true })
  revocationReason: string | null;

  /**
   * Last-use tracking, written opportunistically rather than on every request:
   * a synchronous UPDATE per authenticated call would serialise on the row.
   */
  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'varchar', length: 45, name: 'last_used_ip', nullable: true })
  lastUsedIp: string | null;

  @Column({ type: 'bigint', name: 'usage_count', default: 0 })
  usageCount: string;

  /**
   * Optional CIDR allowlist for this key specifically, independent of the
   * workspace-wide one. Lets a key issued to a fixed AI-service host be pinned
   * to that host, so a leaked key is unusable from anywhere else.
   */
  @Column({ type: 'jsonb', name: 'allowed_ips', default: () => "'[]'::jsonb" })
  allowedIps: string[];

  get isRevoked(): boolean {
    return this.revokedAt !== null && this.revokedAt !== undefined;
  }

  get isExpired(): boolean {
    return this.expiresAt ? this.expiresAt.getTime() <= Date.now() : false;
  }

  get isUsable(): boolean {
    return !this.isRevoked && !this.isExpired;
  }
}
