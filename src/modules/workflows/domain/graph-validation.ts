import { isUuid } from '../../../common/utils/uuid.util';
import {
  checkSchema,
  isPlainObject,
  type JsonSchema,
} from '../../tools/domain/json-schema';
import {
  CONDITION_OPERATORS,
  DEFAULT_TRIGGER_SCHEMA,
  GRAPH_SCHEMA_VERSION,
  HANDLE,
  handleOf,
  isLoopEdge,
  NODE_TYPES,
  UNARY_OPERATORS,
  type ConditionRule,
  type LoopSpec,
  type NodeType,
  type OutputContract,
  type RetryPolicy,
  type SupervisorNode,
  type TriggerNode,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph';
import { parseTemplate, templatesIn, TemplateError, type TemplateRef } from './templates';

export interface GraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxLoopIterations: number;
  maxSupervisorRounds: number;
  maxSteps: number;
  maxToolIterations: number;
  maxStepTimeoutMs: number;
  maxStepAttempts: number;
}

export interface GraphIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/** A loop: a condition-controlled back edge over a single-entry, single-exit region. */
export interface CompiledLoop {
  edgeId: string;
  /** The loop's entry node: the back edge's target. */
  head: string;
  /** The condition node that decides, each iteration, whether to go round again. */
  tail: string;
  /** The condition rule whose handle is the back edge. */
  ruleId: string;
  body: ReadonlySet<string>;
  maxIterations: number;
  onExhausted: 'fall_through' | 'fail';
}

export type OutputKind = 'json' | 'text' | 'passages' | 'none';

/** A validated graph, indexed for the scheduler. */
export interface CompiledGraph {
  graph: WorkflowGraph;
  nodes: ReadonlyMap<string, WorkflowNode>;
  trigger: TriggerNode;
  outputs: readonly string[];
  /** Data edges into each node: loop back edges and supervisor worker edges excluded. */
  incoming: ReadonlyMap<string, readonly WorkflowEdge[]>;
  outgoing: ReadonlyMap<string, readonly WorkflowEdge[]>;
  loops: readonly CompiledLoop[];
  loopOf: ReadonlyMap<string, CompiledLoop>;
  supervisors: ReadonlyMap<string, { node: SupervisorNode; workers: readonly string[] }>;
  supervisorOf: ReadonlyMap<string, string>;
  /** Topological order of the acyclic core; workers follow their supervisor. */
  order: readonly string[];
  ancestors: ReadonlyMap<string, ReadonlySet<string>>;
  outputKinds: ReadonlyMap<string, OutputKind>;
  /** Worst-case steps a run can schedule. */
  stepBound: number;
  references: { agentIds: string[]; toolIds: string[]; knowledgeBaseIds: string[] };
}

export interface GraphReport {
  valid: boolean;
  errors: GraphIssue[];
  warnings: GraphIssue[];
  /** The graph with unknown properties removed: what is stored. */
  normalized: WorkflowGraph | null;
  compiled: CompiledGraph | null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RULE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const RESERVED_HANDLES: ReadonlySet<string> = new Set(Object.values(HANDLE));

/**
 * Validates a workflow definition and compiles it for execution.
 *
 * Checked, in order: shape and size; each node's configuration; edges and
 * their handles; one trigger and at least one output; supervisors and their
 * workers; loops (each an explicit, bounded, condition-controlled back edge
 * over a single-entry, single-exit region); acyclicity of everything else;
 * reachability; template references (each must precede its use); and type
 * compatibility (passages go to agents, text has no fields). References to
 * agents, tools and knowledge bases are returned for the caller to check
 * against the workspace.
 */
export function validateGraph(raw: unknown, limits: GraphLimits): GraphReport {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const fail = (): GraphReport => ({
    valid: false,
    errors,
    warnings,
    normalized: null,
    compiled: null,
  });

  // ── Shape ──────────────────────────────────────────────────────────────
  if (!isPlainObject(raw)) {
    errors.push({
      code: 'GRAPH_INVALID',
      message: 'The definition must be an object with nodes and edges.',
    });
    return fail();
  }
  const version = raw.schemaVersion ?? GRAPH_SCHEMA_VERSION;
  if (version !== GRAPH_SCHEMA_VERSION) {
    errors.push({
      code: 'GRAPH_VERSION',
      message: `Unsupported schemaVersion ${describeValue(version)}; expected ${GRAPH_SCHEMA_VERSION}.`,
    });
    return fail();
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    errors.push({ code: 'GRAPH_INVALID', message: '"nodes" and "edges" must be arrays.' });
    return fail();
  }
  if (raw.nodes.length > limits.maxNodes) {
    errors.push({
      code: 'LIMIT_EXCEEDED',
      message: `A workflow may have at most ${limits.maxNodes} nodes.`,
    });
  }
  if (raw.edges.length > limits.maxEdges) {
    errors.push({
      code: 'LIMIT_EXCEEDED',
      message: `A workflow may have at most ${limits.maxEdges} edges.`,
    });
  }
  if (errors.length > 0) return fail();

  // ── Nodes ──────────────────────────────────────────────────────────────
  const nodes = new Map<string, WorkflowNode>();
  for (const [index, rawNode] of raw.nodes.entries()) {
    const node = normalizeNode(rawNode, index, limits, errors);
    if (!node) continue;
    if (nodes.has(node.id)) {
      errors.push({
        code: 'NODE_DUPLICATE',
        message: `Two nodes have the id "${node.id}".`,
        nodeId: node.id,
      });
      continue;
    }
    nodes.set(node.id, node);
  }

  // ── Edges ──────────────────────────────────────────────────────────────
  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  for (const [index, rawEdge] of raw.edges.entries()) {
    const edge = normalizeEdge(rawEdge, index, limits, errors);
    if (!edge) continue;
    if (edgeIds.has(edge.id)) {
      errors.push({
        code: 'EDGE_DUPLICATE',
        message: `Two edges have the id "${edge.id}".`,
        edgeId: edge.id,
      });
      continue;
    }
    edgeIds.add(edge.id);
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      errors.push({
        code: 'EDGE_DANGLING',
        message: `Edge "${edge.id}" connects to a node that does not exist.`,
        edgeId: edge.id,
      });
      continue;
    }
    if (edge.source === edge.target) {
      errors.push({
        code: 'EDGE_INVALID',
        message: 'A node cannot connect to itself.',
        edgeId: edge.id,
      });
      continue;
    }
    const key = `${edge.source}|${handleOf(edge)}|${edge.target}`;
    if (edgeKeys.has(key)) {
      errors.push({
        code: 'EDGE_DUPLICATE',
        message: 'Two edges connect the same outcome to the same node.',
        edgeId: edge.id,
      });
      continue;
    }
    edgeKeys.add(key);
    checkHandle(source, target, edge, errors);
    edges.push(edge);
  }
  if (errors.length > 0) return fail();

