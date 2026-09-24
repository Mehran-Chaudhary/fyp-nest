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
import type { DetectorFailureMode } from '../../../config/pii.config';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * A workspace's PII redaction policy. One row per workspace, created on first
 * save; until then the platform defaults (`PII_DEFAULT_*`) apply.
 *
 * Deliberately a table of its own rather than keys in the workspace settings
 * blob: the settings are writable with `workspace:update`, and the redaction
 * policy must be writable only with `pii:policy:update`. Weakening what is
 * masked before data reaches a model is a separate, audited entitlement.
 *
 * The allow and deny lists are stored encrypted. A deny list is typically the
 * names of confidential projects and clients — exactly the terms that must not
 * sit in clear text in a database dump.
 */
@Entity('pii_policies')
export class PiiPolicy {
  @PrimaryColumn({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @OneToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /** Optimistic lock: two administrators editing the policy must not overwrite each other. */
  @VersionColumn({ name: 'version', default: 1 })
  version: number;

  /** False sends prompts unmasked. An explicit, audited decision — never a fallback. */
  @Column({ type: 'boolean', name: 'enabled', default: true })
  enabled: boolean;

  @Column({ type: 'jsonb', name: 'entity_types' })
  entityTypes: string[];

  @Column({ type: 'real', name: 'score_threshold' })
  scoreThreshold: number;

  @Column({ type: 'varchar', length: 24, name: 'on_detector_failure' })
  onDetectorFailure: DetectorFailureMode;

  @Column({ type: 'varchar', length: 8, name: 'language' })
  language: string;

  /** Encrypted JSON array. */
  @Column({ type: 'text', name: 'allow_list_ciphertext', nullable: true })
  allowListCiphertext: string | null;

  /** Encrypted JSON array. */
  @Column({ type: 'text', name: 'deny_list_ciphertext', nullable: true })
  denyListCiphertext: string | null;

  @Column({ type: 'uuid', name: 'updated_by_id', nullable: true })
  updatedById: string | null;
}
