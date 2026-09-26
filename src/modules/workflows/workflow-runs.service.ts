import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  AppException,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PermissionDeniedError,
} from '../../common/exceptions/app.exception';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { hasPermission } from '../../common/utils/permission.util';
import { isUuid } from '../../common/utils/uuid.util';
import { WORKFLOWS_CONFIG_KEY, type WorkflowsConfig } from '../../config/workflows.config';
import { returnedRows } from '../../database/query.util';
import { RequestContextService } from '../../shared/context/request-context.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AuditService } from '../audit/audit.service';
import { labelOf } from '../agents/conversations.service';
import {
  withholdReason,
  type InformationLabel,
  type LabelReader,
} from '../agents/domain/labels';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { Classification } from '../knowledge/domain/classification';
import { KnowledgeBaseAccessService } from '../knowledge/knowledge-bases/knowledge-base-access.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { RedactionService } from '../privacy/redaction.service';
import { Integrity } from '../tools/domain/information-flow';
import { applyDefaults, validateValue } from '../tools/domain/json-schema';
import { DEFAULT_TRIGGER_SCHEMA, HANDLE } from './domain/graph';
import { ACTIVE_RUN_STATUSES, RunStatus, RunTrigger, StepStatus } from './domain/run-state';
import { reconstructTrace } from './domain/trace';
import type {
  ApprovalItemDto,
  ContentDto,
  DeadLetterDto,
  ListRunsQueryDto,
  RunDetailDto,
  RunDto,
  StartRunDto,
  StepDto,
  TraceDto,
} from './dto/workflow.dto';
import { CompiledGraphsService } from './engine/compiled-graphs.service';
import type { StepOutputEnvelope } from './engine/engine-types';
import { stepId, WorkflowEngineService } from './engine/workflow-engine.service';
import { Workflow, WorkflowStatus } from './entities/workflow.entity';
import { WorkflowRun } from './entities/workflow-run.entity';
import { WorkflowStep } from './entities/workflow-step.entity';
import { WorkflowVersion } from './entities/workflow-version.entity';
import { RunAad, RunCryptoService } from './run-crypto.service';

const READ_ALL = 'workflow:read_all';
const REVEAL = 'pii:reveal';
/** Advisory-lock namespace for per-workspace run admission. */
const ADMISSION_LOCK = 918_274;

type ContentTarget = { kind: 'run' } | { kind: 'step'; step: WorkflowStep };

/**
 * Workflow runs, as people and API clients see them: starting, watching,
 * reading, cancelling, resuming and deleting runs; deciding approvals; and the
 * audit-derived trace and the dead-letter view.
 *
 * ## Who sees what
 *
 * A run belongs to whoever started it. Everyone with `workflow:read` sees
 * their own runs; `workflow:read_all` sees everyone's — supervision — with the
 * same three rules as conversations: content is withheld from a reader whose
 * *current* access does not dominate its label; another member's content is
 * shown with personal data masked unless `reveal=true` (`pii:reveal`, audited
 * CRITICAL); and every supervised read is audited.
 */
@Injectable()
export class WorkflowRunsService {
  private readonly config: WorkflowsConfig;

  constructor(
    @InjectRepository(Workflow) private readonly workflows: Repository<Workflow>,
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
    @InjectRepository(WorkflowRun) private readonly runs: Repository<WorkflowRun>,
    @InjectRepository(WorkflowStep) private readonly steps: Repository<WorkflowStep>,
    private readonly dataSource: DataSource,
    private readonly engine: WorkflowEngineService,
    private readonly graphs: CompiledGraphsService,
    private readonly crypto: RunCryptoService,
    private readonly knowledgeAccess: KnowledgeBaseAccessService,
    private readonly redaction: RedactionService,
    private readonly gateway: LlmGatewayService,
    private readonly auditService: AuditService,
    private readonly events: EventBusService,
    private readonly requestContext: RequestContextService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
  }

  // ── Starting a run ────────────────────────────────────────────────────────

