import type { ErrorCode } from '../../../common/enums/error-code.enum';
import type { InformationLabel } from '../../agents/domain/labels';
import type { AccessPrincipal } from '../../knowledge/domain/access';
import type { Classification } from '../../knowledge/domain/classification';
import type { FlowContext, Integrity, ToolDataPolicy } from '../domain/information-flow';
import type { JsonSchema } from '../domain/json-schema';
import type { ToolDenialReason } from '../entities/tool-execution.entity';

/**
 * The bounds of the agent a call is made through, if any.
 *
 * An agent is a delegate (ADR 0003): what it may read is the user's access
 * *narrowed* by the agent's configuration. A tool that reads — knowledge
 * search — applies these bounds exactly as the agent's own retrieval does.
 */
export interface ToolAgentScope {
  id: string;
  version: number;
  name: string;
  knowledgeBaseIds: readonly string[];
  /** The lower of the agent's and the model endpoint's classification ceilings. */
  maxClassification: Classification;
}

/** Where a call came from, for the ledger, the audit record and idempotency. */
export interface ToolCallOrigin {
  conversationId?: string;
  runId?: string;
  stepId?: string;
  /** Reason → act iteration within one answer. */
  iteration?: number;
}

export interface BuiltinToolContext {
  principal: AccessPrincipal;
  agent: ToolAgentScope | null;
  flow: FlowContext;
  origin: ToolCallOrigin;
  /** Who the action is on behalf of, for provenance in anything sent. */
  actorLabel: string;
  signal: AbortSignal;
}

/** A tool's successful result. */
export interface ToolOutput {
  /** Text for the model. Escaped and masked by the engine before it enters a prompt. */
  content: string;
  /** Structured form, for workflow steps that consume the result directly. */
  data?: unknown;
  /** The sensitivity of what the result contains; PUBLIC when absent. */
  label?: InformationLabel;
  /** Content-free facts for the ledger: counts, statuses, hosts. */
  metadata?: Record<string, unknown>;
}

/**
 * A failure the model should hear about: bad input it can correct, a denial,
 * a dependency that is down. Reported as the tool's observation rather than
 * thrown out of the turn.
 */
export class ToolRuntimeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { retryable?: boolean; denial?: ToolDenialReason } = {},
  ) {
    super(message);
    this.name = 'ToolRuntimeError';
  }
}

/** The static half of a built-in tool: what it is, and what it accepts. */
export interface BuiltinToolDefinition {
  name: string;
  displayName: string;
  description: string;
  parameters: JsonSchema;
  dataPolicy: ToolDataPolicy;
  resultIntegrity: Integrity;
  requiresApproval: boolean;
  requiredPermissions: string[];
  timeoutMs: number;
  /** Calls allowed per agent answer or workflow run, below the platform-wide ceiling. */
  maxCallsPerRun?: number;
}

export interface BuiltinTool {
  readonly definition: BuiltinToolDefinition;
  /** False when a dependency is not configured; the tool is then not offered. */
  isAvailable(): boolean;
  execute(args: Record<string, unknown>, context: BuiltinToolContext): Promise<ToolOutput>;
}

export const BUILTIN_TOOLS = Symbol('BUILTIN_TOOLS');