  // ── One trigger, at least one output ───────────────────────────────────
  const triggers = [...nodes.values()].filter(
    (node): node is TriggerNode => node.type === 'trigger',
  );
  if (triggers.length !== 1) {
    errors.push({
      code: triggers.length === 0 ? 'TRIGGER_MISSING' : 'TRIGGER_MULTIPLE',
      message: 'A workflow has exactly one trigger node.',
    });
  }
  const outputs = [...nodes.values()]
    .filter((node) => node.type === 'output')
    .map((node) => node.id);
  if (outputs.length === 0) {
    errors.push({
      code: 'OUTPUT_MISSING',
      message: 'A workflow needs at least one output node.',
    });
  }
  for (const edge of edges) {
    if (nodes.get(edge.target)?.type === 'trigger') {
      errors.push({
        code: 'EDGE_INVALID',
        message: 'Nothing may connect into the trigger.',
        edgeId: edge.id,
      });
    }
  }
  if (errors.length > 0) return fail();
  const trigger = triggers[0];

  const outgoing = groupBy(edges, (edge) => edge.source);

  // ── Supervisors and their workers ──────────────────────────────────────
  const supervisors = new Map<string, { node: SupervisorNode; workers: string[] }>();
  const supervisorOf = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.type !== 'supervisor') continue;
    const workerEdges = (outgoing.get(node.id) ?? []).filter(
      (edge) => handleOf(edge) === HANDLE.WORKER,
    );
    if (workerEdges.length === 0) {
      errors.push({
        code: 'SUPERVISOR_INVALID',
        message:
          'A supervisor needs at least one worker (an edge from its "worker" handle to an agent).',
        nodeId: node.id,
      });
      continue;
    }
    const workers: string[] = [];
    for (const edge of workerEdges) {
      const worker = nodes.get(edge.target) as WorkflowNode;
      if (worker.type !== 'agent') {
        errors.push({
          code: 'SUPERVISOR_INVALID',
          message: 'A supervisor’s workers must be agent nodes.',
          edgeId: edge.id,
        });
        continue;
      }
      if (supervisorOf.has(worker.id)) {
        errors.push({
          code: 'SUPERVISOR_INVALID',
          message: 'An agent can work for one supervisor only.',
          nodeId: worker.id,
        });
        continue;
      }
      supervisorOf.set(worker.id, node.id);
      workers.push(worker.id);
    }
    supervisors.set(node.id, { node, workers });
  }
  for (const [workerId, supervisorId] of supervisorOf) {
    const into = edges.filter((edge) => edge.target === workerId);
    const outOf = outgoing.get(workerId) ?? [];
    if (into.length !== 1 || into[0].source !== supervisorId || outOf.length > 0) {
      errors.push({
        code: 'SUPERVISOR_INVALID',
        message:
          'A worker is connected only to its supervisor: one incoming edge from the supervisor, ' +
          'and no outgoing edges (its result goes back to the supervisor).',
        nodeId: workerId,
      });
    }
  }
  if (errors.length > 0) return fail();

  // ── The acyclic core: everything but loop back edges ───────────────────
  const coreEdges = edges.filter((edge) => !isLoopEdge(edge));
  const order = topologicalOrder([...nodes.keys()], coreEdges);
  if (!order) {
    errors.push({
      code: 'CYCLE',
      message:
        'The workflow has a cycle. Repetition must be an explicit loop: an edge from a ' +
        'condition rule back to an earlier node, marked with a maximum number of iterations.',
    });
    return fail();
  }
  const ancestors = computeAncestors(order, coreEdges);

  // ── Loops ──────────────────────────────────────────────────────────────
  const loops: CompiledLoop[] = [];
  const loopOf = new Map<string, CompiledLoop>();
  for (const edge of edges.filter(isLoopEdge)) {
    const loop = compileLoop(edge, nodes, coreEdges, ancestors, limits, errors);
    if (!loop) continue;
    for (const member of loop.body) {
      if (loopOf.has(member)) {
        errors.push({
          code: 'LOOP_INVALID',
          message: 'Loops may not overlap or nest.',
          nodeId: member,
          edgeId: edge.id,
        });
      } else if (supervisorOf.has(member) || nodes.get(member)?.type === 'supervisor') {
        errors.push({
          code: 'LOOP_INVALID',
          message: 'A loop may not contain a supervisor or its workers.',
          nodeId: member,
          edgeId: edge.id,
        });
      }
    }
    loops.push(loop);
    for (const member of loop.body) if (!loopOf.has(member)) loopOf.set(member, loop);
  }
  for (const loop of loops) {
    // Single entry: only the head is entered from outside the body.
    for (const edge of coreEdges) {
      if (
        loop.body.has(edge.target) &&
        !loop.body.has(edge.source) &&
        edge.target !== loop.head
      ) {
        errors.push({
          code: 'LOOP_INVALID',
          message: `A loop is entered only at its first node ("${loop.head}").`,
          edgeId: edge.id,
        });
      }
      // Single exit: only the deciding condition leaves the body.
      if (
        loop.body.has(edge.source) &&
        !loop.body.has(edge.target) &&
        edge.source !== loop.tail
      ) {
        errors.push({
          code: 'LOOP_INVALID',
          message: `A loop is left only through its condition ("${loop.tail}").`,
          edgeId: edge.id,
        });
      }
    }
  }
  if (errors.length > 0) return fail();

  // ── Reachability ───────────────────────────────────────────────────────
  const reachable = reach(trigger.id, edges, 'forward');
  for (const node of nodes.values()) {
    if (!reachable.has(node.id)) {
      errors.push({
        code: 'UNREACHABLE',
        message: 'This node can never run: nothing leads to it from the trigger.',
        nodeId: node.id,
      });
    }
  }
  const reachesOutput = new Set<string>();
  for (const output of outputs)
    for (const id of reach(output, edges, 'backward')) reachesOutput.add(id);
  for (const node of nodes.values()) {
    if (!reachesOutput.has(node.id) && !supervisorOf.has(node.id)) {
      warnings.push({
        code: 'DEAD_END',
        message:
          'Nothing this node produces reaches an output. That is fine for a side effect such as an email.',
        nodeId: node.id,
      });
    }
  }
  if (errors.length > 0) return fail();

  // ── Types: what each node produces, and where it may go ────────────────
  const outputKinds = new Map<string, OutputKind>();
  for (const node of nodes.values()) outputKinds.set(node.id, outputKindOf(node));
  for (const edge of coreEdges) {
    const source = nodes.get(edge.source) as WorkflowNode;
    const target = nodes.get(edge.target) as WorkflowNode;
    if (source.type === 'retrieval' && target.type === 'tool') {
      errors.push({
        code: 'TYPE_MISMATCH',
        message:
          'Retrieved passages are reference material for an agent; a tool cannot take them. ' +
          'Put an agent between the two.',
        edgeId: edge.id,
      });
    }
  }

  // ── Templates: every reference exists and comes first ──────────────────
  const scopeOf = (nodeId: string): ReadonlySet<string> => {
    const supervisor = supervisorOf.get(nodeId);
    const own = ancestors.get(nodeId) ?? new Set<string>();
    if (!supervisor) return own;
    return new Set([...own, ...(ancestors.get(supervisor) ?? []), supervisor]);
  };
  const triggerSchema = trigger.data.inputSchema ?? DEFAULT_TRIGGER_SCHEMA;
  for (const node of nodes.values()) {
    for (const { template, where } of templatesOf(node)) {
      let parts;
      try {
        parts = parseTemplate(template);
      } catch (error) {
        errors.push({
          code: 'TEMPLATE_INVALID',
          message: `${where}: ${(error as TemplateError).message}`,
          nodeId: node.id,
        });
        continue;
      }
      for (const part of parts) {
        if (!('ref' in part)) continue;
        checkReference(part.ref, part.source, node, where, {
          nodes,
          scope: scopeOf(node.id),
          loopOf,
          outputKinds,
          triggerSchema,
          errors,
          warnings,
        });
      }
    }
  }
  if (errors.length > 0) return fail();

  // ── Worst case, against the step ceiling ───────────────────────────────
  let stepBound = 0;
  for (const node of nodes.values()) {
    const loop = loopOf.get(node.id);
    if (loop) stepBound += loop.maxIterations + 1;
    else if (node.type === 'supervisor') stepBound += node.data.maxRounds + 1;
    else if (supervisorOf.has(node.id)) {
      stepBound += (nodes.get(supervisorOf.get(node.id) as string) as SupervisorNode).data
        .maxRounds;
    } else stepBound += 1;
  }
  if (stepBound > limits.maxSteps) {
    warnings.push({
      code: 'STEP_BOUND',
      message:
        `In the worst case this workflow schedules ${stepBound} steps, more than the ceiling of ` +
        `${limits.maxSteps}; a run that goes that far will be stopped.`,
    });
  }

  const references = {
    agentIds: unique(
      [...nodes.values()].flatMap((node) =>
        node.type === 'agent'
          ? [node.data.agentId]
          : node.type === 'supervisor' && node.data.agentId
            ? [node.data.agentId]
            : [],
      ),
    ),
    toolIds: unique(
      [...nodes.values()].flatMap((node) =>
        node.type === 'tool' ? [node.data.toolId] : [],
      ),
    ),
    knowledgeBaseIds: unique(
      [...nodes.values()].flatMap((node) =>
        node.type === 'retrieval' ? (node.data.knowledgeBaseIds ?? []) : [],
      ),
    ),
  };

  // Workers run right after their supervisor in the order.
  const workers = new Set(supervisorOf.keys());
  const finalOrder: string[] = [];
  for (const id of order) {
    if (workers.has(id)) continue;
    finalOrder.push(id);
    const supervisor = supervisors.get(id);
    if (supervisor) finalOrder.push(...supervisor.workers);
  }

  const normalized: WorkflowGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: [...nodes.values()],
    edges,
    ...(isViewport(raw.viewport) ? { viewport: raw.viewport } : {}),
  };

  const incoming = groupBy(
    coreEdges.filter(
      (edge) => !(supervisors.has(edge.source) && handleOf(edge) === HANDLE.WORKER),
    ),
    (edge) => edge.target,
  );

  return {
    valid: true,
    errors,
    warnings,
    normalized,
    compiled: {
      graph: normalized,
      nodes,
      trigger,
      outputs,
      incoming,
      outgoing,
      loops,
      loopOf,
      supervisors,
      supervisorOf,
      order: finalOrder,
      ancestors,
      outputKinds,
      stepBound,
      references,
    },
  };
}

