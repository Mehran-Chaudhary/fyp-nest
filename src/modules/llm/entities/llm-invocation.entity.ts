import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum InvocationPurpose {
  AGENT_TURN = 'AGENT_TURN',
  DIRECT_CHAT = 'DIRECT_CHAT',
  /** An agent node of a workflow run (phase 4). */
  WORKFLOW_STEP = 'WORKFLOW_STEP',
  /** A supervisor node deciding which agent acts next (phase 4). */
  WORKFLOW_ROUTING = 'WORKFLOW_ROUTING',
}

export enum InvocationStatus {
  COMPLETED = 'COMPLETED',
  /** Stopped by the client disconnecting. */
  CANCELLED = 'CANCELLED',
  /** The endpoint failed or timed out. */
  FAILED = 'FAILED',
  /** Refused before sending: redaction was unavailable and the policy fails closed. */
  REFUSED = 'REFUSED',
  /** Stopped by the gateway's egress check. */
  BLOCKED = 'BLOCKED',
  /**
   * Refused before sending by governance (phase 5): a token budget exhausted,
   * the token rate exceeded, or the agent's circuit open.
   */
  THROTTLED = 'THROTTLED',
}

/** Detailed per-stage timings and redaction statistics, for the benchmark. */
export interface InvocationMetrics {
  timings?: Record<string, number | null>;
  redaction?: {
    enabled: boolean;
    degraded: boolean;
    entities: number;
    occurrences: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    detectors: string[];
    cacheHits: number;
    segments: number;
  };
  placeholders?: { resolved: number; unresolved: number };
  context?: {
    contextWindow: number;
    budget: number;
    systemTokens: number;
    passageTokens: number;
    historyTokens: number;
    userTokens: number;
    passagesIncluded: number;
    passagesDropped: number;
    historyIncluded: number;
    historyExcluded: number;
  };
  parameters?: Record<string, number | string | boolean | string[] | undefined>;
  reasoningRemoved?: boolean;
  promptTemplateVersion?: number;
  /** Reason → act loop: how many model calls the answer took, and the tools called. */
  toolLoop?: {
    iterations: number;
    toolCalls: number;
    denied: number;
    failed: number;
    finishedBy: string;
  };
}

/**
 * The usage ledger: one row per call to a language model, including the ones
 * refused or blocked before anything was sent.
 *
 * Holds **no content** — no prompt, no answer, no redacted values — only who,
 * which model, how many tokens, how long each stage took, and what the privacy
 * layer did. That is what the proposal's benchmarking commitment needs ("the
 * exact processing time added by the PII Redaction Engine layer"), what phase
 * 5's token quotas will be enforced against, and what the Command Centre will
 * chart.
 *
 * Deliberately no foreign keys to agents or conversations: usage must survive
 * their deletion, exactly as billing records would.
 */
@Entity('llm_invocations')
@Index('idx_llm_invocations_org_created', ['organizationId', 'createdAt'])
export class LlmInvocation {
  /** Assigned by the caller, so the audit record and the message can reference it. */
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'varchar', length: 16, name: 'purpose' })
  purpose: InvocationPurpose;

  @Column({ type: 'varchar', length: 16, name: 'status' })
  status: InvocationStatus;

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

  @Column({ type: 'uuid', name: 'message_id', nullable: true })
  messageId: string | null;

  /** The workflow run this call belonged to (phase 4), for per-run token accounting. */
  @Column({ type: 'uuid', name: 'workflow_run_id', nullable: true })
  workflowRunId?: string | null;

  @Column({ type: 'uuid', name: 'workflow_step_id', nullable: true })
  workflowStepId?: string | null;

  /** Reason → act iteration within one answer; 1 for an answer without tools. */
  @Column({ type: 'smallint', name: 'iteration', nullable: true })
  iteration?: number | null;

  @Column({ type: 'varchar', length: 16, name: 'provider' })
  provider: string;

  @Column({ type: 'varchar', length: 200, name: 'model' })
  model: string;

  @Column({ type: 'varchar', length: 64, name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'varchar', length: 32, name: 'finish_reason', nullable: true })
  finishReason: string | null;

  @Column({ type: 'integer', name: 'prompt_tokens', default: 0 })
  promptTokens: number;

  @Column({ type: 'integer', name: 'completion_tokens', default: 0 })
  completionTokens: number;

  @Column({ type: 'boolean', name: 'tokens_estimated', default: false })
  tokensEstimated: boolean;

  @Column({ type: 'boolean', name: 'streamed', default: false })
  streamed: boolean;

  // ── Headline timings (ms), as columns so percentiles are plain SQL ────────

  @Column({ type: 'integer', name: 'total_ms', nullable: true })
  totalMs: number | null;

  @Column({ type: 'integer', name: 'ttft_ms', nullable: true })
  ttftMs: number | null;

  @Column({ type: 'integer', name: 'queue_ms', nullable: true })
  queueMs: number | null;

  @Column({ type: 'integer', name: 'retrieval_ms', nullable: true })
  retrievalMs: number | null;

  /** Detection + masking + egress check + unmasking: the PII engine's cost. */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    name: 'redaction_ms',
    nullable: true,
  })
  redactionMs: string | null;

  @Column({ type: 'integer', name: 'entities_masked', default: 0 })
  entitiesMasked: number;

  @Column({ type: 'boolean', name: 'redaction_degraded', default: false })
  redactionDegraded: boolean;

  @Column({ type: 'jsonb', name: 'metrics', default: () => "'{}'::jsonb" })
  metrics: InvocationMetrics;
}
