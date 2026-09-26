import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, hkdfSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { hasPermission } from '../../common/utils/permission.util';
import { stableStringify } from '../../common/utils/stable-stringify';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { TOOLS_CONFIG_KEY, type ToolsConfig } from '../../config/tools.config';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AuditService } from '../audit/audit.service';
import { PUBLIC_LABEL, type InformationLabel } from '../agents/domain/labels';
import type { AccessPrincipal } from '../knowledge/domain/access';
import type { MaskingSession } from '../privacy/domain/masking-session';
import { RedactionService } from '../privacy/redaction.service';
import {
  ToolRuntimeError,
  type ToolAgentScope,
  type ToolCallOrigin,
  type ToolOutput,
} from './builtins/builtin-tool';
import {
  checkFlow,
  describeViolation,
  type FlowContext,
  type Integrity,
} from './domain/information-flow';
import { applyDefaults, validateValue } from './domain/json-schema';
import {
  ToolKind,
  type HttpToolConfig,
  type ToolDescriptor,
} from './domain/tool-definition';
import {
  ToolDenialReason,
  ToolExecution,
  ToolExecutionStatus,
} from './entities/tool-execution.entity';
import type { RenderedHttpRequest } from './domain/tool-definition';
import { HttpToolRunner } from './http/http-tool.runner';
import { HttpToolError } from './http/safe-http.client';
import { ToolRegistryService } from './tool-registry.service';

/** Largest argument object accepted from a model, in bytes of JSON. */
const MAX_ARGUMENT_BYTES = 16 * 1024;

/**
 * Counts calls against a ceiling. The ReAct loop holds one per answer; a
 * workflow run holds one per run, backed by the database.
 */
export interface ToolCallBudget {
  /** Reserves one call of `tool`. False when a ceiling has been reached. */
  reserve(tool: ToolDescriptor): Promise<boolean>;
}

/** A budget in memory, for one agent answer. */
export class InMemoryToolBudget implements ToolCallBudget {
  private total = 0;
  private readonly perTool = new Map<string, number>();

  constructor(private readonly maxCalls: number) {}

  reserve(tool: ToolDescriptor): Promise<boolean> {
    const used = this.perTool.get(tool.id) ?? 0;
    if (this.total >= this.maxCalls) return Promise.resolve(false);
    if (tool.maxCallsPerRun !== undefined && used >= tool.maxCallsPerRun) {
      return Promise.resolve(false);
    }
    this.total += 1;
    this.perTool.set(tool.id, used + 1);
    return Promise.resolve(true);
  }

  get used(): number {
    return this.total;
  }
}

export interface ToolExecutionContext {
  principal: AccessPrincipal;
  agent: ToolAgentScope | null;
  flow: FlowContext;
  /**
   * The request's masking session. In a ReAct loop the model's arguments are
   * masked, and the session restores (or refuses) real values; it also backs
   * the egress check on outgoing HTTP requests.
   */
  session: MaskingSession | null;
  /** Whether arguments carry placeholders (a model wrote them) or real values (a workflow template did). */
  argumentsAreMasked: boolean;
  origin: ToolCallOrigin;
  actorLabel: string;
  /** Derived from the step and call position in workflows, so retries are idempotent. */
  executionId: string;
  budget: ToolCallBudget;
  /** A person approved this call (a workflow tool node behind an approval node). */
  approvalGranted?: boolean;
  signal?: AbortSignal;
}

interface OutcomeBase {
  tool: ToolDescriptor | null;
  toolName: string;
  executionId: string;
  durationMs: number;
}

