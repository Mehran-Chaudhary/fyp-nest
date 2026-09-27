import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A single-use MFA recovery code (phase 5).
 *
 * The code itself is shown once, at enrolment; only a keyed digest bound to
 * the user is stored, so a database dump yields no usable code. A used code
 * is marked rather than deleted, which makes "this code was already used" a
 * distinguishable — and auditable — outcome.
 */
@Entity('user_recovery_codes')
export class UserRecoveryCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 128, name: 'code_hash' })
  codeHash: string;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt: Date | null;
}
