import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { uuidV5 } from '../../../common/utils/uuid.util';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../../config/llm.config';
import { TOOLS_CONFIG_KEY, type ToolsConfig } from '../../../config/tools.config';
import {
  WORKFLOWS_CONFIG_KEY,
  type WorkflowsConfig,
} from '../../../config/workflows.config';
import { returnedRows } from '../../../database/query.util';
import { AgentTaskService, type TaskPassage } from '../../agents/agent-task.service';
import {
  joinLabels,
  PUBLIC_LABEL,
  type InformationLabel,
} from '../../agents/domain/labels';
import type { MessageToolCall } from '../../agents/entities/conversation-message.entity';
import { RetrievalService } from '../../knowledge/retrieval/retrieval.service';
import { Integrity, meetIntegrity } from '../../tools/domain/information-flow';
import type { ToolDescriptor } from '../../tools/domain/tool-definition';
import {
  ToolExecutorService,
  type ToolCallBudget,
} from '../../tools/tool-executor.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { evaluateRule, ruleValue } from '../domain/conditions';
import {
  HANDLE,
  handleOf,
  workerHandle,
  type AgentNode,
  type ApprovalNode,
  type ConditionNode,
  type OutputNode,
  type RetrievalNode,
  type SupervisorNode,
  type ToolNode,
} from '../domain/graph';
import { FailureClass, StepStatus } from '../domain/run-state';
import { visibleStep, type StepSnapshot } from '../domain/scheduler';
import {
  renderTemplate,
  renderValue,
  stringify,
  TemplateError,
  templateRefs,
  templatesIn,
  type TemplateScope,
} from '../domain/templates';
import type { WorkflowStep } from '../entities/workflow-step.entity';
import { RunAad, RunCryptoService } from '../run-crypto.service';
import {
  RunBudgetExceeded,
  StepFailure,
  type NodeResult,
  type StepContext,
  type StepOutputEnvelope,
} from './engine-types';

/** Namespace for execution ids derived from step ids (idempotent side effects). */
const EXECUTION_NAMESPACE = '0c9b6a1e-4f2d-5b3c-8e7a-1d2f3a4b5c6d';

interface LoadedOutput {
  step: WorkflowStep;
  envelope: StepOutputEnvelope;
}

/**
 * Runs one node. Each node type reads what it needs from earlier steps —
 * decrypting only the outputs its templates reference — does its work as the
 * run's initiator, and returns its output with the labels of everything it
 * read and produced.
 */
@Injectable()
export class StepExecutorService {
  private readonly config: WorkflowsConfig;
  private readonly llmConfig: LlmConfig;
  private readonly toolsConfig: ToolsConfig;

  constructor(
    private readonly agentTasks: AgentTaskService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly retrieval: RetrievalService,
    private readonly crypto: RunCryptoService,
    private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
    this.llmConfig = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
    this.toolsConfig = configService.getOrThrow<ToolsConfig>(TOOLS_CONFIG_KEY);
  }

  async execute(context: StepContext): Promise<NodeResult> {
    try {
      switch (context.node.type) {
        case 'agent':
          return await this.agent(context, context.node);
        case 'tool':
          return await this.tool(context, context.node);
        case 'retrieval':
          return await this.retrievalNode(context, context.node);
        case 'condition':
          return await this.condition(context, context.node);
        case 'supervisor':
          return await this.supervisor(context, context.node);
        case 'approval':
          return await this.approval(context, context.node);
        case 'output':
          return await this.output(context, context.node);
        default:
          throw new StepFailure(
            ErrorCode.WORKFLOW_INVALID,
            FailureClass.PERMANENT,
            `A ${context.node.type} node is not executed as a step.`,
          );
      }
    } catch (error) {
      if (error instanceof TemplateError) {
        throw new StepFailure(
          ErrorCode.WORKFLOW_TEMPLATE_ERROR,
          FailureClass.PERMANENT,
          error.message,
        );
      }
      throw error;
    }
  }

  // ── Agent ─────────────────────────────────────────────────────────────────