// ── Nodes ───────────────────────────────────────────────────────────────────

function normalizeNode(
  raw: unknown,
  index: number,
  limits: GraphLimits,
  errors: GraphIssue[],
): WorkflowNode | null {
  if (!isPlainObject(raw)) {
    errors.push({ code: 'NODE_INVALID', message: `Node ${index + 1} is not an object.` });
    return null;
  }
  const id = raw.id;
  if (typeof id !== 'string' || !ID.test(id)) {
    errors.push({
      code: 'NODE_ID_INVALID',
      message: `Node ${index + 1} needs an id of letters, digits, "-" or "_" (at most 64).`,
    });
    return null;
  }
  const type = raw.type as NodeType;
  if (!NODE_TYPES.includes(type)) {
    errors.push({
      code: 'NODE_TYPE_UNKNOWN',
      message: `Unknown node type ${describeValue(raw.type)}.`,
      nodeId: id,
    });
    return null;
  }
  const data = isPlainObject(raw.data) ? raw.data : {};
  const issue = (message: string) =>
    errors.push({ code: 'NODE_DATA_INVALID', message, nodeId: id });

  const base = {
    id,
    type,
    ...(typeof raw.label === 'string' ? { label: raw.label.slice(0, 80) } : {}),
    ...(isPosition(raw.position)
      ? { position: { x: raw.position.x, y: raw.position.y } }
      : {}),
  };

  switch (type) {
    case 'trigger': {
      let inputSchema: JsonSchema | undefined;
      if (data.inputSchema !== undefined) {
        const problems = checkSchema(data.inputSchema, { rootObject: true });
        problems.forEach((problem) =>
          issue(`inputSchema${problem.path}: ${problem.message}`),
        );
        inputSchema = data.inputSchema as JsonSchema;
      }
      return { ...base, type, data: inputSchema ? { inputSchema } : {} };
    }
    case 'agent': {
      if (typeof data.agentId !== 'string' || !isUuid(data.agentId))
        issue('Choose an agent (agentId).');
      const prompt = optionalString(data.prompt, 8_000, 'prompt', issue);
      const output = normalizeOutput(data.output, issue);
      const maxToolIterations = optionalInt(
        data.maxToolIterations,
        0,
        limits.maxToolIterations,
        'maxToolIterations',
        issue,
      );
      return {
        ...base,
        type,
        data: {
          agentId: String(data.agentId),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(typeof data.useTools === 'boolean' ? { useTools: data.useTools } : {}),
          ...(maxToolIterations !== undefined ? { maxToolIterations } : {}),
          ...(output ? { output } : {}),
          ...timing(data, limits, issue),
        },
      };
    }
    case 'tool': {
      if (typeof data.toolId !== 'string' || !isUuid(data.toolId))
        issue('Choose a tool (toolId).');
      const args = data.arguments === undefined ? {} : data.arguments;
      if (!isPlainObject(args)) issue('"arguments" must be an object.');
      else if (JSON.stringify(args).length > 16_000) issue('"arguments" is too large.');
      return {
        ...base,
        type,
        data: {
          toolId: String(data.toolId),
          arguments: isPlainObject(args) ? args : {},
          ...timing(data, limits, issue),
        },
      };
    }
    case 'retrieval': {
      const query = optionalString(data.query, 2_000, 'query', issue);
      if (!query) issue('A retrieval node needs a query.');
      const ids = data.knowledgeBaseIds;
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length > 20 ||
          ids.some((id) => typeof id !== 'string' || !isUuid(id)))
      ) {
        issue('"knowledgeBaseIds" must be at most 20 knowledge base ids.');
      }
      const topK = optionalInt(data.topK, 1, 20, 'topK', issue);
      return {
        ...base,
        type,
        data: {
          query: query ?? '',
          ...(Array.isArray(ids) ? { knowledgeBaseIds: ids as string[] } : {}),
          ...(topK !== undefined ? { topK } : {}),
        },
      };
    }
    case 'condition': {
      const rules: ConditionRule[] = [];
      if (!Array.isArray(data.rules) || data.rules.length === 0 || data.rules.length > 20) {
        issue('A condition needs 1 to 20 rules.');
      } else {
        const seen = new Set<string>();
        for (const rawRule of data.rules) {
          const rule = normalizeRule(rawRule, issue);
          if (!rule) continue;
          if (seen.has(rule.id)) issue(`Two rules have the id "${rule.id}".`);
          seen.add(rule.id);
          rules.push(rule);
        }
      }
      return { ...base, type, data: { rules } };
    }
    case 'supervisor': {
      const strategy = data.strategy === 'round_robin' ? 'round_robin' : 'llm';
      if (
        data.strategy !== undefined &&
        (typeof data.strategy !== 'string' ||
          !['llm', 'round_robin'].includes(data.strategy))
      ) {
        issue('strategy must be "llm" or "round_robin".');
      }
      if (
        data.agentId !== undefined &&
        (typeof data.agentId !== 'string' || !isUuid(data.agentId))
      ) {
        issue('agentId must be an agent id.');
      }
      const goal = optionalString(data.goal, 8_000, 'goal', issue);
      const maxRounds =
        optionalInt(data.maxRounds, 1, limits.maxSupervisorRounds, 'maxRounds', issue) ?? 3;
      return {
        ...base,
        type,
        data: {
          strategy,
          ...(typeof data.agentId === 'string' ? { agentId: data.agentId } : {}),
          ...(goal !== undefined ? { goal } : {}),
          maxRounds,
        },
      };
    }
    case 'approval': {
      const message = optionalString(data.message, 4_000, 'message', issue);
      const timeoutMs = optionalInt(
        data.timeoutMs,
        60_000,
        30 * 86_400_000,
        'timeoutMs',
        issue,
      );
      if (
        data.onTimeout !== undefined &&
        (typeof data.onTimeout !== 'string' ||
          !['reject', 'approve'].includes(data.onTimeout))
      ) {
        issue('onTimeout must be "reject" or "approve".');
      }
      return {
        ...base,
        type,
        data: {
          ...(message !== undefined ? { message } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(data.onTimeout === 'approve' ? { onTimeout: 'approve' as const } : {}),
          ...(data.allowSelfApproval === true ? { allowSelfApproval: true } : {}),
        },
      };
    }
    case 'output': {
      const value = optionalString(data.value, 8_000, 'value', issue);
      return { ...base, type, data: value !== undefined ? { value } : {} };
    }
    default:
      return null;
  }
}

