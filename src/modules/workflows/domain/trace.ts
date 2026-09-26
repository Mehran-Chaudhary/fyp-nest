/**
 * Rebuilding a run's trace from the audit log alone.
 *
 * The implementation plan's first exit criterion for phase 4: *a three-agent
 * workflow completes end to end and its full trace is reconstructible from
 * the audit log alone*. The audit log is the evidence that survives — it is
 * hash-chained and append-only, while runs can be deleted — so every fact
 * needed to redraw the run is written there as it happens:
 *
 *  - `workflow.execution.started` — the workflow, its version and definition
 *    digest, and who started it (the record's actor);
 *  - `workflow.step.completed` / `workflow.step.failed` — each step: node,
 *    iteration, attempts, the steps that made it ready, the outcome it took,
 *    the agent or tool version it ran, the tool calls it made, its tokens;
 *  - `tool.executed` / `tool.execution.denied` / `tool.execution.failed` —
 *    each tool call, keyed back to its step;
 *  - `workflow.approval.*` — who decided, and what;
 *  - the run's final record, with its step count and the steps skipped.
 *
 * None of it is content: the trace says *what happened*, never what was said.
 */

export interface AuditLike {
  sequence: string | number;
  action: string;
  status: string;
  actorId: string | null;
  actorType?: string | null;
  resourceId: string | null;
  errorCode?: string | null;
  createdAt?: Date | string;
  metadata: Record<string, unknown>;
}

export interface TraceToolCall {
  executionId: string;
  tool: string;
  outcome: 'executed' | 'failed' | 'denied';
  reason?: string;
}

export interface TraceStep {
  stepId: string;
  nodeId: string;
  nodeType: string;
  iteration: number;
  /** The step's settled status, or `RETRYING` when its last record is a failed attempt. */
  status: string;
  attempts: number;
  /** `nodeId#iteration` of the steps that made this one ready. */
  predecessors: string[];
  handles: string[];
  agentId?: string;
  agentVersion?: number;
  toolId?: string;
  toolVersion?: number;
  model?: string;
  tokens?: number;
  durationMs?: number;
  errorCode?: string;
  toolCalls: TraceToolCall[];
}

export interface TraceApproval {
  stepId: string;
  decision: 'requested' | 'granted' | 'rejected';
  actorId: string | null;
}

export interface RunTrace {
  runId: string;
  workflowId: string | null;
  workflowVersion: number | null;
  definitionDigest: string | null;
  startedBy: string | null;
  finalStatus: string | null;
  steps: TraceStep[];
  edges: Array<{ from: string; to: string }>;
  approvals: TraceApproval[];
  skipped: string[];
  /** Times the run was resumed after failing. */
  resumptions: number;
  /** Every fact the run's final record promised is present. */
  complete: boolean;
  problems: string[];
}

const STARTED = 'workflow.execution.started';
const RESUMED = 'workflow.execution.resumed';
const FINISHED = new Set([
  'workflow.execution.completed',
  'workflow.execution.failed',
  'workflow.execution.cancelled',
  'workflow.execution.timed_out',
]);
const STEP = new Set(['workflow.step.completed', 'workflow.step.failed']);
const TOOL: Record<string, TraceToolCall['outcome']> = {
  'tool.executed': 'executed',
  'tool.execution.failed': 'failed',
  'tool.execution.denied': 'denied',
};
const RETRYING = 'RETRYING';
const PENDING = 'PENDING';
const APPROVAL: Record<string, TraceApproval['decision']> = {
  'workflow.approval.requested': 'requested',
  'workflow.approval.granted': 'granted',
  'workflow.approval.rejected': 'rejected',
};