  private async agent(context: StepContext, node: AgentNode): Promise<NodeResult> {
    const supervisorId = context.graph.supervisorOf.get(node.id);
    const predecessors = this.predecessors(context);
    const loaded = await this.load(context, [
      ...this.refNodes(node.data.prompt ? [node.data.prompt] : []),
      ...predecessors,
      ...(supervisorId ? [supervisorId] : []),
    ]);
    const scope = await this.scope(context, loaded);
    const used = new Set<string>();

    let task: string;
    if (supervisorId) {
      // A worker's task is the supervisor's instruction for this round.
      const supervisor = loaded.get(supervisorId);
      used.add(supervisorId);
      const instruction =
        (supervisor?.envelope.value as { instruction?: string } | undefined)?.instruction ??
        '';
      const extra = node.data.prompt ? this.render(node.data.prompt, scope, used) : '';
      task = [instruction, extra].filter(Boolean).join('\n\n');
    } else if (node.data.prompt) {
      task = this.render(node.data.prompt, scope, used);
    } else {
      task = await this.defaultInput(context, predecessors, loaded, used);
    }
    if (task.trim().length === 0) {
      throw new StepFailure(
        ErrorCode.WORKFLOW_TEMPLATE_ERROR,
        FailureClass.PERMANENT,
        'The agent’s task is empty.',
      );
    }

    const passages: TaskPassage[] = [];
    for (const predecessor of predecessors) {
      const output = loaded.get(predecessor);
      if (output?.envelope.passages) {
        used.add(predecessor);
        passages.push(...output.envelope.passages);
      }
    }
    const { label, integrity } = this.labelsOf(context, loaded, used);

    const toolCalls: MessageToolCall[] = [];
    const result = await this.agentTasks.run(context.principal, {
      agentId: node.data.agentId,
      task,
      passages,
      inputLabel: label,
      inputIntegrity: integrity,
      useTools: node.data.useTools ?? true,
      maxToolIterations: node.data.maxToolIterations,
      output: node.data.output ?? { format: 'text' },
      origin: {
        runId: context.run.id,
        stepId: context.step.id,
        workflowId: context.run.workflowId,
      },
      executionId: (iteration, toolName) =>
        uuidV5(`${context.step.id}#${iteration}#${toolName}`, EXECUTION_NAMESPACE),
      callBudget: this.runBudget(context.run.id),
      onTokens: (tokens) => this.consumeTokens(context.run.id, tokens),
      onToolEnd: (call) => toolCalls.push(call),
      actorLabel: context.actorLabel,
      signal: context.signal,
    });

    return {
      kind: 'done',
      output: { value: result.json !== undefined ? result.json : result.text },
      handles: [HANDLE.OUT],
      label: result.label,
      integrity: result.integrity,
      input: { task },
      meta: {
        agentId: result.agentId,
        agentVersion: result.agentVersion,
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        invocationIds: result.invocationIds,
        toolCalls: result.toolCalls,
        facts: {
          iterations: result.iterations,
          finishedBy: result.finishedBy,
          passages: passages.length,
          citationsUsed: result.citations.filter((citation) => citation.cited).length,
          entitiesMasked: result.redaction.entities,
        },
      },
    };
  }

  // ── Tool ──────────────────────────────────────────────────────────────────

