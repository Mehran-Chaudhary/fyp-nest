import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { GraphIssue } from '../domain/graph-validation';
import type { WorkflowGraph } from '../domain/graph';

/** Per-version limits, each at most the platform ceiling. */
export interface WorkflowSettings {
  maxSteps?: number;
  maxTokens?: number;
  runTimeoutMs?: number;
}

/**
 * One immutable version of a workflow definition. A database trigger rejects
 * UPDATE: history is evidence. A version is stored even when invalid — the
 * canvas saves drafts mid-edit — with its validation report; only a valid one
 * can be published or run.
 */
@Entity('workflow_versions')
@Index('uq_workflow_versions_workflow_version', ['workflowId', 'version'], { unique: true })
export class WorkflowVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'uuid', name: 'workflow_id' })
  workflowId: string;

  @Column({ type: 'integer', name: 'version' })
  version: number;

  @Column({ type: 'jsonb', name: 'graph' })
  graph: WorkflowGraph;

  @Column({ type: 'jsonb', name: 'settings', default: () => "'{}'::jsonb" })
  settings: WorkflowSettings;

  /** SHA-256 of the normalized graph and settings. */
  @Column({ type: 'varchar', length: 64, name: 'digest' })
  digest: string;

  @Column({ type: 'boolean', name: 'valid' })
  valid: boolean;

  @Column({ type: 'jsonb', name: 'validation', default: () => "'{}'::jsonb" })
  validation: { errors: GraphIssue[]; warnings: GraphIssue[]; stepBound?: number };

  @Column({ type: 'varchar', length: 500, name: 'change_note', nullable: true })
  changeNote: string | null;

  @Column({ type: 'integer', name: 'restored_from_version', nullable: true })
  restoredFromVersion: number | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;
}