export function reconstructTrace(runId: string, records: readonly AuditLike[]): RunTrace {
  const ordered = [...records].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const problems: string[] = [];
  const trace: RunTrace = {
    runId,
    workflowId: null,
    workflowVersion: null,
    definitionDigest: null,
    startedBy: null,
    finalStatus: null,
    steps: [],
    edges: [],
    approvals: [],
    skipped: [],
    resumptions: 0,
    complete: false,
    problems,
  };

  const steps = new Map<string, TraceStep>();
  let expectedSteps: number | null = null;

  for (const record of ordered) {
    const metadata = record.metadata ?? {};
    const belongs = record.resourceId === runId || metadata.runId === runId;
    if (!belongs) continue;

    if (record.action === STARTED) {
      trace.workflowId = str(metadata.workflowId);
      trace.workflowVersion = num(metadata.workflowVersion);
      trace.definitionDigest = str(metadata.definitionDigest);
      trace.startedBy = record.actorId;
    } else if (record.action === RESUMED) {
      trace.resumptions += 1;
    } else if (FINISHED.has(record.action)) {
      trace.finalStatus = str(metadata.status) ?? record.action.split('.').pop() ?? null;
      expectedSteps = num(metadata.steps);
      trace.skipped = Array.isArray(metadata.skipped) ? metadata.skipped.map(String) : [];
    } else if (STEP.has(record.action)) {
      const stepId = str(metadata.stepId) ?? record.resourceId ?? '';
      const existing = steps.get(stepId);
      // A failed attempt that will be retried is a fact, not an outcome.
      const final = metadata.final !== false;
      const step: TraceStep = {
        stepId,
        nodeId: str(metadata.nodeId) ?? '?',
        nodeType: str(metadata.nodeType) ?? '?',
        iteration: num(metadata.iteration) ?? 0,
        status: !final
          ? RETRYING
          : (str(metadata.status) ??
            (record.action === 'workflow.step.failed' ? 'FAILED' : 'SUCCEEDED')),
        attempts: num(metadata.attempt) ?? 1,
        predecessors: Array.isArray(metadata.predecessors)
          ? metadata.predecessors.map(String)
          : [],
        handles: Array.isArray(metadata.handles) ? metadata.handles.map(String) : [],
        ...(str(metadata.agentId) ? { agentId: str(metadata.agentId) as string } : {}),
        ...(num(metadata.agentVersion) !== null
          ? { agentVersion: num(metadata.agentVersion) as number }
          : {}),
        ...(str(metadata.toolId) ? { toolId: str(metadata.toolId) as string } : {}),
        ...(num(metadata.toolVersion) !== null
          ? { toolVersion: num(metadata.toolVersion) as number }
          : {}),
        ...(str(metadata.model) ? { model: str(metadata.model) as string } : {}),
        ...(num(metadata.tokens) !== null
          ? { tokens: num(metadata.tokens) as number }
          : {}),
        ...(num(metadata.durationMs) !== null
          ? { durationMs: num(metadata.durationMs) as number }
          : {}),
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
        // Tool calls recorded before this step's own record are kept.
        toolCalls: existing?.toolCalls ?? [],
      };
      steps.set(stepId, step);
    } else if (record.action in TOOL) {
      const stepId = str(metadata.stepId);
      if (!stepId) continue;
      const call: TraceToolCall = {
        executionId: str(metadata.executionId) ?? '?',
        tool: str(metadata.toolName) ?? '?',
        outcome: TOOL[record.action],
        ...(str(metadata.reason) ? { reason: str(metadata.reason) as string } : {}),
      };
      const step = steps.get(stepId);
      if (step) step.toolCalls.push(call);
      else {
        steps.set(stepId, {
          stepId,
          nodeId: '?',
          nodeType: '?',
          iteration: 0,
          status: PENDING,
          attempts: 0,
          predecessors: [],
          handles: [],
          toolCalls: [call],
        });
      }
    } else if (record.action in APPROVAL) {
      trace.approvals.push({
        stepId: str(metadata.stepId) ?? '?',
        decision: APPROVAL[record.action],
        actorId: record.actorId,
      });
    }
  }

  trace.steps = [...steps.values()];
  const keys = new Set(trace.steps.map((step) => `${step.nodeId}#${step.iteration}`));
  const skipped = new Set(trace.skipped);
  for (const step of trace.steps) {
    if (step.nodeId === '?') {
      problems.push(
        `Tool calls were recorded for step ${step.stepId}, but the step itself was not.`,
      );
    }
    for (const predecessor of step.predecessors) {
      trace.edges.push({ from: predecessor, to: `${step.nodeId}#${step.iteration}` });
      if (!keys.has(predecessor) && !skipped.has(predecessor)) {
        problems.push(
          `Step ${step.nodeId}#${step.iteration} names a predecessor, ${predecessor}, with no record.`,
        );
      }
    }
  }

  if (!trace.workflowId) problems.push('The run’s start was not recorded.');
  if (!trace.finalStatus) problems.push('The run’s end was not recorded.');
  // Steps that never settled (retrying when the run was cancelled) are not counted.
  const settled = trace.steps.filter(
    (step) => step.status !== RETRYING && step.status !== PENDING,
  ).length;
  if (expectedSteps !== null && expectedSteps !== settled) {
    problems.push(
      `The run recorded ${expectedSteps} steps; ${settled} settled step records were found.`,
    );
  }
  trace.complete = problems.length === 0;
  return trace;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