  private async tool(context: StepContext, node: ToolNode): Promise<NodeResult> {
    const loaded = await this.load(
      context,
      this.refNodes(templatesIn(node.data.arguments)),
    );
    const scope = await this.scope(context, loaded);
    const usage = { nodes: new Set<string>(), input: false };
    const args = renderValue(node.data.arguments, scope, usage) as Record<string, unknown>;
    const { label, integrity } = this.labelsOf(context, loaded, usage.nodes);

    const descriptor: ToolDescriptor | null =
      (
        await this.toolRegistry.resolveMany(context.run.organizationId, [node.data.toolId])
      ).get(node.data.toolId) ?? null;

    const outcome = await this.toolExecutor.execute(
      descriptor,
      { name: descriptor?.name ?? 'unknown', arguments: args },
      {
        principal: context.principal,
        agent: null,
        flow: { label, integrity },
        session: null,
        argumentsAreMasked: false,
        origin: { runId: context.run.id, stepId: context.step.id },
        actorLabel: context.actorLabel,
        executionId: uuidV5(`${context.step.id}#tool`, EXECUTION_NAMESPACE),
        budget: this.runBudget(context.run.id),
        approvalGranted: this.approvedBefore(context),
        signal: context.signal,
      },
    );

    const call: MessageToolCall = {
      executionId: outcome.executionId,
      tool: outcome.toolName,
      status: outcome.status,
      ...(outcome.status !== 'ok' ? { code: outcome.code } : {}),
      ...(outcome.status === 'denied' ? { reason: outcome.reason } : {}),
      durationMs: outcome.durationMs,
    };

    if (outcome.status === 'denied') {
      throw new StepFailure(outcome.code, FailureClass.POLICY, outcome.message);
    }
    if (outcome.status === 'error') {
      throw new StepFailure(
        outcome.code,
        outcome.code === ErrorCode.TOOL_TIMEOUT
          ? FailureClass.TIMEOUT
          : outcome.retryable
            ? FailureClass.TRANSIENT
            : FailureClass.PERMANENT,
        outcome.message,
      );
    }

    return {
      kind: 'done',
      output: { value: outcome.data !== undefined ? outcome.data : outcome.content },
      handles: [HANDLE.OUT],
      label: joinLabels(label, outcome.label),
      integrity: meetIntegrity(integrity, outcome.integrity),
      input: { arguments: args },
      meta: {
        toolId: outcome.tool.id,
        toolVersion: outcome.tool.version,
        promptTokens: 0,
        completionTokens: 0,
        invocationIds: [],
        toolCalls: [call],
        facts: { replayed: outcome.replayed, truncated: outcome.truncated },
      },
    };
  }

  // ── Retrieval ─────────────────────────────────────────────────────────────

  private async retrievalNode(
    context: StepContext,
    node: RetrievalNode,
  ): Promise<NodeResult> {
    const loaded = await this.load(context, this.refNodes([node.data.query]));
    const scope = await this.scope(context, loaded);
    const used = new Set<string>();
    const query = this.render(node.data.query, scope, used).replace(/\s+/g, ' ').trim();
    if (query.length === 0) {
      throw new StepFailure(
        ErrorCode.WORKFLOW_TEMPLATE_ERROR,
        FailureClass.PERMANENT,
        'The query is empty.',
      );
    }
    const { label, integrity } = this.labelsOf(context, loaded, used);

    const response = await this.retrieval.retrieve(context.principal, {
      query: query.slice(0, 2_000),
      topK: node.data.topK ?? 8,
      ...(node.data.knowledgeBaseIds?.length
        ? { restrictToKnowledgeBaseIds: node.data.knowledgeBaseIds }
        : {}),
      // Retrieved for a model to read later: nothing above what the endpoint may receive.
      maxClassification: this.llmConfig.maxClassification,
      origin: { workflowRunId: context.run.id, workflowStepId: context.step.id },
    });

    const passages: TaskPassage[] = response.results.map((passage) => ({
      title: passage.documentTitle,
      text: passage.text,
      label: {
        classification: passage.classification,
        knowledgeBaseIds: [passage.knowledgeBaseId],
        documentIds: [passage.documentId],
      },
    }));

    return {
      kind: 'done',
      output: {
        value: response.results.map((passage) => ({
          title: passage.documentTitle,
          text: passage.text,
          classification: passage.classification,
          documentId: passage.documentId,
          knowledgeBaseId: passage.knowledgeBaseId,
          score: passage.score,
        })),
        passages,
      },
      handles: [HANDLE.OUT],
      label: joinLabels(label, ...passages.map((passage) => passage.label)),
      integrity: meetIntegrity(
        integrity,
        passages.length > 0 ? Integrity.INTERNAL : undefined,
      ),
      input: { query },
      meta: {
        promptTokens: 0,
        completionTokens: 0,
        invocationIds: [],
        toolCalls: [],
        facts: { passages: passages.length, retrievalId: response.retrievalId },
      },
    };
  }

  // ── Condition ─────────────────────────────────────────────────────────────

