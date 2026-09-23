import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Role } from '../../rbac/entities/role.entity';
import { User } from '../../users/entities/user.entity';

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REVOKED = 'REVOKED',
  /** Set lazily when a pending invitation is examined after its expiry. */
  EXPIRED = 'EXPIRED',
}

/**
 * An outstanding offer of workspace membership.
 *
 * An invitation is a bearer credential: whoever holds the token can join the
 * workspace with the role it names. It is therefore treated with the same care
 * as a password reset link — only the HMAC digest is stored, it expires, it is
 * single use, and it can be revoked before use.
 *
 * The invited address is bound into the invitation and re-checked at acceptance.
 * Without that check, a forwarded invitation email would let an unintended
 * recipient join, which is precisely the kind of quiet access leak the audit
 * log exists to catch.
 *
 * Supports proposal module 6.2 ("allow admins to invite team members").
 */
@Entity('invitations')
@Index('idx_invitations_token_hash', ['tokenHash'], { unique: true })
@Index('idx_invitations_organization', ['organizationId'])
@Index('idx_invitations_email', ['emailNormalized'])
@Index('idx_invitations_status', ['organizationId', 'status'])
export class Invitation extends BaseEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  /** As typed by the inviter; reproduced in the invitation email. */
  @Column({ type: 'varchar', length: 320, name: 'email' })
  email: string;

  /** Lowercased form used for lookups and for the equality check at acceptance. */
  @Column({ type: 'varchar', length: 320, name: 'email_normalized' })
  emailNormalized: string;

  @Column({ type: 'varchar', length: 128, name: 'token_hash' })
  tokenHash: string;

  @Column({ type: 'varchar', length: 32, name: 'status', default: InvitationStatus.PENDING })
  status: InvitationStatus;

  /**
   * Role granted on acceptance.
   *
   * `ON DELETE RESTRICT`: deleting a role that a pending invitation references
   * would leave the invitation unredeemable, so the RBAC service requires such
   * invitations to be revoked or re-pointed first.
   */
  @Column({ type: 'uuid', name: 'role_id' })
  roleId: string;

  @ManyToOne(() => Role, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'uuid', name: 'invited_by_id' })
  invitedById: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invited_by_id' })
  invitedBy?: User;

  @Column({ type: 'timestamptz', name: 'accepted_at', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'uuid', name: 'accepted_by_id', nullable: true })
  acceptedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'accepted_by_id' })
  acceptedBy?: User | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'uuid', name: 'revoked_by_id', nullable: true })
  revokedById: string | null;

  /** Optional note from the inviter, included in the email. */
  @Column({ type: 'text', name: 'message', nullable: true })
  message: string | null;

  /** Number of times the invitation email has been sent, for abuse detection. */
  @Column({ type: 'integer', name: 'send_count', default: 1 })
  sendCount: number;

  @Column({ type: 'timestamptz', name: 'last_sent_at', nullable: true })
  lastSentAt: Date | null;

  get isExpired(): boolean {
    return this.expiresAt.getTime() <= Date.now();
  }

  /** True only when the invitation can still be redeemed right now. */
  get isRedeemable(): boolean {
    return this.status === InvitationStatus.PENDING && !this.isExpired;
  }
}
