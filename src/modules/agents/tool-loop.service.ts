import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { stableStringify } from '../../common/utils/stable-stringify';
import type { AccessPrincipal } from '../knowledge/domain/access';
import {
  PARAMETER_BOUNDS,
  type ChatMessage,
  type GenerationParameters,
} from '../llm/domain/generation';
import {
  LlmGatewayService,
  type GatewayHandlers,
  type GatewayResult,
  type PrivacyGuard,
} from '../llm/llm-gateway.service';
import type { EffectivePiiPolicy } from '../privacy/domain/policy';
import { RedactionService } from '../privacy/redaction.service';
import type { ToolAgentScope, ToolCallOrigin } from '../tools/builtins/builtin-tool';
import { meetIntegrity, type FlowContext } from '../tools/domain/information-flow';
import {
  escapeToolText,
  formatToolCallMessage,
  formatToolResult,
  parseToolCall,
  TOOL_CALL_CLOSE,
  ToolCallStreamFilter,
  type ToolCallParse,
  type ToolResultStatus,
} from '../tools/domain/tool-call-protocol';
import type { ToolDescriptor } from '../tools/domain/tool-definition';
import { ToolDenialReason } from '../tools/entities/tool-execution.entity';
import { ToolExecutorService, type ToolCallBudget } from '../tools/tool-executor.service';
import { joinLabels } from './domain/labels';
import type { MessageToolCall } from './entities/conversation-message.entity';

/** Appended to the last tool result when the model must stop calling tools. */
const FINAL_NOTE =
  'You have reached the limit of tool calls for this answer. Answer now, using the ' +
  'information above, without calling any more tools.';

/** Replaces an old tool result when the transcript outgrows the context window. */
const ELIDED = '[An earlier tool result was removed to fit the context window.]';

/** Consecutive failed or refused calls after which the model is made to answer. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** One model call within an answer. */
export interface LoopIteration {
  invocationId: string;
  iteration: number;
  result: GatewayResult;
  /** The tool call this iteration ended with, if it ended with one. */
  toolCall: MessageToolCall | null;
  final: boolean;
}

export interface ToolLoopRequest {
  principal: AccessPrincipal;
  model: { name: string; contextWindow: number };
  parameters: GenerationParameters;
  promptBudget: number;
  /** The masked transcript: system prompt (tools section included), history, question. */
  messages: ChatMessage[];
  privacy: PrivacyGuard;
  policy: EffectivePiiPolicy;
  /** Tools offered; empty means one plain model call. */
  tools: readonly ToolDescriptor[];
  maxIterations: number;
  flow: FlowContext;
  agent: ToolAgentScope;
  origin: ToolCallOrigin;
  actorLabel: string;
  /**
   * The execution id for a call: deterministic in workflow steps — from the
   * step, the iteration and the tool — so a retried step's side effects are
   * recognised and not repeated.
   */
  executionId: (iteration: number, toolName: string) => string;
  callBudget: ToolCallBudget;
  /** Every model call, as it completes: for the usage ledger and token budgets. May throw to stop. */
  onIteration?: (iteration: LoopIteration) => Promise<void>;
  handlers?: {
    /** Called once: when the first model call is admitted. */
    onAdmitted?: GatewayHandlers['onAdmitted'];
    onDelta?: (text: string) => void;
    onThinking?: () => void;
    onToolStart?: (event: { tool: string; iteration: number }) => void;
    onToolEnd?: (call: MessageToolCall) => void;
  };
  signal?: AbortSignal;
}

/** Owned by the caller, so a failure part-way through still knows what happened. */
export interface ToolLoopProgress {
  /** Everything a user has been shown so far, across iterations. */
  visible: string;
  iterations: number;
  toolCalls: MessageToolCall[];
  /** The context's labels so far: a partial answer carries what its tools returned. */
  flow: FlowContext | null;
}