  private async condition(context: StepContext, node: ConditionNode): Promise<NodeResult> {
    const loaded = await this.load(
      context,
      this.refNodes(node.data.rules.map((rule) => rule.value)),
    );
    const scope = await this.scope(context, loaded);
    const loopByRule = new Map(
      context.graph.loops
        .filter((loop) => loop.tail === node.id)
        .map((loop) => [loop.ruleId, loop]),
    );

    let handle: string = HANDLE.ELSE;
    let matchedRule: string | null = null;
    let exhausted: string | null = null;
    for (const rule of node.data.rules) {
      if (!evaluateRule(rule, ruleValue(rule, scope))) continue;
      const loop = loopByRule.get(rule.id);
      if (loop && context.step.iteration + 1 > loop.maxIterations) {
        if (loop.onExhausted === 'fail') {
          throw new StepFailure(
            ErrorCode.WORKFLOW_LOOP_EXHAUSTED,
            FailureClass.PERMANENT,
            `The loop reached its limit of ${loop.maxIterations} iterations.`,
          );
        }
        exhausted = rule.id;
        continue; // fall through, as if this rule did not exist
      }
      handle = rule.id;
      matchedRule = rule.id;
      break;
    }

    // Conservative: every node a rule could read labels the decision.
    const used = new Set(this.refNodes(node.data.rules.map((rule) => rule.value)));
    const { label, integrity } = this.labelsOf(context, loaded, used);
    return {
      kind: 'done',
      output: { value: { handle, matchedRule } },
      handles: [handle],
      label,
      integrity,
      input: null,
      meta: {
        promptTokens: 0,
        completionTokens: 0,
        invocationIds: [],
        toolCalls: [],
        facts: { handle, matchedRule, loopExhausted: exhausted },
      },
    };
  }

  // ── Supervisor ────────────────────────────────────────────────────────────

  private async supervisor(
    context: StepContext,
    node: SupervisorNode,
  ): Promise<NodeResult> {
    const round = context.step.iteration;
    const workers = context.graph.supervisors.get(node.id)?.workers ?? [];
    const predecessors = this.predecessors(context);

    // The work so far: this supervisor's workers, in round order.
    const workerSteps = context.steps
      .filter(
        (step) =>
          workers.includes(step.nodeId) &&
          step.status === StepStatus.SUCCEEDED &&
          step.iteration < round,
      )
      .sort((a, b) => a.iteration - b.iteration);
    const loaded = await this.load(context, [
      ...this.refNodes(node.data.goal ? [node.data.goal] : []),
      ...predecessors,
    ]);
    const transcriptOutputs = await this.openSteps(context, workerSteps);
    const scope = await this.scope(context, loaded);
    const used = new Set<string>();
    const goal = node.data.goal
      ? this.render(node.data.goal, scope, used)
      : await this.defaultInput(context, predecessors, loaded, used);

    const base = this.labelsOf(context, loaded, used);
    const label = joinLabels(base.label, ...workerSteps.map((step) => labelOfStep(step)));
    const integrity = meetIntegrity(
      base.integrity,
      ...workerSteps.map((step) => step.integrity),
    );
    const last =
      workerSteps.length > 0
        ? transcriptOutputs.get(workerSteps[workerSteps.length - 1].id)
        : undefined;

    const finish = (
      facts: Record<string, string | number | boolean | null>,
      meta?: {
        promptTokens: number;
        completionTokens: number;
        invocationIds: string[];
        model?: string;
      },
    ): NodeResult => ({
      kind: 'done',
      output: { value: last?.value ?? goal },
      handles: [HANDLE.DONE],
      label,
      integrity,
      input: { goal },
      meta: {
        promptTokens: meta?.promptTokens ?? 0,
        completionTokens: meta?.completionTokens ?? 0,
        invocationIds: meta?.invocationIds ?? [],
        toolCalls: [],
        ...(meta?.model ? { model: meta.model } : {}),
        facts: { decision: 'FINISH', round, ...facts },
      },
    });

    if (round >= node.data.maxRounds) return finish({ reason: 'max_rounds' });

    if (node.data.strategy === 'round_robin') {
      const next = workers[round % workers.length];
      return this.assign(next, goal, round, label, integrity, {
        promptTokens: 0,
        completionTokens: 0,
        invocationIds: [],
      });
    }

    const agents = await this.workerProfiles(context, workers);
    const decision = await this.agentTasks.route(context.principal, {
      agentId: node.data.agentId ?? null,
      goal,
      workers: workers.map((id) => ({
        key: id,
        name: agents.get(id)?.name ?? id,
        description: agents.get(id)?.description ?? '',
      })),
      transcript: workerSteps.map((step) => ({
        worker: step.nodeId,
        round: step.iteration + 1,
        output: stringify(transcriptOutputs.get(step.id)?.value ?? ''),
      })),
      inputLabel: label,
      round: round + 1,
      maxRounds: node.data.maxRounds,
      origin: {
        runId: context.run.id,
        stepId: context.step.id,
        workflowId: context.run.workflowId,
      },
      onTokens: (tokens) => this.consumeTokens(context.run.id, tokens),
      signal: context.signal,
    });

    const meta = {
      promptTokens: decision.usage.promptTokens,
      completionTokens: decision.usage.completionTokens,
      invocationIds: decision.invocationIds,
      model: decision.model,
    };
    if (decision.next === 'FINISH') return finish({ reason: 'decided' }, meta);
    return this.assign(
      decision.next,
      decision.instruction || goal,
      round,
      label,
      integrity,
      meta,
    );
  }

