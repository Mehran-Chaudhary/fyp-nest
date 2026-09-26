import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { MessageToolCall } from '../../agents/entities/conversation-message.entity';
import type { Classification } from '../../knowledge/domain/classification';
import type { Integrity } from '../../tools/domain/information-flow';
import type { NodeType } from '../domain/graph';
import type { FailureClass, StepStatus } from '../domain/run-state';
import type { StepRef } from '../domain/scheduler';

/** A human decision on an approval step. The comment is sealed under the run key. */
export interface StepApproval {
  requestedAt: string;
  expiresAt: string;
  decision?: 'approved' | 'rejected';
  decidedById?: string | null;
  decidedAt?: string;
  /** How it was decided: by a person, or by the timeout policy. */
  decidedBy?: 'person' | 'timeout';
  commentCiphertext?: string | null;
}

/**
 * One execution of one node: `(run, node, iteration)`, with a name-based id
 * derived from exactly that triple, so scheduling the same step twice inserts
 * nothing the second time.
 *
 * The step's input (what it was given) and output (what it handed on) are the
 * inter-agent messages of the proposal, and are stored only as ciphertext
 * under the run's key, bound to this step. Everything else on the row is
 * metadata — which is all the dead-letter queue, the canvas's live view and an
 * operator ever see.
 */
@Entity('workflow_steps')
@Index('uq_workflow_steps_run_node_iteration', ['runId', 'nodeId', 'iteration'], {
  unique: true,
})
export class WorkflowStep {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'varchar', length: 64, name: 'node_id' })
  nodeId: string;

  @Column({ type: 'varchar', length: 16, name: 'node_type' })
  nodeType: NodeType;

  @Column({ type: 'integer', name: 'iteration', default: 0 })
  iteration: number;

  @Column({ type: 'varchar', length: 20, name: 'status' })
  status: StepStatus;

  /** The outcomes taken: which outgoing edges are live. */
  @Column({ type: 'jsonb', name: 'handles', default: () => "'[]'::jsonb" })
  handles: string[];

  @Column({ type: 'jsonb', name: 'predecessors', default: () => "'[]'::jsonb" })
  predecessors: StepRef[];

  @Column({ type: 'integer', name: 'attempt', default: 0 })
  attempt: number;

  @Column({ type: 'integer', name: 'max_attempts' })
  maxAttempts: number;

  /** Incremented whenever a job is (re-)dispatched for the step. */
  @Column({ type: 'integer', name: 'dispatch', default: 0 })
  dispatch: number;

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

  @Column({ type: 'uuid', name: 'agent_id', nullable: true })
  agentId: string | null;

  @Column({ type: 'integer', name: 'agent_version', nullable: true })
  agentVersion: number | null;

  @Column({ type: 'uuid', name: 'tool_id', nullable: true })
  toolId: string | null;

  @Column({ type: 'integer', name: 'tool_version', nullable: true })
  toolVersion: number | null;

  @Column({ type: 'varchar', length: 200, name: 'model', nullable: true })
  model: string | null;

  @Column({ type: 'integer', name: 'prompt_tokens', default: 0 })
  promptTokens: number;

  @Column({ type: 'integer', name: 'completion_tokens', default: 0 })
  completionTokens: number;

  @Column({ type: 'jsonb', name: 'invocation_ids', default: () => "'[]'::jsonb" })
  invocationIds: string[];

  @Column({ type: 'jsonb', name: 'tool_calls', default: () => "'[]'::jsonb" })
  toolCalls: MessageToolCall[];

  @Column({ type: 'jsonb', name: 'approval', nullable: true })
  approval: StepApproval | null;

  @Column({ type: 'varchar', length: 64, name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'varchar', length: 16, name: 'failure_class', nullable: true })
  failureClass: FailureClass | null;

  @Column({ type: 'timestamptz', name: 'enqueued_at', nullable: true })
  enqueuedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'next_attempt_at', nullable: true })
  nextAttemptAt: Date | null;

  @Column({ type: 'timestamptz', name: 'first_attempt_at', nullable: true })
  firstAttemptAt: Date | null;

  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'heartbeat_at', nullable: true })
  heartbeatAt: Date | null;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'integer', name: 'duration_ms', nullable: true })
  durationMs: number | null;

  @Column({ type: 'timestamptz', name: 'dead_lettered_at', nullable: true })
  deadLetteredAt: Date | null;
}
