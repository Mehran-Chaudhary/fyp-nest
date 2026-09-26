import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { performance } from 'node:perf_hooks';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { AuditAction, AuditStatus } from '../../../common/enums/audit-action.enum';
import { ActorType } from '../../../common/enums/auth-type.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { AppException } from '../../../common/exceptions/app.exception';
import { backoffDelay } from '../../../common/utils/retry.util';
import { uuidV5 } from '../../../common/utils/uuid.util';
import {
  WORKFLOWS_CONFIG_KEY,
  type WorkflowsConfig,
} from '../../../config/workflows.config';
import { returnedRows } from '../../../database/query.util';
import { RequestContextService } from '../../../shared/context/request-context.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import type { PublishableEvent } from '../../../shared/events/realtime-event';
import { QUEUE_NAME } from '../../../shared/queue/queue.constants';
import { AuditService } from '../../audit/audit.service';
import { joinLabels, type InformationLabel } from '../../agents/domain/labels';
import { Classification } from '../../knowledge/domain/classification';
import { Integrity, meetIntegrity } from '../../tools/domain/information-flow';
import { buildDeadLetterRecord } from '../domain/dead-letter';
import { HANDLE, type WorkflowNode } from '../domain/graph';
import type { CompiledGraph } from '../domain/graph-validation';
import { jobMacKey, verifyStepJob, type StepJobData } from '../domain/job-auth';
import {
  FailureClass,
  isRunActive,
  isStepTerminal,
  RunStatus,
  StepStatus,
} from '../domain/run-state';
import { schedule, type PlannedStep, type StepSnapshot } from '../domain/scheduler';
import { WorkflowRun } from '../entities/workflow-run.entity';
import { WorkflowStep, type StepApproval } from '../entities/workflow-step.entity';
import { RunAad, RunCryptoService } from '../run-crypto.service';
import { PrincipalRevokedError, RunPrincipalService } from '../run-principal.service';
import { CompiledGraphsService } from './compiled-graphs.service';
import {
  RunBudgetExceeded,
  StepFailure,
  type NodeResult,
  type StepOutputEnvelope,
} from './engine-types';
import { labelOfStep, StepExecutorService } from './step-executor.service';
import { WorkflowJobsService } from './workflow-jobs.service';

/** Namespace for step ids: `uuidv5(run:node:iteration)`. */
export const STEP_NAMESPACE = '9a8b7c6d-5e4f-5a3b-9c2d-1e0f9a8b7c6d';

export function stepId(runId: string, nodeId: string, iteration: number): string {
  return uuidV5(`${runId}:${nodeId}:${iteration}`, STEP_NAMESPACE);
}

/** Why a running step's work was stopped from outside. */
class StepAbort extends Error {
  constructor(readonly kind: 'TIMEOUT' | 'CANCELLED' | 'LEASE_LOST' | 'DEADLINE') {
    super(`step aborted: ${kind}`);
    this.name = 'StepAbort';
  }
}

interface Settlement {
  status: StepStatus.SUCCEEDED | StepStatus.FAILED;
  handles: string[];
  output: StepOutputEnvelope | null;
  input: unknown;
  label: InformationLabel;
  integrity: Integrity;
  errorCode?: string | null;
  failureClass?: FailureClass | null;
  meta?: NodeResult extends infer R ? (R extends { meta: infer M } ? M : never) : never;
  approval?: StepApproval | null;
  durationMs?: number | null;
}

/** What to do after a transaction commits: dispatch jobs, publish events. */
interface AfterCommit {
  dispatch: WorkflowStep[];
  events: PublishableEvent[];
  cancelRunning: boolean;
}

/**
 * The multi-agent workflow engine (proposal module 6.9): executes a run one
 * step at a time, each step a queued job, with PostgreSQL as the source of
 * truth for every state change.
 *
 * ## A step's life
 *
 *  1. **Authenticate the job.** Its MAC must verify under the run's key.
 *  2. **Claim** the step: compare-and-set QUEUED → RUNNING (or take over a
 *     RUNNING step whose worker stopped sending heartbeats).
 *  3. **Re-establish the principal** from the database: the run acts for its
 *     initiator, with their access as it is *now*.
 *  4. **Execute** the node, under a timeout, sending heartbeats that also
 *     notice cancellation.
 *  5. **Settle** in one transaction holding the run's row lock: record the
 *     step's (encrypted) output and labels, write its audit record, ask the
 *     scheduler what becomes ready, insert those steps, and finish the run if
 *     nothing is left. Then dispatch the new steps.
 *
 * Because completing a step and scheduling its successors commit together,
 * there is no state in which a step finished but its successors were never
 * recorded. A job lost after that commit leaves a QUEUED row that the
 * reconciliation sweep dispatches again.
 *
 * ## Failure
 *
 * Transient failures and timeouts are retried with jittered exponential
 * backoff up to the node's attempt limit; policy and permanent failures are
 * not. A step that fails for good follows its `error` edge if it has one;
 * otherwise the run fails. Either way a metadata-only record goes to the
 * dead-letter queue.
 *
 * ## Circuit breakers
 *
 * Two ceilings stop a runaway run: the **step ceiling**, checked as steps are
 * scheduled — so an infinite loop is stopped before its next step reaches the
 * queue — and the **token budget**, checked after every model call. Either
 * fails the run and is audited as `agent.circuit_broken`.
 */