  private assign(
    worker: string,
    instruction: string,
    round: number,
    label: InformationLabel,
    integrity: Integrity,
    meta: {
      promptTokens: number;
      completionTokens: number;
      invocationIds: string[];
      model?: string;
    },
  ): NodeResult {
    return {
      kind: 'done',
      output: { value: { worker, instruction } },
      handles: [workerHandle(worker)],
      label,
      integrity,
      input: { instruction },
      meta: {
        ...meta,
        toolCalls: [],
        facts: { decision: worker, round },
      },
    };
  }

  // ── Approval ──────────────────────────────────────────────────────────────

  private async approval(context: StepContext, node: ApprovalNode): Promise<NodeResult> {
    const predecessors = this.predecessors(context);
    const loaded = await this.load(context, [
      ...this.refNodes(node.data.message ? [node.data.message] : []),
      ...predecessors,
    ]);
    const scope = await this.scope(context, loaded);
    const used = new Set<string>();
    const message = node.data.message
      ? this.render(node.data.message, scope, used)
      : await this.defaultInput(context, predecessors, loaded, used);
    const { label, integrity } = this.labelsOf(context, loaded, used);
    const now = Date.now();
    return {
      kind: 'waiting',
      approval: {
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(
          now + (node.data.timeoutMs ?? this.config.approvalTimeoutMs),
        ).toISOString(),
      },
      input: { message },
      label,
      integrity,
    };
  }

  // ── Output ────────────────────────────────────────────────────────────────

  private async output(context: StepContext, node: OutputNode): Promise<NodeResult> {
    const predecessors = this.predecessors(context);
    const loaded = await this.load(context, [
      ...this.refNodes(node.data.value ? [node.data.value] : []),
      ...predecessors,
    ]);
    const scope = await this.scope(context, loaded);
    const usage = { nodes: new Set<string>(), input: false };

    let value: unknown;
    if (node.data.value) {
      value = renderValue(node.data.value, scope, usage);
    } else {
      const live = predecessors.filter((id) => loaded.has(id));
      live.forEach((id) => usage.nodes.add(id));
      value =
        live.length === 1
          ? loaded.get(live[0])?.envelope.value
          : Object.fromEntries(live.map((id) => [id, loaded.get(id)?.envelope.value]));
    }
    const { label, integrity } = this.labelsOf(context, loaded, usage.nodes);
    return {
      kind: 'done',
      output: { value },
      handles: [HANDLE.OUT],
      label,
      integrity,
      input: null,
      meta: { promptTokens: 0, completionTokens: 0, invocationIds: [], toolCalls: [] },
    };
  }

  // ── Reading earlier steps ─────────────────────────────────────────────────

  /** Sources of the live data edges into this step. */
  private predecessors(context: StepContext): string[] {
    const incoming = context.graph.incoming.get(context.node.id) ?? [];
    return [...new Set(incoming.map((edge) => edge.source))];
  }

  private refNodes(templates: readonly string[]): string[] {
    return templates.flatMap((template) =>
      templateRefs(template).flatMap((ref) => (ref.root === 'nodes' ? [ref.nodeId] : [])),
    );
  }