export interface ToolLoopResult {
  final: GatewayResult;
  finalInvocationId: string;
  /** Every iteration's visible text: what a streaming user saw. */
  visible: string;
  /** The final iteration's visible text: the answer itself. */
  answer: string;
  flow: FlowContext;
  toolCalls: MessageToolCall[];
  iterations: number;
  finishedBy: 'answer' | 'tool_limit';
  usage: { promptTokens: number; completionTokens: number; estimated: boolean };
  timings: {
    egressCheckMs: number;
    unmaskMs: number;
    queueMs: number;
    generationMs: number;
    toolMs: number;
    toolRedactionMs: number;
    ttftMs: number | null;
  };
  /** The final masked transcript, for a structured-output repair call. */
  messages: ChatMessage[];
}

/**
 * The reason → act → observe loop (ReAct, Yao et al. 2023; proposal module
 * 6.11): parse the model's tool-call intent, execute it, feed the result back,
 * and iterate to a bounded depth.
 *
 * Every property of a plain agent answer survives the loop:
 *
 *  - **Only masked text reaches the model.** Tool results are escaped and then
 *    masked in the request's *own* masking session, so a person is the same
 *    placeholder in the question, in a searched passage and in the draft
 *    email; and each iteration goes back through the gateway's egress check.
 *  - **Labels flow.** Each result's confidentiality label is joined into the
 *    context and its integrity met with it, and the next call is checked
 *    against the *updated* context — reading payroll through a tool closes
 *    the door to sending it anywhere a payroll reader may not.
 *  - **Bounded.** At most `maxIterations` tool calls; an exact repeat is
 *    answered from the transcript instead of re-run; three failures in a row
 *    end the loop; a result is capped in tokens, and old results are elided
 *    when the transcript outgrows the window. When the loop stops, the model
 *    is told to answer with what it has.
 *
 * Tool calls never reach a streaming user: text before `<tool_call>` streams
 * as the model's visible reasoning; the call itself is withheld.
 */
@Injectable()
export class ToolLoopService {
  constructor(
    private readonly gateway: LlmGatewayService,
    private readonly executor: ToolExecutorService,
    private readonly redaction: RedactionService,
  ) {}

