import { Column, Entity, Index, OneToMany } from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import type { OrganizationMember } from '../../memberships/entities/organization-member.entity';
import type { Session } from '../../auth/entities/session.entity';
import type { UserToken } from './user-token.entity';

export enum UserStatus {
  /** Registered but has not yet confirmed their email address. */
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  /** Blocked by a platform administrator. Reversible. */
  SUSPENDED = 'SUSPENDED',
  /** Closed by the user. Retained for audit integrity, cannot sign in. */
  DEACTIVATED = 'DEACTIVATED',
}

/**
 * A platform identity.
 *
 * A user is deliberately *not* owned by an organization. One person can belong
 * to several workspaces — a consultant serving two client tenants, for example —
 * and their identity, credentials and sessions are shared across all of them.
 * Everything tenant-specific (roles, permissions, membership status) lives on
 * {@link OrganizationMember} instead. Collapsing the two would make cross-tenant
 * membership impossible and force credential duplication, which is the single
 * most common multi-tenancy modelling mistake.
 *
 * Supports proposal module 6.1 (Authentication and IAM).
 */
@Entity('users')
// Uniqueness is enforced by a partial unique index in the migration
// (`WHERE deleted_at IS NULL`) so a soft-deleted account does not permanently
// reserve its email address.
@Index('idx_users_email_normalized', ['emailNormalized'])
@Index('idx_users_status', ['status'])
@Index('idx_users_created_at', ['createdAt'])
export class User extends SoftDeletableEntity {
  /** As the user typed it. Shown back to them; never used for lookups. */
  @Column({ type: 'varchar', length: 320, name: 'email' })
  email: string;

  /**
   * Lowercased, trimmed email used for every lookup and uniqueness check.
   *
   * Stored as its own column rather than lowercasing at query time so the
   * uniqueness index is usable, and so `Alice@x.com` cannot register alongside
   * `alice@x.com` — which would otherwise let an attacker shadow a colleague's
   * account and harvest misdirected invitations.
   */
  @Column({ type: 'varchar', length: 320, name: 'email_normalized' })
  emailNormalized: string;

  /**
   * Argon2id (or scrypt) encoded hash. Never leaves the repository layer:
   * `@Column({ select: false })` keeps it out of every query that does not ask
   * for it explicitly, so it cannot be serialised into a response by accident.
   */
  @Column({ type: 'varchar', length: 255, name: 'password_hash', select: false })
  passwordHash: string;

  @Column({ type: 'varchar', length: 100, name: 'first_name' })
  firstName: string;

  @Column({ type: 'varchar', length: 100, name: 'last_name' })
  lastName: string;

  @Column({ type: 'varchar', length: 255, name: 'display_name', nullable: true })
  displayName: string | null;

  @Column({ type: 'text', name: 'avatar_url', nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'varchar', length: 32, name: 'status', default: UserStatus.PENDING })
  status: UserStatus;

  @Column({ type: 'timestamptz', name: 'email_verified_at', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'last_login_at', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'varchar', length: 45, name: 'last_login_ip', nullable: true })
  lastLoginIp: string | null;

  /**
   * Consecutive failed sign-in attempts. Reset on success.
   *
   * Duplicated in Redis for fast rate limiting, but persisted here as well: an
   * attacker who can cause a Redis flush must not thereby clear the lockout.
   */
  @Column({ type: 'integer', name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts: number;

  /** When set and in the future, sign-in is refused regardless of credentials. */
  @Column({ type: 'timestamptz', name: 'locked_until', nullable: true })
  lockedUntil: Date | null;

  /**
   * Any access token issued before this instant is rejected.
   *
   * Bumped on password change, on "sign out everywhere" and when an account is
   * suspended. This is what bounds revocation latency to zero for those events,
   * rather than to the access token's remaining lifetime.
   */
  @Column({ type: 'timestamptz', name: 'tokens_valid_from', nullable: true })
  tokensValidFrom: Date | null;

  /**
   * Platform-wide administrator.
   *
   * Orthogonal to workspace roles: this grants operational access to the
   * platform itself (health, tenant administration) and is never granted by a
   * workspace owner. Deliberately a plain boolean rather than a role, so it can
   * never be conferred through the workspace role editor.
   */
  @Column({ type: 'boolean', name: 'is_platform_admin', default: false })
  isPlatformAdmin: boolean;

  /** A second factor (TOTP) is required at sign-in. Phase 5. */
  @Column({ type: 'boolean', name: 'mfa_enabled', default: false })
  mfaEnabled: boolean;

  /**
   * AES-256-GCM encrypted TOTP seed, bound to the user id by associated data.
   * Holds the *pending* seed during enrolment (with `mfaEnabled` false) and
   * the active one afterwards.
   */
  @Column({ type: 'text', name: 'mfa_secret', nullable: true, select: false })
  mfaSecret: string | null;

  @Column({ type: 'timestamptz', name: 'mfa_enrolled_at', nullable: true })
  mfaEnrolledAt: Date | null;

  /**
   * The last TOTP time step accepted. A code is valid for its 30-second step
   * (and one step either side for clock drift), so without this a code seen
   * over someone's shoulder could be replayed within the same minute.
   */
  @Column({ type: 'bigint', name: 'mfa_last_used_step', nullable: true, select: false })
  mfaLastUsedStep: string | null;

  /** Set when the account was erased at its owner's request (phase 5). */
  @Column({ type: 'timestamptz', name: 'erased_at', nullable: true })
  erasedAt: Date | null;

  /** Free-form user preferences (locale, theme, notification settings). */
  @Column({ type: 'jsonb', name: 'preferences', default: () => "'{}'::jsonb" })
  preferences: Record<string, unknown>;

  @OneToMany('OrganizationMember', 'user')
  memberships?: OrganizationMember[];

  @OneToMany('Session', 'user')
  sessions?: Session[];

  @OneToMany('UserToken', 'user')
  tokens?: UserToken[];

  // ── Derived state ─────────────────────────────────────────────────────────

  get fullName(): string {
    return `${this.firstName} ${this.lastName}`.trim();
  }

  get preferredName(): string {
    return this.displayName?.trim() || this.fullName || this.email;
  }

  get isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null && this.emailVerifiedAt !== undefined;
  }

  get isLocked(): boolean {
    return this.lockedUntil !== null && this.lockedUntil !== undefined
      ? this.lockedUntil.getTime() > Date.now()
      : false;
  }

  /** True when the account is in a state that permits sign-in. */
  get canAuthenticate(): boolean {
    return (
      (this.status === UserStatus.ACTIVE || this.status === UserStatus.PENDING) &&
      !this.isLocked
    );
  }
}
