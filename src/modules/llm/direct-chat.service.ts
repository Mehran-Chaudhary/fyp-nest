import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { RedactionService, type RedactionOutcome } from '../privacy/redaction.service';
import {
  resolveParameters,
  type ChatMessage,
  type GenerationParameters,
} from './domain/generation';
import type { ChatCompletionDto, DirectChatDto } from './dto/llm.dto';
import {
  InvocationPurpose,
  InvocationStatus,
  type InvocationMetrics,
} from './entities/llm-invocation.entity';
import { invocationStatusOf } from './llm-errors';
import {
  LlmGatewayService,
  type GatewayHandlers,
  type GatewayResult,
} from './llm-gateway.service';
import { LlmPolicyService } from './llm-policy.service';
import { UsageService } from './usage.service';

export type DirectChatStage = 'redacting' | 'queued' | 'generating' | 'thinking';

export interface StreamHandlers {
  /**
   * Preflight passed (model resolved and allowed): open the stream here, so
   * headers and heartbeats flow while redaction, queueing and a cold model
   * load happen — a proxy waiting minutes for headers would give up.
   */
  onOpen?: (meta: { invocationId: string; model: string }) => void;
  onStatus?: (stage: DirectChatStage, detail?: Record<string, unknown>) => void;
  onDelta?: (text: string) => void;
}

/**
 * Direct access to the gateway (`llm:invoke`): a caller-supplied conversation,
 * no agent, no retrieval, nothing stored.
 *
 * Still under the full privacy regime — there is no route to the model that
 * skips it. Every message, including a caller-written system prompt, is masked
 * in one session; the gateway checks the payload before it leaves; the answer
 * is unmasked for the caller. The call is written to the usage ledger and the
 * audit log like any other, without its content.
 */
@Injectable()
export class DirectChatService {
  private readonly config: LlmConfig;

  constructor(
    private readonly gateway: LlmGatewayService,
    private readonly policies: LlmPolicyService,
    private readonly redaction: RedactionService,
    private readonly usage: UsageService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
  }

