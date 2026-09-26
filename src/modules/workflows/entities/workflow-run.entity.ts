import { Column, Entity, Index } from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import type { Classification } from '../../knowledge/domain/classification';
import type { Integrity } from '../../tools/domain/information-flow';
import type { RunStatus, RunTrigger } from '../domain/run-state';

/**
 * One execution of a workflow version.
 *
 * ## Encrypted, and shreddable
 *
 * Every run has its own 256-bit data key, stored only wrapped by the master
 * key. The run's input and output, every step's input and output and every
 * approval comment are sealed under it with AES-256-GCM, bound by associated
 * data to exactly where they belong — so a ciphertext moved between rows, or
 * between runs, fails to decrypt. Deleting a run destroys the key in the same
 * transaction, making every copy of its content unreadable at once, backups
 * included. The same key authenticates the run's queued jobs.
 *
 * ## Labels
 *
 * A run carries the high-water mark of everything its steps touched
 * (classification and compartments) and the low-water mark of how far its
 * content can be trusted (integrity). Reading a run's content requires
 * dominating its label, exactly like reading a conversation message.
 */
@Entity('workflow_runs')
@Index('idx_workflow_runs_org_created', ['organizationId', 'createdAt'])
export class WorkflowRun extends SoftDeletableEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'uuid', name: 'workflow_id' })
  workflowId: string;

  @Column({ type: 'integer', name: 'workflow_version' })
  workflowVersion: number;

  @Column({ type: 'varchar', length: 20, name: 'status' })
  status: RunStatus;

  @Column({ type: 'varchar', length: 16, name: 'trigger' })
  trigger: RunTrigger;

  @Column({ type: 'uuid', name: 'initiator_user_id', nullable: true })
  initiatorUserId: string | null;

  @Column({ type: 'uuid', name: 'initiator_api_key_id', nullable: true })
  initiatorApiKeyId: string | null;

  @Column({ type: 'uuid', name: 'initiator_membership_id', nullable: true })
  initiatorMembershipId: string | null;

  /** Client-supplied: starting the same run twice yields one run. */
  @Column({ type: 'varchar', length: 128, name: 'idempotency_key', nullable: true })
  idempotencyKey: string | null;

  @Column({ type: 'text', name: 'wrapped_data_key', nullable: true, select: false })
  wrappedDataKey: string | null;

  @Column({ type: 'text', name: 'input_ciphertext', nullable: true, select: false })
  inputCiphertext: string | null;

  @Column({ type: 'integer', name: 'input_bytes', default: 0 })
  inputBytes: number;

  @Column({ type: 'text', name: 'output_ciphertext', nullable: true, select: false })
  outputCiphertext: string | null;

  @Column({ type: 'integer', name: 'output_bytes', default: 0 })
  outputBytes: number;

  @Column({ type: 'varchar', length: 16, name: 'classification' })
  classification: Classification;

  @Column({ type: 'jsonb', name: 'knowledge_base_ids', default: () => "'[]'::jsonb" })
  knowledgeBaseIds: string[];

  @Column({ type: 'jsonb', name: 'document_ids', default: () => "'[]'::jsonb" })
  documentIds: string[];

  @Column({ type: 'varchar', length: 16, name: 'integrity' })
  integrity: Integrity;

  @Column({ type: 'integer', name: 'max_steps' })
  maxSteps: number;

  /** Steps scheduled so far (skipped ones excluded): counted against `maxSteps`. */
  @Column({ type: 'integer', name: 'steps_scheduled', default: 0 })
  stepsScheduled: number;

  @Column({ type: 'integer', name: 'max_tokens' })
  maxTokens: number;

  @Column({ type: 'bigint', name: 'tokens_used', default: 0 })
  tokensUsed: string;

  @Column({ type: 'integer', name: 'tool_calls', default: 0 })
  toolCalls: number;

  @Column({ type: 'varchar', length: 64, name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'uuid', name: 'error_step_id', nullable: true })
  errorStepId: string | null;

  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'deadline_at' })
  deadlineAt: Date;

  @Column({ type: 'timestamptz', name: 'cancel_requested_at', nullable: true })
  cancelRequestedAt: Date | null;

  @Column({ type: 'uuid', name: 'cancelled_by_id', nullable: true })
  cancelledById: string | null;

  @Column({ type: 'varchar', length: 128, name: 'request_id', nullable: true })
  requestId: string | null;
}
