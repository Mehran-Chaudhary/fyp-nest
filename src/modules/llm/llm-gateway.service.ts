import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { CircuitBreaker, CircuitOpenError } from '../../common/utils/circuit-breaker';
import { withRetry } from '../../common/utils/retry.util';
import {
  Semaphore,
  SemaphoreFullError,
  SemaphoreTimeoutError,
} from '../../common/utils/semaphore';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import { circuitStateValue, MetricsService } from '../../observability/metrics.service';
import { withSpan } from '../../observability/telemetry';
import { AuditService } from '../audit/audit.service';
import {
  GovernorService,
  type AdmissionLease,
  type InvocationAttribution,
} from '../quotas/governor.service';
import type { MaskingSession } from '../privacy/domain/masking-session';
import type { ChatMessage, GenerationParameters } from './domain/generation';
import { ThinkFilter } from './domain/think-filter';
import { TokenEstimator } from './domain/token-estimator';
import { GenerationInterruptedError, toGatewayException } from './llm-errors';
import {
  LLM_PROVIDER,
  LlmProviderError,
  type LlmProvider,
  type ProviderStream,
} from './providers/provider.types';

/**
 * How the privacy boundary treats a request. There is no way to call the
 * gateway without deciding: either a masking session travels with the
 * request, or redaction is off by an explicit workspace policy.
 */
export type PrivacyGuard =
  | { mode: 'masked'; session: MaskingSession }
  | { mode: 'disabled'; reason: 'workspace-policy' };

export interface GatewayChatRequest {
  organizationId: string;
  model: string;
  messages: ChatMessage[];
  parameters: GenerationParameters;
  contextWindow: number;
  privacy: PrivacyGuard;
  /** Aborted when the client goes away; generation stops on the GPU too. */
  signal?: AbortSignal;
  /**
   * Who the call is for (phase 5): the member or API key, and the agent.
   * Every token budget, the token rate and the agent's circuit breaker are
   * keyed by it. Absent, only the workspace's own limits apply.
   */
  attribution?: InvocationAttribution;
}

export interface GatewayHandlers {
  /**
   * The endpoint accepted the request and is streaming. Called once, before
   * any delta. Throwing cancels the generation.
   */
  onAdmitted?: (info: { queueMs: number; connectMs: number }) => void | Promise<void>;
  /** Unmasked text, in order, reasoning blocks removed. */
  onDelta?: (text: string) => void;
  /** The model began a reasoning block the user will not see. */
  onThinking?: () => void;
}

export interface GatewayTimings {
  egressCheckMs: number;
  queueMs: number;
  connectMs: number;
  ttftMs: number | null;
  generationMs: number;
  unmaskMs: number;
  totalMs: number;
}

export interface GatewayResult {
  provider: string;
  model: string;
  /** Unmasked answer. */
  text: string;
  /** The answer as the model wrote it, placeholders and all. */
  maskedText: string;
  finishReason: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    /** True when the endpoint did not report counts and they were estimated. */
    estimated: boolean;
  };
  placeholders: { resolved: number; unresolved: number };
  reasoningRemoved: boolean;
  timings: GatewayTimings;
}

type Deadline = 'first-token' | 'idle' | 'duration' | 'length';

class DeadlineReached extends Error {
  constructor(readonly deadline: Deadline) {
    super(`deadline: ${deadline}`);
    this.name = 'DeadlineReached';
  }
}

/** Wraps an exception thrown by a caller's handler, so it is not blamed on the endpoint. */
class HandlerFailure extends Error {
  constructor(readonly original: unknown) {
    super('handler failed');
    this.name = 'HandlerFailure';
  }
}

/** Characters of model output tolerated per requested token before cutting it off. */
const CHARACTERS_PER_TOKEN_CEILING = 16;