  async run(request: ToolLoopRequest, progress: ToolLoopProgress): Promise<ToolLoopResult> {
    const names = new Set(request.tools.map((tool) => tool.name));
    const byName = new Map(request.tools.map((tool) => [tool.name, tool]));
    const offered = request.tools.length > 0 && request.maxIterations > 0;
    const session = request.privacy.mode === 'masked' ? request.privacy.session : null;
    const handlers = request.handlers ?? {};
    const baseCount = request.messages.length;

    let messages = [...request.messages];
    let flow = request.flow;
    let forceAnswer = false;
    let consecutiveFailures = 0;
    const seen = new Map<string, number>();
    const totals = {
      promptTokens: 0,
      completionTokens: 0,
      estimated: false,
      egressCheckMs: 0,
      unmaskMs: 0,
      queueMs: 0,
      generationMs: 0,
      toolMs: 0,
      toolRedactionMs: 0,
      ttftMs: null as number | null,
    };
    let admitted = false;

    for (let iteration = 1; ; iteration += 1) {
      const toolsActive = offered && !forceAnswer && iteration <= request.maxIterations;
      const invocationId = randomUUID();
      const filter = offered ? new ToolCallStreamFilter() : null;
      const onDelta = handlers.onDelta
        ? (text: string) => {
            const shown = filter ? filter.push(text) : text;
            if (shown) handlers.onDelta?.(shown);
          }
        : undefined;

      const result = await this.gateway.chat(
        {
          organizationId: request.principal.organizationId,
          model: request.model.name,
          messages,
          parameters: toolsActive ? withToolStop(request.parameters) : request.parameters,
          contextWindow: request.model.contextWindow,
          privacy: request.privacy,
          signal: request.signal,
        },
        {
          onAdmitted: admitted ? undefined : handlers.onAdmitted,
          onDelta,
          onThinking: handlers.onThinking,
        },
      );
      admitted = true;
      progress.iterations = iteration;
      // A held-back "<tool_c" that never became a call belongs to the answer.
      const heldBack = filter?.flush() ?? '';
      if (heldBack && handlers.onDelta) handlers.onDelta(heldBack);

      totals.promptTokens += result.usage.promptTokens;
      totals.completionTokens += result.usage.completionTokens;
      totals.estimated ||= result.usage.estimated;
      totals.egressCheckMs += result.timings.egressCheckMs;
      totals.unmaskMs += result.timings.unmaskMs;
      totals.queueMs += result.timings.queueMs;
      totals.generationMs += result.timings.generationMs;
      totals.ttftMs ??= result.timings.ttftMs;

      const parse: ToolCallParse = offered
        ? parseToolCall(result.maskedText, names)
        : { kind: 'none' };
      // A call in the forced last iteration is ignored: the loop is over.
      const isCall = toolsActive && parse.kind !== 'none';
      const shown = visibleText(result.text, parse, offered);
      progress.visible = joinVisible(progress.visible, shown);

      if (!isCall) {
        await request.onIteration?.({
          invocationId,
          iteration,
          result,
          toolCall: null,
          final: true,
        });
        const answer =
          shown.trim().length > 0
            ? shown
            : parse.kind !== 'none'
              ? 'I could not finish this within the number of tool calls allowed.'
              : shown;
        return {
          final: result,
          finalInvocationId: invocationId,
          visible: progress.visible.length > 0 ? progress.visible : answer,
          answer,
          flow,
          toolCalls: progress.toolCalls,
          iterations: iteration,
          finishedBy: parse.kind !== 'none' || forceAnswer ? 'tool_limit' : 'answer',
          usage: {
            promptTokens: totals.promptTokens,
            completionTokens: totals.completionTokens,
            estimated: totals.estimated,
          },
          timings: {
            egressCheckMs: round(totals.egressCheckMs),
            unmaskMs: round(totals.unmaskMs),
            queueMs: round(totals.queueMs),
            generationMs: round(totals.generationMs),
            toolMs: round(totals.toolMs),
            toolRedactionMs: round(totals.toolRedactionMs),
            ttftMs: totals.ttftMs,
          },
          messages,
        };
      }

      // ── The model asked for a tool ────────────────────────────────────
      let observation: { name: string; status: ToolResultStatus; content: string };
      let record: MessageToolCall | null = null;

      if (parse.kind === 'malformed') {
        messages.push({ role: 'assistant', content: result.maskedText.trim() });
        observation = {
          name: 'unknown',
          status: 'error',
          content:
            `Your tool call could not be understood: ${parse.reason} Call a tool exactly as ` +
            `<tool_call>{"name": "<tool>", "arguments": {…}}${TOOL_CALL_CLOSE}, or answer normally.`,
        };
        consecutiveFailures += 1;
      } else if (parse.kind === 'call') {
        const call = parse.call;
        messages.push({
          role: 'assistant',
          content: formatToolCallMessage(call.preamble, call),
        });

        const key = `${call.name}:${stableStringify(call.arguments)}`;
        const repeats = seen.get(key) ?? 0;
        seen.set(key, repeats + 1);

        if (repeats > 0) {
          observation = {
            name: call.name,
            status: 'error',
            content:
              'You already made exactly this call; its result is above. Use it, try something ' +
              'different, or answer.',
          };
          consecutiveFailures += 1;
          if (repeats >= 2) forceAnswer = true;
        } else {
          handlers.onToolStart?.({ tool: call.name, iteration });
          const outcome = await this.executor.execute(byName.get(call.name) ?? null, call, {
            principal: request.principal,
            agent: request.agent,
            flow,
            session,
            argumentsAreMasked: true,
            origin: { ...request.origin, iteration },
            actorLabel: request.actorLabel,
            executionId: request.executionId(iteration, call.name),
            budget: request.callBudget,
            signal: request.signal,
          });
          totals.toolMs += outcome.durationMs;

          record = {
            executionId: outcome.executionId,
            tool: outcome.toolName,
            status: outcome.status,
            ...(outcome.status !== 'ok' ? { code: outcome.code } : {}),
            ...(outcome.status === 'denied' ? { reason: outcome.reason } : {}),
            durationMs: outcome.durationMs,
          };
          progress.toolCalls.push(record);
          handlers.onToolEnd?.(record);

          if (outcome.status === 'ok') {
            flow = {
              label: joinLabels(flow.label, outcome.label),
              integrity: meetIntegrity(flow.integrity, outcome.integrity),
            };
            progress.flow = flow;
            consecutiveFailures = 0;
            observation = { name: call.name, status: 'ok', content: outcome.content };
          } else {
            consecutiveFailures += 1;
            if (
              outcome.status === 'denied' &&
              outcome.reason === ToolDenialReason.CALL_LIMIT
            ) {
              forceAnswer = true;
            }
            observation = {
              name: call.name,
              status: outcome.status,
              content: outcome.message,
            };
          }
        }
      } else {
        throw new Error('unreachable');
      }

      await request.onIteration?.({
        invocationId,
        iteration,
        result,
        toolCall: record,
        final: false,
      });

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) forceAnswer = true;
      const last = forceAnswer || iteration >= request.maxIterations;

      // ── The observation, escaped, bounded and masked ──────────────────
      const bounded = this.boundTokens(request.model.name, observation.content);
      let content = escapeToolText(bounded);
      if (session) {
        const masked = await this.redaction.extend(session, {
          organizationId: request.principal.organizationId,
          segments: [{ id: `tool:${iteration}`, text: content }],
          policy: request.policy,
          purpose: 'tool-result',
          signal: request.signal,
        });
        totals.toolRedactionMs += masked.timings.totalMs;
        content = masked.segments[0]?.text ?? '';
      }
      const resultMessage = formatToolResult({
        name: observation.name,
        callId: `c${iteration}`,
        status: observation.status,
        content,
      });
      messages.push({
        role: 'user',
        content: last ? `${resultMessage}\n\n${FINAL_NOTE}` : resultMessage,
      });
      if (last) forceAnswer = true;

      messages = this.fit(messages, request.model.name, request.promptBudget, baseCount);
    }
  }

  /** Caps a tool result at the configured token budget before it enters a prompt. */
  private boundTokens(model: string, text: string): string {
    const limit = this.executor.resultMaxTokens;
    const tokens = this.gateway.tokens.estimate(model, text);
    if (tokens <= limit) return text;
    const keep = Math.max(1, Math.floor(text.length * (limit / tokens) * 0.95));
    return `${text.slice(0, keep)}\n[result shortened to fit]`;
  }

  /**
   * Keeps the transcript inside the prompt budget by eliding the oldest tool
   * results first. The system prompt, the question and the latest exchange are
   * never elided; if they alone overflow, the answer cannot be produced.
   */
  private fit(
    messages: ChatMessage[],
    model: string,
    budget: number,
    baseCount: number,
  ): ChatMessage[] {
    const fitted = [...messages];
    const estimate = () => this.gateway.tokens.estimateMessages(model, fitted);
    for (
      let index = baseCount;
      index < fitted.length - 2 && estimate() > budget;
      index += 1
    ) {
      if (
        fitted[index].role === 'user' &&
        fitted[index].content.startsWith('<tool_result')
      ) {
        fitted[index] = { role: 'user', content: ELIDED };
      }
    }
    if (estimate() > budget) {
      throw new AppException(
        ErrorCode.LLM_CONTEXT_OVERFLOW,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          message: 'The tool results no longer fit in the model’s context window.',
          details: { promptBudget: budget },
        },
      );
    }
    return fitted;
  }
}

/** Adds the tool-call stop sequence, within the provider limit on stop sequences. */
function withToolStop(parameters: GenerationParameters): GenerationParameters {
  const stops = [...(parameters.stop ?? []).filter((stop) => stop !== TOOL_CALL_CLOSE)];
  return {
    ...parameters,
    stop: [TOOL_CALL_CLOSE, ...stops].slice(0, PARAMETER_BOUNDS.stopSequences),
  };
}

/**
 * What of one model reply a person sees: everything before a tool call. A
 * bare-JSON call (no tags) is entirely machinery.
 */
function visibleText(text: string, parse: ToolCallParse, offered: boolean): string {
  if (!offered) return text;
  const filter = new ToolCallStreamFilter();
  const shown = filter.push(text) + filter.flush();
  if (parse.kind === 'call' && !filter.sawCall) return '';
  return shown;
}

function joinVisible(before: string, next: string): string {
  if (!before.trim()) return next;
  if (!next.trim()) return before;
  return `${before.trimEnd()}\n\n${next.trimStart()}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
