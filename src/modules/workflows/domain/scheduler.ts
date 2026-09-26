import type { CompiledGraph } from './graph-validation';
import { handleOf, HANDLE, workerHandle, type WorkflowEdge } from './graph';
import { isStepTerminal, StepStatus } from './run-state';

/** What the scheduler needs to know about one step. */
export interface StepSnapshot {
  nodeId: string;
  iteration: number;
  status: StepStatus;
  /** The outcomes this step took — which of its outgoing edges are live. */
  handles: readonly string[];
}

export interface StepRef {
  nodeId: string;
  iteration: number;
}

export interface PlannedStep extends StepRef {
  status: StepStatus.QUEUED | StepStatus.SKIPPED;
  /** The steps whose completion made this one ready or skipped: the trace's edges. */
  predecessors: StepRef[];
}

export interface ScheduleOutcome {
  create: PlannedStep[];
  /** Nothing is in flight and nothing more can become ready. */
  settled: boolean;
  /** Settled, and at least one output node succeeded. */
  succeeded: boolean;
}

type Readiness = { kind: 'wait' } | { kind: 'ready' | 'skip'; predecessors: StepRef[] };

const WAIT: Readiness = { kind: 'wait' };

/**
 * Decides which steps become ready — and which are skipped — given every
 * step recorded so far. A pure function of the graph and the recorded state:
 * the engine calls it after each step completes, inside a transaction that
 * locks the run, and inserts what it returns.
 *
 * Because it recomputes from the whole state rather than reacting to one
 * event, a lost or duplicated event cannot strand or double-schedule a run:
 * the next call finds exactly what is missing. (Step ids are derived from
 * `(run, node, iteration)`, so an insert of a step that already exists is a
 * no-op as well.)
 *
 * ## Semantics
 *
 *  - **Joins.** A node runs once all its incoming edges are resolved (their
 *    source steps finished) and at least one of them is live. If all are
 *    resolved and none is live, the node is skipped, and so are the paths
 *    below it: dead-path elimination, as in BPMN and Airflow.
 *  - **Branches.** A condition makes exactly one of its handles live; an
 *    approval, `approved` or `rejected`; a failed step with an `error` edge,
 *    only that edge.
 *  - **Loops.** A condition-controlled back edge re-runs its single-entry,
 *    single-exit body with the iteration number increased. Edges leaving the
 *    body wait until the condition takes an exit.
 *  - **Supervisors.** Each round, the supervisor hands the turn to one worker
 *    (`worker:<id>`); the worker's completion starts the next round; `done`
 *    leaves the supervisor.
 */