/**
 * The LLM gateway (proposal module 6.7) — and the platform's privacy boundary.
 *
 * Every call to a language model goes through `chat()`. In order:
 *
 *  1. **Egress check.** The exact payload about to leave is scanned: no value
 *     the masking session knows, and nothing an enabled recognizer detects,
 *     may appear outside a placeholder. A finding blocks the request with
 *     `PII_EGRESS_BLOCKED`, audited as CRITICAL. This is the implementation
 *     plan's exit criterion — "the prompt captured at the gateway boundary
 *     contains none of them" — enforced on every request, not only in a test.
 *  2. **Bulkhead.** At most `LLM_MAX_CONCURRENCY` generations per process; the
 *     rest wait briefly in order, then get `LLM_BUSY` with `Retry-After`.
 *  3. **Circuit breaker.** A failing endpoint is failed fast for a cooldown.
 *  4. **Connect,** retrying transient failures — but only before the first
 *     token. Once text has reached a user, a retry would be a different answer.
 *  5. **Stream,** under three deadlines: first token (covers a cold model
 *     load), idle gap between tokens, and total duration; plus an output-size
 *     cap. Reasoning blocks are removed and placeholders unmasked as tokens
 *     arrive.
 *
 * Token usage comes from the endpoint where it reports it, and is estimated
 * otherwise; the reported counts continuously calibrate the estimator used for
 * context budgeting.
 */