  /** Opens the outputs of the steps this step may read, for the given nodes. */
  private async load(
    context: StepContext,
    nodeIds: readonly string[],
  ): Promise<Map<string, LoadedOutput>> {
    const snapshots: StepSnapshot[] = context.steps.map((step) => ({
      nodeId: step.nodeId,
      iteration: step.iteration,
      status: step.status,
      handles: step.handles,
    }));
    const wanted = new Map<string, WorkflowStep>();
    for (const nodeId of new Set(nodeIds)) {
      if (nodeId === context.graph.trigger.id) continue;
      const visible = visibleStep(context.graph, snapshots, context.step, nodeId);
      if (!visible) continue;
      const step = context.steps.find(
        (candidate) =>
          candidate.nodeId === nodeId && candidate.iteration === visible.iteration,
      );
      if (step) wanted.set(nodeId, step);
    }
    const opened = await this.openSteps(context, [...wanted.values()]);
    const loaded = new Map<string, LoadedOutput>();
    for (const [nodeId, step] of wanted) {
      const envelope = opened.get(step.id);
      if (envelope) loaded.set(nodeId, { step, envelope });
    }
    return loaded;
  }

  private async openSteps(
    context: StepContext,
    steps: readonly WorkflowStep[],
  ): Promise<Map<string, StepOutputEnvelope>> {
    if (steps.length === 0) return new Map();
    const rows: Array<{ id: string; output_ciphertext: string | null }> =
      await this.dataSource.query(
        `SELECT id, output_ciphertext FROM workflow_steps WHERE run_id = $1 AND id = ANY($2::uuid[])`,
        [context.run.id, steps.map((step) => step.id)],
      );
    const opened = new Map<string, StepOutputEnvelope>();
    for (const row of rows) {
      if (!row.output_ciphertext) continue;
      opened.set(
        row.id,
        this.crypto.open<StepOutputEnvelope>(
          context.key,
          row.output_ciphertext,
          RunAad.stepOutput(context.run.id, row.id),
        ),
      );
    }
    return opened;
  }

  private runInputCache = new WeakMap<StepContext, unknown>();

  private async runInput(context: StepContext): Promise<unknown> {
    if (this.runInputCache.has(context)) return this.runInputCache.get(context);
    const [row]: Array<{ input_ciphertext: string | null }> = await this.dataSource.query(
      `SELECT input_ciphertext FROM workflow_runs WHERE id = $1`,
      [context.run.id],
    );
    const input = row?.input_ciphertext
      ? this.crypto.open(context.key, row.input_ciphertext, RunAad.runInput(context.run.id))
      : {};
    this.runInputCache.set(context, input);
    return input;
  }

  private async scope(
    context: StepContext,
    loaded: ReadonlyMap<string, LoadedOutput>,
  ): Promise<TemplateScope> {
    return {
      input: await this.runInput(context),
      nodes: Object.fromEntries(
        [...loaded.entries()].map(([nodeId, output]) => [
          nodeId,
          { output: output.envelope.value },
        ]),
      ),
    };
  }

  private render(template: string, scope: TemplateScope, used: Set<string>): string {
    const rendered = renderTemplate(template, scope);
    rendered.nodes.forEach((node) => used.add(node));
    return rendered.text;
  }

  /**
   * The input of a node with no template: the run's input for a node fed by
   * the trigger (its `input` field when it has one), otherwise the outputs of
   * its predecessors as text. Retrieval predecessors contribute passages, not
   * text.
   */
  private async defaultInput(
    context: StepContext,
    predecessors: readonly string[],
    loaded: ReadonlyMap<string, LoadedOutput>,
    used: Set<string>,
  ): Promise<string> {
    const parts: string[] = [];
    for (const predecessor of predecessors) {
      if (predecessor === context.graph.trigger.id) {
        const input = await this.runInput(context);
        const field = (input as { input?: unknown } | null)?.input;
        parts.push(typeof field === 'string' ? field : stringify(input));
        continue;
      }
      const output = loaded.get(predecessor);
      if (!output || output.envelope.passages) continue;
      used.add(predecessor);
      parts.push(stringify(output.envelope.value));
    }
    return parts.join('\n\n');
  }

