import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DataSource } from 'typeorm';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException, ConflictError } from '../../common/exceptions/app.exception';
import { AGENTS_CONFIG_KEY, type AgentsConfig } from '../../config/agents.config';
import { GOVERNANCE_CONFIG_KEY, type GovernanceConfig } from '../../config/governance.config';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import { RAG_CONFIG_KEY, type RagConfig } from '../../config/rag.config';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { Classification, dominates } from '../knowledge/domain/classification';
import type {
  RetrievalResponseDto,
  RetrievedChunkDto,
} from '../knowledge/retrieval/dto/retrieval.dto';
import { RetrievalService } from '../knowledge/retrieval/retrieval.service';
import {
  resolveParameters,
  type ChatMessage,
  type GenerationParameters,
} from '../llm/domain/generation';
import { PER_MESSAGE_OVERHEAD } from '../llm/domain/token-estimator';
import {
  InvocationPurpose,
  InvocationStatus,
  type InvocationMetrics,
} from '../llm/entities/llm-invocation.entity';
import { GenerationInterruptedError, invocationStatusOf } from '../llm/llm-errors';
import { LlmGatewayService, type GatewayResult } from '../llm/llm-gateway.service';
import { LlmPolicyService, type ResolvedModel } from '../llm/llm-policy.service';
import { UsageService } from '../llm/usage.service';
import { RedactionService, type RedactionOutcome } from '../privacy/redaction.service';
import { GovernorService } from '../quotas/governor.service';
import { Integrity, meetIntegrity } from '../tools/domain/information-flow';
import type { ToolDescriptor } from '../tools/domain/tool-definition';
import { InMemoryToolBudget, ToolExecutorService } from '../tools/tool-executor.service';
import { AgentsService, type ExecutableAgent } from './agents.service';
import { ConversationsService, labelOf, toMessageDto } from './conversations.service';
import { toolsOf, type AgentConfig } from './domain/agent-config';
import {
  planBudget,
  selectHistory,
  selectPassages,
  type BudgetPlan,
} from './domain/context-window';
import {
  joinLabels,
  PUBLIC_LABEL,
  withholdReason,
  type InformationLabel,
} from './domain/labels';
import { compileSystemPrompt, PROMPT_TEMPLATE_VERSION } from './domain/persona';
import {
  assembleMessages,
  citedTags,
  escapeTitle,
  escapeUntrusted,
  sourceTag,
  userTurn,
  type MaskedSource,
} from './domain/prompt';
import type {
  ContextAccountingDto,
  PromptPreviewDto,
  PromptPreviewResultDto,
} from './dto/agent.dto';
import type {
  SendMessageDto,
  TurnOverridesDto,
  TurnResultDto,
  TurnRetrievalDto,
} from './dto/conversation.dto';
import type { Conversation } from './entities/conversation.entity';
import { ConversationStatus } from './entities/conversation.entity';
import {
  MessageRole,
  MessageStatus,
  type ConversationMessage,
  type MessageCitation,
  type MessageToolCall,
} from './entities/conversation-message.entity';
import {
  ToolLoopService,
  type LoopIteration,
  type ToolLoopProgress,
  type ToolLoopResult,
} from './tool-loop.service';

export type TurnStage =
  'retrieving' | 'redacting' | 'queued' | 'generating' | 'thinking' | 'tool';

/** Progress callbacks for a streamed turn. */
export interface TurnStreamHandlers {
  /** Preflight passed: the turn will run. Open the stream here. */
  onOpen?: (meta: {
    conversationId: string;
    agentId: string;
    agentVersion: number;
    model: string;
    userMessageId: string;
    assistantMessageId: string;
  }) => void;
  onStatus?: (stage: TurnStage, detail?: Record<string, unknown>) => void;
  onDelta?: (text: string) => void;
  /** A tool call finished (phase 4): which tool and how it went — never content. */
  onTool?: (call: MessageToolCall) => void;
}

interface HistoryEntry {
  id: string;
  role: MessageRole;
  content: string;
  label: InformationLabel;
  integrity: Integrity;
}

interface IncludedSource {
  tag: string;
  passage: RetrievedChunkDto;
}

interface TurnPlan {
  model: ResolvedModel;
  parameters: GenerationParameters;
  budget: BudgetPlan;
  messages: ChatMessage[];
  redaction: RedactionOutcome;
  retrieval: RetrievalResponseDto | null;
  sources: IncludedSource[];
  historyIncluded: HistoryEntry[];
  historyExcluded: number;
  userLabel: InformationLabel;
  assistantLabel: InformationLabel;
  /** How far the prompt can be trusted: the lowest integrity of its inputs. */
  integrity: Integrity;
  /** Tools offered this turn (granted, enabled, and usable by this user). */
  tools: ToolDescriptor[];
  maxIterations: number;
  accounting: ContextAccountingDto;
  retrievalMs: number;
}

/**
 * One agent turn, end to end (proposal modules 6.7, 6.8, 6.10 and 6.12
 * together).
 *
 *     preflight ─▶ retrieve ─▶ budget ─▶ mask ─▶ gateway ─▶ unmask ─▶ store
 *    (owner, agent,  (as the     (tokens)  (one     (egress   (as it     (encrypted,
 *     lease, dup)     user)                session)  check)    streams)   labelled)
 *
 * ## The agent is a delegate, never a principal
 *
 * Everything the agent reads, it reads as the person talking to it: retrieval
 * runs with the user's access scope, narrowed by the agent's knowledge bases and
 * classification ceiling and by the model endpoint's ceiling — never widened.
 * History is re-checked against the user's current access each turn. So an
 * agent cannot be used as a confused deputy: configuring an agent with the HR
 * compartment does not let anyone without HR access reach HR through it.
 *
 * ## Only masked text leaves
 *
 * The system prompt, every retrieved passage and title, every history message
 * and the question are masked in one session, so a person or number is the
 * same placeholder wherever it appears. The gateway re-checks the final
 * payload, and unmasks the answer as it streams back.
 */