export type ToolCallOutcome =
  | (OutcomeBase & {
      status: 'ok';
      tool: ToolDescriptor;
      /** The result as text: raw, not yet escaped or masked. */
      content: string;
      data?: unknown;
      label: InformationLabel;
      integrity: Integrity;
      truncated: boolean;
      /** A side effect already performed by an earlier attempt, not repeated. */
      replayed: boolean;
    })
  | (OutcomeBase & {
      status: 'error';
      code: ErrorCode;
      /** Safe to show the model: no secrets, no stack traces. */
      message: string;
      retryable: boolean;
    })
  | (OutcomeBase & {
      status: 'denied';
      code: ErrorCode;
      reason: ToolDenialReason;
      message: string;
    });

/**
 * The Tool Execution Engine (proposal module 6.11): every tool call, from an
 * agent's reason → act loop or from a workflow's tool node, passes through
 * {@link execute}, which applies the same checks in the same order.
 *
 *  1. **Granted and enabled.** The tool is one this agent was given, and it
 *     has not been disabled or deleted since.
 *  2. **Permitted.** The delegating principal holds `tool:execute` and the
 *     tool's own required permissions: an agent acting for someone can do
 *     only what they could.
 *  3. **Valid arguments,** against the tool's JSON Schema.
 *  4. **Approved,** when the tool requires a person to approve each call.
 *  5. **Information flow:** the context's confidentiality and integrity labels
 *     against the tool's sink policy (see `information-flow.ts`).
 *  6. **Personal data:** placeholders are restored only for tools trusted with
 *     them; for the rest, a call carrying personal data is refused, and the
 *     outgoing HTTP request is re-scanned as the gateway re-scans prompts.
 *  7. **Budget:** per-answer and per-run call ceilings.
 *  8. **Idempotency:** a side-effecting call claims its execution id first, so
 *     a retried workflow step does not send the same email twice.
 *
 * Then it runs, under a timeout, and every outcome — success, failure or
 * denial — is written to the content-free ledger and the audit log
 * (`tool.executed`, `tool.execution.failed`, `tool.execution.denied`).
 *
 * Tool-level problems are *returned* as outcomes, not thrown: the model reads
 * them as observations and can correct itself. Only cancellation and
 * infrastructure faults throw.
 */