  async start(
    principal: AccessPrincipal,
    workflowId: string,
    input: StartRunDto,
  ): Promise<RunDto> {
    if (!isUuid(workflowId)) throw new NotFoundError(ErrorCode.WORKFLOW_NOT_FOUND);
    const workflow = await this.workflows.findOne({
      where: { id: workflowId, organizationId: principal.organizationId },
    });
    if (!workflow) throw new NotFoundError(ErrorCode.WORKFLOW_NOT_FOUND);

    // Which version: the published one, or — for an editor's test run — another.
    let versionNumber = workflow.publishedVersion;
    if (input.version !== undefined && input.version !== workflow.publishedVersion) {
      if (!hasPermission(principal.permissions, 'workflow:update')) {
        throw new PermissionDeniedError(['workflow:update'], {
          message:
            'Running an unpublished version is a test run, which requires workflow:update.',
        });
      }
      versionNumber = input.version;
    } else if (workflow.status !== WorkflowStatus.ACTIVE || versionNumber === null) {
      throw new ConflictError(ErrorCode.WORKFLOW_NOT_ACTIVE);
    }
    const version = await this.versions.findOne({
      where: { workflowId: workflow.id, version: versionNumber },
    });
    if (!version) throw new NotFoundError(ErrorCode.WORKFLOW_VERSION_NOT_FOUND);
    if (!version.valid) {
      throw new AppException(ErrorCode.WORKFLOW_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, {
        details: { errors: version.validation.errors?.slice(0, 20) ?? [] },
      });
    }
    const graph = await this.graphs.get(
      principal.organizationId,
      workflow.id,
      version.version,
    );

    const usesModel = [...graph.nodes.values()].some(
      (node) =>
        node.type === 'agent' ||
        (node.type === 'supervisor' && node.data.strategy === 'llm'),
    );
    if (usesModel) this.gateway.assertConfigured();

    // The input, against the trigger's schema.
    const schema = graph.trigger.data.inputSchema ?? DEFAULT_TRIGGER_SCHEMA;
    const runInput = applyDefaults(schema, input.input) as Record<string, unknown>;
    const issues = validateValue(schema, runInput);
    if (issues.length > 0) {
      throw new AppException(
        ErrorCode.WORKFLOW_INPUT_INVALID,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          details: { issues },
        },
      );
    }
    const inputBytes = Buffer.byteLength(JSON.stringify(runInput), 'utf8');
    if (inputBytes > this.config.maxInputBytes) {
      throw new AppException(ErrorCode.PAYLOAD_TOO_LARGE, HttpStatus.PAYLOAD_TOO_LARGE, {
        details: { maxBytes: this.config.maxInputBytes },
      });
    }

    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(workflow.id, input.idempotencyKey);
      if (existing) return { ...this.toRunDto(existing), duplicate: true };
    }

    const runId = randomUUID();
    const dataKey = this.crypto.createKey(runId);
    const settings = version.settings ?? {};
    const now = Date.now();
    const runTimeoutMs = Math.min(
      settings.runTimeoutMs ?? this.config.runTimeoutMs,
      this.config.runTimeoutMs,
    );
    const triggerStepId = stepId(runId, graph.trigger.id, 0);
    let dispatch: WorkflowStep[] = [];
    const after = { dispatch: [] as WorkflowStep[], events: [], cancelRunning: false };

    try {
      const run = await this.dataSource.transaction(async (manager) => {
        // Admission control: a workspace's runs in progress are bounded, so one
        // tenant cannot occupy every worker.
        await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          ADMISSION_LOCK,
          principal.organizationId,
        ]);
        const [{ active }]: Array<{ active: number }> = await manager.query(
          `SELECT count(*)::int AS active FROM workflow_runs
            WHERE organization_id = $1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL')`,
          [principal.organizationId],
        );
        if (active >= this.config.maxActiveRunsPerOrganization) {
          throw new AppException(
            ErrorCode.WORKFLOW_CONCURRENCY_LIMIT,
            HttpStatus.TOO_MANY_REQUESTS,
            {
              retryAfterSeconds: 30,
              details: { active, limit: this.config.maxActiveRunsPerOrganization },
            },
          );
        }

        const sealedInput = this.crypto.seal(
          dataKey.plaintext,
          runInput,
          RunAad.runInput(runId),
        );
        const run = manager.getRepository(WorkflowRun).create({
          id: runId,
          organizationId: principal.organizationId,
          workflowId: workflow.id,
          workflowVersion: version.version,
          status: RunStatus.RUNNING,
          trigger: principal.kind === 'api_key' ? RunTrigger.API : RunTrigger.MANUAL,
          initiatorUserId: principal.kind === 'user' ? (principal.userId ?? null) : null,
          initiatorApiKeyId:
            principal.kind === 'api_key' ? (principal.apiKeyId ?? null) : null,
          initiatorMembershipId: principal.membershipId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          wrappedDataKey: dataKey.wrapped,
          inputCiphertext: sealedInput.ciphertext,
          inputBytes: sealedInput.bytes,
          classification: Classification.PUBLIC,
          knowledgeBaseIds: [],
          documentIds: [],
          integrity: Integrity.TRUSTED,
          maxSteps: Math.min(
            settings.maxSteps ?? this.config.maxSteps,
            this.config.maxSteps,
          ),
          stepsScheduled: 1,
          maxTokens: Math.min(
            settings.maxTokens ?? this.config.maxTokensPerRun,
            this.config.maxTokensPerRun,
          ),
          tokensUsed: '0',
          toolCalls: 0,
          startedAt: new Date(now),
          deadlineAt: new Date(now + runTimeoutMs),
          requestId: this.requestContext.requestId ?? null,
        });
        await manager.getRepository(WorkflowRun).insert(run);

        // The trigger step: already done, its output the run's input.
        const sealedOutput = this.crypto.seal(
          dataKey.plaintext,
          { value: runInput } satisfies StepOutputEnvelope,
          RunAad.stepOutput(runId, triggerStepId),
        );
        await manager.getRepository(WorkflowStep).insert({
          id: triggerStepId,
          organizationId: principal.organizationId,
          runId,
          nodeId: graph.trigger.id,
          nodeType: 'trigger',
          iteration: 0,
          status: StepStatus.SUCCEEDED,
          handles: [HANDLE.OUT],
          predecessors: [],
          attempt: 1,
          maxAttempts: 1,
          dispatch: 0,
          outputCiphertext: sealedOutput.ciphertext,
          outputBytes: sealedOutput.bytes,
          classification: Classification.PUBLIC,
          knowledgeBaseIds: [],
          documentIds: [],
          integrity: Integrity.TRUSTED,
          firstAttemptAt: new Date(now),
          startedAt: new Date(now),
          completedAt: new Date(now),
          durationMs: 0,
        });

        await this.auditService.record(
          {
            action: AuditAction.WORKFLOW_EXECUTION_STARTED,
            organizationId: principal.organizationId,
            resourceType: 'workflow_run',
            resourceId: runId,
            resourceLabel: workflow.name,
            metadata: {
              runId,
              workflowId: workflow.id,
              workflowVersion: version.version,
              definitionDigest: version.digest,
              testRun: version.version !== workflow.publishedVersion,
              trigger: run.trigger,
              maxSteps: run.maxSteps,
              maxTokens: run.maxTokens,
              stepBound: graph.stepBound,
              inputBytes: sealedInput.bytes,
            },
          },
          manager,
        );
        await this.auditService.record(
          {
            action: AuditAction.WORKFLOW_STEP_COMPLETED,
            organizationId: principal.organizationId,
            resourceType: 'workflow_step',
            resourceId: triggerStepId,
            metadata: {
              runId,
              stepId: triggerStepId,
              nodeId: graph.trigger.id,
              nodeType: 'trigger',
              iteration: 0,
              attempt: 1,
              status: StepStatus.SUCCEEDED,
              final: true,
              predecessors: [],
              handles: [HANDLE.OUT],
              classification: Classification.PUBLIC,
            },
          },
          manager,
        );

        await this.engine.advance(manager, run, graph, dataKey.plaintext, after);
        await manager
          .getRepository(Workflow)
          .update({ id: workflow.id }, { lastRunAt: new Date(now) });
        return run;
      });

      dispatch = after.dispatch;
      await this.engine.afterCommit(run, dataKey.plaintext, after);
      await this.events.publish({
        type: 'run.started',
        organizationId: run.organizationId,
        runId: run.id,
        workflowId: run.workflowId,
        ...(run.initiatorUserId ? { initiatorUserId: run.initiatorUserId } : {}),
        ...(run.initiatorApiKeyId ? { initiatorApiKeyId: run.initiatorApiKeyId } : {}),
        data: { workflowVersion: run.workflowVersion, steps: dispatch.length },
      });
      return this.toRunDto(await this.loadRun(principal.organizationId, run.id));
    } catch (error) {
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findByIdempotencyKey(workflow.id, input.idempotencyKey);
        if (existing) return { ...this.toRunDto(existing), duplicate: true };
      }
      throw error;
    } finally {
      this.crypto.destroy(dataKey.plaintext);
    }
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(
    principal: AccessPrincipal,
    query: ListRunsQueryDto,
  ): Promise<PaginatedResult<RunDto>> {
    const all = query.scope === 'all';
    if (all && !hasPermission(principal.permissions, READ_ALL)) {
      throw new PermissionDeniedError([READ_ALL]);
    }
    const builder = this.runs
      .createQueryBuilder('run')
      .where('run.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });
    if (!all) this.ownedBy(builder, principal);
    if (query.status) builder.andWhere('run.status = :status', { status: query.status });
    if (query.workflowId && isUuid(query.workflowId)) {
      builder.andWhere('run.workflow_id = :workflowId', { workflowId: query.workflowId });
    }
    const [rows, total] = await builder
      .orderBy('run.created_at', 'DESC')
      .addOrderBy('run.id', 'ASC')
      .skip(query.skip)
      .take(query.take)
      .getManyAndCount();
    return {
      items: rows.map((run) => this.toRunDto(run)),
      meta: buildPaginationMeta(total, query.page, query.take),
    };
  }

  async get(principal: AccessPrincipal, runId: string): Promise<RunDetailDto> {
    const run = await this.visibleRun(principal, runId);
    const steps = await this.steps.find({
      where: { runId: run.id },
      order: { createdAt: 'ASC', iteration: 'ASC' },
    });
    return { ...this.toRunDto(run), steps: steps.map((step) => this.toStepDto(step)) };
  }

  /** A run's input and output — label-checked, and masked for supervisors. */
  async runContent(
    principal: AccessPrincipal,
    runId: string,
    reveal: boolean,
  ): Promise<ContentDto> {
    return this.content(principal, runId, { kind: 'run' }, reveal);
  }

  async stepContent(
    principal: AccessPrincipal,
    runId: string,
    stepIdValue: string,
    reveal: boolean,
  ): Promise<ContentDto> {
    const run = await this.visibleRun(principal, runId);
    if (!isUuid(stepIdValue)) throw new NotFoundError(ErrorCode.WORKFLOW_STEP_NOT_FOUND);
    const step = await this.steps.findOne({ where: { id: stepIdValue, runId: run.id } });
    if (!step) throw new NotFoundError(ErrorCode.WORKFLOW_STEP_NOT_FOUND);
    return this.content(principal, runId, { kind: 'step', step }, reveal);
  }

  private async content(
    principal: AccessPrincipal,
    runId: string,
    target: ContentTarget,
    reveal: boolean,
  ): Promise<ContentDto> {
    const run = await this.visibleRun(principal, runId, true);
    const own = this.isOwner(run, principal);
    if (reveal && !hasPermission(principal.permissions, REVEAL))
      throw new PermissionDeniedError([REVEAL]);

    const label: InformationLabel =
      target.kind === 'run' ? labelOf(run) : labelOf(target.step);
    const reason = withholdReason(label, await this.readerFor(principal, label));
    if (reason) {
      return {
        contentState: 'WITHHELD',
        withheldReason: reason,
        input: null,
        output: null,
        classification: label.classification,
      };
    }
    if (!run.wrappedDataKey) {
      return {
        contentState: 'WITHHELD',
        withheldReason: 'NOT_AVAILABLE',
        input: null,
        output: null,
        classification: label.classification,
      };
    }

    const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
    let input: unknown = null;
    let output: unknown = null;
    try {
      if (target.kind === 'run') {
        input = run.inputCiphertext
          ? this.crypto.open(key, run.inputCiphertext, RunAad.runInput(run.id))
          : null;
        output = run.outputCiphertext
          ? this.crypto.open(key, run.outputCiphertext, RunAad.runOutput(run.id))
          : null;
      } else {
        const [row]: Array<{
          input_ciphertext: string | null;
          output_ciphertext: string | null;
        }> = await this.dataSource.query(
          `SELECT input_ciphertext, output_ciphertext FROM workflow_steps WHERE id = $1`,
          [target.step.id],
        );
        input = row?.input_ciphertext
          ? this.crypto.open(
              key,
              row.input_ciphertext,
              RunAad.stepInput(run.id, target.step.id),
            )
          : null;
        const envelope = row?.output_ciphertext
          ? this.crypto.open<StepOutputEnvelope>(
              key,
              row.output_ciphertext,
              RunAad.stepOutput(run.id, target.step.id),
            )
          : null;
        output = envelope?.value ?? null;
      }
    } finally {
      this.crypto.destroy(key);
    }

    if (own) {
      return {
        contentState: 'VISIBLE',
        input,
        output,
        classification: label.classification,
      };
    }

    await this.auditService.recordSafe({
      action: AuditAction.WORKFLOW_RUN_SUPERVISED,
      organizationId: principal.organizationId,
      resourceType: 'workflow_run',
      resourceId: run.id,
      metadata: {
        runId: run.id,
        ...(target.kind === 'step' ? { stepId: target.step.id } : {}),
        initiatorUserId: run.initiatorUserId,
        revealed: reveal,
        classification: label.classification,
      },
    });
    if (reveal) {
      await this.auditService.recordSafe({
        action: AuditAction.PII_UNMASKED,
        organizationId: principal.organizationId,
        resourceType: 'workflow_run',
        resourceId: run.id,
        metadata: {
          runId: run.id,
          ...(target.kind === 'step' ? { stepId: target.step.id } : {}),
        },
      });
      return {
        contentState: 'VISIBLE',
        input,
        output,
        classification: label.classification,
      };
    }

    const masked = await this.maskDeep(principal.organizationId, { input, output });
    if (!masked) {
      return {
        contentState: 'WITHHELD',
        withheldReason: 'REDACTION_UNAVAILABLE',
        input: null,
        output: null,
        classification: label.classification,
      };
    }
    return {
      contentState: masked.changed ? 'MASKED' : 'VISIBLE',
      input: masked.value.input,
      output: masked.value.output,
      classification: label.classification,
    };
  }

  // ── Control ───────────────────────────────────────────────────────────────

  async cancel(principal: AccessPrincipal, runId: string): Promise<RunDto> {
    const run = await this.visibleRun(principal, runId);
    this.assertCanControl(run, principal);
    if (!ACTIVE_RUN_STATUSES.includes(run.status))
      throw new ConflictError(ErrorCode.WORKFLOW_RUN_FINISHED);
    await this.engine.cancelRun(run.id, principal.userId ?? null);
    return this.toRunDto(await this.loadRun(principal.organizationId, run.id));
  }

  /**
   * Resumes a failed or timed-out run from where it stopped: the failed and
   * cancelled steps run again (retry counts reset), completed steps keep their
   * outputs. "Resumed rather than restarted" — per-step persistence at work.
   */
  async resume(principal: AccessPrincipal, runId: string): Promise<RunDto> {
    const visible = await this.visibleRun(principal, runId);
    this.assertCanControl(visible, principal);
    if (![RunStatus.FAILED, RunStatus.TIMED_OUT].includes(visible.status)) {
      throw new ConflictError(ErrorCode.WORKFLOW_RUN_NOT_RESUMABLE, {
        details: { status: visible.status },
      });
    }
    const run = await this.runWithKey(visible.id);
    if (!run?.wrappedDataKey) throw new ConflictError(ErrorCode.WORKFLOW_RUN_NOT_RESUMABLE);

    const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
    try {
      const reset = await this.dataSource.transaction(async (manager) => {
        const locked = await manager
          .getRepository(WorkflowRun)
          .createQueryBuilder('run')
          .setLock('pessimistic_write')
          .where('run.id = :id', { id: run.id })
          .getOne();
        if (!locked || ![RunStatus.FAILED, RunStatus.TIMED_OUT].includes(locked.status)) {
          throw new ConflictError(ErrorCode.WORKFLOW_RUN_NOT_RESUMABLE);
        }
        const rows = returnedRows<{ id: string }>(
          await manager.query(
            `UPDATE workflow_steps
              SET status = 'QUEUED', attempt = 0, error_code = NULL, failure_class = NULL,
                  dispatch = dispatch + 1, enqueued_at = NULL, next_attempt_at = NULL,
                  heartbeat_at = NULL, completed_at = NULL, dead_lettered_at = NULL,
                  handles = '[]'::jsonb
            WHERE run_id = $1 AND status IN ('FAILED','CANCELLED')
              AND NOT (status = 'FAILED' AND handles @> '["error"]'::jsonb)
            RETURNING id`,
            [run.id],
          ),
        );
        const runTimeoutMs = this.config.runTimeoutMs;
        await manager.update(
          WorkflowRun,
          { id: run.id },
          {
            status: RunStatus.RUNNING,
            errorCode: null,
            errorStepId: null,
            completedAt: null,
            deadlineAt: new Date(Date.now() + runTimeoutMs),
          },
        );
        await this.auditService.record(
          {
            action: AuditAction.WORKFLOW_EXECUTION_RESUMED,
            organizationId: run.organizationId,
            resourceType: 'workflow_run',
            resourceId: run.id,
            metadata: {
              runId: run.id,
              previousStatus: locked.status,
              stepsReset: rows.length,
            },
          },
          manager,
        );
        return rows.map((row) => row.id);
      });
      const steps =
        reset.length > 0 ? await this.steps.find({ where: { id: In(reset) } }) : [];
      await this.engine.dispatch(run, key, steps);
      if (steps.length === 0) await this.engine.reconcile(run.id);
      await this.events.publish({
        type: 'run.resumed',
        organizationId: run.organizationId,
        runId: run.id,
        workflowId: run.workflowId,
        ...(run.initiatorUserId ? { initiatorUserId: run.initiatorUserId } : {}),
        data: { stepsReset: steps.length },
      });
    } finally {
      this.crypto.destroy(key);
    }
    return this.toRunDto(await this.loadRun(principal.organizationId, run.id));
  }

  /**
   * Deletes a finished run by destroying its key: its input, output and every
   * inter-agent message become unreadable at once, backups included. The rows
   * go too; the audit trail stays.
   */
  async remove(principal: AccessPrincipal, runId: string): Promise<void> {
    const run = await this.visibleRun(principal, runId);
    if (
      !this.isOwner(run, principal) &&
      !hasPermission(principal.permissions, 'workflow:delete')
    ) {
      throw new PermissionDeniedError(['workflow:delete']);
    }
    if (ACTIVE_RUN_STATUSES.includes(run.status)) {
      throw new ConflictError(ErrorCode.RESOURCE_CONFLICT, {
        message: 'Cancel the run before deleting it.',
      });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE workflow_runs
            SET wrapped_data_key = NULL, input_ciphertext = NULL, output_ciphertext = NULL, deleted_at = now()
          WHERE id = $1`,
        [run.id],
      );
      await manager.query(`DELETE FROM workflow_steps WHERE run_id = $1`, [run.id]);
      await this.auditService.record(
        {
          action: AuditAction.WORKFLOW_RUN_DELETED,
          organizationId: principal.organizationId,
          resourceType: 'workflow_run',
          resourceId: run.id,
          metadata: { runId: run.id, workflowId: run.workflowId, status: run.status },
        },
        manager,
      );
    });
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  async listApprovals(principal: AccessPrincipal): Promise<ApprovalItemDto[]> {
    const rows = await this.steps
      .createQueryBuilder('step')
      .innerJoin(WorkflowRun, 'run', 'run.id = step.run_id')
      .addSelect(['run.id', 'run.workflowId', 'run.initiatorUserId'])
      .where('step.organization_id = :organizationId AND step.status = :status', {
        organizationId: principal.organizationId,
        status: StepStatus.WAITING_APPROVAL,
      })
      .orderBy('step.created_at', 'ASC')
      .limit(100)
      .getMany();

    const items: ApprovalItemDto[] = [];
    for (const step of rows) {
      const run = await this.runWithKey(step.runId);
      if (!run) continue;
      const label = labelOf(step);
      const cleared =
        withholdReason(label, await this.readerFor(principal, label)) === null;
      let message: string | null = null;
      if (cleared && run.wrappedDataKey) {
        const [row]: Array<{ input_ciphertext: string | null }> =
          await this.dataSource.query(
            `SELECT input_ciphertext FROM workflow_steps WHERE id = $1`,
            [step.id],
          );
        if (row?.input_ciphertext) {
          const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
          try {
            message = String(
              this.crypto.open<{ message?: string }>(
                key,
                row.input_ciphertext,
                RunAad.stepInput(run.id, step.id),
              ).message ?? '',
            );
          } finally {
            this.crypto.destroy(key);
          }
        }
      }
      const graph = await this.graphs.get(
        run.organizationId,
        run.workflowId,
        run.workflowVersion,
      );
      const node = graph.nodes.get(step.nodeId);
      const selfApproval =
        run.initiatorUserId !== null && run.initiatorUserId === principal.userId;
      const allowSelf = node?.type === 'approval' && node.data.allowSelfApproval === true;
      items.push({
        runId: run.id,
        stepId: step.id,
        workflowId: run.workflowId,
        nodeId: step.nodeId,
        requestedAt: step.approval?.requestedAt ?? step.createdAt.toISOString(),
        expiresAt: step.approval?.expiresAt ?? '',
        initiatorUserId: run.initiatorUserId,
        classification: step.classification,
        message,
        canDecide: cleared && (!selfApproval || allowSelf),
      });
    }
    return items;
  }

  async decide(
    principal: AccessPrincipal,
    runId: string,
    stepIdValue: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ): Promise<RunDto> {
    if (!isUuid(runId) || !isUuid(stepIdValue))
      throw new NotFoundError(ErrorCode.WORKFLOW_STEP_NOT_FOUND);
    const run = await this.loadRun(principal.organizationId, runId);
    const step = await this.steps.findOne({ where: { id: stepIdValue, runId: run.id } });
    if (!step) throw new NotFoundError(ErrorCode.WORKFLOW_STEP_NOT_FOUND);
    if (step.status !== StepStatus.WAITING_APPROVAL)
      throw new ConflictError(ErrorCode.WORKFLOW_APPROVAL_NOT_PENDING);

    const graph = await this.graphs.get(
      run.organizationId,
      run.workflowId,
      run.workflowVersion,
    );
    const node = graph.nodes.get(step.nodeId);
    const allowSelf = node?.type === 'approval' && node.data.allowSelfApproval === true;
    if (
      !allowSelf &&
      principal.kind === 'user' &&
      run.initiatorUserId === principal.userId
    ) {
      throw new ForbiddenError(ErrorCode.WORKFLOW_SELF_APPROVAL_FORBIDDEN);
    }
    // An approver decides on content, so must be cleared to read it.
    const reason = withholdReason(
      labelOf(step),
      await this.readerFor(principal, labelOf(step)),
    );
    if (reason) {
      await this.auditService.recordSafe({
        action: AuditAction.ACCESS_DENIED,
        status: AuditStatus.DENIED,
        organizationId: principal.organizationId,
        resourceType: 'workflow_step',
        resourceId: step.id,
        metadata: { runId: run.id, reason, purpose: 'approval' },
      });
      throw new ForbiddenError(ErrorCode.FORBIDDEN, {
        message: 'You are not cleared for the information this approval concerns.',
      });
    }

    const decided = await this.engine.decideApproval({
      runId: run.id,
      stepId: step.id,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: 'person',
      actorUserId: principal.userId ?? null,
      comment: comment ?? null,
    });
    if (!decided) throw new ConflictError(ErrorCode.WORKFLOW_APPROVAL_NOT_PENDING);
    return this.toRunDto(await this.loadRun(principal.organizationId, run.id));
  }

  // ── Trace and dead letters ────────────────────────────────────────────────

  /** The run's trace, rebuilt from the audit log alone. */
  async trace(principal: AccessPrincipal, runId: string): Promise<TraceDto> {
    if (!hasPermission(principal.permissions, 'audit:read')) {
      throw new PermissionDeniedError(['audit:read']);
    }
    if (!isUuid(runId)) throw new NotFoundError(ErrorCode.WORKFLOW_RUN_NOT_FOUND);
    const records: Array<{
      sequence: string;
      action: string;
      status: string;
      actor_id: string | null;
      resource_id: string | null;
      error_code: string | null;
      metadata: Record<string, unknown>;
    }> = await this.dataSource.query(
      `SELECT sequence, action, status, actor_id, resource_id, error_code, metadata
         FROM audit_logs
        WHERE organization_id = $1 AND (resource_id = $2 OR metadata->>'runId' = $2)
        ORDER BY sequence ASC
        LIMIT 20000`,
      [principal.organizationId, runId],
    );
    if (records.length === 0) throw new NotFoundError(ErrorCode.WORKFLOW_RUN_NOT_FOUND);
    const trace = reconstructTrace(
      runId,
      records.map((record) => ({
        sequence: record.sequence,
        action: record.action,
        status: record.status,
        actorId: record.actor_id,
        resourceId: record.resource_id,
        errorCode: record.error_code,
        metadata: record.metadata,
      })),
    );
    return {
      runId,
      complete: trace.complete,
      problems: trace.problems,
      trace: trace as unknown as Record<string, unknown>,
    };
  }

  /** Dead-lettered steps, metadata only: debugging from metadata alone. */
  async deadLetters(
    principal: AccessPrincipal,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<DeadLetterDto>> {
    const [rows, total] = await this.steps
      .createQueryBuilder('step')
      .innerJoin(WorkflowRun, 'run', 'run.id = step.run_id')
      .addSelect(['run.workflowId', 'run.workflowVersion', 'run.status'])
      .where(
        'step.organization_id = :organizationId AND step.dead_lettered_at IS NOT NULL',
        {
          organizationId: principal.organizationId,
        },
      )
      .orderBy('step.dead_lettered_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const runs = new Map(
      (
        await this.runs.find({
          where: { id: In([...new Set(rows.map((row) => row.runId))]) },
        })
      ).map((run) => [run.id, run]),
    );
    return {
      items: rows.map((step) => {
        const run = runs.get(step.runId);
        return {
          runId: step.runId,
          stepId: step.id,
          workflowId: run?.workflowId ?? '',
          workflowVersion: run?.workflowVersion ?? 0,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          iteration: step.iteration,
          attempts: step.attempt,
          errorCode: step.errorCode,
          failureClass: step.failureClass,
          deadLetteredAt: step.deadLetteredAt as Date,
          runStatus: run?.status ?? RunStatus.FAILED,
        };
      }),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async visibleRun(
    principal: AccessPrincipal,
    runId: string,
    withContent = false,
  ): Promise<WorkflowRun> {
    if (!isUuid(runId)) throw new NotFoundError(ErrorCode.WORKFLOW_RUN_NOT_FOUND);
    const builder = this.runs
      .createQueryBuilder('run')
      .where('run.id = :runId AND run.organization_id = :organizationId', {
        runId,
        organizationId: principal.organizationId,
      });
    if (withContent) {
      builder.addSelect([
        'run.wrappedDataKey',
        'run.inputCiphertext',
        'run.outputCiphertext',
      ]);
    }
    const run = await builder.getOne();
    // Someone else's run is not found — not forbidden — unless you supervise.
    if (
      !run ||
      (!this.isOwner(run, principal) && !hasPermission(principal.permissions, READ_ALL))
    ) {
      throw new NotFoundError(ErrorCode.WORKFLOW_RUN_NOT_FOUND);
    }
    return run;
  }

  private async loadRun(organizationId: string, runId: string): Promise<WorkflowRun> {
    const run = await this.runs.findOne({ where: { id: runId, organizationId } });
    if (!run) throw new NotFoundError(ErrorCode.WORKFLOW_RUN_NOT_FOUND);
    return run;
  }

  private async runWithKey(runId: string): Promise<WorkflowRun | null> {
    return this.runs
      .createQueryBuilder('run')
      .addSelect('run.wrappedDataKey')
      .where('run.id = :runId', { runId })
      .getOne();
  }

  private async findByIdempotencyKey(
    workflowId: string,
    key: string,
  ): Promise<WorkflowRun | null> {
    return this.runs.findOne({ where: { workflowId, idempotencyKey: key } });
  }

  private isOwner(run: WorkflowRun, principal: AccessPrincipal): boolean {
    return principal.kind === 'api_key'
      ? run.initiatorApiKeyId !== null && run.initiatorApiKeyId === principal.apiKeyId
      : run.initiatorUserId !== null && run.initiatorUserId === principal.userId;
  }

  /** Your own runs with `workflow:execute`; anyone's with `workflow:update`. */
  private assertCanControl(run: WorkflowRun, principal: AccessPrincipal): void {
    if (
      this.isOwner(run, principal) &&
      hasPermission(principal.permissions, 'workflow:execute')
    )
      return;
    if (hasPermission(principal.permissions, 'workflow:update')) return;
    throw new PermissionDeniedError(['workflow:update'], {
      message: 'Controlling someone else’s run requires workflow:update.',
    });
  }

  private ownedBy(
    builder: ReturnType<Repository<WorkflowRun>['createQueryBuilder']>,
    principal: AccessPrincipal,
  ): void {
    if (principal.kind === 'api_key') {
      builder.andWhere('run.initiator_api_key_id = :keyId', { keyId: principal.apiKeyId });
    } else {
      builder.andWhere('run.initiator_user_id = :userId', { userId: principal.userId });
    }
  }

  private async readerFor(
    principal: AccessPrincipal,
    label: InformationLabel,
  ): Promise<LabelReader> {
    const scope = await this.knowledgeAccess.resolveScope(principal);
    const documentIds = label.documentIds;
    let deleted = new Set<string>();
    if (documentIds.length > 0) {
      const live: Array<{ id: string }> = await this.dataSource.query(
        `SELECT id FROM documents WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [principal.organizationId, documentIds],
      );
      const alive = new Set(live.map((row) => row.id));
      deleted = new Set(documentIds.filter((id) => !alive.has(id)));
    }
    return {
      clearance: scope.clearance,
      readableKnowledgeBaseIds: new Set(scope.knowledgeBases.keys()),
      deletedDocumentIds: deleted,
    };
  }

  /**
   * Masks personal data in every string of a structured value, in one masking
   * session. Null when detection is unavailable and the policy refuses.
   */
  private async maskDeep(
    organizationId: string,
    value: Record<string, unknown>,
  ): Promise<{ value: Record<string, unknown>; changed: boolean } | null> {
    const segments: Array<{ id: string; text: string }> = [];
    const collect = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const id = `s${segments.length}`;
        segments.push({ id, text: node });
        return { __segment: id };
      }
      if (Array.isArray(node)) return node.map(collect);
      if (typeof node === 'object' && node !== null) {
        return Object.fromEntries(
          Object.entries(node).map(([key, item]) => [key, collect(item)]),
        );
      }
      return node;
    };
    const skeleton = collect(value);
    if (segments.length === 0) return { value, changed: false };

    try {
      const outcome = await this.redaction.redact({
        organizationId,
        segments,
        purpose: 'supervision',
      });
      try {
        if (!outcome.enabled) return { value, changed: false };
        const masked = new Map(
          outcome.segments.map((segment) => [segment.id, segment.text]),
        );
        const fill = (node: unknown): unknown => {
          if (typeof node === 'object' && node !== null && '__segment' in node) {
            return masked.get((node as { __segment: string }).__segment) ?? '';
          }
          if (Array.isArray(node)) return node.map(fill);
          if (typeof node === 'object' && node !== null) {
            return Object.fromEntries(
              Object.entries(node).map(([key, item]) => [key, fill(item)]),
            );
          }
          return node;
        };
        return { value: fill(skeleton) as Record<string, unknown>, changed: true };
      } finally {
        outcome.session?.destroy();
      }
    } catch (error) {
      if (
        error instanceof AppException &&
        error.code === ErrorCode.PII_DETECTION_UNAVAILABLE
      )
        return null;
      throw error;
    }
  }

  toRunDto(run: WorkflowRun): RunDto {
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      status: run.status,
      trigger: run.trigger,
      initiatorUserId: run.initiatorUserId,
      initiatorApiKeyId: run.initiatorApiKeyId,
      classification: run.classification,
      integrity: run.integrity,
      maxSteps: run.maxSteps,
      stepsScheduled: run.stepsScheduled,
      maxTokens: run.maxTokens,
      tokensUsed: Number(run.tokensUsed ?? 0),
      toolCalls: run.toolCalls,
      errorCode: run.errorCode,
      errorStepId: run.errorStepId,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      deadlineAt: run.deadlineAt,
    };
  }

  toStepDto(step: WorkflowStep): StepDto {
    const approval = step.approval
      ? {
          requestedAt: step.approval.requestedAt,
          expiresAt: step.approval.expiresAt,
          ...(step.approval.decision ? { decision: step.approval.decision } : {}),
          ...(step.approval.decidedAt ? { decidedAt: step.approval.decidedAt } : {}),
          ...(step.approval.decidedBy ? { decidedBy: step.approval.decidedBy } : {}),
          ...(step.approval.decidedById !== undefined
            ? { decidedById: step.approval.decidedById }
            : {}),
        }
      : null;
    return {
      id: step.id,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      iteration: step.iteration,
      status: step.status,
      handles: step.handles ?? [],
      predecessors: (step.predecessors ?? []).map(
        (ref) => `${ref.nodeId}#${ref.iteration}`,
      ),
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      classification: step.classification,
      integrity: step.integrity,
      agentId: step.agentId,
      agentVersion: step.agentVersion,
      toolId: step.toolId,
      toolVersion: step.toolVersion,
      model: step.model,
      promptTokens: step.promptTokens,
      completionTokens: step.completionTokens,
      toolCalls: step.toolCalls ?? [],
      errorCode: step.errorCode,
      failureClass: step.failureClass,
      deadLettered: step.deadLetteredAt !== null,
      approval,
      inputBytes: step.inputBytes,
      outputBytes: step.outputBytes,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs: step.durationMs,
      createdAt: step.createdAt,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { driverError?: { code?: string } }).driverError?.code ??
    (error as { code?: string }).code;
  return code === '23505';
}
