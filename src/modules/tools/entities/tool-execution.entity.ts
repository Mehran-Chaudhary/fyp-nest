import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum ToolExecutionStatus {
  /** Claimed: a side-effecting call in progress (or one whose outcome was lost). */
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT',
  /** Refused before it ran: not granted, not permitted, or blocked by a policy. */
  DENIED = 'DENIED',
}

/** Why a call was refused. A closed vocabulary, so denials can be counted and charted. */
export enum ToolDenialReason {
  NOT_GRANTED = 'NOT_GRANTED',
  DISABLED = 'DISABLED',
  PERMISSION = 'PERMISSION',
  ARGUMENTS = 'ARGUMENTS',
  CONFIDENTIALITY = 'CONFIDENTIALITY',
  INTEGRITY = 'INTEGRITY',
  PII = 'PII',
  EGRESS = 'EGRESS',
  APPROVAL = 'APPROVAL',
  CALL_LIMIT = 'CALL_LIMIT',
  RECIPIENT = 'RECIPIENT',
  DUPLICATE = 'DUPLICATE',
}

/**
 * The tool ledger: one row per tool call, including the refused ones.
 *
 * Like the LLM usage ledger, it holds **no content** — no arguments, no
 * results. Arguments are represented by a keyed digest, which lets an
 * investigator see that the same call was made twice without being able to
 * recover what it was. Deliberately no foreign keys: the ledger outlives the
 * tools, agents, conversations and runs it describes.
 *
 * Its id doubles as the idempotency key for side-effecting calls in workflow
 * steps: the id is derived from (step, iteration, call), so a retried step
 * finds its earlier claim and does not send the same email twice.
 */
@Entity('tool_executions')
@Index('idx_tool_executions_org_created', ['organizationId', 'createdAt'])
export class ToolExecution {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'uuid', name: 'tool_id', nullable: true })
  toolId: string | null;

  @Column({ type: 'varchar', length: 48, name: 'tool_name' })
  toolName: string;

  @Column({ type: 'varchar', length: 16, name: 'tool_kind', nullable: true })
  toolKind: string | null;

  @Column({ type: 'integer', name: 'tool_version', nullable: true })
  toolVersion: number | null;

  @Column({ type: 'varchar', length: 64, name: 'definition_digest', nullable: true })
  definitionDigest: string | null;

  @Column({ type: 'varchar', length: 16, name: 'status' })
  status: ToolExecutionStatus;

  @Column({ type: 'varchar', length: 24, name: 'denial_reason', nullable: true })
  denialReason: ToolDenialReason | null;

  @Column({ type: 'varchar', length: 64, name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId: string | null;

  @Column({ type: 'uuid', name: 'api_key_id', nullable: true })
  apiKeyId: string | null;

  @Column({ type: 'uuid', name: 'agent_id', nullable: true })
  agentId: string | null;

  @Column({ type: 'integer', name: 'agent_version', nullable: true })
  agentVersion: number | null;

  @Column({ type: 'uuid', name: 'conversation_id', nullable: true })
  conversationId: string | null;

  @Column({ type: 'uuid', name: 'workflow_run_id', nullable: true })
  workflowRunId: string | null;

  @Column({ type: 'uuid', name: 'workflow_step_id', nullable: true })
  workflowStepId: string | null;

  @Column({ type: 'smallint', name: 'iteration', nullable: true })
  iteration: number | null;

  @Column({ type: 'varchar', length: 64, name: 'arguments_digest', nullable: true })
  argumentsDigest: string | null;

  @Column({ type: 'integer', name: 'result_bytes', default: 0 })
  resultBytes: number;

  @Column({ type: 'boolean', name: 'result_truncated', default: false })
  resultTruncated: boolean;

  @Column({ type: 'integer', name: 'duration_ms', nullable: true })
  durationMs: number | null;

  @Column({ type: 'varchar', length: 16, name: 'context_classification', nullable: true })
  contextClassification: string | null;

  @Column({ type: 'varchar', length: 16, name: 'context_integrity', nullable: true })
  contextIntegrity: string | null;

  @Column({ type: 'boolean', name: 'side_effects', default: false })
  sideEffects: boolean;

  /** Content-free detail: HTTP status and host, passage counts, the recipient's member id. */
  @Column({ type: 'jsonb', name: 'metadata', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;
}