@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);
  private readonly llmConfig: LlmConfig;
  private readonly agentsConfig: AgentsConfig;
  private readonly ragConfig: RagConfig;
  private readonly circuitConfig: GovernanceConfig['circuit'];

  constructor(
    private readonly agents: AgentsService,
    private readonly conversations: ConversationsService,
    private readonly retrieval: RetrievalService,
    private readonly redaction: RedactionService,
    private readonly gateway: LlmGatewayService,
    private readonly llmPolicies: LlmPolicyService,
    private readonly usage: UsageService,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
    private readonly toolExecutor: ToolExecutorService,
    private readonly toolLoop: ToolLoopService,
    configService: ConfigService,
    private readonly governor: GovernorService,
  ) {
    this.llmConfig = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
    this.agentsConfig = configService.getOrThrow<AgentsConfig>(AGENTS_CONFIG_KEY);
    this.ragConfig = configService.getOrThrow<RagConfig>(RAG_CONFIG_KEY);
    this.circuitConfig =
      configService.getOrThrow<GovernanceConfig>(GOVERNANCE_CONFIG_KEY).circuit;
  }

  // ── A turn ────────────────────────────────────────────────────────────────

  async runTurn(
    principal: AccessPrincipal,
    conversationId: string,
    input: SendMessageDto,
    handlers: TurnStreamHandlers = {},
    signal?: AbortSignal,
  ): Promise<TurnResultDto> {
    const started = performance.now();
    this.gateway.assertConfigured();
    this.assertMessageLength(input.content);

    // ── Preflight: every failure here is an ordinary HTTP error ──────────
    const conversation = await this.conversations.load(principal, conversationId, 'owner', {
      withKey: true,
      withTitle: true,
    });
    if (conversation.status === ConversationStatus.ARCHIVED) {
      throw new ConflictError(ErrorCode.CONVERSATION_ARCHIVED);
    }
    const executable = await this.agents.resolveForExecution(
      principal,
      conversation.agentId,
    );
    await this.conversations.assertNotDuplicate(conversation.id, input.clientMessageId);
    await this.assertConversationBudget(principal, executable, conversation);
    const model = await this.llmPolicies.resolve(
      principal.organizationId,
      [executable.config.model],
      executable.config.contextWindow,
    );

    const lockId = await this.conversations.acquireTurn(conversation);
    const key = this.conversations.unwrapKey(conversation);
    const ids: { invocation: string; user: string; assistant: string } = {
      invocation: randomUUID(),
      user: randomUUID(),
      assistant: randomUUID(),
    };
    let plan: TurnPlan | null = null;
    // A holder, not a `let`: it is assigned inside a callback the compiler cannot follow.
    const stored: { userMessage: ConversationMessage | null } = { userMessage: null };

    try {
      handlers.onOpen?.({
        conversationId: conversation.id,
        agentId: executable.agent.id,
        agentVersion: executable.version.version,
        model: model.name,
        userMessageId: ids.user,
        assistantMessageId: ids.assistant,
      });

      const history = await this.loadHistory(
        principal,
        conversation,
        key,
        executable.config,
      );
      plan = await this.plan(principal, executable, model, {
        question: input.content,
        history: history.entries,
        historyExcludedByAccess: history.excluded,
        conversationLabel: conversationLabel(conversation),
        overrides: input.parameters,
        retrievalOverride: input.retrieval,
        conversationId: conversation.id,
        onStatus: handlers.onStatus,
        signal,
      });

      handlers.onStatus?.('queued', this.gateway.load);
      const activePlan = plan;
      let turnTokens = 0;
      const progress: ToolLoopProgress = {
        visible: '',
        iterations: 0,
        toolCalls: [],
        flow: null,
      };
      let loop: ToolLoopResult;
      try {
        loop = await this.toolLoop.run(
          {
            principal,
            model: { name: model.name, contextWindow: model.contextWindow },
            parameters: activePlan.parameters,
            promptBudget: activePlan.budget.promptBudget,
            messages: activePlan.messages,
            privacy: activePlan.redaction.session
              ? { mode: 'masked', session: activePlan.redaction.session }
              : { mode: 'disabled', reason: 'workspace-policy' },
            policy: activePlan.redaction.policy,
            tools: activePlan.tools,
            maxIterations: activePlan.maxIterations,
            flow: { label: activePlan.assistantLabel, integrity: activePlan.integrity },
            agent: this.agentScope(executable),
            origin: { conversationId: conversation.id },
            actorLabel: actorLabelOf(principal),
            executionId: () => randomUUID(),
            callBudget: new InMemoryToolBudget(this.toolExecutor.maxIterations),
            purpose: InvocationPurpose.AGENT_TURN,
            // Intermediate model calls (those that ended in a tool call) are
            // recorded as they happen; the final one commits with the answer.
            onIteration: async (iteration) => {
              turnTokens +=
                iteration.result.usage.promptTokens + iteration.result.usage.completionTokens;
              if (iteration.final) return;
              await this.usage.record(
                this.iterationEntry(
                  principal,
                  executable,
                  conversation,
                  activePlan,
                  iteration,
                ),
              );
              // The turn's circuit breaker (phase 5): no further model call
              // once one answer has spent its budget.
              await this.assertTurnBudget(principal, executable, conversation, turnTokens);
            },
            handlers: {
              // The question is stored only once the model has accepted the
              // request: a refused or blocked turn leaves no orphaned question.
              onAdmitted: async () => {
                stored.userMessage = await this.dataSource.transaction((manager) =>
                  this.conversations.appendMessage(manager, conversation, key, {
                    id: ids.user,
                    role: MessageRole.USER,
                    status: MessageStatus.COMPLETE,
                    content: input.content,
                    tokenCount: activePlan.accounting.userTokens,
                    label: activePlan.userLabel,
                    integrity: Integrity.TRUSTED,
                    agentVersion: executable.version.version,
                    clientMessageId: input.clientMessageId ?? null,
                  }),
                );
                handlers.onStatus?.('generating');
              },
              onDelta: handlers.onDelta,
              onThinking: () => handlers.onStatus?.('thinking'),
              onToolStart: ({ tool, iteration }) =>
                handlers.onStatus?.('tool', { tool, iteration }),
              onToolEnd: (call) => handlers.onTool?.(call),
            },
            signal,
          },
          progress,
        );
      } catch (error) {
        await this.recordFailure(
          principal,
          executable,
          conversation,
          key,
          activePlan,
          ids,
          error,
          {
            started,
            admitted: stored.userMessage !== null,
            progress,
          },
        );
        throw error;
      }

      if (!stored.userMessage) {
        throw new Error('The model answered without the turn having been admitted.');
      }
      ids.invocation = loop.finalInvocationId;
      return await this.complete(
        principal,
        executable,
        conversation,
        key,
        activePlan,
        ids,
        mergeLoop(loop),
        {
          started,
          userMessage: stored.userMessage,
          userContent: input.content,
          streamed: handlers.onDelta !== undefined,
          loop,
        },
      );
    } catch (error) {
      if (!plan && isRedactionRefusal(error)) {
        await this.recordRefusal(
          principal,
          executable,
          conversation,
          model,
          ids.invocation,
          error,
          started,
        );
      }
      throw error;
    } finally {
      plan?.redaction.session?.destroy();
      this.conversations.destroyKey(key);
      await this.conversations.releaseTurn(conversation.id, lockId);
    }
  }

  /**
   * The exact prompt a turn would send — masked — without sending it or
   * storing anything. The most direct way to see the privacy layer work, and to
   * debug an agent's answers.
   */
  async preview(
    principal: AccessPrincipal,
    agentId: string,
    input: PromptPreviewDto,
  ): Promise<PromptPreviewResultDto> {
    this.assertMessageLength(input.content);
    const executable = await this.agents.resolveForExecution(principal, agentId);
    const model = await this.llmPolicies.resolve(
      principal.organizationId,
      [executable.config.model],
      executable.config.contextWindow,
    );

    let history: { entries: HistoryEntry[]; excluded: number } = {
      entries: [],
      excluded: 0,
    };
    let label: InformationLabel = PUBLIC_LABEL;
    if (input.conversationId) {
      const conversation = await this.conversations.load(
        principal,
        input.conversationId,
        'owner',
        {
          withKey: true,
        },
      );
      if (conversation.agentId !== agentId) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            message: 'That conversation belongs to a different agent.',
          },
        );
      }
      const key = this.conversations.unwrapKey(conversation);
      try {
        history = await this.loadHistory(principal, conversation, key, executable.config);
      } finally {
        this.conversations.destroyKey(key);
      }
      label = conversationLabel(conversation);
    }

    const plan = await this.plan(principal, executable, model, {
      question: input.content,
      history: history.entries,
      historyExcludedByAccess: history.excluded,
      conversationLabel: label,
    });

    try {
      return {
        model: model.name,
        agentVersion: executable.version.version,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        messages: plan.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        context: plan.accounting,
        redaction: {
          enabled: plan.redaction.enabled,
          degraded: plan.redaction.degraded,
          entities: plan.redaction.summary?.entities ?? 0,
          occurrences: plan.redaction.summary?.occurrences ?? 0,
          byType: plan.redaction.summary?.byType ?? {},
          bySource: plan.redaction.summary?.bySource ?? {},
          detectors: plan.redaction.detectors,
          timings: plan.redaction.timings,
          // The gateway's own check, run here too so the preview is honest.
          egressFindings: plan.redaction.session
            ? plan.redaction.session.findLeaks(
                plan.messages.map((m) => m.content).join('\n\n'),
              )
            : [],
        },
        retrieval: plan.retrieval
          ? {
              retrievalId: plan.retrieval.retrievalId,
              passagesRetrieved: plan.retrieval.results.length,
              passagesIncluded: plan.sources.length,
              effectiveClearance: plan.retrieval.effectiveClearance,
              knowledgeBasesSearched: plan.retrieval.knowledgeBasesSearched,
            }
          : null,
      };
    } finally {
      plan.redaction.session?.destroy();
    }
  }

  // ── Planning ──────────────────────────────────────────────────────────────

  private async plan(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    model: ResolvedModel,
    input: {
      question: string;
      history: HistoryEntry[];
      historyExcludedByAccess: number;
      conversationLabel: InformationLabel;
      overrides?: TurnOverridesDto;
      retrievalOverride?: TurnRetrievalDto;
      conversationId?: string;
      onStatus?: TurnStreamHandlers['onStatus'];
      signal?: AbortSignal;
    },
  ): Promise<TurnPlan> {
    const { config } = executable;
    const estimator = this.gateway.tokens;
    const parameters = resolveParameters(
      {
        defaultTemperature: this.llmConfig.defaultTemperature,
        defaultMaxOutputTokens: this.llmConfig.defaultMaxOutputTokens,
        maxOutputTokens: model.maxOutputTokens,
      },
      config.parameters,
      input.overrides,
    );
    const budget = planBudget(model.contextWindow, parameters.maxOutputTokens);

    // ── Retrieval, as the user ──────────────────────────────────────────
    let retrieval: RetrievalResponseDto | null = null;
    let retrievalMs = 0;
    const knowledgeBaseIds = this.turnKnowledgeBases(config, input.retrievalOverride);
    if (knowledgeBaseIds.length > 0) {
      input.onStatus?.('retrieving');
      const retrievalStarted = performance.now();
      retrieval = await this.retrieval.retrieve(principal, {
        query: this.retrievalQuery(input.question),
        topK: config.retrieval.topK,
        mode: config.retrieval.mode,
        rerank: config.retrieval.rerank,
        minScore:
          config.retrieval.mode === 'dense'
            ? (config.retrieval.minScore ?? undefined)
            : undefined,
        restrictToKnowledgeBaseIds: knowledgeBaseIds,
        maxClassification: this.ceiling(config),
        origin: {
          agentId: executable.agent.id,
          agentVersion: executable.version.version,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        },
      });
      retrievalMs = Math.round(performance.now() - retrievalStarted);
    }

    // ── Tools: granted, enabled, and usable by this user (phase 4) ──────
    const toolsConfig = toolsOf(config, this.toolExecutor.defaultIterations);
    const maxIterations = Math.min(
      toolsConfig.maxIterations,
      this.toolExecutor.maxIterations,
    );
    const tools =
      maxIterations > 0
        ? await this.toolExecutor.offerable(principal, toolsConfig.toolIds)
        : [];
    const promptTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    // ── Budget (estimated on the plain text; checked again after masking) ─
    const systemFor = (hasContext: boolean) =>
      compileSystemPrompt({
        agentName: executable.agent.name,
        persona: config.persona,
        instructions: executable.instructions,
        grounding: config.grounding,
        citations: config.citations,
        hasContext,
        tools: promptTools,
      });
    const systemTokens =
      estimator.estimate(model.name, systemFor(true)) + PER_MESSAGE_OVERHEAD;
    const userTokens =
      estimator.estimate(model.name, input.question) + PER_MESSAGE_OVERHEAD + 8;

    if (systemTokens + userTokens > budget.promptBudget) {
      throw new AppException(
        ErrorCode.LLM_CONTEXT_OVERFLOW,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          details: {
            estimatedTokens: systemTokens + userTokens,
            promptBudget: budget.promptBudget,
            contextWindow: budget.contextWindow,
          },
        },
      );
    }

    const passages = (retrieval?.results ?? []).map((passage) => ({
      id: passage.chunkId,
      passage,
      tokens:
        estimator.estimate(model.name, `${passage.documentTitle}\n${passage.text}`) + 16,
    }));
    const passageBudget = Math.min(
      config.retrieval.maxContextTokens,
      budget.promptBudget - systemTokens - userTokens,
    );
    const chosenPassages = selectPassages(passages, passageBudget);

    const historyBudget = Math.min(
      config.memory.maxHistoryTokens,
      budget.promptBudget - systemTokens - userTokens - chosenPassages.tokens,
    );
    const candidates = input.history.map((entry) => ({
      id: entry.id,
      role: entry.role,
      tokens: estimator.estimate(model.name, entry.content) + PER_MESSAGE_OVERHEAD,
    }));
    const chosenHistory = selectHistory(
      candidates,
      Math.max(0, historyBudget),
      Math.min(config.memory.maxMessages, this.agentsConfig.memory.maxMessages),
    );
    const includedIds = new Set(chosenHistory.included);
    let historyIncluded = input.history.filter((entry) => includedIds.has(entry.id));

    const sources: IncludedSource[] = chosenPassages.included.map((entry, index) => ({
      tag: sourceTag(index),
      passage: entry.passage,
    }));
    const system = systemFor(sources.length > 0);

    // ── Mask everything in one session ──────────────────────────────────
    input.onStatus?.('redacting');
    const redaction = await this.redaction.redact({
      organizationId: principal.organizationId,
      segments: [
        { id: 'system', text: system },
        ...sources.flatMap((source) => [
          { id: `title:${source.tag}`, text: escapeTitle(source.passage.documentTitle) },
          { id: `text:${source.tag}`, text: escapeUntrusted(source.passage.text) },
        ]),
        ...historyIncluded.map((entry) => ({
          id: `history:${entry.id}`,
          text: entry.content,
        })),
        { id: 'question', text: input.question },
      ],
      purpose: 'agent-turn',
      signal: input.signal,
    });

    try {
      const masked = new Map(
        redaction.segments.map((segment) => [segment.id, segment.text]),
      );
      const maskedSources: MaskedSource[] = sources.map((source) => ({
        tag: source.tag,
        title: masked.get(`title:${source.tag}`) ?? '',
        text: masked.get(`text:${source.tag}`) ?? '',
      }));
      const finalUserTurn = userTurn(masked.get('question') ?? '', maskedSources);

      const assemble = () =>
        assembleMessages(
          masked.get('system') ?? '',
          historyIncluded.map((entry) => ({
            role:
              entry.role === MessageRole.USER ? ('user' as const) : ('assistant' as const),
            content: masked.get(`history:${entry.id}`) ?? '',
          })),
          finalUserTurn,
        );

      // Placeholders change lengths slightly; trim the oldest history if needed.
      let messages = assemble();
      let droppedAfterMasking = 0;
      while (
        estimator.estimateMessages(model.name, messages) > budget.promptBudget &&
        historyIncluded.length > 0
      ) {
        historyIncluded = historyIncluded.slice(1);
        while (historyIncluded[0]?.role === MessageRole.ASSISTANT)
          historyIncluded = historyIncluded.slice(1);
        droppedAfterMasking += 1;
        messages = assemble();
      }
      if (estimator.estimateMessages(model.name, messages) > budget.promptBudget) {
        throw new AppException(
          ErrorCode.LLM_CONTEXT_OVERFLOW,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            details: {
              promptBudget: budget.promptBudget,
              contextWindow: budget.contextWindow,
            },
          },
        );
      }

      // ── Labels: the answer is as sensitive as everything it was shown ──
      const userLabel: InformationLabel = {
        classification: input.conversationLabel.classification,
        knowledgeBaseIds: input.conversationLabel.knowledgeBaseIds,
        documentIds: [],
      };
      const assistantLabel = joinLabels(
        userLabel,
        ...historyIncluded.map((entry) => entry.label),
        ...sources.map((source) => ({
          classification: source.passage.classification,
          knowledgeBaseIds: [source.passage.knowledgeBaseId],
          documentIds: [source.passage.documentId],
        })),
      );

      // Integrity: the question and instructions are the user's and the
      // platform's; workspace documents and earlier answers may carry text
      // someone else wrote.
      const integrity = meetIntegrity(
        Integrity.TRUSTED,
        ...historyIncluded.map((entry) => entry.integrity),
        sources.length > 0 ? Integrity.INTERNAL : undefined,
      );

      const historyTokens = historyIncluded.reduce(
        (total, entry) =>
          total + (candidates.find((candidate) => candidate.id === entry.id)?.tokens ?? 0),
        0,
      );

      return {
        model,
        parameters,
        budget,
        messages,
        redaction,
        retrieval,
        sources,
        historyIncluded,
        historyExcluded:
          input.historyExcludedByAccess +
          chosenHistory.excludedByBudget +
          chosenHistory.excludedByLimit +
          droppedAfterMasking,
        userLabel,
        assistantLabel,
        integrity,
        tools,
        maxIterations,
        retrievalMs,
        accounting: {
          contextWindow: budget.contextWindow,
          promptBudget: budget.promptBudget,
          reservedForAnswer: budget.reservedForAnswer,
          systemTokens,
          passageTokens: chosenPassages.tokens,
          historyTokens,
          userTokens,
          passagesIncluded: sources.length,
          passagesDropped: chosenPassages.dropped,
          historyIncluded: historyIncluded.length,
          historyExcluded:
            input.historyExcludedByAccess +
            chosenHistory.excludedByBudget +
            chosenHistory.excludedByLimit +
            droppedAfterMasking,
        },
      };
    } catch (error) {
      redaction.session?.destroy();
      throw error;
    }
  }

  /**
   * History the model may see this turn: complete messages only, each within
   * the turn's classification ceiling, and — for the assistant's messages —
   * still readable by the user today. The user's own words are theirs.
   */
  private async loadHistory(
    principal: AccessPrincipal,
    conversation: Conversation,
    key: Buffer,
    config: AgentConfig,
  ): Promise<{ entries: HistoryEntry[]; excluded: number }> {
    const limit = Math.min(config.memory.maxMessages, this.agentsConfig.memory.maxMessages);
    const rows = await this.conversations.recentMessages(conversation.id, limit);
    if (rows.length === 0) return { entries: [], excluded: 0 };

    const reader = await this.conversations.readerFor(principal, rows);
    const ceiling = this.ceiling(config);
    const entries: HistoryEntry[] = [];
    let excluded = 0;

    for (const row of rows) {
      if (row.status !== MessageStatus.COMPLETE) continue;
      const label = labelOf(row);
      const aboveCeiling = !dominates(ceiling, label.classification);
      const withheld =
        row.role === MessageRole.ASSISTANT && withholdReason(label, reader) !== null;
      if (aboveCeiling || withheld) {
        excluded += 1;
        continue;
      }
      const content = this.conversations.decrypt(key, row);
      if (content) {
        entries.push({
          id: row.id,
          role: row.role,
          content,
          label,
          integrity: row.integrity ?? Integrity.INTERNAL,
        });
      }
    }

    return { entries, excluded };
  }

  // ── Completion and failure ────────────────────────────────────────────────

  private async complete(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    conversation: Conversation,
    key: Buffer,
    plan: TurnPlan,
    ids: { invocation: string; user: string; assistant: string },
    result: GatewayResult,
    context: {
      started: number;
      userMessage: ConversationMessage;
      userContent: string;
      streamed: boolean;
      loop: ToolLoopResult;
    },
  ): Promise<TurnResultDto> {
    const loop = context.loop;
    // The answer is as sensitive as everything it was shown — tool results
    // included — and as trustworthy as the least trustworthy of them.
    const answerLabel = loop.flow.label;
    const cited = new Set(
      citedTags(
        result.text,
        plan.sources.map((source) => source.tag),
      ),
    );
    const citations: MessageCitation[] = plan.sources.map((source) => ({
      tag: source.tag,
      documentId: source.passage.documentId,
      chunkId: source.passage.chunkId,
      knowledgeBaseId: source.passage.knowledgeBaseId,
      rank: source.passage.rank,
      score: source.passage.score,
      cited: cited.has(source.tag),
    }));

    const redactionMs = round(
      plan.redaction.timings.totalMs +
        result.timings.egressCheckMs +
        result.timings.unmaskMs +
        loop.timings.toolRedactionMs,
    );
    const totalMs = Math.round(performance.now() - context.started);
    const redactionSummary = {
      enabled: plan.redaction.enabled,
      degraded: plan.redaction.degraded,
      entities: plan.redaction.summary?.entities ?? 0,
      byType: plan.redaction.summary?.byType ?? {},
      placeholdersResolved: result.placeholders.resolved,
      placeholdersUnresolved: result.placeholders.unresolved,
    };

    const assistant = await this.dataSource.transaction(async (manager) => {
      const saved = await this.conversations.appendMessage(manager, conversation, key, {
        id: ids.assistant,
        role: MessageRole.ASSISTANT,
        status: MessageStatus.COMPLETE,
        content: result.text,
        tokenCount: result.usage.completionTokens,
        label: answerLabel,
        integrity: loop.flow.integrity,
        toolCalls: loop.toolCalls,
        citations,
        agentVersion: executable.version.version,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        model: result.model,
        invocationId: ids.invocation,
        retrievalId: plan.retrieval?.retrievalId ?? null,
        redaction: redactionSummary,
      });
      await this.conversations.recordTurn(
        manager,
        conversation,
        joinLabels(conversationLabel(conversation), answerLabel),
        { prompt: result.usage.promptTokens, completion: result.usage.completionTokens },
      );
      await this.usage.record(
        {
          ...this.invocationBase(
            principal,
            executable,
            conversation,
            plan.model,
            ids,
            context.streamed,
          ),
          messageId: ids.assistant,
          status: InvocationStatus.COMPLETED,
          errorCode: null,
          finishReason:
            loop.finishedBy === 'tool_limit' ? 'tool_limit' : result.finishReason,
          // This row is the final model call; earlier calls in a tool loop
          // were recorded as they happened, so totals are never counted twice.
          promptTokens: loop.final.usage.promptTokens,
          completionTokens: loop.final.usage.completionTokens,
          tokensEstimated: loop.final.usage.estimated,
          iteration: loop.iterations,
          totalMs,
          ttftMs: result.timings.ttftMs === null ? null : Math.round(result.timings.ttftMs),
          queueMs: Math.round(result.timings.queueMs),
          retrievalMs: plan.retrievalMs,
          redactionMs: redactionMs.toFixed(2),
          entitiesMasked: redactionSummary.entities,
          redactionDegraded: plan.redaction.degraded,
          metrics: {
            ...this.metrics(plan, result),
            ...(loop.iterations > 1 || loop.toolCalls.length > 0
              ? { toolLoop: toolLoopMetrics(loop) }
              : {}),
          },
        },
        manager,
      );
      return saved;
    });

    await this.auditService.recordSafe({
      action: AuditAction.AGENT_INVOKED,
      organizationId: principal.organizationId,
      resourceType: 'agent',
      resourceId: executable.agent.id,
      resourceLabel: executable.agent.name,
      durationMs: totalMs,
      metadata: {
        agentVersion: executable.version.version,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        conversationId: conversation.id,
        messageId: ids.assistant,
        invocationId: ids.invocation,
        model: result.model,
        retrievalId: plan.retrieval?.retrievalId,
        passages: plan.sources.length,
        passagesCited: cited.size,
        historyIncluded: plan.historyIncluded.length,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        classification: answerLabel.classification,
        integrity: loop.flow.integrity,
        iterations: loop.iterations,
        toolCalls: loop.toolCalls.map((call) => ({
          executionId: call.executionId,
          tool: call.tool,
          status: call.status,
          ...(call.reason ? { reason: call.reason } : {}),
        })),
        redaction: {
          enabled: redactionSummary.enabled,
          degraded: redactionSummary.degraded,
          entities: redactionSummary.entities,
          byType: redactionSummary.byType,
        },
        timings: {
          retrievalMs: plan.retrievalMs,
          redactionMs,
          totalMs,
          ttftMs: result.timings.ttftMs,
        },
      },
    });
    await this.auditRedaction(principal, ids.invocation, plan);
    void this.agents.touch(executable.agent.id);

    const titles = new Map(
      plan.sources.map((source) => [
        source.passage.documentId,
        source.passage.documentTitle,
      ]),
    );
    return {
      conversationId: conversation.id,
      userMessage: toMessageDto(
        context.userMessage,
        context.userContent,
        'VISIBLE',
        undefined,
        titles,
      ),
      assistantMessage: toMessageDto(assistant, result.text, 'VISIBLE', undefined, titles),
      usage: result.usage,
      timings: {
        retrievalMs: plan.retrievalMs,
        redactionMs,
        queueMs: result.timings.queueMs,
        timeToFirstTokenMs: result.timings.ttftMs,
        generationMs: result.timings.generationMs,
        totalMs,
      },
      retrieval: {
        retrievalId: plan.retrieval?.retrievalId ?? null,
        passagesProvided: plan.sources.length,
        passagesCited: cited.size,
        effectiveClearance: plan.retrieval?.effectiveClearance ?? null,
      },
      context: { ...plan.accounting },
    };
  }

  /**
   * Records a turn that failed at or after the gateway. If the model had
   * already been streaming, what the user saw is kept as a cancelled or failed
   * message — text on a screen cannot be unsent, so history must reflect it.
   */
  private async recordFailure(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    conversation: Conversation,
    key: Buffer,
    plan: TurnPlan,
    ids: { invocation: string; user: string; assistant: string },
    error: unknown,
    context: { started: number; admitted: boolean; progress?: ToolLoopProgress },
  ): Promise<void> {
    const interrupted = error instanceof GenerationInterruptedError ? error : null;
    // What earlier iterations of a tool loop showed, and what their tools returned.
    const shownBefore = context.progress?.visible ?? '';
    const partialLabel = context.progress?.flow?.label ?? plan.assistantLabel;
    const partialIntegrity = context.progress?.flow?.integrity ?? plan.integrity;
    const code =
      error instanceof AppException ? error.code : ErrorCode.INTERNAL_SERVER_ERROR;
    const status = invocationStatusOf(error);
    const totalMs = Math.round(performance.now() - context.started);
    const partialTtft = interrupted?.partial.ttftMs ?? null;

    try {
      await this.dataSource.transaction(async (manager) => {
        if (context.admitted) {
          const partial = [shownBefore, interrupted?.partial.text ?? '']
            .filter((text) => text.trim().length > 0)
            .join('\n\n');
          await this.conversations.appendMessage(manager, conversation, key, {
            id: ids.assistant,
            role: MessageRole.ASSISTANT,
            status:
              status === InvocationStatus.CANCELLED
                ? MessageStatus.CANCELLED
                : MessageStatus.FAILED,
            content: partial.length > 0 ? partial : null,
            tokenCount:
              partial.length > 0
                ? this.gateway.tokens.estimate(plan.model.name, partial)
                : 0,
            label: partialLabel,
            integrity: partialIntegrity,
            toolCalls: context.progress?.toolCalls ?? [],
            agentVersion: executable.version.version,
            promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
            model: plan.model.name,
            invocationId: ids.invocation,
            retrievalId: plan.retrieval?.retrievalId ?? null,
            errorCode: code,
          });
          await this.conversations.recordTurn(
            manager,
            conversation,
            joinLabels(conversationLabel(conversation), partialLabel),
            { prompt: 0, completion: 0 },
          );
        }
        await this.usage.record(
          {
            ...this.invocationBase(
              principal,
              executable,
              conversation,
              plan.model,
              ids,
              true,
            ),
            messageId: context.admitted ? ids.assistant : null,
            status,
            errorCode: code,
            finishReason: null,
            promptTokens: context.admitted
              ? this.gateway.tokens.estimateMessages(plan.model.name, plan.messages)
              : 0,
            completionTokens: interrupted
              ? this.gateway.tokens.estimate(
                  plan.model.name,
                  interrupted.partial.maskedText,
                )
              : 0,
            tokensEstimated: true,
            totalMs,
            ttftMs: partialTtft === null ? null : Math.round(partialTtft),
            queueMs: null,
            retrievalMs: plan.retrievalMs,
            redactionMs: plan.redaction.timings.totalMs.toFixed(2),
            entitiesMasked: plan.redaction.summary?.entities ?? 0,
            redactionDegraded: plan.redaction.degraded,
            metrics: {},
          },
          manager,
        );
      });
    } catch (persistError) {
      this.logger.error(
        { err: persistError as Error, conversationId: conversation.id },
        'Could not record a failed agent turn.',
      );
    }

    // Egress blocks and governance refusals are audited where they happen.
    if (status !== InvocationStatus.BLOCKED && status !== InvocationStatus.THROTTLED) {
      await this.auditService.recordSafe({
        action: AuditAction.LLM_INFERENCE_FAILED,
        status:
          status === InvocationStatus.CANCELLED ? AuditStatus.SUCCESS : AuditStatus.FAILURE,
        organizationId: principal.organizationId,
        resourceType: 'llm_invocation',
        resourceId: ids.invocation,
        errorCode: code,
        durationMs: totalMs,
        metadata: {
          purpose: InvocationPurpose.AGENT_TURN,
          outcome: status,
          agentId: executable.agent.id,
          conversationId: conversation.id,
          model: plan.model.name,
          admitted: context.admitted,
        },
      });
    }
  }

  /** A turn refused before anything was sent, because redaction was unavailable. */
  private async recordRefusal(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    conversation: Conversation,
    model: ResolvedModel,
    invocationId: string,
    error: unknown,
    started: number,
  ): Promise<void> {
    await this.usage.record({
      ...this.invocationBase(
        principal,
        executable,
        conversation,
        model,
        { invocation: invocationId },
        false,
      ),
      messageId: null,
      status: InvocationStatus.REFUSED,
      errorCode: error instanceof AppException ? error.code : null,
      finishReason: null,
      promptTokens: 0,
      completionTokens: 0,
      tokensEstimated: true,
      totalMs: Math.round(performance.now() - started),
      ttftMs: null,
      queueMs: null,
      retrievalMs: null,
      redactionMs: null,
      entitiesMasked: 0,
      redactionDegraded: false,
      metrics: {},
    });
  }

  // ── Circuit breaking (phase 5) ────────────────────────────────────────────

  /**
   * A conversation's lifetime budget: a conversation that has spent it takes
   * no more turns (start a new one), which also bounds how large a history an
   * automation can grow by talking to an agent in a loop.
   */
  private async assertConversationBudget(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    conversation: Conversation,
  ): Promise<void> {
    const limit = this.circuitConfig.maxTokensPerConversation;
    if (limit <= 0) return;
    const used = Number(conversation.promptTokens ?? 0) + Number(conversation.completionTokens ?? 0);
    if (used < limit) return;

    await this.auditService.recordSafe({
      action: AuditAction.AGENT_CIRCUIT_BROKEN,
      status: AuditStatus.DENIED,
      organizationId: principal.organizationId,
      resourceType: 'conversation',
      resourceId: conversation.id,
      metadata: {
        scope: 'conversation',
        reason: 'TOKEN_BUDGET',
        agentId: executable.agent.id,
        conversationId: conversation.id,
        tokens: used,
        limit,
      },
    });
    throw new ConflictError(ErrorCode.CONVERSATION_TOKEN_BUDGET_EXCEEDED, {
      details: { tokensUsed: used, limit },
    });
  }

  /**
   * One answer's budget across its tool-loop iterations. Checked after each
   * model call that ended in a tool call — before the next one is made — so a
   * model that keeps calling tools cannot keep spending.
   */
  private async assertTurnBudget(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    conversation: Conversation,
    tokens: number,
  ): Promise<void> {
    const limit = this.circuitConfig.maxTokensPerTurn;
    if (limit <= 0 || tokens < limit) return;

    await this.auditService.recordSafe({
      action: AuditAction.AGENT_CIRCUIT_BROKEN,
      status: AuditStatus.DENIED,
      organizationId: principal.organizationId,
      resourceType: 'agent',
      resourceId: executable.agent.id,
      resourceLabel: executable.agent.name,
      metadata: {
        scope: 'turn',
        reason: 'TOKEN_BUDGET',
        conversationId: conversation.id,
        tokens,
        limit,
      },
    });
    await this.governor.recordAgentFault(
      principal.organizationId,
      executable.agent.id,
      ErrorCode.AGENT_TOKEN_BUDGET_EXCEEDED,
    );
    throw new AppException(
      ErrorCode.AGENT_TOKEN_BUDGET_EXCEEDED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { details: { tokens, limit } },
    );
  }

  /** The agent's bounds, as the tool engine applies them (delegation, ADR 0003). */
  private agentScope(executable: ExecutableAgent) {
    return {
      id: executable.agent.id,
      version: executable.version.version,
      name: executable.agent.name,
      knowledgeBaseIds: executable.config.retrieval.knowledgeBaseIds,
      maxClassification: this.ceiling(executable.config),
    };
  }

  /** The ledger row for a model call that ended in a tool call. */
  private iterationEntry(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    conversation: Conversation,
    plan: TurnPlan,
    iteration: LoopIteration,
  ) {
    const { result } = iteration;
    return {
      ...this.invocationBase(
        principal,
        executable,
        conversation,
        plan.model,
        { invocation: iteration.invocationId },
        true,
      ),
      messageId: null,
      status: InvocationStatus.COMPLETED,
      errorCode: null,
      finishReason: 'tool_call',
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      tokensEstimated: result.usage.estimated,
      iteration: iteration.iteration,
      totalMs: Math.round(result.timings.totalMs),
      ttftMs: result.timings.ttftMs === null ? null : Math.round(result.timings.ttftMs),
      queueMs: Math.round(result.timings.queueMs),
      retrievalMs: null,
      redactionMs: round(result.timings.egressCheckMs + result.timings.unmaskMs).toFixed(2),
      entitiesMasked: 0,
      redactionDegraded: plan.redaction.degraded,
      metrics: {
        timings: {
          egressCheckMs: result.timings.egressCheckMs,
          unmaskMs: result.timings.unmaskMs,
          queueMs: result.timings.queueMs,
          connectMs: result.timings.connectMs,
          ttftMs: result.timings.ttftMs,
          generationMs: result.timings.generationMs,
        },
        placeholders: result.placeholders,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      },
    };
  }

  private invocationBase(
    principal: AccessPrincipal,
    executable: ExecutableAgent,
    conversation: Conversation,
    model: ResolvedModel,
    ids: { invocation: string },
    streamed: boolean,
  ) {
    return {
      id: ids.invocation,
      organizationId: principal.organizationId,
      purpose: InvocationPurpose.AGENT_TURN,
      userId: principal.userId ?? null,
      apiKeyId: principal.apiKeyId ?? null,
      agentId: executable.agent.id,
      agentVersion: executable.version.version,
      conversationId: conversation.id,
      provider: this.gateway.providerKind,
      model: model.name,
      streamed,
    };
  }

  private metrics(plan: TurnPlan, result: GatewayResult): InvocationMetrics {
    return {
      timings: {
        retrievalMs: plan.retrievalMs,
        detectionPatternMs: plan.redaction.timings.patternMs,
        detectionNerMs: plan.redaction.timings.nerMs,
        maskingMs: plan.redaction.timings.maskingMs,
        egressCheckMs: result.timings.egressCheckMs,
        unmaskMs: result.timings.unmaskMs,
        queueMs: result.timings.queueMs,
        connectMs: result.timings.connectMs,
        ttftMs: result.timings.ttftMs,
        generationMs: result.timings.generationMs,
      },
      redaction: {
        enabled: plan.redaction.enabled,
        degraded: plan.redaction.degraded,
        entities: plan.redaction.summary?.entities ?? 0,
        occurrences: plan.redaction.summary?.occurrences ?? 0,
        byType: plan.redaction.summary?.byType ?? {},
        bySource: plan.redaction.summary?.bySource ?? {},
        detectors: plan.redaction.detectors,
        cacheHits: plan.redaction.cacheHits,
        segments: plan.redaction.summary?.segments ?? 0,
      },
      placeholders: result.placeholders,
      context: { ...plan.accounting, budget: plan.accounting.promptBudget },
      parameters: { ...plan.parameters },
      reasoningRemoved: result.reasoningRemoved,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    };
  }

  private async auditRedaction(
    principal: AccessPrincipal,
    invocationId: string,
    plan: TurnPlan,
  ): Promise<void> {
    const summary = plan.redaction.summary;
    if (!summary || summary.entities === 0) return;
    await this.auditService.recordSafe({
      action: AuditAction.PII_REDACTED,
      organizationId: principal.organizationId,
      resourceType: 'llm_invocation',
      resourceId: invocationId,
      metadata: {
        entities: summary.entities,
        occurrences: summary.occurrences,
        byType: summary.byType,
        bySource: summary.bySource,
        degraded: plan.redaction.degraded,
        detectionMs: round(plan.redaction.timings.patternMs + plan.redaction.timings.nerMs),
        maskingMs: plan.redaction.timings.maskingMs,
      },
    });
  }

  // ── Small decisions ───────────────────────────────────────────────────────

  private assertMessageLength(content: string): void {
    if (content.length > this.agentsConfig.maxMessageLength) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, {
        message: `Messages are limited to ${this.agentsConfig.maxMessageLength} characters.`,
      });
    }
  }

  /** The agent's bases for this turn, optionally narrowed by the request. */
  private turnKnowledgeBases(config: AgentConfig, override?: TurnRetrievalDto): string[] {
    if (!config.retrieval.enabled || override?.enabled === false) return [];
    const configured = config.retrieval.knowledgeBaseIds;
    if (!override?.knowledgeBaseIds) return configured;
    const requested = new Set(override.knowledgeBaseIds);
    return configured.filter((id) => requested.has(id));
  }

  /**
   * The retrieval query: whitespace-normalised, and trimmed to the retrieval
   * limit from the end — in a long message the question usually comes last.
   */
  private retrievalQuery(question: string): string {
    const normalized = question.replace(/\s+/g, ' ').trim();
    const limit = this.ragConfig.maxQueryLength;
    return normalized.length > limit
      ? normalized.slice(normalized.length - limit)
      : normalized;
  }

  /** The lower of the agent's classification ceiling and the model endpoint's. */
  private ceiling(config: AgentConfig): Classification {
    const endpoint = this.llmConfig.maxClassification;
    const agent = config.retrieval.maxClassification;
    if (!agent) return endpoint;
    return dominates(agent, endpoint) ? endpoint : agent;
  }
}