  /** The labels of the run input (trusted, public) and of every earlier step read. */
  private labelsOf(
    context: StepContext,
    loaded: ReadonlyMap<string, LoadedOutput>,
    used: ReadonlySet<string>,
  ): { label: InformationLabel; integrity: Integrity } {
    const steps = [...used]
      .map((nodeId) => loaded.get(nodeId)?.step)
      .filter(Boolean) as WorkflowStep[];
    return {
      label: joinLabels(PUBLIC_LABEL, ...steps.map(labelOfStep)),
      integrity: meetIntegrity(Integrity.TRUSTED, ...steps.map((step) => step.integrity)),
    };
  }

  /** Whether this step was reached through an approval that a person granted. */
  private approvedBefore(context: StepContext): boolean {
    const incoming = context.graph.incoming.get(context.node.id) ?? [];
    return incoming.some((edge) => {
      if (context.graph.nodes.get(edge.source)?.type !== 'approval') return false;
      if (handleOf(edge) !== HANDLE.APPROVED) return false;
      return context.steps.some(
        (step) =>
          step.nodeId === edge.source &&
          step.status === StepStatus.SUCCEEDED &&
          step.handles.includes(HANDLE.APPROVED),
      );
    });
  }

  private async workerProfiles(
    context: StepContext,
    workers: readonly string[],
  ): Promise<Map<string, { name: string; description: string }>> {
    const agentIds = workers
      .map((id) => context.graph.nodes.get(id))
      .flatMap((node) => (node?.type === 'agent' ? [node.data.agentId] : []));
    const rows: Array<{ id: string; name: string; description: string | null }> =
      agentIds.length === 0
        ? []
        : await this.dataSource.query(
            `SELECT id, name, description FROM agents
              WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND deleted_at IS NULL`,
            [agentIds, context.run.organizationId],
          );
    const byAgent = new Map(rows.map((row) => [row.id, row]));
    const profiles = new Map<string, { name: string; description: string }>();
    for (const workerId of workers) {
      const node = context.graph.nodes.get(workerId);
      if (node?.type !== 'agent') continue;
      const agent = byAgent.get(node.data.agentId);
      profiles.set(workerId, {
        name: node.label ?? agent?.name ?? workerId,
        description: (agent?.description ?? '').slice(0, 300),
      });
    }
    return profiles;
  }

  // ── Budgets ───────────────────────────────────────────────────────────────

  /** Adds a model call's tokens to the run; over budget, the run's circuit opens. */
  private async consumeTokens(runId: string, tokens: number): Promise<void> {
    const [row] = returnedRows<{ tokens_used: string; max_tokens: number }>(
      await this.dataSource.query(
        `UPDATE workflow_runs SET tokens_used = tokens_used + $2
          WHERE id = $1 RETURNING tokens_used, max_tokens`,
        [runId, Math.max(0, Math.round(tokens))],
      ),
    );
    if (row && Number(row.tokens_used) > row.max_tokens) {
      throw new RunBudgetExceeded(Number(row.tokens_used), row.max_tokens);
    }
  }

  private runBudget(runId: string): ToolCallBudget {
    const maxCalls = this.toolsConfig.maxCallsPerRun;
    const dataSource = this.dataSource;
    return {
      async reserve(tool: ToolDescriptor): Promise<boolean> {
        const reserved = returnedRows(
          await dataSource.query(
            `UPDATE workflow_runs SET tool_calls = tool_calls + 1
              WHERE id = $1 AND tool_calls < $2 RETURNING tool_calls`,
            [runId, maxCalls],
          ),
        );
        if (reserved.length === 0) return false;
        if (tool.maxCallsPerRun === undefined) return true;
        const [{ count }]: Array<{ count: number }> = await dataSource.query(
          `SELECT count(*)::int AS count FROM tool_executions
            WHERE workflow_run_id = $1 AND tool_id = $2 AND status IN ('SUCCEEDED', 'RUNNING')`,
          [runId, tool.id],
        );
        return count < tool.maxCallsPerRun;
      },
    };
  }
}

export function labelOfStep(
  step: Pick<WorkflowStep, 'classification' | 'knowledgeBaseIds' | 'documentIds'>,
): InformationLabel {
  return {
    classification: step.classification,
    knowledgeBaseIds: step.knowledgeBaseIds ?? [],
    documentIds: step.documentIds ?? [],
  };
}
