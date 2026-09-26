import type { JsonSchema } from '../../tools/domain/json-schema';

/**
 * The workflow definition: the JSON graph the React Flow canvas produces
 * (proposal module 6.13), in the shape React Flow already uses — nodes with
 * `id`, `type`, `position` and `data`; edges with `source`, `target` and
 * optional handles — so the frontend can save and load its state directly.
 *
 * Contract: `docs/contracts/workflow-graph-v1.md`.
 */
export const GRAPH_SCHEMA_VERSION = 1;

export type NodeType =
  | 'trigger'
  | 'agent'
  | 'tool'
  | 'retrieval'
  | 'condition'
  | 'supervisor'
  | 'approval'
  | 'output';

export const NODE_TYPES: readonly NodeType[] = [
  'trigger',
  'agent',
  'tool',
  'retrieval',
  'condition',
  'supervisor',
  'approval',
  'output',
];

export interface RetryPolicy {
  /** Attempts in total, including the first. */
  maxAttempts?: number;
  /** Base delay before the first retry; doubled each time, with jitter. */
  backoffMs?: number;
}

export type OutputContract = { format: 'text' } | { format: 'json'; schema: JsonSchema };

export interface TriggerData {
  /** What a run's input must look like. Default: `{ "input": string }`. */
  inputSchema?: JsonSchema;
}

export interface AgentData {
  agentId: string;
  /**
   * The task, as a template: `{{input.question}}`, `{{nodes.research.output}}`.
   * Default: the run input for an agent fed by the trigger, otherwise the
   * outputs of its predecessors.
   */
  prompt?: string;
  /** Offer the agent's granted tools. Default true. */
  useTools?: boolean;
  maxToolIterations?: number;
  output?: OutputContract;
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export interface ToolData {
  toolId: string;
  /**
   * Arguments: literal JSON, or templates. A string that is exactly one
   * template keeps the referenced value's type (`"{{nodes.a.output.count}}"`
   * stays a number).
   */
  arguments: Record<string, unknown>;
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export interface RetrievalData {
  query: string;
  /** Narrows the search; the run's initiator must be able to read each. */
  knowledgeBaseIds?: string[];
  topK?: number;
}

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_true'
  | 'is_false'
  | 'is_empty'
  | 'is_not_empty';

export const CONDITION_OPERATORS: readonly ConditionOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_true',
  'is_false',
  'is_empty',
  'is_not_empty',
];

/** Operators that take no operand. */
export const UNARY_OPERATORS: ReadonlySet<ConditionOperator> = new Set([
  'is_true',
  'is_false',
  'is_empty',
  'is_not_empty',
]);

export interface ConditionRule {
  /** Also the source handle of the edge taken when this rule matches. */
  id: string;
  /** What to test, as a template, e.g. `{{nodes.review.output.approved}}`. */
  value: string;
  operator: ConditionOperator;
  operand?: string | number | boolean;
  caseSensitive?: boolean;
}

export interface ConditionData {
  /** Evaluated in order; the first match wins; none matching takes `else`. */
  rules: ConditionRule[];
}

export interface SupervisorData {
  /** `llm`: a model decides who acts next. `round_robin`: each worker in turn. */
  strategy: 'llm' | 'round_robin';
  /** Persona for the supervisor's decisions; default a neutral router. */
  agentId?: string;
  /** The team's goal, as a template. Default: the supervisor's inputs. */
  goal?: string;
  /** Worker turns at most. */
  maxRounds: number;
}

export interface ApprovalData {
  /** What approvers are asked, as a template. */
  message?: string;
  timeoutMs?: number;
  /** When nobody decides in time. Default reject. */
  onTimeout?: 'reject' | 'approve';
  /** Separation of duties: by default, whoever started the run cannot approve it. */
  allowSelfApproval?: boolean;
}

export interface OutputData {
  /** The run's result, as a template. Default: the predecessor's output. */
  value?: string;
}

interface NodeBase<T extends NodeType, D> {
  id: string;
  type: T;
  label?: string;
  position?: { x: number; y: number };
  data: D;
}

export type TriggerNode = NodeBase<'trigger', TriggerData>;
export type AgentNode = NodeBase<'agent', AgentData>;
export type ToolNode = NodeBase<'tool', ToolData>;
export type RetrievalNode = NodeBase<'retrieval', RetrievalData>;
export type ConditionNode = NodeBase<'condition', ConditionData>;
export type SupervisorNode = NodeBase<'supervisor', SupervisorData>;
export type ApprovalNode = NodeBase<'approval', ApprovalData>;
export type OutputNode = NodeBase<'output', OutputData>;

export type WorkflowNode =
  | TriggerNode
  | AgentNode
  | ToolNode
  | RetrievalNode
  | ConditionNode
  | SupervisorNode
  | ApprovalNode
  | OutputNode;

export interface LoopSpec {
  /** Times this edge may be taken; the loop body runs at most this plus one times. */
  maxIterations: number;
  /**
   * When the limit is reached: `fall_through` (default) evaluates the
   * condition as if this rule did not exist; `fail` fails the run.
   */
  onExhausted?: 'fall_through' | 'fail';
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Which outcome of the source this edge follows. Default `out`. */
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  data?: { loop?: LoopSpec };
}

export interface WorkflowGraph {
  schemaVersion: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Canvas state; stored, never interpreted. */
  viewport?: { x: number; y: number; zoom: number };
}

// ── Handles ─────────────────────────────────────────────────────────────────

export const HANDLE = {
  OUT: 'out',
  ERROR: 'error',
  ELSE: 'else',
  WORKER: 'worker',
  DONE: 'done',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export function handleOf(edge: Pick<WorkflowEdge, 'sourceHandle'>): string {
  return edge.sourceHandle && edge.sourceHandle.length > 0 ? edge.sourceHandle : HANDLE.OUT;
}

/** The handle a supervisor step records when it hands a round to `workerNodeId`. */
export function workerHandle(workerNodeId: string): string {
  return `${HANDLE.WORKER}:${workerNodeId}`;
}

export function isLoopEdge(edge: WorkflowEdge): boolean {
  return edge.data?.loop !== undefined;
}

export const DEFAULT_TRIGGER_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { input: { type: 'string', minLength: 1, maxLength: 32_000 } },
  required: ['input'],
  additionalProperties: false,
};
