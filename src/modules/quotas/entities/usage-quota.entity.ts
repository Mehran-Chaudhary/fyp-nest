import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import {
  QuotaEnforcement,
  QuotaManager,
  QuotaPeriod,
  QuotaScope,
} from '../domain/quota-model';

/**
 * A token quota (proposal module 6.14): at most `tokenLimit` tokens per
 * `period` for everything a `scope` does.
 *
 * `PLATFORM` rows are the deployment's own limits on the workspace — the
 * plan's monthly allowance and the per-minute rate — kept in step with the
 * environment and read-only to the workspace. `WORKSPACE` rows are what its
 * administrators set with `quota:manage`: stricter budgets for the whole
 * workspace, or for one member, agent or API key.
 */
@Entity('usage_quotas')
export class UsageQuota extends BaseEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'varchar', length: 16, name: 'scope' })
  scope: QuotaScope;

  /** Member's user id, agent id or API key id; null for the whole workspace. */
  @Column({ type: 'uuid', name: 'subject_id', nullable: true })
  subjectId: string | null;

  @Column({ type: 'varchar', length: 8, name: 'period' })
  period: QuotaPeriod;

  @Column({ type: 'bigint', name: 'token_limit' })
  tokenLimit: string;

  @Column({ type: 'varchar', length: 8, name: 'enforcement', default: QuotaEnforcement.HARD })
  enforcement: QuotaEnforcement;

  /** Percentage of the limit at which administrators are alerted, once per period. */
  @Column({ type: 'smallint', name: 'alert_threshold', default: 80 })
  alertThreshold: number;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'managed_by',
    default: QuotaManager.WORKSPACE,
  })
  managedBy: QuotaManager;

  @Column({ type: 'varchar', length: 120, name: 'label', nullable: true })
  label: string | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @Column({ type: 'uuid', name: 'updated_by_id', nullable: true })
  updatedById: string | null;
}
