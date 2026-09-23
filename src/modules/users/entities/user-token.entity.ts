import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import { User } from './user.entity';

export enum UserTokenType {
  EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
  /** Confirms a request to change the address on file, sent to the new address. */
  EMAIL_CHANGE = 'EMAIL_CHANGE',
}

/**
 * A single-use, time-limited token sent to a user out of band.
 *
 * Only the HMAC digest of the token is stored, never the token itself, so a
 * database dump yields no usable password-reset link. Consumption is recorded
 * rather than the row being deleted: a replay attempt then produces a
 * distinguishable "already used" outcome that is worth auditing, instead of
 * being indistinguishable from an expired or forged token.
 */
@Entity('user_tokens')
@Index('idx_user_tokens_hash', ['tokenHash'], { unique: true })
@Index('idx_user_tokens_user_type', ['userId', 'type'])
@Index('idx_user_tokens_expires_at', ['expiresAt'])
export class UserToken extends BaseEntity {
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, (user) => user.tokens, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'varchar', length: 32, name: 'type' })
  type: UserTokenType;

  /** HMAC-SHA256 of the token. The token itself exists only in the sent email. */
  @Column({ type: 'varchar', length: 128, name: 'token_hash' })
  tokenHash: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', name: 'consumed_at', nullable: true })
  consumedAt: Date | null;

  /** IP the token was redeemed from, retained for the security timeline. */
  @Column({ type: 'varchar', length: 45, name: 'consumed_ip', nullable: true })
  consumedIp: string | null;

  @Column({ type: 'varchar', length: 45, name: 'requested_ip', nullable: true })
  requestedIp: string | null;

  /**
   * Type-specific payload. For `EMAIL_CHANGE`, the address being moved to —
   * held here rather than applied eagerly so an unconfirmed request cannot
   * lock the user out of their current address.
   */
  @Column({ type: 'jsonb', name: 'metadata', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  get isExpired(): boolean {
    return this.expiresAt.getTime() <= Date.now();
  }

  get isConsumed(): boolean {
    return this.consumedAt !== null && this.consumedAt !== undefined;
  }

  get isUsable(): boolean {
    return !this.isExpired && !this.isConsumed;
  }
}
