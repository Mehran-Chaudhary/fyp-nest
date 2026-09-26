import type { ErrorCode } from '../../../common/enums/error-code.enum';
import type { TaskPassage } from '../../agents/agent-task.service';
import type { InformationLabel } from '../../agents/domain/labels';
import type { MessageToolCall } from '../../agents/entities/conversation-message.entity';
import type { AccessPrincipal } from '../../knowledge/domain/access';
import type { Integrity } from '../../tools/domain/information-flow';
import type { WorkflowNode } from '../domain/graph';
import type { CompiledGraph } from '../domain/graph-validation';
import type { FailureClass } from '../domain/run-state';
import type { WorkflowRun } from '../entities/workflow-run.entity';
import type { StepApproval, WorkflowStep } from '../entities/workflow-step.entity';

/** What a step hands on, sealed under the run key. */
export interface StepOutputEnvelope {
  /** Read by later templates as `{{nodes.<id>.output}}`. */
  value: unknown;
  /** A retrieval node's passages, which a following agent reads as reference material. */
  passages?: TaskPassage[];
}

export interface StepMeta {
  agentId?: string;
  agentVersion?: number;
  toolId?: string;
  toolVersion?: number;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  invocationIds: string[];
  toolCalls: MessageToolCall[];
  /** Content-free facts for the audit record: the rule matched, the worker chosen. */
  facts?: Record<string, string | number | boolean | null>;
}

export type NodeResult =
  | {
      kind: 'done';
      output: StepOutputEnvelope;
      handles: string[];
      label: InformationLabel;
      integrity: Integrity;
      /** What the step was given (a rendered prompt, tool arguments): sealed for inspection. */
      input: unknown;
      meta: StepMeta;
    }
  | {
      kind: 'waiting';
      approval: StepApproval;
      input: unknown;
      label: InformationLabel;
      integrity: Integrity;
    };

/** Everything a node executor needs for one step. */
export interface StepContext {
  run: WorkflowRun;
  step: WorkflowStep;
  node: WorkflowNode;
  graph: CompiledGraph;
  principal: AccessPrincipal;
  /** The run's data key, for opening earlier outputs. Zeroed after the step. */
  key: Buffer;
  /** Every step of the run, metadata only. */
  steps: WorkflowStep[];
  actorLabel: string;
  signal: AbortSignal;
}

/**
 * A step failure with an explicit class. Transient and timeout failures are
 * retried with backoff; policy and permanent ones are not.
 */
export class StepFailure extends Error {
  constructor(
    readonly code: ErrorCode | string,
    readonly failureClass: FailureClass,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StepFailure';
  }
}

/** The run exhausted its token budget: the circuit breaker opens for the whole run. */
export class RunBudgetExceeded extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(`The run used ${used} tokens of its ${limit}-token budget.`);
    this.name = 'RunBudgetExceeded';
  }
}