export function schedule(
  graph: CompiledGraph,
  steps: readonly StepSnapshot[],
): ScheduleOutcome {
  const key = (nodeId: string, iteration: number) => `${nodeId}#${iteration}`;
  const byKey = new Map<string, StepSnapshot>();
  const byNode = new Map<string, StepSnapshot[]>();
  const index = (step: StepSnapshot) => {
    byKey.set(key(step.nodeId, step.iteration), step);
    byNode.set(step.nodeId, [...(byNode.get(step.nodeId) ?? []), step]);
  };
  steps.forEach(index);

  const latest = (nodeId: string): StepSnapshot | undefined =>
    (byNode.get(nodeId) ?? []).reduce<StepSnapshot | undefined>(
      (best, step) => (!best || step.iteration > best.iteration ? step : best),
      undefined,
    );

  const candidateIterations = (nodeId: string): number[] => {
    const supervisorId = graph.supervisorOf.get(nodeId);
    if (supervisorId) {
      return (byNode.get(supervisorId) ?? [])
        .filter(
          (step) =>
            step.status === StepStatus.SUCCEEDED &&
            step.handles.includes(workerHandle(nodeId)),
        )
        .map((step) => step.iteration);
    }

    if (graph.supervisors.has(nodeId)) {
      const next = (byNode.get(nodeId) ?? [])
        .filter((step) => step.status === StepStatus.SUCCEEDED)
        .flatMap((step) => {
          const worker = step.handles.find((handle) =>
            handle.startsWith(`${HANDLE.WORKER}:`),
          );
          if (!worker) return [];
          const workerStep = byKey.get(
            key(worker.slice(HANDLE.WORKER.length + 1), step.iteration),
          );
          return workerStep?.status === StepStatus.SUCCEEDED ? [step.iteration + 1] : [];
        });
      return [0, ...next];
    }

    const loop = graph.loopOf.get(nodeId);
    if (loop && loop.head === nodeId) {
      const again = (byNode.get(loop.tail) ?? [])
        .filter(
          (step) =>
            step.status === StepStatus.SUCCEEDED &&
            step.handles.includes(loop.ruleId) &&
            step.iteration + 1 <= loop.maxIterations,
        )
        .map((step) => step.iteration + 1);
      return [0, ...again];
    }
    if (loop) return (byNode.get(loop.head) ?? []).map((step) => step.iteration);

    return [0];
  };

  const readiness = (nodeId: string, iteration: number): Readiness => {
    const supervisorId = graph.supervisorOf.get(nodeId);
    if (supervisorId) {
      return { kind: 'ready', predecessors: [{ nodeId: supervisorId, iteration }] };
    }
    if (graph.supervisors.has(nodeId) && iteration > 0) {
      const previous = byKey.get(key(nodeId, iteration - 1));
      const worker = previous?.handles
        .find((handle) => handle.startsWith(`${HANDLE.WORKER}:`))
        ?.slice(HANDLE.WORKER.length + 1);
      return worker
        ? { kind: 'ready', predecessors: [{ nodeId: worker, iteration: iteration - 1 }] }
        : WAIT;
    }
    const loop = graph.loopOf.get(nodeId);
    if (loop && loop.head === nodeId && iteration > 0) {
      return {
        kind: 'ready',
        predecessors: [{ nodeId: loop.tail, iteration: iteration - 1 }],
      };
    }

    const incoming = graph.incoming.get(nodeId) ?? [];
    if (incoming.length === 0) return WAIT;

    const predecessors: StepRef[] = [];
    let live = false;
    for (const edge of incoming) {
      const resolved = resolveEdge(edge, nodeId, iteration);
      if (resolved === null) return WAIT;
      predecessors.push({
        nodeId: resolved.step.nodeId,
        iteration: resolved.step.iteration,
      });
      live ||= resolved.live;
    }
    return { kind: live ? 'ready' : 'skip', predecessors };
  };

  /** The source step an edge depends on, whether it is finished, and whether the edge is live. */
  const resolveEdge = (
    edge: WorkflowEdge,
    target: string,
    iteration: number,
  ): { step: StepSnapshot; live: boolean } | null => {
    const sourceLoop = graph.loopOf.get(edge.source);
    const targetLoop = graph.loopOf.get(target);
    const handle = handleOf(edge);

    let step: StepSnapshot | undefined;
    if (sourceLoop && sourceLoop === targetLoop) {
      step = byKey.get(key(edge.source, iteration));
    } else if (sourceLoop) {
      // Leaving a loop: only once the condition takes an exit.
      step = latest(edge.source);
      if (step && step.handles.includes(sourceLoop.ruleId)) return null;
    } else if (graph.supervisors.has(edge.source)) {
      // Leaving a supervisor: only once it has finished its rounds.
      step = latest(edge.source);
      if (step && step.handles.some((h) => h.startsWith(`${HANDLE.WORKER}:`))) return null;
    } else {
      step = byKey.get(key(edge.source, 0));
    }

    if (!step || !isStepTerminal(step.status)) return null;
    return { step, live: step.handles.includes(handle) };
  };

  const create: PlannedStep[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of graph.order) {
      if (nodeId === graph.trigger.id) continue;
      for (const iteration of candidateIterations(nodeId)) {
        if (byKey.has(key(nodeId, iteration))) continue;
        const decision = readiness(nodeId, iteration);
        if (decision.kind === 'wait') continue;
        const planned: PlannedStep = {
          nodeId,
          iteration,
          status: decision.kind === 'ready' ? StepStatus.QUEUED : StepStatus.SKIPPED,
          predecessors: decision.predecessors,
        };
        create.push(planned);
        index({ nodeId, iteration, status: planned.status, handles: [] });
        changed = true;
      }
    }
  }

  const all = [...byKey.values()];
  const settled = all.every((step) => isStepTerminal(step.status));
  const succeeded =
    settled &&
    graph.outputs.some((output) =>
      (byNode.get(output) ?? []).some((step) => step.status === StepStatus.SUCCEEDED),
    );
  return { create, settled, succeeded };
}

/** For each node, the output a template may read in step `nodeId@iteration`. */
export function visibleStep(
  graph: CompiledGraph,
  steps: readonly StepSnapshot[],
  reader: StepRef,
  nodeId: string,
): StepSnapshot | undefined {
  const sameLoop =
    graph.loopOf.get(nodeId) !== undefined &&
    graph.loopOf.get(nodeId) === graph.loopOf.get(reader.nodeId);
  return steps
    .filter(
      (step) =>
        step.nodeId === nodeId &&
        step.status === StepStatus.SUCCEEDED &&
        // Inside a shared loop: this iteration's value if it exists, else the previous one's.
        (!sameLoop || step.iteration <= reader.iteration),
    )
    .reduce<StepSnapshot | undefined>(
      (best, step) => (!best || step.iteration > best.iteration ? step : best),
      undefined,
    );
}