function normalizeRule(
  raw: unknown,
  issue: (message: string) => void,
): ConditionRule | null {
  if (!isPlainObject(raw)) {
    issue('Each rule must be an object.');
    return null;
  }
  if (typeof raw.id !== 'string' || !RULE_ID.test(raw.id) || RESERVED_HANDLES.has(raw.id)) {
    issue('Each rule needs an id (a short identifier, not "else", "error" or "out").');
    return null;
  }
  if (typeof raw.value !== 'string' || raw.value.length === 0 || raw.value.length > 2_000) {
    issue(
      `Rule "${raw.id}" needs a value to test, such as {{nodes.review.output.approved}}.`,
    );
    return null;
  }
  const operator = raw.operator as ConditionRule['operator'];
  if (!CONDITION_OPERATORS.includes(operator)) {
    issue(`Rule "${raw.id}" has an unknown operator.`);
    return null;
  }
  const operand = raw.operand;
  if (!UNARY_OPERATORS.has(operator)) {
    if (!['string', 'number', 'boolean'].includes(typeof operand)) {
      issue(`Rule "${raw.id}" needs an operand.`);
      return null;
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(operator) && typeof operand !== 'number') {
      issue(`Rule "${raw.id}" compares numbers; its operand must be a number.`);
      return null;
    }
    if (typeof operand === 'string' && operand.length > 1_000) {
      issue(`Rule "${raw.id}": the operand is too long.`);
      return null;
    }
  }
  return {
    id: raw.id,
    value: raw.value,
    operator,
    ...(operand !== undefined && !UNARY_OPERATORS.has(operator)
      ? { operand: operand as string | number | boolean }
      : {}),
    ...(typeof raw.caseSensitive === 'boolean' ? { caseSensitive: raw.caseSensitive } : {}),
  };
}