@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);
  private readonly config: ToolsConfig;
  private readonly digestKey: Buffer;

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly httpRunner: HttpToolRunner,
    private readonly redaction: RedactionService,
    private readonly auditService: AuditService,
    private readonly events: EventBusService,
    @InjectRepository(ToolExecution)
    private readonly ledger: Repository<ToolExecution>,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<ToolsConfig>(TOOLS_CONFIG_KEY);
    const security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    this.digestKey = Buffer.from(
      hkdfSync(
        'sha256',
        security.encryptionKey,
        'daiap-tool-arguments',
        'daiap/tool-arguments/v1',
        32,
      ),
    );
  }

  get maxIterations(): number {
    return this.config.maxIterations;
  }

  get defaultIterations(): number {
    return this.config.defaultIterations;
  }

  get resultMaxTokens(): number {
    return this.config.resultMaxTokens;
  }

  get maxCallsPerRun(): number {
    return this.config.maxCallsPerRun;
  }

  /**
   * The tools to offer for an answer: granted, enabled, available on this
   * deployment, and usable by this principal. A tool the principal could not
   * run is not offered at all — the model never learns it exists.
   */
  async offerable(
    principal: AccessPrincipal,
    toolIds: readonly string[],
  ): Promise<ToolDescriptor[]> {
    if (!this.config.enabled || toolIds.length === 0) return [];
    if (!hasPermission(principal.permissions, 'tool:execute')) return [];

    const resolved = await this.registry.resolveMany(principal.organizationId, toolIds);
    return [...resolved.values()]
      .filter((tool) => tool.enabled && this.registry.isAvailable(tool))
      .filter((tool) =>
        tool.requiredPermissions.every((permission) =>
          hasPermission(principal.permissions, permission),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A keyed digest of a call's arguments: equal calls compare equal, and nothing is revealed. */
  argumentsDigest(toolName: string, args: Record<string, unknown>): string {
    return createHmac('sha256', this.digestKey)
      .update(stableStringify({ tool: toolName, args }))
      .digest('hex');
  }

  async execute(
    tool: ToolDescriptor | null,
    call: { name: string; arguments: Record<string, unknown> },
    context: ToolExecutionContext,
  ): Promise<ToolCallOutcome> {
    const started = performance.now();
    const argumentsDigest = this.argumentsDigest(call.name, call.arguments);
    const base = {
      tool,
      toolName: tool?.name ?? call.name.slice(0, 48),
      executionId: context.executionId,
    };
    const deny = (code: ErrorCode, reason: ToolDenialReason, message: string) =>
      this.finishDenied(
        { ...base, code, reason, message },
        context,
        argumentsDigest,
        started,
      );

    // ── 1–2. Granted, enabled, permitted ─────────────────────────────────
    if (!tool) {
      return deny(
        ErrorCode.TOOL_NOT_GRANTED,
        ToolDenialReason.NOT_GRANTED,
        'There is no such tool available to you.',
      );
    }
    if (!tool.enabled || !this.registry.isAvailable(tool)) {
      return deny(
        ErrorCode.TOOL_DISABLED,
        ToolDenialReason.DISABLED,
        'This tool is currently disabled.',
      );
    }
    const required = ['tool:execute', ...tool.requiredPermissions];
    const missing = required.filter(
      (permission) => !hasPermission(context.principal.permissions, permission),
    );
    if (missing.length > 0) {
      return deny(
        ErrorCode.PERMISSION_DENIED,
        ToolDenialReason.PERMISSION,
        'The person you are acting for is not permitted to use this tool.',
      );
    }

    // ── 3. Arguments ─────────────────────────────────────────────────────
    let args = applyDefaults(tool.parameters, call.arguments) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) {
      return deny(
        ErrorCode.TOOL_ARGUMENTS_INVALID,
        ToolDenialReason.ARGUMENTS,
        'The arguments are too large.',
      );
    }
    const issues = validateValue(tool.parameters, args);
    if (issues.length > 0) {
      return deny(
        ErrorCode.TOOL_ARGUMENTS_INVALID,
        ToolDenialReason.ARGUMENTS,
        `Invalid arguments: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}.`,
      );
    }

    // ── 4. Approval ──────────────────────────────────────────────────────
    if (tool.requiresApproval && !context.approvalGranted) {
      return deny(
        ErrorCode.TOOL_APPROVAL_REQUIRED,
        ToolDenialReason.APPROVAL,
        'This tool needs a person to approve each use, so it cannot be called here. Tell the ' +
          'user what you would do and ask them to run it through an approval step.',
      );
    }

    // ── 5. Information flow ──────────────────────────────────────────────
    const violation = checkFlow(context.flow, tool.dataPolicy);
    if (violation) {
      return deny(
        ErrorCode.TOOL_INFORMATION_FLOW_BLOCKED,
        violation.kind === 'CONFIDENTIALITY'
          ? ToolDenialReason.CONFIDENTIALITY
          : ToolDenialReason.INTEGRITY,
        describeViolation(violation),
      );
    }

    // ── 6. Personal data in the arguments ────────────────────────────────
    if (context.argumentsAreMasked && context.session) {
      const carriesPii = containsPlaceholders(args, context.session);
      if (carriesPii && tool.dataPolicy.piiArguments === 'deny') {
        return deny(
          ErrorCode.TOOL_PII_BLOCKED,
          ToolDenialReason.PII,
          'This tool may not receive personal data, and the call includes some. Call it ' +
            'without the masked values, or answer without it.',
        );
      }
      if (carriesPii) args = unmaskDeep(args, context.session) as Record<string, unknown>;
    }

    // ── 7. Budget ────────────────────────────────────────────────────────
    if (!(await context.budget.reserve(tool))) {
      return deny(
        ErrorCode.TOOL_CALL_LIMIT,
        ToolDenialReason.CALL_LIMIT,
        'The tool-call limit has been reached. Answer with the information you have.',
      );
    }

    // ── 8. Idempotency for side effects ──────────────────────────────────
    if (tool.dataPolicy.sideEffects) {
      const claim = await this.claim(tool, context, argumentsDigest);
      if (claim === 'DONE') {
        return this.finishOk(
          {
            ...base,
            tool,
            content:
              'This action was already completed earlier in this run; it was not repeated.',
            label: PUBLIC_LABEL,
            integrity: tool.resultIntegrity,
            truncated: false,
            replayed: true,
          },
          context,
          argumentsDigest,
          started,
          { replayed: true },
          false,
        );
      }
      if (claim === 'UNKNOWN') {
        return deny(
          ErrorCode.TOOL_EXECUTION_FAILED,
          ToolDenialReason.DUPLICATE,
          'An earlier attempt at this action may or may not have completed, so it was not ' +
            'repeated. A person should check before trying again.',
        );
      }
    }

    // ── Run ──────────────────────────────────────────────────────────────
    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;

    try {
      const output = await this.run(tool, args, context, signal);
      const { content, truncated } = this.bound(output.content);
      return this.finishOk(
        {
          ...base,
          tool,
          content,
          data: output.data,
          label: output.label ?? PUBLIC_LABEL,
          integrity: tool.resultIntegrity,
          truncated,
          replayed: false,
        },
        context,
        argumentsDigest,
        started,
        output.metadata ?? {},
        true,
      );
    } catch (error) {
      // Cancellation of the whole answer or step is not the tool's failure.
      if (context.signal?.aborted && !timeout.aborted) throw error;

      if (error instanceof ToolRuntimeError) {
        if (error.options.denial) {
          return deny(error.code, error.options.denial, error.message);
        }
        return this.finishFailed(
          {
            ...base,
            code: error.code,
            message: error.message,
            retryable: error.options.retryable ?? false,
          },
          context,
          argumentsDigest,
          started,
        );
      }
      if (timeout.aborted || (error instanceof HttpToolError && error.kind === 'TIMEOUT')) {
        return this.finishFailed(
          {
            ...base,
            code: ErrorCode.TOOL_TIMEOUT,
            message: 'The tool did not finish in time.',
            retryable: true,
          },
          context,
          argumentsDigest,
          started,
        );
      }
      if (
        error instanceof AppException &&
        error.code === ErrorCode.PII_DETECTION_UNAVAILABLE
      ) {
        // Fail closed: the outgoing request could not be inspected.
        return this.finishFailed(
          {
            ...base,
            code: ErrorCode.PII_DETECTION_UNAVAILABLE,
            message:
              'The request could not be checked for personal data, so it was not sent.',
            retryable: true,
          },
          context,
          argumentsDigest,
          started,
        );
      }

      this.logger.error(
        { err: error as Error, tool: tool.name, executionId: context.executionId },
        'A tool failed unexpectedly.',
      );
      return this.finishFailed(
        {
          ...base,
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: 'The tool failed unexpectedly.',
          retryable: false,
        },
        context,
        argumentsDigest,
        started,
      );
    }
  }

  // ── Running ───────────────────────────────────────────────────────────────

  private async run(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<ToolOutput> {
    if (tool.kind === ToolKind.HTTP && tool.http) {
      const secret = await this.registry.loadSecret(
        context.principal.organizationId,
        tool.id,
      );
      return this.httpRunner.run({
        tool: tool as ToolDescriptor & { http: HttpToolConfig },
        secret,
        args,
        signal,
        inspect: (request) => this.inspectEgress(tool, request, context, signal),
      });
    }

    const builtin = this.registry.builtin(tool.name);
    if (!builtin) {
      throw new ToolRuntimeError(ErrorCode.TOOL_NOT_FOUND, 'This tool is not available.');
    }
    return builtin.execute(args, {
      principal: context.principal,
      agent: context.agent,
      flow: context.flow,
      origin: context.origin,
      actorLabel: context.actorLabel,
      signal,
    });
  }

  /**
   * The egress check for a request leaving for a third party. With a masking
   * session, the session's own leak check (known values and recognizers) —
   * exactly what the LLM gateway runs on prompts. Without one (a workflow tool
   * node, whose arguments are real values), a detection pass over the request.
   */
  private async inspectEgress(
    tool: ToolDescriptor,
    request: RenderedHttpRequest,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (tool.dataPolicy.piiArguments === 'unmask') return null;

    const outgoing = [
      decodeURIComponentSafe(request.url.pathname),
      decodeURIComponentSafe(request.url.search),
      ...Object.values(request.headers),
      request.body ?? '',
    ].join('\n');

    let types: string[];
    if (context.session) {
      types = [
        ...new Set(
          context.session.findLeaks(outgoing).map((finding) => finding.entityType),
        ),
      ];
    } else {
      types = (
        await this.redaction.detectTypes({
          organizationId: context.principal.organizationId,
          texts: [outgoing],
          purpose: 'tool-egress',
          signal,
        })
      ).entityTypes;
    }
    return types.length === 0
      ? null
      : `The request would send personal data (${types.join(', ')}) to ${request.url.host}, ` +
          'which this tool is not permitted to receive.';
  }

  private bound(content: string): { content: string; truncated: boolean } {
    const limit = this.config.maxResultBytes;
    if (Buffer.byteLength(content, 'utf8') <= limit) return { content, truncated: false };
    let cut = content.slice(0, limit);
    while (Buffer.byteLength(cut, 'utf8') > limit) cut = cut.slice(0, -1);
    return { content: `${cut}\n[result truncated]`, truncated: true };
  }

  // ── Idempotency ───────────────────────────────────────────────────────────

  /**
   * Claims a side-effecting execution. `RUN`: proceed. `DONE`: an earlier
   * attempt succeeded. `UNKNOWN`: an earlier attempt started and never
   * reported back — it may have acted — so at-most-once wins over retrying.
   */
  private async claim(
    tool: ToolDescriptor,
    context: ToolExecutionContext,
    argumentsDigest: string,
  ): Promise<'RUN' | 'DONE' | 'UNKNOWN'> {
    const inserted = await this.ledger
      .createQueryBuilder()
      .insert()
      .into(ToolExecution)
      .values(
        this.row(
          tool,
          context,
          argumentsDigest,
          ToolExecutionStatus.RUNNING,
        ) as QueryDeepPartialEntity<ToolExecution>,
      )
      .orIgnore()
      .returning(['id'])
      .execute();
    if ((inserted.raw as unknown[]).length > 0) return 'RUN';

    const existing = await this.ledger.findOne({ where: { id: context.executionId } });
    if (!existing) return 'RUN';
    if (existing.status === ToolExecutionStatus.SUCCEEDED) return 'DONE';
    if (existing.status === ToolExecutionStatus.RUNNING) return 'UNKNOWN';

    // A definite failure or denial earlier: the action did not happen, so it may run.
    await this.ledger.update(
      { id: context.executionId },
      {
        status: ToolExecutionStatus.RUNNING,
        completedAt: null,
        errorCode: null,
        denialReason: null,
      },
    );
    return 'RUN';
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  private row(
    tool: ToolDescriptor | null,
    context: ToolExecutionContext,
    argumentsDigest: string,
    status: ToolExecutionStatus,
  ): Partial<ToolExecution> {
    return {
      id: context.executionId,
      organizationId: context.principal.organizationId,
      toolId: tool?.id ?? null,
      toolName: tool?.name ?? 'unknown',
      toolKind: tool?.kind ?? null,
      toolVersion: tool?.version ?? null,
      definitionDigest: tool?.digest ?? null,
      status,
      userId: context.principal.userId ?? null,
      apiKeyId: context.principal.apiKeyId ?? null,
      agentId: context.agent?.id ?? null,
      agentVersion: context.agent?.version ?? null,
      conversationId: context.origin.conversationId ?? null,
      workflowRunId: context.origin.runId ?? null,
      workflowStepId: context.origin.stepId ?? null,
      iteration: context.origin.iteration ?? null,
      argumentsDigest,
      contextClassification: context.flow.label.classification,
      contextIntegrity: context.flow.integrity,
      sideEffects: tool?.dataPolicy.sideEffects ?? false,
      metadata: {},
    };
  }

  private async persist(
    tool: ToolDescriptor | null,
    context: ToolExecutionContext,
    argumentsDigest: string,
    fields: Partial<ToolExecution>,
  ): Promise<void> {
    const row = {
      ...this.row(tool, context, argumentsDigest, fields.status as ToolExecutionStatus),
      ...fields,
      completedAt: new Date(),
    };
    try {
      await this.ledger
        .createQueryBuilder()
        .insert()
        .into(ToolExecution)
        .values(row as QueryDeepPartialEntity<ToolExecution>)
        .orUpdate(
          [
            'status',
            'denial_reason',
            'error_code',
            'completed_at',
            'duration_ms',
            'result_bytes',
            'result_truncated',
            'metadata',
            'arguments_digest',
          ],
          ['id'],
        )
        .execute();
    } catch (error) {
      this.logger.error(
        { err: error as Error, executionId: context.executionId },
        'Could not record a tool execution in the ledger.',
      );
    }
  }

  private auditBase(
    tool: ToolDescriptor | null,
    toolName: string,
    context: ToolExecutionContext,
    argumentsDigest: string,
    durationMs: number,
  ) {
    return {
      organizationId: context.principal.organizationId,
      resourceType: 'tool',
      resourceId: tool?.id,
      resourceLabel: toolName,
      durationMs,
      metadata: {
        executionId: context.executionId,
        toolName,
        toolVersion: tool?.version,
        toolDigest: tool?.digest,
        toolKind: tool?.kind,
        agentId: context.agent?.id,
        agentVersion: context.agent?.version,
        conversationId: context.origin.conversationId,
        runId: context.origin.runId,
        stepId: context.origin.stepId,
        iteration: context.origin.iteration,
        argumentsDigest,
        contextClassification: context.flow.label.classification,
        contextIntegrity: context.flow.integrity,
        sideEffects: tool?.dataPolicy.sideEffects,
      },
    };
  }

  private async finishOk(
    outcome: Omit<Extract<ToolCallOutcome, { status: 'ok' }>, 'status' | 'durationMs'>,
    context: ToolExecutionContext,
    argumentsDigest: string,
    started: number,
    metadata: Record<string, unknown>,
    record: boolean,
  ): Promise<ToolCallOutcome> {
    const durationMs = Math.round(performance.now() - started);
    const resultBytes = Buffer.byteLength(outcome.content, 'utf8');
    if (record) {
      await this.persist(outcome.tool, context, argumentsDigest, {
        status: ToolExecutionStatus.SUCCEEDED,
        durationMs,
        resultBytes,
        resultTruncated: outcome.truncated,
        metadata,
      });
    }
    const base = this.auditBase(
      outcome.tool,
      outcome.toolName,
      context,
      argumentsDigest,
      durationMs,
    );
    await this.auditService.recordSafe({
      action: AuditAction.TOOL_EXECUTED,
      ...base,
      metadata: {
        ...base.metadata,
        resultBytes,
        truncated: outcome.truncated,
        replayed: outcome.replayed,
        resultClassification: outcome.label.classification,
        ...pickFacts(metadata),
      },
    });
    await this.announce('tool.called', outcome.toolName, context, { ok: true, durationMs });
    return { ...outcome, status: 'ok', durationMs };
  }

  private async finishFailed(
    outcome: Omit<Extract<ToolCallOutcome, { status: 'error' }>, 'status' | 'durationMs'>,
    context: ToolExecutionContext,
    argumentsDigest: string,
    started: number,
  ): Promise<ToolCallOutcome> {
    const durationMs = Math.round(performance.now() - started);
    await this.persist(outcome.tool, context, argumentsDigest, {
      status:
        outcome.code === ErrorCode.TOOL_TIMEOUT
          ? ToolExecutionStatus.TIMED_OUT
          : ToolExecutionStatus.FAILED,
      errorCode: outcome.code,
      durationMs,
    });
    const base = this.auditBase(
      outcome.tool,
      outcome.toolName,
      context,
      argumentsDigest,
      durationMs,
    );
    await this.auditService.recordSafe({
      action: AuditAction.TOOL_EXECUTION_FAILED,
      status: AuditStatus.FAILURE,
      errorCode: outcome.code,
      ...base,
      metadata: { ...base.metadata, retryable: outcome.retryable },
    });
    await this.announce('tool.called', outcome.toolName, context, {
      ok: false,
      errorCode: outcome.code,
      durationMs,
    });
    return { ...outcome, status: 'error', durationMs };
  }

  private async finishDenied(
    outcome: Omit<Extract<ToolCallOutcome, { status: 'denied' }>, 'status' | 'durationMs'>,
    context: ToolExecutionContext,
    argumentsDigest: string,
    started: number,
  ): Promise<ToolCallOutcome> {
    const durationMs = Math.round(performance.now() - started);
    await this.persist(outcome.tool, context, argumentsDigest, {
      status: ToolExecutionStatus.DENIED,
      denialReason: outcome.reason,
      errorCode: outcome.code,
      durationMs,
    });
    const base = this.auditBase(
      outcome.tool,
      outcome.toolName,
      context,
      argumentsDigest,
      durationMs,
    );
    await this.auditService.recordSafe({
      action: AuditAction.TOOL_EXECUTION_DENIED,
      status: AuditStatus.DENIED,
      errorCode: outcome.code,
      ...base,
      metadata: { ...base.metadata, reason: outcome.reason },
    });
    await this.announce('tool.denied', outcome.toolName, context, {
      reason: outcome.reason,
      errorCode: outcome.code,
    });
    return { ...outcome, status: 'denied', durationMs };
  }

  private async announce(
    type: 'tool.called' | 'tool.denied',
    toolName: string,
    context: ToolExecutionContext,
    data: Record<string, string | number | boolean>,
  ): Promise<void> {
    if (!context.origin.runId) return;
    await this.events.publish({
      type,
      organizationId: context.principal.organizationId,
      runId: context.origin.runId,
      ...(context.origin.stepId ? { stepId: context.origin.stepId } : {}),
      ...(context.principal.userId ? { initiatorUserId: context.principal.userId } : {}),
      ...(context.principal.apiKeyId
        ? { initiatorApiKeyId: context.principal.apiKeyId }
        : {}),
      data: { tool: toolName, executionId: context.executionId, ...data },
    });
  }
}

/** Whether any string value carries a placeholder this session can resolve. */
function containsPlaceholders(value: unknown, session: MaskingSession): boolean {
  if (typeof value === 'string') return session.unmaskPreview(value) !== value;
  if (Array.isArray(value))
    return value.some((item) => containsPlaceholders(item, session));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => containsPlaceholders(item, session));
  }
  return false;
}

function unmaskDeep(value: unknown, session: MaskingSession): unknown {
  if (typeof value === 'string') return session.unmask(value);
  if (Array.isArray(value)) return value.map((item) => unmaskDeep(item, session));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unmaskDeep(item, session)]),
    );
  }
  return value;
}

/** Only primitive, content-free facts from a tool's metadata go into the audit record. */
function pickFacts(metadata: Record<string, unknown>): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (['number', 'boolean'].includes(typeof value)) facts[key] = value;
    else if (typeof value === 'string' && value.length <= 128) facts[key] = value;
  }
  return facts;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}
