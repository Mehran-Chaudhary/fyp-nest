import { Column, Entity, Index } from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';

export enum WorkflowStatus {
  /** Being built; runs only as an editor's test run. */
  DRAFT = 'DRAFT',
  /** Published: members with `workflow:execute` may run the published version. */
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
}

/**
 * A workflow: the identity and publication state of a canvas definition.
 * The definition itself lives in append-only `workflow_versions`.
 *
 * Editing never changes what runs: saving appends a version, and only
 * publishing moves `publishedVersion`. A run pins the version it started with,
 * so an edit made while a run is in flight cannot change that run.
 */
@Entity('workflows')
@Index('idx_workflows_org', ['organizationId'])
export class Workflow extends SoftDeletableEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'varchar', length: 80, name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 16, name: 'status', default: WorkflowStatus.DRAFT })
  status: WorkflowStatus;

  @Column({ type: 'integer', name: 'current_version', default: 1 })
  currentVersion: number;

  @Column({ type: 'integer', name: 'published_version', nullable: true })
  publishedVersion: number | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @Column({ type: 'uuid', name: 'published_by_id', nullable: true })
  publishedById: string | null;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'last_run_at', nullable: true })
  lastRunAt: Date | null;
}