function normalizeOutput(
  raw: unknown,
  issue: (message: string) => void,
): OutputContract | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || (raw.format !== 'text' && raw.format !== 'json')) {
    issue('output.format must be "text" or "json".');
    return undefined;
  }
  if (raw.format === 'text') return { format: 'text' };
  const problems = checkSchema(raw.schema);
  problems.forEach((problem) => issue(`output.schema${problem.path}: ${problem.message}`));
  return { format: 'json', schema: raw.schema as JsonSchema };
}

function timing(
  data: Record<string, unknown>,
  limits: GraphLimits,
  issue: (message: string) => void,
): { timeoutMs?: number; retry?: RetryPolicy } {
  const timeoutMs = optionalInt(
    data.timeoutMs,
    1_000,
    limits.maxStepTimeoutMs,
    'timeoutMs',
    issue,
  );
  let retry: RetryPolicy | undefined;
  if (data.retry !== undefined) {
    if (!isPlainObject(data.retry)) issue('"retry" must be an object.');
    else {
      const maxAttempts = optionalInt(
        data.retry.maxAttempts,
        1,
        limits.maxStepAttempts,
        'retry.maxAttempts',
        issue,
      );
      const backoffMs = optionalInt(
        data.retry.backoffMs,
        0,
        3_600_000,
        'retry.backoffMs',
        issue,
      );
      retry = {
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(backoffMs !== undefined ? { backoffMs } : {}),
      };
    }
  }
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retry ? { retry } : {}),
  };
}