@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);
  private readonly config: LlmConfig;
  private readonly breaker: CircuitBreaker;
  private readonly bulkhead: Semaphore;
  readonly tokens = new TokenEstimator();

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly auditService: AuditService,
    configService: ConfigService,
    @Optional() private readonly governor?: GovernorService,
    @Optional() metrics?: MetricsService,
  ) {
    this.config = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
    this.breaker = new CircuitBreaker('llm', this.config.circuitBreaker);
    // The queue is bounded as well as the concurrency: beyond a few waiters per
    // slot, waiting longer than the queue timeout is the likely outcome anyway.
    this.bulkhead = new Semaphore(
      this.config.maxConcurrency,
      this.config.maxConcurrency * 8,
    );
    metrics?.onScrape(() => {
      metrics.llmInFlight.set(this.bulkhead.inUse);
      metrics.llmWaiting.set(this.bulkhead.waiting);
      metrics.circuitState.set({ dependency: 'llm' }, circuitStateValue(this.breaker.state));
    });
  }

  get isConfigured(): boolean {
    return this.config.configured;
  }

  get providerKind(): string {
    return this.provider.kind;
  }

  get circuit(): ReturnType<CircuitBreaker['describe']> {
    return this.breaker.describe();
  }

  get load(): { inUse: number; waiting: number; capacity: number } {
    return {
      inUse: this.bulkhead.inUse,
      waiting: this.bulkhead.waiting,
      capacity: this.bulkhead.capacity,
    };
  }

  assertConfigured(): void {
    if (this.isConfigured) return;
    throw new AppException(ErrorCode.LLM_NOT_CONFIGURED, HttpStatus.SERVICE_UNAVAILABLE, {
      message: 'No language model is configured on this deployment yet.',
      details: { missingConfiguration: ['LLM_BASE_URL'] },
    });
  }

  ping(): Promise<boolean> {
    return this.isConfigured ? this.provider.ping() : Promise.resolve(false);
  }

  async chat(
    request: GatewayChatRequest,
    handlers: GatewayHandlers = {},
  ): Promise<GatewayResult> {
    this.assertConfigured();
    return withSpan(
      'llm.chat',
      {
        'gen_ai.system': this.provider.kind,
        'gen_ai.request.model': request.model,
        'gen_ai.request.max_tokens': request.parameters.maxOutputTokens,
        'daiap.purpose': request.attribution?.purpose ?? 'unspecified',
        'daiap.redaction': request.privacy.mode,
      },
      async (span) => {
        const result = await this.governedChat(request, handlers);
        span.setAttributes({
          'gen_ai.usage.input_tokens': result.usage.promptTokens,
          'gen_ai.usage.output_tokens': result.usage.completionTokens,
          'gen_ai.response.finish_reasons': [result.finishReason ?? 'unknown'],
          'daiap.ttft_ms': result.timings.ttftMs ?? -1,
          'daiap.placeholders_unresolved': result.placeholders.unresolved,
        });
        return result;
      },
    );
  }

  /**
   * Admission first (phase 5): the token budgets, the token rate and the
   * agent's circuit breaker are consulted before anything else happens, with
   * the call's worst case — the prompt it is about to send plus the most it
   * may generate. The lease is settled with what the call really consumed,
   * however it ended.
   */
  private async governedChat(
    request: GatewayChatRequest,
    handlers: GatewayHandlers,
  ): Promise<GatewayResult> {
    const lease: AdmissionLease | null = this.governor
      ? await this.governor.admit({
          organizationId: request.organizationId,
          attribution: request.attribution,
          estimatedTokens:
            this.tokens.estimateMessages(request.model, request.messages) +
            request.parameters.maxOutputTokens,
        })
      : null;

    try {
      const result = await this.guardedChat(request, handlers);
      await lease?.settle({
        tokens: result.usage.promptTokens + result.usage.completionTokens,
      });
      return result;
    } catch (error) {
      await lease?.settle(this.consumedOnFailure(request, error));
      throw error;
    }
  }

  /** What a failed call cost: nothing, unless the model had begun answering. */
  private consumedOnFailure(
    request: GatewayChatRequest,
    error: unknown,
  ): { tokens: number; errorCode: string | null; cancelled: boolean } {
    // GenerationInterruptedError is an AppException too, with its own code.
    const errorCode = error instanceof AppException ? error.code : null;
    if (error instanceof GenerationInterruptedError) {
      return {
        tokens:
          this.tokens.estimateMessages(request.model, request.messages) +
          this.tokens.estimate(request.model, error.partial.maskedText),
        errorCode,
        cancelled: error.cancelled,
      };
    }
    return { tokens: 0, errorCode, cancelled: false };
  }

  private async guardedChat(
    request: GatewayChatRequest,
    handlers: GatewayHandlers,
  ): Promise<GatewayResult> {
    const started = performance.now();

    // ── 1. Egress check ───────────────────────────────────────────────────
    const egressStarted = performance.now();
    await this.assertNoLeak(request);
    const egressCheckMs = round(performance.now() - egressStarted);

    // ── 2. Bulkhead ───────────────────────────────────────────────────────
    const queueStarted = performance.now();
    const release = await this.acquireSlot(request.signal);
    const queueMs = round(performance.now() - queueStarted);

    try {
      // ── 3–5. Breaker, connect, stream ───────────────────────────────────
      return await this.breaker.execute(
        () => this.generate(request, handlers, { started, egressCheckMs, queueMs }),
        (error) => this.isEndpointFault(error),
      );
    } catch (error) {
      if (error instanceof HandlerFailure) throw error.original;
      if (error instanceof CircuitOpenError) {
        throw new AppException(ErrorCode.LLM_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE, {
          message:
            'The language model is failing; requests are paused briefly to let it recover.',
          retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
          details: { reason: 'CIRCUIT_OPEN' },
        });
      }
      if (error instanceof LlmProviderError) throw toGatewayException(error);
      throw error;
    } finally {
      release();
    }
  }

  // ── Stages ────────────────────────────────────────────────────────────────

  private async assertNoLeak(request: GatewayChatRequest): Promise<void> {
    if (request.privacy.mode !== 'masked') return;

    const outgoing = request.messages.map((message) => message.content).join('\n\n');
    const findings = request.privacy.session.findLeaks(outgoing);
    if (findings.length === 0) return;

    const entityTypes = [...new Set(findings.map((finding) => finding.entityType))].sort();
    this.logger.error(
      `Blocked a prompt to ${request.model}: sensitive data of type ${entityTypes.join(', ')} ` +
        'survived masking. Nothing was sent.',
    );
    await this.auditService.recordSafe({
      action: AuditAction.PII_EGRESS_BLOCKED,
      status: AuditStatus.DENIED,
      organizationId: request.organizationId,
      resourceType: 'llm_request',
      metadata: {
        model: request.model,
        entityTypes,
        reasons: [...new Set(findings.map((finding) => finding.reason))].sort(),
        messages: request.messages.length,
      },
    });
    throw new AppException(ErrorCode.PII_EGRESS_BLOCKED, HttpStatus.INTERNAL_SERVER_ERROR, {
      details: { entityTypes },
    });
  }

  private async acquireSlot(signal?: AbortSignal): Promise<() => void> {
    try {
      return await this.bulkhead.acquire({ timeoutMs: this.config.queueTimeoutMs, signal });
    } catch (error) {
      if (error instanceof SemaphoreTimeoutError || error instanceof SemaphoreFullError) {
        throw new AppException(ErrorCode.LLM_BUSY, HttpStatus.SERVICE_UNAVAILABLE, {
          retryAfterSeconds: 5,
          details: { capacity: this.bulkhead.capacity, waiting: this.bulkhead.waiting },
        });
      }
      throw error;
    }
  }

  private async generate(
    request: GatewayChatRequest,
    handlers: GatewayHandlers,
    context: { started: number; egressCheckMs: number; queueMs: number },
  ): Promise<GatewayResult> {
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;

    const deadline = (kind: Deadline) => controller.abort(new DeadlineReached(kind));
    const durationTimer = setTimeout(() => deadline('duration'), this.config.maxDurationMs);
    let firstTokenTimer: NodeJS.Timeout | undefined = setTimeout(
      () => deadline('first-token'),
      this.config.firstTokenTimeoutMs,
    );
    let idleTimer: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      clearTimeout(durationTimer);
      clearTimeout(firstTokenTimer);
      clearTimeout(idleTimer);
    };

    const session = request.privacy.mode === 'masked' ? request.privacy.session : null;
    const unmasker = session?.createStreamUnmasker() ?? null;
    const think = new ThinkFilter();
    const outputLimit = request.parameters.maxOutputTokens * CHARACTERS_PER_TOKEN_CEILING;

    let maskedText = '';
    let text = '';
    let unmaskMs = 0;
    let ttftMs: number | null = null;
    let stream: ProviderStream | null = null;
    let connectMs = 0;
    let generationStarted = 0;

    const emit = (chunk: string) => {
      if (chunk.length === 0) return;
      const unmaskStarted = performance.now();
      const visible = unmasker ? unmasker.push(chunk) : chunk;
      unmaskMs += performance.now() - unmaskStarted;
      if (visible.length > 0) {
        text += visible;
        handlers.onDelta?.(visible);
      }
    };

    try {
      // ── Connect (retried only here, before any token) ───────────────────
      const connectStarted = performance.now();
      stream = await withRetry(
        () =>
          this.provider.open(
            {
              model: request.model,
              messages: request.messages,
              parameters: request.parameters,
              contextWindow: request.contextWindow,
            },
            signal,
          ),
        {
          retries: this.config.maxRetries,
          baseDelayMs: 500,
          maxDelayMs: 4_000,
          signal,
          shouldRetry: (error) =>
            error instanceof LlmProviderError && error.retryable && !signal.aborted,
          retryAfterMs: (error) =>
            error instanceof LlmProviderError ? error.retryAfterMs : undefined,
        },
      );
      connectMs = round(performance.now() - connectStarted);

      try {
        await handlers.onAdmitted?.({ queueMs: context.queueMs, connectMs });
      } catch (error) {
        throw new HandlerFailure(error);
      }

      // ── Stream ──────────────────────────────────────────────────────────
      generationStarted = performance.now();
      let finish: {
        finishReason: string | null;
        promptTokens: number | null;
        completionTokens: number | null;
      } | null = null;

      for await (const event of stream.events) {
        if (event.type === 'done') {
          finish = event;
          break;
        }

        if (ttftMs === null) {
          ttftMs = round(performance.now() - context.started);
          clearTimeout(firstTokenTimer);
          firstTokenTimer = undefined;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => deadline('idle'), this.config.idleTimeoutMs);

        maskedText += event.text;
        const wasThinking = think.isThinking;
        emit(think.push(event.text));
        if (!wasThinking && think.isThinking) handlers.onThinking?.();

        if (maskedText.length > outputLimit) {
          deadline('length');
          break;
        }
      }

      const cutForLength =
        controller.signal.reason instanceof DeadlineReached &&
        controller.signal.reason.deadline === 'length';
      if (!finish && !cutForLength) {
        throw new LlmProviderError(
          'INVALID_RESPONSE',
          'The model stream ended without completing.',
          false,
        );
      }

      emit(think.flush());
      const unmaskStarted = performance.now();
      const tail = unmasker?.flush() ?? '';
      unmaskMs += performance.now() - unmaskStarted;
      if (tail.length > 0) {
        text += tail;
        handlers.onDelta?.(tail);
      }

      return this.result(request, {
        text,
        maskedText,
        finishReason: cutForLength ? 'length' : (finish?.finishReason ?? null),
        promptTokens: finish?.promptTokens ?? null,
        completionTokens: finish?.completionTokens ?? null,
        reasoningRemoved: think.thought,
        timings: {
          egressCheckMs: context.egressCheckMs,
          queueMs: context.queueMs,
          connectMs,
          ttftMs,
          generationMs: round(
            generationStarted ? performance.now() - generationStarted : 0,
          ),
          unmaskMs: round(unmaskMs),
          totalMs: round(performance.now() - context.started),
        },
      });
    } catch (error) {
      stream?.cancel();
      throw this.classify(error, request, controller.signal, {
        text,
        maskedText,
        ttftMs,
        admitted: generationStarted > 0,
      });
    } finally {
      clearTimers();
    }
  }

  private result(
    request: GatewayChatRequest,
    output: {
      text: string;
      maskedText: string;
      finishReason: string | null;
      promptTokens: number | null;
      completionTokens: number | null;
      reasoningRemoved: boolean;
      timings: GatewayTimings;
    },
  ): GatewayResult {
    const rawPrompt = TokenEstimator.rawMessages(request.messages);
    if (output.promptTokens !== null) {
      this.tokens.observe(request.model, rawPrompt, output.promptTokens);
    }

    const estimated = output.promptTokens === null || output.completionTokens === null;
    const statistics =
      request.privacy.mode === 'masked'
        ? request.privacy.session.unmaskStatistics()
        : { resolved: 0, unresolved: 0 };

    return {
      provider: this.provider.kind,
      model: request.model,
      text: output.text,
      maskedText: output.maskedText,
      finishReason: output.finishReason,
      usage: {
        promptTokens:
          output.promptTokens ??
          this.tokens.estimateMessages(request.model, request.messages),
        completionTokens:
          output.completionTokens ?? this.tokens.estimate(request.model, output.maskedText),
        estimated,
      },
      placeholders: statistics,
      reasoningRemoved: output.reasoningRemoved,
      timings: output.timings,
    };
  }

  /**
   * Decides what a failure means. Before the endpoint admitted the request it
   * is an ordinary error for the API to report; after, it interrupts a stream
   * and carries what was produced.
   */
  private classify(
    error: unknown,
    request: GatewayChatRequest,
    signal: AbortSignal,
    progress: {
      text: string;
      maskedText: string;
      ttftMs: number | null;
      admitted: boolean;
    },
  ): unknown {
    if (error instanceof HandlerFailure) return error;

    const partial = {
      text: progress.text,
      maskedText: progress.maskedText,
      ttftMs: progress.ttftMs,
    };
    const reason: unknown = signal.reason;

    if (request.signal?.aborted && !(reason instanceof DeadlineReached)) {
      return new GenerationInterruptedError(
        ErrorCode.REQUEST_TIMEOUT,
        HttpStatus.REQUEST_TIMEOUT,
        partial,
        true,
        { message: 'The client disconnected; generation was stopped.', cause: error },
      );
    }

    if (reason instanceof DeadlineReached) {
      const message =
        reason.deadline === 'first-token'
          ? `The model produced nothing within ${this.config.firstTokenTimeoutMs}ms.`
          : reason.deadline === 'idle'
            ? `The model stopped responding for ${this.config.idleTimeoutMs}ms.`
            : `The generation exceeded ${this.config.maxDurationMs}ms.`;
      if (!progress.admitted || progress.maskedText.length === 0) {
        return new LlmProviderError('TIMEOUT', message, false, undefined, undefined, {
          cause: error,
        });
      }
      return new GenerationInterruptedError(
        ErrorCode.LLM_TIMEOUT,
        HttpStatus.GATEWAY_TIMEOUT,
        partial,
        false,
        { message, cause: new LlmProviderError('TIMEOUT', message, false) },
      );
    }

    if (progress.admitted && error instanceof LlmProviderError) {
      return new GenerationInterruptedError(
        ErrorCode.LLM_UNAVAILABLE,
        HttpStatus.BAD_GATEWAY,
        partial,
        false,
        { message: 'The model failed part-way through its answer.', cause: error },
      );
    }

    return error;
  }

  /** Whether a failure reflects on the endpoint's health (and so on the breaker). */
  private isEndpointFault(error: unknown): boolean {
    if (error instanceof HandlerFailure) return false;
    if (error instanceof GenerationInterruptedError) {
      return !error.cancelled && error.cause instanceof LlmProviderError;
    }
    if (error instanceof LlmProviderError) {
      return !['MODEL_NOT_FOUND', 'REJECTED'].includes(error.code);
    }
    return false;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