  async chat(
    principal: AccessPrincipal,
    input: DirectChatDto,
    handlers: StreamHandlers = {},
    signal?: AbortSignal,
  ): Promise<ChatCompletionDto> {
    this.gateway.assertConfigured();
    const invocationId = randomUUID();
    const started = performance.now();

    const model = await this.policies.resolve(principal.organizationId, [input.model]);
    const parameters = resolveParameters(
      {
        defaultTemperature: this.config.defaultTemperature,
        defaultMaxOutputTokens: this.config.defaultMaxOutputTokens,
        maxOutputTokens: model.maxOutputTokens,
      },
      input.parameters,
    );

    const base = {
      id: invocationId,
      organizationId: principal.organizationId,
      purpose: InvocationPurpose.DIRECT_CHAT,
      userId: principal.userId ?? null,
      apiKeyId: principal.apiKeyId ?? null,
      agentId: null,
      agentVersion: null,
      conversationId: null,
      messageId: null,
      provider: this.gateway.providerKind,
      model: model.name,
      streamed: handlers.onDelta !== undefined,
    };

    handlers.onOpen?.({ invocationId, model: model.name });

    // ── Mask every message in one session ────────────────────────────────
    handlers.onStatus?.('redacting');
    let outcome: RedactionOutcome;
    try {
      outcome = await this.redaction.redact({
        organizationId: principal.organizationId,
        segments: input.messages.map((message, index) => ({
          id: String(index),
          text: message.content,
        })),
        purpose: 'direct-chat',
        signal,
      });
    } catch (error) {
      await this.recordFailure(
        base,
        InvocationStatus.REFUSED,
        error,
        performance.now() - started,
      );
      throw error;
    }

    try {
      const messages: ChatMessage[] = input.messages.map((message, index) => ({
        role: message.role,
        content: outcome.segments[index].text,
      }));

      const promptTokens = this.gateway.tokens.estimateMessages(model.name, messages);
      if (promptTokens + parameters.maxOutputTokens > model.contextWindow) {
        throw new AppException(
          ErrorCode.LLM_CONTEXT_OVERFLOW,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            details: {
              estimatedPromptTokens: promptTokens,
              maxOutputTokens: parameters.maxOutputTokens,
              contextWindow: model.contextWindow,
            },
          },
        );
      }

      const gatewayHandlers: GatewayHandlers = {
        onAdmitted: () =>
          handlers.onStatus?.('generating', {
            redaction: {
              enabled: outcome.enabled,
              degraded: outcome.degraded,
              entitiesMasked: outcome.summary?.entities ?? 0,
            },
          }),
        onDelta: handlers.onDelta,
        onThinking: () => handlers.onStatus?.('thinking'),
      };
      handlers.onStatus?.('queued', this.gateway.load);

      let result: GatewayResult;
      try {
        result = await this.gateway.chat(
          {
            organizationId: principal.organizationId,
            model: model.name,
            messages,
            parameters,
            contextWindow: model.contextWindow,
            privacy: outcome.session
              ? { mode: 'masked', session: outcome.session }
              : { mode: 'disabled', reason: 'workspace-policy' },
            signal,
            attribution: {
              userId: principal.userId ?? null,
              apiKeyId: principal.apiKeyId ?? null,
              purpose: InvocationPurpose.DIRECT_CHAT,
            },
          },
          gatewayHandlers,
        );
      } catch (error) {
        await this.recordFailure(
          base,
          invocationStatusOf(error),
          error,
          performance.now() - started,
          outcome,
        );
        throw error;
      }

      const redactionMs = round(
        outcome.timings.totalMs + result.timings.egressCheckMs + result.timings.unmaskMs,
      );
      const totalMs = round(performance.now() - started);

      await this.usage.record({
        ...base,
        status: InvocationStatus.COMPLETED,
        errorCode: null,
        finishReason: result.finishReason,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        tokensEstimated: result.usage.estimated,
        totalMs: Math.round(totalMs),
        ttftMs: result.timings.ttftMs === null ? null : Math.round(result.timings.ttftMs),
        queueMs: Math.round(result.timings.queueMs),
        retrievalMs: null,
        redactionMs: redactionMs.toFixed(2),
        entitiesMasked: outcome.summary?.entities ?? 0,
        redactionDegraded: outcome.degraded,
        metrics: this.metrics(outcome, result, parameters),
      });

      await this.auditService.recordSafe({
        action: AuditAction.LLM_INFERENCE_COMPLETED,
        organizationId: principal.organizationId,
        resourceType: 'llm_invocation',
        resourceId: invocationId,
        durationMs: Math.round(totalMs),
        metadata: {
          model: model.name,
          purpose: InvocationPurpose.DIRECT_CHAT,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          finishReason: result.finishReason,
          redaction: this.redactionAudit(outcome),
        },
      });
      await this.auditRedaction(principal.organizationId, invocationId, outcome);

      return {
        invocationId,
        model: model.name,
        content: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
        redaction: {
          enabled: outcome.enabled,
          degraded: outcome.degraded,
          entitiesMasked: outcome.summary?.entities ?? 0,
          byType: outcome.summary?.byType ?? {},
          placeholdersResolved: result.placeholders.resolved,
          placeholdersUnresolved: result.placeholders.unresolved,
        },
        timings: {
          redactionMs,
          queueMs: result.timings.queueMs,
          timeToFirstTokenMs: result.timings.ttftMs,
          generationMs: result.timings.generationMs,
          totalMs,
        },
      };
    } finally {
      outcome.session?.destroy();
    }
  }

  private metrics(
    outcome: RedactionOutcome,
    result: GatewayResult,
    parameters: GenerationParameters,
  ): InvocationMetrics {
    return {
      timings: {
        detectionPatternMs: outcome.timings.patternMs,
        detectionNerMs: outcome.timings.nerMs,
        maskingMs: outcome.timings.maskingMs,
        egressCheckMs: result.timings.egressCheckMs,
        unmaskMs: result.timings.unmaskMs,
        queueMs: result.timings.queueMs,
        connectMs: result.timings.connectMs,
        ttftMs: result.timings.ttftMs,
        generationMs: result.timings.generationMs,
      },
      redaction: {
        enabled: outcome.enabled,
        degraded: outcome.degraded,
        entities: outcome.summary?.entities ?? 0,
        occurrences: outcome.summary?.occurrences ?? 0,
        byType: outcome.summary?.byType ?? {},
        bySource: outcome.summary?.bySource ?? {},
        detectors: outcome.detectors,
        cacheHits: outcome.cacheHits,
        segments: outcome.summary?.segments ?? 0,
      },
      placeholders: result.placeholders,
      parameters: { ...parameters },
      reasoningRemoved: result.reasoningRemoved,
    };
  }

  private redactionAudit(outcome: RedactionOutcome): Record<string, unknown> {
    return {
      enabled: outcome.enabled,
      degraded: outcome.degraded,
      entities: outcome.summary?.entities ?? 0,
      byType: outcome.summary?.byType ?? {},
      detectors: outcome.detectors,
    };
  }

  /** `pii.redacted`: the compliance log's record that masking happened, and of what types. */
  private async auditRedaction(
    organizationId: string,
    invocationId: string,
    outcome: RedactionOutcome,
  ): Promise<void> {
    if (!outcome.summary || outcome.summary.entities === 0) return;
    await this.auditService.recordSafe({
      action: AuditAction.PII_REDACTED,
      organizationId,
      resourceType: 'llm_invocation',
      resourceId: invocationId,
      metadata: {
        entities: outcome.summary.entities,
        occurrences: outcome.summary.occurrences,
        byType: outcome.summary.byType,
        bySource: outcome.summary.bySource,
        degraded: outcome.degraded,
        detectionMs: round(outcome.timings.patternMs + outcome.timings.nerMs),
        maskingMs: outcome.timings.maskingMs,
      },
    });
  }

  private async recordFailure(
    base: {
      id: string;
      organizationId: string;
      purpose: InvocationPurpose;
      userId: string | null;
      apiKeyId: string | null;
      agentId: null;
      agentVersion: null;
      conversationId: null;
      messageId: null;
      provider: string;
      model: string;
      streamed: boolean;
    },
    status: InvocationStatus,
    error: unknown,
    elapsedMs: number,
    outcome?: RedactionOutcome,
  ): Promise<void> {
    const code =
      error instanceof AppException ? error.code : ErrorCode.INTERNAL_SERVER_ERROR;
    await this.usage.record({
      ...base,
      status,
      errorCode: code,
      finishReason: null,
      promptTokens: 0,
      completionTokens: 0,
      tokensEstimated: true,
      totalMs: Math.round(elapsedMs),
      ttftMs: null,
      queueMs: null,
      retrievalMs: null,
      redactionMs: outcome ? outcome.timings.totalMs.toFixed(2) : null,
      entitiesMasked: outcome?.summary?.entities ?? 0,
      redactionDegraded: outcome?.degraded ?? false,
      metrics: {},
    });

    if (status === InvocationStatus.FAILED || status === InvocationStatus.CANCELLED) {
      await this.auditService.recordSafe({
        action: AuditAction.LLM_INFERENCE_FAILED,
        status:
          status === InvocationStatus.CANCELLED ? AuditStatus.SUCCESS : AuditStatus.FAILURE,
        organizationId: base.organizationId,
        resourceType: 'llm_invocation',
        resourceId: base.id,
        errorCode: code,
        durationMs: Math.round(elapsedMs),
        metadata: { model: base.model, purpose: base.purpose, outcome: status },
      });
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