// ── Edges ───────────────────────────────────────────────────────────────────

function normalizeEdge(
  raw: unknown,
  index: number,
  limits: GraphLimits,
  errors: GraphIssue[],
): WorkflowEdge | null {
  if (!isPlainObject(raw)) {
    errors.push({ code: 'EDGE_INVALID', message: `Edge ${index + 1} is not an object.` });
    return null;
  }
  const id = raw.id;
  if (typeof id !== 'string' || !ID.test(id)) {
    errors.push({ code: 'EDGE_INVALID', message: `Edge ${index + 1} needs an id.` });
    return null;
  }
  if (typeof raw.source !== 'string' || typeof raw.target !== 'string') {
    errors.push({
      code: 'EDGE_INVALID',
      message: 'An edge needs a source and a target.',
      edgeId: id,
    });
    return null;
  }
  const sourceHandle =
    typeof raw.sourceHandle === 'string' && raw.sourceHandle.length > 0
      ? raw.sourceHandle
      : null;
  if (sourceHandle && sourceHandle.length > 64) {
    errors.push({
      code: 'EDGE_INVALID',
      message: 'The source handle is too long.',
      edgeId: id,
    });
    return null;
  }

  let loop: LoopSpec | undefined;
  const data = isPlainObject(raw.data) ? raw.data : {};
  if (data.loop !== undefined) {
    const spec = data.loop;
    if (
      !isPlainObject(spec) ||
      !Number.isInteger(spec.maxIterations) ||
      (spec.maxIterations as number) < 1 ||
      (spec.maxIterations as number) > limits.maxLoopIterations
    ) {
      errors.push({
        code: 'LOOP_INVALID',
        message: `A loop edge needs maxIterations between 1 and ${limits.maxLoopIterations}.`,
        edgeId: id,
      });
      return null;
    }
    loop = {
      maxIterations: spec.maxIterations as number,
      ...(spec.onExhausted === 'fail' ? { onExhausted: 'fail' as const } : {}),
    };
  }

  return {
    id,
    source: raw.source,
    target: raw.target,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(typeof raw.targetHandle === 'string' && raw.targetHandle
      ? { targetHandle: raw.targetHandle.slice(0, 64) }
      : {}),
    ...(typeof raw.label === 'string' ? { label: raw.label.slice(0, 80) } : {}),
    ...(loop ? { data: { loop } } : {}),
  };
}

