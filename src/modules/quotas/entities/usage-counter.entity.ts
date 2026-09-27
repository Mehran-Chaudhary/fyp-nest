import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Consumption against one budget in one calendar period.
 *
 * `tokens_reserved` is what calls in flight may still spend (each reserved its
 * worst case — prompt plus maximum output — before it was sent); it moves to
 * `tokens_used` as each call settles. Admission checks `used + reserved`, so
 * a burst of concurrent calls cannot overspend between them.
 *
 * The usage ledger (`llm_invocations`) remains the source of truth: the
 * maintenance sweep raises `tokens_used` to the ledger's sum whenever a
 * settlement was lost to a crash, and releases reservations that expired.
 */
@Entity('usage_counters')
export class UsageCounter {
  @PrimaryColumn({ type: 'uuid', name: 'quota_id' })
  quotaId: string;

  @PrimaryColumn({ type: 'timestamptz', name: 'period_start' })
  periodStart: Date;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'bigint', name: 'tokens_used', default: 0 })
  tokensUsed: string;

  @Column({ type: 'bigint', name: 'tokens_reserved', default: 0 })
  tokensReserved: string;

  @Column({ type: 'integer', name: 'requests', default: 0 })
  requests: number;

  /** Calls refused against this budget in this period. */
  @Column({ type: 'integer', name: 'rejected', default: 0 })
  rejected: number;

  /** When the alert threshold was crossed this period; alerts fire once. */
  @Column({ type: 'timestamptz', name: 'alerted_at', nullable: true })
  alertedAt: Date | null;

  /** When the budget was first exhausted this period. */
  @Column({ type: 'timestamptz', name: 'exhausted_at', nullable: true })
  exhaustedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