@Injectable()
export class WorkflowEngineService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowEngineService.name);
  private readonly config: WorkflowsConfig;
  /** Local in-flight steps by run, so a cancellation can abort them. */
  private readonly inFlight = new Map<string, Set<AbortController>>();

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(WorkflowRun) private readonly runs: Repository<WorkflowRun>,
    @InjectRepository(WorkflowStep) private readonly steps: Repository<WorkflowStep>,
    private readonly crypto: RunCryptoService,
    private readonly principals: RunPrincipalService,
    private readonly executor: StepExecutorService,
    private readonly jobs: WorkflowJobsService,
    private readonly graphs: CompiledGraphsService,
    private readonly auditService: AuditService,
    private readonly events: EventBusService,
    private readonly requestContext: RequestContextService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
  }

  onModuleInit(): void {
    this.events.onControl((message) => {
      if (message.kind !== 'cancel-run') return;
      for (const controller of this.inFlight.get(message.runId) ?? []) {
        controller.abort(new StepAbort('CANCELLED'));
      }
    });
  }

  // ── The queue's entry point ───────────────────────────────────────────────

  async process(job: Job<StepJobData>): Promise<{ outcome: string }> {
    return this.requestContext.run(
      {
        requestId: job.data?.requestId ?? `wf-${String(job.id)}`,
        startTime: Date.now(),
        ip: 'internal',
        actorType: ActorType.SYSTEM,
        actorLabel: 'workflow engine',
      },
      () => this.runJob(job),
    );
  }

  private async runJob(job: Job<StepJobData>): Promise<{ outcome: string }> {
    const data = job.data;
    const run = await this.loadRunWithKey(data?.runId);
    if (!run || run.organizationId !== data.organizationId || !run.wrappedDataKey) {
      // A deleted run's jobs cannot be verified any more (its key is gone): stale, not hostile.
      return { outcome: 'skipped: run not found' };
    }

    const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
    try {
      if (!verifyStepJob(jobMacKey(key), data)) {
        await this.auditService.recordSafe({
          action: AuditAction.WORKFLOW_STEP_REJECTED,
          status: AuditStatus.DENIED,
          organizationId: run.organizationId,
          resourceType: 'workflow_step',
          resourceId:
            typeof data.stepId === 'string' ? data.stepId.slice(0, 64) : undefined,
          metadata: {
            runId: run.id,
            jobId: String(job.id).slice(0, 128),
            reason: 'MAC_INVALID',
            queue: QUEUE_NAME.WORKFLOW_STEPS,
          },
        });
        this.logger.error(
          `Rejected a workflow job that failed authentication (run ${run.id}).`,
        );
        throw new UnrecoverableError('job authentication failed');
      }
      return await this.executeStep(run, data, key);
    } finally {
      this.crypto.destroy(key);
    }
  }

  private async executeStep(
    run: WorkflowRun,
    data: StepJobData,
    key: Buffer,
  ): Promise<{ outcome: string }> {
    if (!isRunActive(run.status)) {
      await this.steps.update(
        { id: data.stepId, runId: run.id, status: StepStatus.QUEUED },
        { status: StepStatus.CANCELLED, completedAt: new Date() },
      );
      return { outcome: 'skipped: run finished' };
    }
    if (run.deadlineAt.getTime() < Date.now()) {
      await this.timeoutRun(run.id);
      return { outcome: 'timed out' };
    }

    const step = await this.claim(data.stepId, run.id);
    if (!step) return { outcome: 'skipped: not claimable' };

    const graph = await this.graphs.get(
      run.organizationId,
      run.workflowId,
      run.workflowVersion,
    );
    const node = graph.nodes.get(step.nodeId);
    if (!node) {
      await this.fail(
        run,
        step,
        key,
        new StepFailure(ErrorCode.WORKFLOW_INVALID, FailureClass.PERMANENT, 'unknown node'),
        graph,
        0,
      );
      return { outcome: 'failed' };
    }

    const controller = new AbortController();
    this.track(run.id, controller);
    const started = performance.now();
    const timeoutMs = Math.min(
      stepTimeoutOf(node) ?? this.config.stepTimeoutMs,
      this.config.stepTimeoutMs,
      Math.max(run.deadlineAt.getTime() - Date.now(), 1_000),
    );
    const timer = setTimeout(() => controller.abort(new StepAbort('TIMEOUT')), timeoutMs);
    const heartbeat = setInterval(
      () => void this.heartbeat(step, controller),
      this.config.heartbeatIntervalMs,
    );

    try {
      const principal = await this.principals.resolve(run);
      const steps = await this.steps.find({ where: { runId: run.id } });
      await this.publish(run, 'step.started', step, { attempt: step.attempt });

      const result = await this.executor.execute({
        run,
        step,
        node,
        graph,
        principal,
        key,
        steps,
        actorLabel: await this.actorLabel(run),
        signal: controller.signal,
      });

      const durationMs = Math.round(performance.now() - started);
      if (result.kind === 'waiting') {
        await this.wait(run, step, key, result, graph);
        return { outcome: 'waiting for approval' };
      }
      await this.settle(run, step, key, graph, {
        status: StepStatus.SUCCEEDED,
        handles: result.handles,
        output: result.output,
        input: result.input,
        label: result.label,
        integrity: result.integrity,
        meta: result.meta,
        durationMs,
      });
      return { outcome: 'succeeded' };
    } catch (error) {
      const reason: unknown = controller.signal.reason;
      const abort =
        controller.signal.aborted && reason instanceof StepAbort ? reason : null;
      if (abort?.kind === 'LEASE_LOST') return { outcome: 'lost lease' };
      if (abort?.kind === 'CANCELLED') {
        await this.steps.update(
          { id: step.id, status: StepStatus.RUNNING, attempt: step.attempt },
          { status: StepStatus.CANCELLED, completedAt: new Date() },
        );
        return { outcome: 'cancelled' };
      }
      await this.fail(
        run,
        step,
        key,
        abort?.kind === 'TIMEOUT'
          ? new StepFailure(
              ErrorCode.WORKFLOW_STEP_TIMEOUT,
              FailureClass.TIMEOUT,
              'The step ran out of time.',
            )
          : error,
        graph,
        Math.round(performance.now() - started),
      );
      return { outcome: 'failed' };
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      this.untrack(run.id, controller);
    }
  }

  // ── Claiming and heartbeats ───────────────────────────────────────────────

  /**
   * QUEUED → RUNNING, or takeover of a RUNNING step whose worker went silent.
   * Exactly one caller wins; everyone else gets null.
   */
  private async claim(id: string, runId: string): Promise<WorkflowStep | null> {
    const rows = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `UPDATE workflow_steps
            SET status = 'RUNNING', attempt = attempt + 1, started_at = now(),
                heartbeat_at = now(), first_attempt_at = COALESCE(first_attempt_at, now()),
                next_attempt_at = NULL, updated_at = now()
          WHERE id = $1 AND run_id = $2
            AND ((status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= now() + interval '2 seconds'))
              OR (status = 'RUNNING' AND heartbeat_at < now() - $3 * interval '1 millisecond'))
          RETURNING id`,
        [id, runId, this.config.stallThresholdMs],
      ),
    );
    if (rows.length === 0) return null;
    return this.steps.findOne({ where: { id } });
  }

  private async heartbeat(step: WorkflowStep, controller: AbortController): Promise<void> {
    try {
      const rows = returnedRows<{ status: RunStatus }>(
        await this.dataSource.query(
          `UPDATE workflow_steps s SET heartbeat_at = now()
             FROM workflow_runs r
            WHERE s.id = $1 AND s.status = 'RUNNING' AND s.attempt = $2 AND r.id = s.run_id
            RETURNING r.status`,
          [step.id, step.attempt],
        ),
      );
      if (rows.length === 0) controller.abort(new StepAbort('LEASE_LOST'));
      else if (!isRunActive(rows[0].status)) controller.abort(new StepAbort('CANCELLED'));
    } catch (error) {
      this.logger.debug(
        `Heartbeat failed for step ${step.id}: ${(error as Error).message}`,
      );
    }
  }

  // ── Settling ──────────────────────────────────────────────────────────────

  /**
   * Records a finished step and advances the run, atomically: the step's
   * output, its audit record, the successors it makes ready and — if nothing
   * is left — the run's own completion, all in one transaction under the
   * run's row lock.
   */
  private async settle(
    run: WorkflowRun,
    step: WorkflowStep,
    key: Buffer,
    graph: CompiledGraph,
    settlement: Settlement,
    expectStatus: StepStatus = StepStatus.RUNNING,
  ): Promise<void> {
    const after: AfterCommit = { dispatch: [], events: [], cancelRunning: false };

    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockRun(manager, run.id);
      if (!locked || !isRunActive(locked.status)) {
        // The run ended (cancelled, timed out) while this step worked.
        await manager.update(
          WorkflowStep,
          { id: step.id, status: expectStatus },
          { status: StepStatus.CANCELLED, completedAt: new Date() },
        );
        return;
      }

      const sealedOutput = settlement.output
        ? this.crypto.seal(key, settlement.output, RunAad.stepOutput(run.id, step.id))
        : null;
      const sealedInput =
        settlement.input !== null && settlement.input !== undefined
          ? this.crypto.seal(key, settlement.input, RunAad.stepInput(run.id, step.id))
          : null;
      if (sealedOutput && sealedOutput.bytes > this.config.maxStepOutputBytes) {
        throw new StepFailure(
          ErrorCode.PAYLOAD_TOO_LARGE,
          FailureClass.PERMANENT,
          `The step's output exceeds ${this.config.maxStepOutputBytes} bytes.`,
        );
      }

      const meta = settlement.meta;
      const updated = await manager
        .createQueryBuilder()
        .update(WorkflowStep)
        .set({
          status: settlement.status,
          handles: settlement.handles,
          ...(sealedOutput
            ? { outputCiphertext: sealedOutput.ciphertext, outputBytes: sealedOutput.bytes }
            : {}),
          ...(sealedInput
            ? { inputCiphertext: sealedInput.ciphertext, inputBytes: sealedInput.bytes }
            : {}),
          classification: settlement.label.classification,
          knowledgeBaseIds: settlement.label.knowledgeBaseIds,
          documentIds: settlement.label.documentIds,
          integrity: settlement.integrity,
          agentId: meta?.agentId ?? null,
          agentVersion: meta?.agentVersion ?? null,
          toolId: meta?.toolId ?? null,
          toolVersion: meta?.toolVersion ?? null,
          model: meta?.model ?? null,
          promptTokens: meta?.promptTokens ?? 0,
          completionTokens: meta?.completionTokens ?? 0,
          invocationIds: meta?.invocationIds ?? [],
          toolCalls: meta?.toolCalls ?? [],
          errorCode: settlement.errorCode ?? null,
          failureClass: settlement.failureClass ?? null,
          completedAt: new Date(),
          durationMs: settlement.durationMs ?? null,
          ...(settlement.approval !== undefined ? { approval: settlement.approval } : {}),
        })
        .where('id = :id AND status = :status AND attempt = :attempt', {
          id: step.id,
          status: expectStatus,
          attempt: step.attempt,
        })
        .execute();
      if (!updated.affected) return; // taken over by another worker: its result stands

      await this.auditStep(manager, locked, step, settlement);

      // The run's labels: the high-water mark of every step, the low-water mark of trust.
      const runLabel = joinLabels(labelOfRun(locked), settlement.label);
      locked.classification = runLabel.classification;
      locked.knowledgeBaseIds = runLabel.knowledgeBaseIds;
      locked.documentIds = runLabel.documentIds;
      locked.integrity = meetIntegrity(locked.integrity, settlement.integrity);
      await manager.update(
        WorkflowRun,
        { id: locked.id },
        {
          classification: locked.classification,
          knowledgeBaseIds: locked.knowledgeBaseIds,
          documentIds: locked.documentIds,
          integrity: locked.integrity,
        },
      );

      after.events.push(
        this.event(
          locked,
          settlement.status === StepStatus.SUCCEEDED ? 'step.completed' : 'step.failed',
          step,
          {
            handles: settlement.handles,
            durationMs: settlement.durationMs ?? null,
            tokens: (meta?.promptTokens ?? 0) + (meta?.completionTokens ?? 0),
            toolCalls: meta?.toolCalls.length ?? 0,
            classification: settlement.label.classification,
            ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
          },
        ),
      );

      await this.advance(manager, locked, graph, key, after);
    });

    await this.afterCommit(run, key, after);
  }

  /** An approval node reached: the step waits for a person. */
  private async wait(
    run: WorkflowRun,
    step: WorkflowStep,
    key: Buffer,
    result: Extract<NodeResult, { kind: 'waiting' }>,
    graph: CompiledGraph,
  ): Promise<void> {
    const after: AfterCommit = { dispatch: [], events: [], cancelRunning: false };
    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockRun(manager, run.id);
      if (!locked || !isRunActive(locked.status)) return;
      const sealed = this.crypto.seal(key, result.input, RunAad.stepInput(run.id, step.id));
      const updated = await manager.update(
        WorkflowStep,
        { id: step.id, status: StepStatus.RUNNING, attempt: step.attempt },
        {
          status: StepStatus.WAITING_APPROVAL,
          approval: result.approval,
          inputCiphertext: sealed.ciphertext,
          inputBytes: sealed.bytes,
          classification: result.label.classification,
          knowledgeBaseIds: result.label.knowledgeBaseIds,
          documentIds: result.label.documentIds,
          integrity: result.integrity,
          heartbeatAt: null,
        },
      );
      if (!updated.affected) return;
      await this.auditService.record(
        {
          action: AuditAction.WORKFLOW_APPROVAL_REQUESTED,
          organizationId: run.organizationId,
          resourceType: 'workflow_step',
          resourceId: step.id,
          metadata: {
            runId: run.id,
            stepId: step.id,
            nodeId: step.nodeId,
            iteration: step.iteration,
            expiresAt: result.approval.expiresAt,
            classification: result.label.classification,
          },
        },
        manager,
      );
      await this.refreshRunStatus(manager, locked);
      after.events.push(
        this.event(locked, 'step.waiting_approval', step, {
          expiresAt: result.approval.expiresAt,
        }),
        this.event(locked, 'approval.requested', step, {
          expiresAt: result.approval.expiresAt,
          classification: result.label.classification,
        }),
      );
    });
    void graph;
    await this.afterCommit(run, key, after);
  }

  /**
   * A person (or the timeout policy) decided an approval step. The step
   * settles with `approved` or `rejected`, and the run moves on.
   */
  async decideApproval(input: {
    runId: string;
    stepId: string;
    decision: 'approved' | 'rejected';
    decidedBy: 'person' | 'timeout';
    actorUserId: string | null;
    comment?: string | null;
  }): Promise<boolean> {
    const run = await this.loadRunWithKey(input.runId);
    if (!run?.wrappedDataKey || !isRunActive(run.status)) return false;
    const step = await this.steps.findOne({ where: { id: input.stepId, runId: run.id } });
    if (!step || step.status !== StepStatus.WAITING_APPROVAL || !step.approval)
      return false;

    const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
    try {
      const graph = await this.graphs.get(
        run.organizationId,
        run.workflowId,
        run.workflowVersion,
      );
      const approval: StepApproval = {
        ...step.approval,
        decision: input.decision,
        decidedById: input.actorUserId,
        decidedAt: new Date().toISOString(),
        decidedBy: input.decidedBy,
        commentCiphertext: input.comment
          ? this.crypto.seal(key, input.comment, RunAad.approvalComment(run.id, step.id))
              .ciphertext
          : null,
      };
      await this.settle(
        run,
        step,
        key,
        graph,
        {
          status: StepStatus.SUCCEEDED,
          handles: [input.decision === 'approved' ? HANDLE.APPROVED : HANDLE.REJECTED],
          output: { value: { decision: input.decision, decidedBy: input.decidedBy } },
          input: null,
          label: labelOfStep(step),
          integrity: step.integrity,
          approval,
          meta: {
            promptTokens: 0,
            completionTokens: 0,
            invocationIds: [],
            toolCalls: [],
            facts: { decision: input.decision, decidedBy: input.decidedBy },
          },
          durationMs: Date.now() - new Date(step.approval.requestedAt).getTime(),
        },
        StepStatus.WAITING_APPROVAL,
      );
      await this.auditService.recordSafe({
        action:
          input.decision === 'approved'
            ? AuditAction.WORKFLOW_APPROVAL_GRANTED
            : AuditAction.WORKFLOW_APPROVAL_REJECTED,
        organizationId: run.organizationId,
        resourceType: 'workflow_step',
        resourceId: step.id,
        ...(input.decidedBy === 'timeout'
          ? { actor: { type: ActorType.SYSTEM, label: 'approval timeout' } }
          : {}),
        metadata: {
          runId: run.id,
          stepId: step.id,
          nodeId: step.nodeId,
          decidedBy: input.decidedBy,
          commented: Boolean(input.comment),
        },
      });
      await this.publish(run, 'approval.decided', step, {
        decision: input.decision,
        decidedBy: input.decidedBy,
      });
      return true;
    } finally {
      this.crypto.destroy(key);
    }
  }

  /**
   * Asks the scheduler what becomes ready, inserts it — or stops the run at
   * the step ceiling — and finishes the run when nothing is left.
   */
  async advance(
    manager: EntityManager,
    run: WorkflowRun,
    graph: CompiledGraph,
    key: Buffer,
    after: AfterCommit,
  ): Promise<void> {
    const rows = await manager.find(WorkflowStep, {
      where: { runId: run.id },
      select: { id: true, nodeId: true, iteration: true, status: true, handles: true },
    });
    const outcome = schedule(graph, rows.map(toSnapshot));
    const queued = outcome.create.filter((planned) => planned.status === StepStatus.QUEUED);

    if (run.stepsScheduled + queued.length > run.maxSteps) {
      await this.breakCircuit(manager, run, graph, key, after, {
        code: ErrorCode.WORKFLOW_STEP_LIMIT_EXCEEDED,
        reason: 'STEP_LIMIT',
        detail: {
          maxSteps: run.maxSteps,
          stepsScheduled: run.stepsScheduled,
          wanted: queued.length,
        },
      });
      return;
    }

    if (outcome.create.length > 0) {
      const inserted = await this.insertPlanned(manager, run, graph, outcome.create);
      const insertedQueued = inserted.filter((step) => step.status === StepStatus.QUEUED);
      run.stepsScheduled += insertedQueued.length;
      await manager.update(
        WorkflowRun,
        { id: run.id },
        { stepsScheduled: run.stepsScheduled },
      );
      after.dispatch.push(...insertedQueued);
      for (const step of inserted) {
        after.events.push(
          this.event(
            run,
            step.status === StepStatus.QUEUED ? 'step.queued' : 'step.skipped',
            step,
            {},
          ),
        );
      }
    }

    if (outcome.settled) {
      await this.finalize(
        manager,
        run,
        graph,
        key,
        after,
        outcome.succeeded ? RunStatus.COMPLETED : RunStatus.FAILED,
        outcome.succeeded ? null : ErrorCode.WORKFLOW_NO_OUTPUT,
      );
      return;
    }
    await this.refreshRunStatus(manager, run);
  }

  private async insertPlanned(
    manager: EntityManager,
    run: WorkflowRun,
    graph: CompiledGraph,
    planned: readonly PlannedStep[],
  ): Promise<WorkflowStep[]> {
    const values = planned.map((plan) => {
      const node = graph.nodes.get(plan.nodeId) as WorkflowNode;
      const skipped = plan.status === StepStatus.SKIPPED;
      return {
        id: stepId(run.id, plan.nodeId, plan.iteration),
        organizationId: run.organizationId,
        runId: run.id,
        nodeId: plan.nodeId,
        nodeType: node.type,
        iteration: plan.iteration,
        status: plan.status,
        handles: [],
        predecessors: plan.predecessors,
        attempt: 0,
        maxAttempts: maxAttemptsOf(node) ?? this.config.stepMaxAttempts,
        dispatch: skipped ? 0 : 1,
        classification: Classification.PUBLIC,
        knowledgeBaseIds: [],
        documentIds: [],
        integrity: Integrity.TRUSTED,
        completedAt: skipped ? new Date() : null,
      };
    });
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(WorkflowStep)
      .values(values)
      .orIgnore()
      .returning(['id'])
      .execute();
    const insertedIds = new Set((result.raw as Array<{ id: string }>).map((row) => row.id));
    return (values as unknown as WorkflowStep[]).filter((value) =>
      insertedIds.has(value.id),
    );
  }

  /** RUNNING while anything can progress; WAITING_APPROVAL when only approvals are open. */
  private async refreshRunStatus(manager: EntityManager, run: WorkflowRun): Promise<void> {
    const [counts]: Array<{ active: number; waiting: number }> = await manager.query(
      `SELECT count(*) FILTER (WHERE status IN ('QUEUED','RUNNING'))::int AS active,
              count(*) FILTER (WHERE status = 'WAITING_APPROVAL')::int AS waiting
         FROM workflow_steps WHERE run_id = $1`,
      [run.id],
    );
    const next =
      counts.active === 0 && counts.waiting > 0
        ? RunStatus.WAITING_APPROVAL
        : RunStatus.RUNNING;
    if (next !== run.status) {
      run.status = next;
      await manager.update(
        WorkflowRun,
        {
          id: run.id,
          status: In([RunStatus.RUNNING, RunStatus.WAITING_APPROVAL, RunStatus.QUEUED]),
        },
        { status: next },
      );
    }
  }

  /** Ends a run: its output (from its output nodes) sealed, its final audit record written. */
  private async finalize(
    manager: EntityManager,
    run: WorkflowRun,
    graph: CompiledGraph,
    key: Buffer,
    after: AfterCommit,
    status: RunStatus,
    errorCode: string | null,
    errorStepId: string | null = null,
  ): Promise<void> {
    let output: { ciphertext: string; bytes: number } | null = null;
    if (status === RunStatus.COMPLETED) {
      const rows: Array<{
        id: string;
        node_id: string;
        iteration: number;
        output_ciphertext: string | null;
      }> = await manager.query(
        `SELECT DISTINCT ON (node_id) id, node_id, iteration, output_ciphertext
             FROM workflow_steps
            WHERE run_id = $1 AND status = 'SUCCEEDED' AND node_id = ANY($2::varchar[])
            ORDER BY node_id, iteration DESC`,
        [run.id, graph.outputs],
      );
      const values = rows
        .filter((row) => row.output_ciphertext)
        .map((row) => ({
          nodeId: row.node_id,
          value: this.crypto.open<StepOutputEnvelope>(
            key,
            row.output_ciphertext as string,
            RunAad.stepOutput(run.id, row.id),
          ).value,
        }));
      const value =
        graph.outputs.length === 1
          ? (values[0]?.value ?? null)
          : Object.fromEntries(values.map((entry) => [entry.nodeId, entry.value]));
      output = this.crypto.seal(key, value, RunAad.runOutput(run.id));
    }

    await manager.update(
      WorkflowRun,
      { id: run.id },
      {
        status,
        errorCode,
        errorStepId,
        completedAt: new Date(),
        ...(output
          ? { outputCiphertext: output.ciphertext, outputBytes: output.bytes }
          : {}),
      },
    );
    await manager.query(
      `UPDATE workflow_steps SET status = 'CANCELLED', completed_at = now()
        WHERE run_id = $1 AND status IN ('QUEUED','WAITING_APPROVAL')`,
      [run.id],
    );
    run.status = status;

    const stats: Array<{
      id: string;
      node_id: string;
      iteration: number;
      status: StepStatus;
    }> = await manager.query(
      `SELECT id, node_id, iteration, status FROM workflow_steps WHERE run_id = $1`,
      [run.id],
    );
    const action =
      status === RunStatus.COMPLETED
        ? AuditAction.WORKFLOW_EXECUTION_COMPLETED
        : status === RunStatus.CANCELLED
          ? AuditAction.WORKFLOW_EXECUTION_CANCELLED
          : status === RunStatus.TIMED_OUT
            ? AuditAction.WORKFLOW_EXECUTION_TIMED_OUT
            : AuditAction.WORKFLOW_EXECUTION_FAILED;
    await this.auditService.record(
      {
        action,
        status: status === RunStatus.COMPLETED ? AuditStatus.SUCCESS : AuditStatus.FAILURE,
        organizationId: run.organizationId,
        resourceType: 'workflow_run',
        resourceId: run.id,
        errorCode: errorCode ?? undefined,
        actor: { type: ActorType.SYSTEM, label: 'workflow engine' },
        metadata: {
          runId: run.id,
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          status,
          // Steps that ran (and so have their own records); skipped ones by name.
          steps: stats.filter((step) =>
            [StepStatus.SUCCEEDED, StepStatus.FAILED].includes(step.status),
          ).length,
          skipped: stats
            .filter((step) => step.status === StepStatus.SKIPPED)
            .map((step) => `${step.node_id}#${step.iteration}`),
          cancelled: stats.filter((step) => step.status === StepStatus.CANCELLED).length,
          stepsScheduled: run.stepsScheduled,
          tokensUsed: Number(run.tokensUsed ?? 0),
          toolCalls: run.toolCalls,
          classification: run.classification,
          integrity: run.integrity,
          outputBytes: output?.bytes ?? 0,
          errorStepId,
        },
      },
      manager,
    );

    after.cancelRunning = status !== RunStatus.COMPLETED;
    after.events.push(
      this.event(
        run,
        status === RunStatus.COMPLETED
          ? 'run.completed'
          : status === RunStatus.CANCELLED
            ? 'run.cancelled'
            : status === RunStatus.TIMED_OUT
              ? 'run.timed_out'
              : 'run.failed',
        null,
        {
          status,
          ...(errorCode ? { errorCode } : {}),
          steps: stats.length,
          tokensUsed: Number(run.tokensUsed ?? 0),
        },
      ),
    );
  }

  /** A ceiling was hit: the run stops, audited as a broken circuit. */
  private async breakCircuit(
    manager: EntityManager,
    run: WorkflowRun,
    graph: CompiledGraph,
    key: Buffer,
    after: AfterCommit,
    input: {
      code: ErrorCode;
      reason: 'STEP_LIMIT' | 'TOKEN_BUDGET';
      detail: Record<string, unknown>;
      stepId?: string;
    },
  ): Promise<void> {
    await this.auditService.record(
      {
        action: AuditAction.AGENT_CIRCUIT_BROKEN,
        status: AuditStatus.FAILURE,
        organizationId: run.organizationId,
        resourceType: 'workflow_run',
        resourceId: run.id,
        errorCode: input.code,
        actor: { type: ActorType.SYSTEM, label: 'workflow engine' },
        metadata: { runId: run.id, reason: input.reason, ...input.detail },
      },
      manager,
    );
    await this.finalize(
      manager,
      run,
      graph,
      key,
      after,
      RunStatus.FAILED,
      input.code,
      input.stepId ?? null,
    );
  }

  // ── Failure ───────────────────────────────────────────────────────────────

  private async fail(
    run: WorkflowRun,
    step: WorkflowStep,
    key: Buffer,
    error: unknown,
    graph: CompiledGraph,
    durationMs: number,
  ): Promise<void> {
    if (error instanceof RunBudgetExceeded) {
      const after: AfterCommit = { dispatch: [], events: [], cancelRunning: false };
      await this.dataSource.transaction(async (manager) => {
        const locked = await this.lockRun(manager, run.id);
        if (!locked || !isRunActive(locked.status)) return;
        await manager.update(
          WorkflowStep,
          { id: step.id, status: StepStatus.RUNNING, attempt: step.attempt },
          {
            status: StepStatus.FAILED,
            errorCode: ErrorCode.WORKFLOW_TOKEN_BUDGET_EXCEEDED,
            failureClass: FailureClass.POLICY,
            completedAt: new Date(),
            durationMs,
          },
        );
        await this.auditStepFailure(
          manager,
          locked,
          step,
          ErrorCode.WORKFLOW_TOKEN_BUDGET_EXCEEDED,
          FailureClass.POLICY,
          true,
          durationMs,
        );
        await this.breakCircuit(manager, locked, graph, key, after, {
          code: ErrorCode.WORKFLOW_TOKEN_BUDGET_EXCEEDED,
          reason: 'TOKEN_BUDGET',
          detail: { used: error.used, limit: error.limit, stepId: step.id },
          stepId: step.id,
        });
      });
      await this.afterCommit(run, key, after);
      return;
    }

    const { code, failureClass } = classifyFailure(error);
    const retryable =
      failureClass === FailureClass.TRANSIENT || failureClass === FailureClass.TIMEOUT;
    const final = !retryable || step.attempt >= step.maxAttempts;

    this.logger.warn(
      `Step ${step.nodeId}#${step.iteration} of run ${run.id} failed ` +
        `(attempt ${step.attempt}/${step.maxAttempts}, ${code}, ${failureClass}${final ? ', final' : ', will retry'}).`,
    );

    if (!final) {
      const node = graph.nodes.get(step.nodeId);
      const base = backoffOf(node) ?? this.config.stepBackoffMs;
      const delayMs = Math.max(
        250,
        backoffDelay(step.attempt, base, this.config.stepBackoffMaxMs),
      );
      const rows = returnedRows<{ dispatch: number }>(
        await this.dataSource.query(
          `UPDATE workflow_steps
              SET status = 'QUEUED', error_code = $3, failure_class = $4, heartbeat_at = NULL,
                  next_attempt_at = now() + $5 * interval '1 millisecond',
                  dispatch = dispatch + 1, enqueued_at = NULL, duration_ms = $6
            WHERE id = $1 AND status = 'RUNNING' AND attempt = $2
            RETURNING dispatch`,
          [step.id, step.attempt, code, failureClass, delayMs, durationMs],
        ),
      );
      if (rows.length === 0) return;
      await this.auditService.recordSafe({
        action: AuditAction.WORKFLOW_STEP_FAILED,
        status: AuditStatus.FAILURE,
        organizationId: run.organizationId,
        resourceType: 'workflow_step',
        resourceId: step.id,
        errorCode: code,
        durationMs,
        actor: { type: ActorType.SYSTEM, label: 'workflow engine' },
        metadata: {
          runId: run.id,
          stepId: step.id,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          iteration: step.iteration,
          attempt: step.attempt,
          failureClass,
          final: false,
          retryInMs: delayMs,
        },
      });
      await this.publish(run, 'step.retrying', step, {
        attempt: step.attempt,
        errorCode: code,
        delayMs,
      });
      await this.jobs.enqueueStep({
        organizationId: run.organizationId,
        runId: run.id,
        stepId: step.id,
        dispatch: rows[0].dispatch,
        runKey: key,
        delayMs,
        requestId: run.requestId,
      });
      return;
    }

    const node = graph.nodes.get(step.nodeId);
    const errorEdge = (graph.outgoing.get(step.nodeId) ?? []).some(
      (edge) => edge.sourceHandle === HANDLE.ERROR,
    );
    await this.deadLetter(run, step, key, node, code, failureClass, retryable, durationMs);

    if (errorEdge) {
      // Routed: the failure is an outcome the workflow handles.
      await this.settle(run, step, key, graph, {
        status: StepStatus.FAILED,
        handles: [HANDLE.ERROR],
        output: { value: { error: code } },
        input: null,
        label: labelOfStep(step),
        integrity: step.integrity,
        errorCode: code,
        failureClass,
        durationMs,
      });
      return;
    }

    const after: AfterCommit = { dispatch: [], events: [], cancelRunning: false };
    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockRun(manager, run.id);
      if (!locked || !isRunActive(locked.status)) return;
      const updated = await manager.update(
        WorkflowStep,
        { id: step.id, status: StepStatus.RUNNING, attempt: step.attempt },
        {
          status: StepStatus.FAILED,
          errorCode: code,
          failureClass,
          completedAt: new Date(),
          durationMs,
        },
      );
      if (!updated.affected) return;
      await this.auditStepFailure(
        manager,
        locked,
        step,
        code,
        failureClass,
        true,
        durationMs,
      );
      after.events.push(
        this.event(locked, 'step.failed', step, {
          errorCode: code,
          failureClass,
          attempt: step.attempt,
        }),
      );
      await this.finalize(
        manager,
        locked,
        graph,
        key,
        after,
        RunStatus.FAILED,
        code,
        step.id,
      );
    });
    await this.afterCommit(run, key, after);
  }

  private async deadLetter(
    run: WorkflowRun,
    step: WorkflowStep,
    key: Buffer,
    node: WorkflowNode | undefined,
    code: string,
    failureClass: FailureClass,
    retryable: boolean,
    durationMs: number,
  ): Promise<void> {
    // A step's input is a function of the run's input at this node, so a keyed
    // fingerprint of (workflow version, node, run input) makes "the same input
    // fails every time" visible — without the input, and without any key that
    // could decrypt it.
    const [row]: Array<{ input_ciphertext: string | null; input_bytes: number }> =
      await this.dataSource.query(
        `SELECT r.input_ciphertext, r.input_bytes FROM workflow_runs r WHERE r.id = $1`,
        [run.id],
      );
    let inputFingerprint: string | null = null;
    if (row?.input_ciphertext) {
      const runInput = this.crypto.open(key, row.input_ciphertext, RunAad.runInput(run.id));
      inputFingerprint = this.crypto.fingerprint({
        workflowId: run.workflowId,
        version: run.workflowVersion,
        nodeId: step.nodeId,
        iteration: step.iteration,
        input: runInput,
      });
    }
    const record = buildDeadLetterRecord({
      sourceQueue: QUEUE_NAME.WORKFLOW_STEPS,
      jobId: `wfs_${step.id}_${step.dispatch}`,
      organizationId: run.organizationId,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      runId: run.id,
      stepId: step.id,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      iteration: step.iteration,
      attempts: step.attempt,
      failureCode: code,
      failureClass,
      retryable,
      firstAttemptAt: step.firstAttemptAt,
      lastDurationMs: durationMs,
      inputFingerprint,
      inputBytes: row?.input_bytes ?? 0,
      agentId: node?.type === 'agent' ? node.data.agentId : null,
      agentVersion: step.agentVersion,
      toolId: node?.type === 'tool' ? node.data.toolId : null,
      toolVersion: step.toolVersion,
    });
    await this.jobs.deadLetter(record);
    await this.steps.update({ id: step.id }, { deadLetteredAt: new Date() });
    await this.auditService.recordSafe({
      action: AuditAction.WORKFLOW_EXECUTION_DEAD_LETTERED,
      status: AuditStatus.FAILURE,
      organizationId: run.organizationId,
      resourceType: 'workflow_step',
      resourceId: step.id,
      errorCode: code,
      actor: { type: ActorType.SYSTEM, label: 'workflow engine' },
      metadata: {
        runId: run.id,
        stepId: step.id,
        nodeId: step.nodeId,
        attempts: step.attempt,
        failureClass,
      },
    });
  }

  // ── Cancellation and timeouts ─────────────────────────────────────────────

  /** Cancels a run: remaining steps cancelled, in-flight ones aborted everywhere. */
  async cancelRun(runId: string, cancelledById: string | null): Promise<boolean> {
    const run = await this.loadRunWithKey(runId);
    if (!run?.wrappedDataKey) return false;
    const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
    const after: AfterCommit = { dispatch: [], events: [], cancelRunning: false };
    let cancelled = false;
    try {
      await this.dataSource.transaction(async (manager) => {
        const locked = await this.lockRun(manager, runId);
        if (!locked || !isRunActive(locked.status)) return;
        await manager.update(
          WorkflowRun,
          { id: runId },
          { cancelRequestedAt: new Date(), cancelledById },
        );
        const graph = await this.graphs.get(
          locked.organizationId,
          locked.workflowId,
          locked.workflowVersion,
        );
        await this.finalize(manager, locked, graph, key, after, RunStatus.CANCELLED, null);
        cancelled = true;
      });
      await this.afterCommit(run, key, after);
      return cancelled;
    } finally {
      this.crypto.destroy(key);
    }
  }

  async timeoutRun(runId: string): Promise<boolean> {
    const run = await this.loadRunWithKey(runId);
    if (!run?.wrappedDataKey) return false;
    const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
    const after: AfterCommit = { dispatch: [], events: [], cancelRunning: false };
    let timedOut = false;
    try {
      await this.dataSource.transaction(async (manager) => {
        const locked = await this.lockRun(manager, runId);
        if (
          !locked ||
          !isRunActive(locked.status) ||
          locked.deadlineAt.getTime() > Date.now()
        )
          return;
        const graph = await this.graphs.get(
          locked.organizationId,
          locked.workflowId,
          locked.workflowVersion,
        );
        await this.finalize(
          manager,
          locked,
          graph,
          key,
          after,
          RunStatus.TIMED_OUT,
          ErrorCode.WORKFLOW_TIMEOUT,
        );
        timedOut = true;
      });
      await this.afterCommit(run, key, after);
      return timedOut;
    } finally {
      this.crypto.destroy(key);
    }
  }

  /**
   * Re-evaluates a run: settles one whose steps are all finished, dispatches
   * QUEUED steps. The sweep calls it for runs that look stuck; it is safe to
   * call on any run at any time.
   */
  async reconcile(runId: string): Promise<void> {
    const run = await this.loadRunWithKey(runId);
    if (!run?.wrappedDataKey || !isRunActive(run.status)) return;
    const key = this.crypto.unwrap(run.id, run.wrappedDataKey);
    const after: AfterCommit = { dispatch: [], events: [], cancelRunning: false };
    try {
      await this.dataSource.transaction(async (manager) => {
        const locked = await this.lockRun(manager, runId);
        if (!locked || !isRunActive(locked.status)) return;
        const graph = await this.graphs.get(
          locked.organizationId,
          locked.workflowId,
          locked.workflowVersion,
        );
        await this.advance(manager, locked, graph, key, after);
      });
      await this.afterCommit(run, key, after);
    } finally {
      this.crypto.destroy(key);
    }
  }

  // ── After commit ──────────────────────────────────────────────────────────

  async afterCommit(run: WorkflowRun, key: Buffer, after: AfterCommit): Promise<void> {
    for (const step of after.dispatch) {
      await this.jobs.enqueueStep({
        organizationId: run.organizationId,
        runId: run.id,
        stepId: step.id,
        dispatch: step.dispatch || 1,
        runKey: key,
        requestId: run.requestId,
      });
    }
    if (after.cancelRunning) {
      await this.events.publishControl({
        kind: 'cancel-run',
        organizationId: run.organizationId,
        runId: run.id,
        reason: 'run finished',
      });
    }
    for (const event of after.events) await this.events.publish(event);
  }

  /** Dispatches QUEUED steps after the caller's own transaction (run start, resume). */
  async dispatch(
    run: WorkflowRun,
    key: Buffer,
    steps: readonly WorkflowStep[],
  ): Promise<void> {
    await this.afterCommit(run, key, {
      dispatch: [...steps],
      events: [],
      cancelRunning: false,
    });
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  private async auditStep(
    manager: EntityManager,
    run: WorkflowRun,
    step: WorkflowStep,
    settlement: Settlement,
  ): Promise<void> {
    const meta = settlement.meta;
    const failed = settlement.status === StepStatus.FAILED;
    await this.auditService.record(
      {
        action: failed
          ? AuditAction.WORKFLOW_STEP_FAILED
          : AuditAction.WORKFLOW_STEP_COMPLETED,
        status: failed ? AuditStatus.FAILURE : AuditStatus.SUCCESS,
        organizationId: run.organizationId,
        resourceType: 'workflow_step',
        resourceId: step.id,
        errorCode: settlement.errorCode ?? undefined,
        durationMs: settlement.durationMs ?? undefined,
        actor: { type: ActorType.SYSTEM, label: 'workflow engine' },
        metadata: {
          runId: run.id,
          stepId: step.id,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          iteration: step.iteration,
          attempt: step.attempt,
          status: settlement.status,
          final: true,
          predecessors: (step.predecessors ?? []).map(
            (ref) => `${ref.nodeId}#${ref.iteration}`,
          ),
          handles: settlement.handles,
          agentId: meta?.agentId,
          agentVersion: meta?.agentVersion,
          toolId: meta?.toolId,
          toolVersion: meta?.toolVersion,
          model: meta?.model,
          invocationIds: meta?.invocationIds,
          toolCalls: (meta?.toolCalls ?? []).map((call) => ({
            executionId: call.executionId,
            tool: call.tool,
            status: call.status,
          })),
          tokens: (meta?.promptTokens ?? 0) + (meta?.completionTokens ?? 0),
          durationMs: settlement.durationMs ?? undefined,
          classification: settlement.label.classification,
          integrity: settlement.integrity,
          ...(meta?.facts ?? {}),
        },
      },
      manager,
    );
  }

  private async auditStepFailure(
    manager: EntityManager,
    run: WorkflowRun,
    step: WorkflowStep,
    code: string,
    failureClass: FailureClass,
    final: boolean,
    durationMs: number,
  ): Promise<void> {
    await this.auditService.record(
      {
        action: AuditAction.WORKFLOW_STEP_FAILED,
        status: AuditStatus.FAILURE,
        organizationId: run.organizationId,
        resourceType: 'workflow_step',
        resourceId: step.id,
        errorCode: code,
        durationMs,
        actor: { type: ActorType.SYSTEM, label: 'workflow engine' },
        metadata: {
          runId: run.id,
          stepId: step.id,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          iteration: step.iteration,
          attempt: step.attempt,
          status: StepStatus.FAILED,
          final,
          failureClass,
          predecessors: (step.predecessors ?? []).map(
            (ref) => `${ref.nodeId}#${ref.iteration}`,
          ),
          handles: [],
          durationMs,
        },
      },
      manager,
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async loadRunWithKey(runId: string | undefined): Promise<WorkflowRun | null> {
    if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) return null;
    return this.runs
      .createQueryBuilder('run')
      .addSelect('run.wrappedDataKey')
      .where('run.id = :runId', { runId })
      .getOne();
  }

  private async lockRun(
    manager: EntityManager,
    runId: string,
  ): Promise<WorkflowRun | null> {
    return manager
      .getRepository(WorkflowRun)
      .createQueryBuilder('run')
      .setLock('pessimistic_write')
      .where('run.id = :runId', { runId })
      .getOne();
  }

  private track(runId: string, controller: AbortController): void {
    const set = this.inFlight.get(runId) ?? new Set();
    set.add(controller);
    this.inFlight.set(runId, set);
  }

  private untrack(runId: string, controller: AbortController): void {
    const set = this.inFlight.get(runId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.inFlight.delete(runId);
  }

  private async actorLabel(run: WorkflowRun): Promise<string> {
    if (run.initiatorApiKeyId) {
      const [key]: Array<{ name: string }> = await this.dataSource.query(
        `SELECT name FROM api_keys WHERE id = $1`,
        [run.initiatorApiKeyId],
      );
      return key ? `the API key "${key.name}"` : 'an API client';
    }
    const [user]: Array<{ name: string }> = await this.dataSource.query(
      `SELECT COALESCE(NULLIF(display_name, ''), NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) AS name
         FROM users WHERE id = $1`,
      [run.initiatorUserId],
    );
    return user?.name ?? 'a workspace member';
  }

  private event(
    run: WorkflowRun,
    type: PublishableEvent['type'],
    step: Pick<WorkflowStep, 'id' | 'nodeId' | 'iteration' | 'nodeType'> | null,
    data: Record<string, unknown>,
  ): PublishableEvent {
    return {
      type,
      organizationId: run.organizationId,
      runId: run.id,
      workflowId: run.workflowId,
      ...(step ? { stepId: step.id, nodeId: step.nodeId } : {}),
      ...(run.initiatorUserId ? { initiatorUserId: run.initiatorUserId } : {}),
      ...(run.initiatorApiKeyId ? { initiatorApiKeyId: run.initiatorApiKeyId } : {}),
      data: {
        ...(step ? { iteration: step.iteration, nodeType: step.nodeType } : {}),
        ...(data as Record<string, string | number | boolean | null>),
      },
    };
  }

  private async publish(
    run: WorkflowRun,
    type: PublishableEvent['type'],
    step: Pick<WorkflowStep, 'id' | 'nodeId' | 'iteration' | 'nodeType'> | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.events.publish(this.event(run, type, step, data));
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function toSnapshot(
  step: Pick<WorkflowStep, 'nodeId' | 'iteration' | 'status' | 'handles'>,
): StepSnapshot {
  return {
    nodeId: step.nodeId,
    iteration: step.iteration,
    status: step.status,
    handles: step.handles ?? [],
  };
}

function labelOfRun(
  run: Pick<WorkflowRun, 'classification' | 'knowledgeBaseIds' | 'documentIds'>,
): InformationLabel {
  return {
    classification: run.classification,
    knowledgeBaseIds: run.knowledgeBaseIds ?? [],
    documentIds: run.documentIds ?? [],
  };
}

function stepTimeoutOf(node: WorkflowNode): number | undefined {
  return node.type === 'agent' || node.type === 'tool' ? node.data.timeoutMs : undefined;
}

function maxAttemptsOf(node: WorkflowNode): number | undefined {
  if (node.type === 'agent' || node.type === 'tool') return node.data.retry?.maxAttempts;
  // Nodes without side effects or model calls: one attempt is enough, one retry is cheap.
  if (node.type === 'condition' || node.type === 'output' || node.type === 'approval')
    return 2;
  return undefined;
}

function backoffOf(node: WorkflowNode | undefined): number | undefined {
  if (node?.type === 'agent' || node?.type === 'tool') return node.data.retry?.backoffMs;
  return undefined;
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  ErrorCode.LLM_BUSY,
  ErrorCode.LLM_UNAVAILABLE,
  ErrorCode.AI_SERVICE_UNAVAILABLE,
  ErrorCode.VECTOR_STORE_UNAVAILABLE,
  ErrorCode.OBJECT_STORAGE_UNAVAILABLE,
  ErrorCode.PII_DETECTION_UNAVAILABLE,
  ErrorCode.WORKFLOW_OUTPUT_INVALID,
  ErrorCode.WORKFLOW_ROUTING_FAILED,
  ErrorCode.DEPENDENCY_FAILURE,
  ErrorCode.SERVICE_UNAVAILABLE,
]);

const POLICY_CODES: ReadonlySet<string> = new Set([
  ErrorCode.PII_EGRESS_BLOCKED,
  ErrorCode.LLM_CLASSIFICATION_EXCEEDED,
  ErrorCode.WORKFLOW_PRINCIPAL_REVOKED,
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.FORBIDDEN,
  ErrorCode.KNOWLEDGE_BASE_ACCESS_DENIED,
]);

/** What a failure means for retrying. */
export function classifyFailure(error: unknown): {
  code: string;
  failureClass: FailureClass;
} {
  if (error instanceof StepFailure)
    return { code: String(error.code), failureClass: error.failureClass };
  if (error instanceof PrincipalRevokedError) {
    return {
      code: ErrorCode.WORKFLOW_PRINCIPAL_REVOKED,
      failureClass: FailureClass.POLICY,
    };
  }
  if (error instanceof AppException) {
    const code = error.code;
    if (code === ErrorCode.LLM_TIMEOUT) return { code, failureClass: FailureClass.TIMEOUT };
    if (TRANSIENT_CODES.has(code)) return { code, failureClass: FailureClass.TRANSIENT };
    if (POLICY_CODES.has(code)) return { code, failureClass: FailureClass.POLICY };
    const status = error.getStatus();
    if (status === 429 || status === 502 || status === 504)
      return { code, failureClass: FailureClass.TRANSIENT };
    return { code, failureClass: FailureClass.PERMANENT };
  }
  // Unexpected (a database blip, a bug): retried, like ingestion's unknown failures.
  return { code: ErrorCode.INTERNAL_SERVER_ERROR, failureClass: FailureClass.TRANSIENT };
}

export { isStepTerminal };