/** The handles each node type offers. */
function checkHandle(
  source: WorkflowNode,
  target: WorkflowNode,
  edge: WorkflowEdge,
  errors: GraphIssue[],
): void {
  const handle = handleOf(edge);
  let allowed: string[];
  switch (source.type) {
    case 'trigger':
      allowed = [HANDLE.OUT];
      break;
    case 'agent':
    case 'tool':
    case 'retrieval':
      allowed = [HANDLE.OUT, HANDLE.ERROR];
      break;
    case 'condition':
      allowed = [...source.data.rules.map((rule) => rule.id), HANDLE.ELSE];
      break;
    case 'supervisor':
      allowed = [HANDLE.WORKER, HANDLE.DONE, HANDLE.ERROR];
      break;
    case 'approval':
      allowed = [HANDLE.APPROVED, HANDLE.REJECTED];
      break;
    case 'output':
      allowed = [];
      break;
  }
  if (!allowed.includes(handle)) {
    errors.push({
      code: 'HANDLE_INVALID',
      message:
        allowed.length === 0
          ? 'An output node has no outgoing edges.'
          : `A ${source.type} node’s edges leave from one of: ${allowed.join(', ')} (got "${handle}").`,
      edgeId: edge.id,
    });
  }
  if (isLoopEdge(edge) && source.type !== 'condition') {
    errors.push({
      code: 'LOOP_INVALID',
      message:
        'Only a condition rule may loop back: the decision to repeat must be explicit.',
      edgeId: edge.id,
    });
  }
  if (isLoopEdge(edge) && target.type === 'trigger') {
    errors.push({
      code: 'LOOP_INVALID',
      message: 'A loop cannot go back to the trigger.',
      edgeId: edge.id,
    });
  }
}

function compileLoop(
  edge: WorkflowEdge,
  nodes: ReadonlyMap<string, WorkflowNode>,
  coreEdges: readonly WorkflowEdge[],
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  limits: GraphLimits,
  errors: GraphIssue[],
): CompiledLoop | null {
  const head = edge.target;
  const tail = edge.source;
  if (!(ancestors.get(tail)?.has(head) ?? false)) {
    errors.push({
      code: 'LOOP_INVALID',
      message: 'A loop edge must go back to a node that runs before the condition.',
      edgeId: edge.id,
    });
    return null;
  }
  const condition = nodes.get(tail) as WorkflowNode;
  const ruleId = handleOf(edge);
  if (
    condition.type !== 'condition' ||
    !condition.data.rules.some((rule) => rule.id === ruleId)
  ) {
    errors.push({
      code: 'LOOP_INVALID',
      message: 'A loop edge must leave from a condition rule.',
      edgeId: edge.id,
    });
    return null;
  }
  // The body: every node on a path from the head to the condition.
  const fromHead = reach(head, coreEdges, 'forward');
  const toTail = reach(tail, coreEdges, 'backward');
  const body = new Set([...fromHead].filter((id) => toTail.has(id)));
  const spec = edge.data?.loop as LoopSpec;
  if (spec.maxIterations > limits.maxLoopIterations) return null;
  return {
    edgeId: edge.id,
    head,
    tail,
    ruleId,
    body,
    maxIterations: spec.maxIterations,
    onExhausted: spec.onExhausted ?? 'fall_through',
  };
}

// ── Templates ───────────────────────────────────────────────────────────────

function templatesOf(node: WorkflowNode): Array<{ template: string; where: string }> {
  switch (node.type) {
    case 'agent':
      return node.data.prompt ? [{ template: node.data.prompt, where: 'prompt' }] : [];
    case 'tool':
      return templatesIn(node.data.arguments).map((template) => ({
        template,
        where: 'arguments',
      }));
    case 'retrieval':
      return [{ template: node.data.query, where: 'query' }];
    case 'condition':
      return node.data.rules.map((rule) => ({
        template: rule.value,
        where: `rule "${rule.id}"`,
      }));
    case 'supervisor':
      return node.data.goal ? [{ template: node.data.goal, where: 'goal' }] : [];
    case 'approval':
      return node.data.message ? [{ template: node.data.message, where: 'message' }] : [];
    case 'output':
      return node.data.value ? [{ template: node.data.value, where: 'value' }] : [];
    default:
      return [];
  }
}