/**
 * The tool loop's totals, shaped as one gateway result: the text is everything
 * the user was shown, the usage is every call's, the timings are summed.
 */
function mergeLoop(loop: ToolLoopResult): GatewayResult {
  return {
    ...loop.final,
    text: loop.visible,
    usage: loop.usage,
    timings: {
      ...loop.final.timings,
      egressCheckMs: loop.timings.egressCheckMs,
      unmaskMs: loop.timings.unmaskMs,
      queueMs: loop.timings.queueMs,
      generationMs: loop.timings.generationMs,
      ttftMs: loop.timings.ttftMs,
    },
  };
}

function toolLoopMetrics(loop: ToolLoopResult) {
  return {
    iterations: loop.iterations,
    toolCalls: loop.toolCalls.length,
    denied: loop.toolCalls.filter((call) => call.status === 'denied').length,
    failed: loop.toolCalls.filter((call) => call.status === 'error').length,
    finishedBy: loop.finishedBy,
  };
}

/** Provenance for anything a tool sends; the tool resolves the person's name itself. */
function actorLabelOf(principal: AccessPrincipal): string {
  return principal.kind === 'api_key' ? 'an API client' : 'a workspace member';
}

function conversationLabel(conversation: Conversation): InformationLabel {
  return {
    classification: conversation.classification ?? Classification.PUBLIC,
    knowledgeBaseIds: conversation.knowledgeBaseIds ?? [],
    documentIds: [],
  };
}

function isRedactionRefusal(error: unknown): boolean {
  return (
    error instanceof AppException && error.code === ErrorCode.PII_DETECTION_UNAVAILABLE
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
