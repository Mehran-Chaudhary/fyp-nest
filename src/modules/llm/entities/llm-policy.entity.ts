import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * A workspace's model policy (`llm:manage`): which of the platform's models it
 * may use, its default, and ceilings tighter than the platform's.
 *
 * Absent until first saved; the platform defaults apply until then.
 */
@Entity('llm_policies')
export class LlmPolicy {
  @PrimaryColumn({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @OneToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @VersionColumn({ name: 'version', default: 1 })
  version: number;

  /** Empty: every model the platform allows. */
  @Column({ type: 'jsonb', name: 'allowed_models', default: () => "'[]'::jsonb" })
  allowedModels: string[];

  @Column({ type: 'varchar', length: 200, name: 'default_model', nullable: true })
  defaultModel: string | null;

  @Column({ type: 'integer', name: 'max_output_tokens', nullable: true })
  maxOutputTokens: number | null;

  @Column({ type: 'integer', name: 'max_context_tokens', nullable: true })
  maxContextTokens: number | null;

  @Column({ type: 'uuid', name: 'updated_by_id', nullable: true })
  updatedById: string | null;
}