function checkReference(
  ref: TemplateRef,
  source: string,
  node: WorkflowNode,
  where: string,
  context: {
    nodes: ReadonlyMap<string, WorkflowNode>;
    scope: ReadonlySet<string>;
    loopOf: ReadonlyMap<string, CompiledLoop>;
    outputKinds: ReadonlyMap<string, OutputKind>;
    triggerSchema: JsonSchema;
    errors: GraphIssue[];
    warnings: GraphIssue[];
  },
): void {
  const optional = source.replace(/\s/g, '').endsWith('?}}');
  if (ref.root === 'input') {
    const first = ref.path[0];
    const properties = context.triggerSchema.properties ?? {};
    if (first && !(first in properties)) {
      context.warnings.push({
        code: 'INPUT_FIELD_UNKNOWN',
        message: `${where}: ${source} names a field the trigger’s input schema does not declare.`,
        nodeId: node.id,
      });
    }
    return;
  }

  const referenced = context.nodes.get(ref.nodeId);
  if (!referenced) {
    context.errors.push({
      code: 'REFERENCE_UNKNOWN',
      message: `${where}: ${source} names a node that does not exist.`,
      nodeId: node.id,
    });
    return;
  }
  const sameLoop =
    context.loopOf.get(node.id) !== undefined &&
    context.loopOf.get(node.id) === context.loopOf.get(ref.nodeId);
  if (!context.scope.has(ref.nodeId) && !(sameLoop && optional)) {
    context.errors.push({
      code: 'REFERENCE_NOT_ANCESTOR',
      message: sameLoop
        ? `${where}: ${source} refers to a later node in the loop; mark it optional ({{…?}}), because the first iteration has no value yet.`
        : `${where}: ${source} refers to a node that does not run before this one.`,
      nodeId: node.id,
    });
    return;
  }
  const kind = context.outputKinds.get(ref.nodeId);
  if (ref.path.length > 0 && (kind === 'text' || kind === 'none')) {
    context.errors.push({
      code: 'TYPE_MISMATCH',
      message:
        `${where}: ${source} reads a field, but "${ref.nodeId}" produces plain text. Give that ` +
        'agent a JSON output schema to read fields from it.',
      nodeId: node.id,
    });
  }
}

// ── Graph algorithms ────────────────────────────────────────────────────────

function outputKindOf(node: WorkflowNode): OutputKind {
  switch (node.type) {
    case 'trigger':
    case 'tool':
    case 'condition':
    case 'approval':
      return 'json';
    case 'agent':
      return node.data.output?.format === 'json' ? 'json' : 'text';
    case 'retrieval':
      return 'passages';
    case 'supervisor':
      return 'text';
    case 'output':
      return 'none';
    default:
      return 'none';
  }
}

/** Kahn's algorithm; null when there is a cycle. Ties broken by id, for stability. */
export function topologicalOrder(
  ids: readonly string[],
  edges: readonly WorkflowEdge[],
): string[] | null {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const target of next.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  return order.length === ids.length ? order : null;
}

function computeAncestors(
  order: readonly string[],
  edges: readonly WorkflowEdge[],
): Map<string, Set<string>> {
  const incoming = groupBy(edges, (edge) => edge.target);
  const ancestors = new Map<string, Set<string>>();
  for (const id of order) {
    const set = new Set<string>();
    for (const edge of incoming.get(id) ?? []) {
      set.add(edge.source);
      for (const ancestor of ancestors.get(edge.source) ?? []) set.add(ancestor);
    }
    ancestors.set(id, set);
  }
  return ancestors;
}

function reach(
  start: string,
  edges: readonly WorkflowEdge[],
  direction: 'forward' | 'backward',
): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of edges) {
      const [from, to] =
        direction === 'forward' ? [edge.source, edge.target] : [edge.target, edge.source];
      if (from === current && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** A short, safe rendering of an unexpected value for an error message. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a value of type ${typeof value}`;
}

function optionalString(
  value: unknown,
  max: number,
  name: string,
  issue: (message: string) => void,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    issue(`"${name}" must be text.`);
    return undefined;
  }
  if (value.length > max) {
    issue(`"${name}" is limited to ${max} characters.`);
    return value.slice(0, max);
  }
  return value;
}

function optionalInt(
  value: unknown,
  min: number,
  max: number,
  name: string,
  issue: (message: string) => void,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issue(`"${name}" must be a whole number from ${min} to ${max}.`);
    return undefined;
  }
  return value as number;
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return (
    isPlainObject(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  );
}

function isViewport(value: unknown): value is { x: number; y: number; zoom: number } {
  return isPosition(value) && typeof (value as { zoom?: unknown }).zoom === 'number';
}
