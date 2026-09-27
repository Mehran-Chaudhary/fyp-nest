import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import { User } from '../../users/entities/user.entity';

export enum SessionRevocationReason {
  /** Superseded by a newer token during normal rotation. Not a security event. */
  ROTATED = 'ROTATED',
  LOGOUT = 'LOGOUT',
  LOGOUT_ALL = 'LOGOUT_ALL',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  /** An already-rotated token was presented again; the whole family was killed. */
  REUSE_DETECTED = 'REUSE_DETECTED',
  ADMIN_REVOKED = 'ADMIN_REVOKED',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  EXPIRED = 'EXPIRED',
  /** Two-step verification was enabled or disabled; other devices sign in again. */
  MFA_CHANGED = 'MFA_CHANGED',
  /** The account was erased at its owner's request. */
  ACCOUNT_ERASED = 'ACCOUNT_ERASED',
}

/**
 * One refresh token in a rotation chain.
 *
 * The platform implements refresh token rotation with reuse detection, the
 * pattern recommended by the OAuth 2.0 Security Best Current Practice:
 *
 *  - Every sign-in starts a **family** (`familyId`). Each refresh mints a new
 *    row in that family and marks the previous one `ROTATED`.
 *  - Presenting a token that has already been rotated means the token leaked —
 *    either the attacker or the legitimate client is replaying a spent value.
 *    The server cannot tell which, so it revokes the **entire family**, forcing
 *    a fresh sign-in and cutting off the attacker even if they hold the newest
 *    token.
 *
 * Without rotation, a stolen refresh token grants access for its full lifetime
 * (thirty days by default) with no way to detect the theft. With it, an attacker
 * gets at most one window before the legitimate client's next refresh trips the
 * alarm, and the incident is recorded as a `CRITICAL` audit event.
 *
 * Only the token's HMAC digest is stored.
 */
@Entity('sessions')
@Index('idx_sessions_token_hash', ['tokenHash'], { unique: true })
@Index('idx_sessions_user', ['userId'])
@Index('idx_sessions_family', ['familyId'])
@Index('idx_sessions_expires_at', ['expiresAt'])
export class Session extends BaseEntity {
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, (user) => user.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /**
   * Shared by every token descended from a single sign-in. Revoking a family
   * signs out that device, and only that device.
   */
  @Column({ type: 'uuid', name: 'family_id' })
  familyId: string;

  @Column({ type: 'varchar', length: 128, name: 'token_hash' })
  tokenHash: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 32, name: 'revoked_reason', nullable: true })
  revokedReason: SessionRevocationReason | null;

  /** The session that replaced this one, forming the rotation chain. */
  @Column({ type: 'uuid', name: 'replaced_by_session_id', nullable: true })
  replacedBySessionId: string | null;

  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'varchar', length: 45, name: 'ip_address', nullable: true })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 512, name: 'user_agent', nullable: true })
  userAgent: string | null;

  /**
   * Coarse device label derived from the user agent, shown on the "active
   * sessions" screen so a user can recognise and revoke an unfamiliar device.
   */
  @Column({ type: 'varchar', length: 128, name: 'device_label', nullable: true })
  deviceLabel: string | null;

  /** Workspace selected at sign-in, if any. Advisory; never an authorization input. */
  @Column({ type: 'uuid', name: 'organization_id', nullable: true })
  organizationId: string | null;

  /**
   * When the sign-in that started this family passed a second factor (phase
   * 5). Copied to every rotated session, so the assurance of a refreshed
   * access token is exactly that of the sign-in it descends from.
   */
  @Column({ type: 'timestamptz', name: 'mfa_verified_at', nullable: true })
  mfaVerifiedAt: Date | null;

  get isRevoked(): boolean {
    return this.revokedAt !== null && this.revokedAt !== undefined;
  }

  get isExpired(): boolean {
    return this.expiresAt.getTime() <= Date.now();
  }

  /** True only for the single live token at the tip of its family. */
  get isActive(): boolean {
    return !this.isRevoked && !this.isExpired;
  }

  /**
   * True when presenting this token indicates a leak.
   *
   * A token revoked because it was *rotated* has, by definition, already been
   * exchanged once. Seeing it again means two parties hold it.
   */
  get indicatesReuse(): boolean {
    return this.isRevoked && this.revokedReason === SessionRevocationReason.ROTATED;
  }
}
