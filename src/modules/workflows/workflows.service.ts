import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  AppException,
  ConflictError,
  NotFoundError,
} from '../../common/exceptions/app.exception';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { hasPermission } from '../../common/utils/permission.util';
import { stableStringify } from '../../common/utils/stable-stringify';
import { isUuid } from '../../common/utils/uuid.util';
import { WORKFLOWS_CONFIG_KEY, type WorkflowsConfig } from '../../config/workflows.config';
import { AuditService } from '../audit/audit.service';
import { AgentsService } from '../agents/agents.service';
import { canSeeAgent } from '../agents/domain/agent-access';
import { Agent } from '../agents/entities/agent.entity';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { KnowledgeBaseAccessService } from '../knowledge/knowledge-bases/knowledge-base-access.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { validateValue } from '../tools/domain/json-schema';
import { GRAPH_SCHEMA_VERSION, type WorkflowGraph } from './domain/graph';
import {
  validateGraph,
  type GraphIssue,
  type GraphReport,
} from './domain/graph-validation';
import { RunStatus } from './domain/run-state';
import type {
  CreateWorkflowDto,
  ListWorkflowsQueryDto,
  PublishWorkflowDto,
  SaveDefinitionDto,
  UpdateWorkflowDto,
  ValidationReportDto,
  WorkflowDto,
  WorkflowSettingsDto,
  WorkflowSummaryDto,
  WorkflowVersionDto,
} from './dto/workflow.dto';
import { CompiledGraphsService } from './engine/compiled-graphs.service';
import { WorkflowEngineService } from './engine/workflow-engine.service';
import { Workflow, WorkflowStatus } from './entities/workflow.entity';
import { WorkflowVersion, type WorkflowSettings } from './entities/workflow-version.entity';

const PG_UNIQUE_VIOLATION = '23505';
/** Largest graph stored, valid or not: drafts are saved mid-edit, but bounded. */
const MAX_GRAPH_BYTES = 512 * 1024;

/** A new workflow starts as the smallest valid graph: trigger → output. */
const STARTER_GRAPH: WorkflowGraph = {
  schemaVersion: GRAPH_SCHEMA_VERSION,
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    { id: 'output', type: 'output', position: { x: 320, y: 0 }, data: {} },
  ],
  edges: [{ id: 'trigger-output', source: 'trigger', target: 'output' }],
};

/**
 * Workflow definitions: the canvas's saved state (proposal module 6.13,
 * backend half), versioned the way agents are.
 *
 * ## Versions are append-only
 *
 * Every save appends an immutable version — valid or not, because the canvas
 * saves drafts mid-edit — with its validation report. Publishing points the
 * workflow at one *valid* version; runs use that version and pin it, so
 * editing a workflow never changes a run in flight, and "restore version 3"
 * appends a copy.
 *
 * ## An editor references only what they can see
 *
 * Saving checks every agent, tool and knowledge base the graph names against
 * the editor's own access: a compartment's id is not something to wire into
 * a workflow by guessing. What a *run* may do is decided again, at run time,
 * by the access of whoever starts it.
 */
@Injectable()
export class WorkflowsService {
  private readonly config: WorkflowsConfig;

  constructor(
    @InjectRepository(Workflow) private readonly workflows: Repository<Workflow>,
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
    private readonly dataSource: DataSource,
    private readonly agents: AgentsService,
    private readonly knowledgeAccess: KnowledgeBaseAccessService,
    private readonly tools: ToolRegistryService,
    private readonly graphs: CompiledGraphsService,
    private readonly engine: WorkflowEngineService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Structural validation plus the reference checks that need the database —
   * the canvas calls this as the user edits, without saving anything.
   */
  async validate(principal: AccessPrincipal, graph: unknown): Promise<GraphReport> {
    if (Buffer.byteLength(JSON.stringify(graph ?? null), 'utf8') > MAX_GRAPH_BYTES) {
      return {
        valid: false,
        errors: [
          {
            code: 'LIMIT_EXCEEDED',
            message: `A definition is limited to ${MAX_GRAPH_BYTES} bytes.`,
          },
        ],
        warnings: [],
        normalized: null,
        compiled: null,
      };
    }
    const report = validateGraph(graph, this.graphs.limits);
    if (!report.compiled) return report;

    const errors: GraphIssue[] = [];
    const { agentIds, toolIds, knowledgeBaseIds } = report.compiled.references;

    if (agentIds.length > 0) {
      const viewer = await this.agents.viewerFor(principal);
      const found = await this.dataSource.getRepository(Agent).find({
        where: { id: In(agentIds), organizationId: principal.organizationId },
        relations: { allowedRoles: true },
      });
      const visible = new Set(
        found
          .filter((agent) =>
            canSeeAgent(
              {
                visibility: agent.visibility,
                accessMode: agent.accessMode,
                allowedRoleIds: (agent.allowedRoles ?? []).map((role) => role.id),
                createdById: agent.createdById,
              },
              viewer,
            ),
          )
          .map((agent) => agent.id),
      );
      for (const node of report.compiled.nodes.values()) {
        const agentId =
          node.type === 'agent'
            ? node.data.agentId
            : node.type === 'supervisor'
              ? node.data.agentId
              : undefined;
        if (agentId && !visible.has(agentId)) {
          errors.push({
            code: 'REFERENCE_UNKNOWN',
            message: 'The agent was not found.',
            nodeId: node.id,
          });
        }
      }
    }

    if (toolIds.length > 0) {
      if (!hasPermission(principal.permissions, 'tool:read')) {
        errors.push({
          code: 'REFERENCE_FORBIDDEN',
          message: 'Using tools in a workflow requires tool:read.',
        });
      } else {
        const resolved = await this.tools.resolveMany(principal.organizationId, toolIds);
        for (const node of report.compiled.nodes.values()) {
          if (node.type !== 'tool') continue;
          const tool = resolved.get(node.data.toolId);
          if (!tool) {
            errors.push({
              code: 'REFERENCE_UNKNOWN',
              message: 'The tool was not found.',
              nodeId: node.id,
            });
            continue;
          }
          if (!tool.enabled) {
            errors.push({
              code: 'REFERENCE_DISABLED',
              message: `The tool "${tool.name}" is disabled.`,
              nodeId: node.id,
            });
          }
          // Literal arguments are checked against the tool's schema now; templated ones at run time.
          const literal = Object.fromEntries(
            Object.entries(node.data.arguments).filter(
              ([, value]) => !(typeof value === 'string' && value.includes('{{')),
            ),
          );
          const required = new Set(tool.parameters.required ?? []);
          for (const name of required) {
            if (!(name in node.data.arguments)) {
              errors.push({
                code: 'TOOL_ARGUMENT_MISSING',
                message: `The tool needs "${name}".`,
                nodeId: node.id,
              });
            }
          }
          for (const issue of validateValue(
            { ...tool.parameters, required: [] },
            literal,
          )) {
            if (issue.message === 'is required') continue;
            errors.push({
              code: 'TOOL_ARGUMENT_INVALID',
              message: `arguments${issue.path} ${issue.message}`,
              nodeId: node.id,
            });
          }
        }
      }
    }

    if (knowledgeBaseIds.length > 0) {
      const scope = await this.knowledgeAccess.resolveScope(principal);
      for (const node of report.compiled.nodes.values()) {
        if (node.type !== 'retrieval') continue;
        for (const id of node.data.knowledgeBaseIds ?? []) {
          if (!scope.knowledgeBases.has(id)) {
            await this.knowledgeAccess.recordHiddenProbe(principal, 'knowledge_base', id);
            errors.push({
              code: 'REFERENCE_UNKNOWN',
              message: 'A knowledge base was not found.',
              nodeId: node.id,
            });
          }
        }
      }
    }

    return errors.length === 0
      ? report
      : { ...report, valid: false, errors: [...report.errors, ...errors], compiled: null };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(
    principal: AccessPrincipal,
    query: ListWorkflowsQueryDto,
  ): Promise<PaginatedResult<WorkflowSummaryDto>> {
    const builder = this.workflows
      .createQueryBuilder('workflow')
      .where('workflow.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });
    if (query.status)
      builder.andWhere('workflow.status = :status', { status: query.status });
    if (query.search) {
      builder.andWhere('workflow.name ILIKE :search', {
        search: `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      });
    }
    const [rows, total] = await builder
      .orderBy('workflow.updated_at', 'DESC')
      .addOrderBy('workflow.id', 'ASC')
      .skip(query.skip)
      .take(query.take)
      .getManyAndCount();
    return {
      items: rows.map((workflow) => this.toSummary(workflow)),
      meta: buildPaginationMeta(total, query.page, query.take),
    };
  }

  async get(principal: AccessPrincipal, workflowId: string): Promise<WorkflowDto> {
    const workflow = await this.load(principal.organizationId, workflowId);
    const version = await this.requireVersion(workflow, workflow.currentVersion);
    return {
      ...this.toSummary(workflow),
      definition: this.toVersionDto(workflow, version),
    };
  }

  async listVersions(
    principal: AccessPrincipal,
    workflowId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<WorkflowVersionDto>> {
    const workflow = await this.load(principal.organizationId, workflowId);
    const [rows, total] = await this.versions.findAndCount({
      where: { workflowId: workflow.id, organizationId: principal.organizationId },
      order: { version: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: rows.map((version) => this.toVersionDto(workflow, version)),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async getVersion(
    principal: AccessPrincipal,
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersionDto> {
    const workflow = await this.load(principal.organizationId, workflowId);
    return this.toVersionDto(workflow, await this.requireVersion(workflow, version));
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(principal: AccessPrincipal, input: CreateWorkflowDto): Promise<WorkflowDto> {
    const graph = input.graph ?? STARTER_GRAPH;
    const settings = this.resolveSettings(input.settings);
    const report = await this.validate(principal, graph);

    const saved = await this.withNameGuard(() =>
      this.dataSource.transaction(async (manager) => {
        const workflow = await manager.getRepository(Workflow).save(
          manager.getRepository(Workflow).create({
            organizationId: principal.organizationId,
            name: input.name,
            description: input.description ?? null,
            status: WorkflowStatus.DRAFT,
            currentVersion: 1,
            publishedVersion: null,
            createdById: principal.userId ?? null,
          }),
        );
        const version = await this.appendVersion(
          manager,
          workflow,
          1,
          graph,
          settings,
          report,
          {
            changeNote: 'Created.',
            createdById: principal.userId ?? null,
          },
        );
        await this.auditService.record(
          {
            action: AuditAction.WORKFLOW_CREATED,
            organizationId: principal.organizationId,
            resourceType: 'workflow',
            resourceId: workflow.id,
            resourceLabel: workflow.name,
            metadata: {
              version: 1,
              digest: version.digest,
              valid: version.valid,
              ...shapeOf(report),
            },
          },
          manager,
        );
        return workflow;
      }),
    );
    return this.get(principal, saved.id);
  }

  /** Saves the canvas: appends a version (valid or not) with its validation report. */
  async saveDefinition(
    principal: AccessPrincipal,
    workflowId: string,
    input: SaveDefinitionDto,
  ): Promise<WorkflowDto> {
    await this.load(principal.organizationId, workflowId);
    const report = await this.validate(principal, input.graph);

    await this.dataSource.transaction(async (manager) => {
      const workflow = await this.lock(manager, principal.organizationId, workflowId);
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== workflow.currentVersion
      ) {
        throw new ConflictError(ErrorCode.WORKFLOW_VERSION_CONFLICT, {
          details: {
            expectedVersion: input.expectedVersion,
            currentVersion: workflow.currentVersion,
          },
        });
      }
      const current = await this.requireVersion(workflow, workflow.currentVersion, manager);
      const settings = input.settings
        ? this.resolveSettings(input.settings)
        : current.settings;
      const digest = definitionDigest(report.normalized ?? input.graph, settings);
      if (digest === current.digest) return; // nothing changed: no new version

      workflow.currentVersion += 1;
      await manager
        .getRepository(Workflow)
        .update({ id: workflow.id }, { currentVersion: workflow.currentVersion });
      const version = await this.appendVersion(
        manager,
        workflow,
        workflow.currentVersion,
        input.graph,
        settings,
        report,
        {
          changeNote: input.changeNote ?? null,
          createdById: principal.userId ?? null,
        },
      );
      await this.auditService.record(
        {
          action: AuditAction.WORKFLOW_UPDATED,
          organizationId: principal.organizationId,
          resourceType: 'workflow',
          resourceId: workflow.id,
          resourceLabel: workflow.name,
          metadata: {
            fromVersion: workflow.currentVersion - 1,
            toVersion: workflow.currentVersion,
            digest: version.digest,
            valid: version.valid,
            errors: report.errors.length,
            changeNote: input.changeNote,
            ...shapeOf(report),
          },
        },
        manager,
      );
    });
    return this.get(principal, workflowId);
  }

  async update(
    principal: AccessPrincipal,
    workflowId: string,
    input: UpdateWorkflowDto,
  ): Promise<WorkflowDto> {
    const workflow = await this.load(principal.organizationId, workflowId);
    await this.withNameGuard(() =>
      this.dataSource.transaction(async (manager) => {
        await manager.getRepository(Workflow).update(
          { id: workflow.id },
          {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        );
        await this.auditService.record(
          {
            action: AuditAction.WORKFLOW_UPDATED,
            organizationId: principal.organizationId,
            resourceType: 'workflow',
            resourceId: workflow.id,
            resourceLabel: input.name ?? workflow.name,
            metadata: { renamed: input.name !== undefined && input.name !== workflow.name },
          },
          manager,
        );
      }),
    );
    return this.get(principal, workflowId);
  }

  /** Makes a valid version the one runs use. */
  async publish(
    principal: AccessPrincipal,
    workflowId: string,
    input: PublishWorkflowDto,
  ): Promise<WorkflowDto> {
    await this.dataSource.transaction(async (manager) => {
      const workflow = await this.lock(manager, principal.organizationId, workflowId);
      const versionNumber = input.version ?? workflow.currentVersion;
      const version = await this.requireVersion(workflow, versionNumber, manager);
      if (!version.valid) {
        throw new AppException(
          ErrorCode.WORKFLOW_INVALID,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            message: 'Only a valid version can be published.',
            details: { errors: version.validation.errors?.slice(0, 20) ?? [] },
          },
        );
      }
      // Re-checked now: an agent or tool may have gone since the version was saved.
      const report = await this.validate(principal, version.graph);
      if (!report.valid) {
        throw new AppException(
          ErrorCode.WORKFLOW_INVALID,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            details: { errors: report.errors.slice(0, 20) },
          },
        );
      }
      await manager.getRepository(Workflow).update(
        { id: workflow.id },
        {
          status: WorkflowStatus.ACTIVE,
          publishedVersion: versionNumber,
          publishedAt: new Date(),
          publishedById: principal.userId ?? null,
        },
      );
      await this.auditService.record(
        {
          action: AuditAction.WORKFLOW_PUBLISHED,
          organizationId: principal.organizationId,
          resourceType: 'workflow',
          resourceId: workflow.id,
          resourceLabel: workflow.name,
          metadata: {
            version: versionNumber,
            previousVersion: workflow.publishedVersion,
            digest: version.digest,
            stepBound: report.compiled?.stepBound,
          },
        },
        manager,
      );
    });
    return this.get(principal, workflowId);
  }

  async archive(principal: AccessPrincipal, workflowId: string): Promise<WorkflowDto> {
    await this.dataSource.transaction(async (manager) => {
      const workflow = await this.lock(manager, principal.organizationId, workflowId);
      if (workflow.status === WorkflowStatus.ARCHIVED) return;
      await manager
        .getRepository(Workflow)
        .update({ id: workflow.id }, { status: WorkflowStatus.ARCHIVED });
      await this.auditService.record(
        {
          action: AuditAction.WORKFLOW_ARCHIVED,
          organizationId: principal.organizationId,
          resourceType: 'workflow',
          resourceId: workflow.id,
          resourceLabel: workflow.name,
          metadata: { publishedVersion: workflow.publishedVersion },
        },
        manager,
      );
    });
    return this.get(principal, workflowId);
  }

  async restoreVersion(
    principal: AccessPrincipal,
    workflowId: string,
    versionNumber: number,
    changeNote?: string,
  ): Promise<WorkflowDto> {
    await this.load(principal.organizationId, workflowId);
    const source = await this.getVersionRow(
      principal.organizationId,
      workflowId,
      versionNumber,
    );
    const report = await this.validate(principal, source.graph);
    await this.dataSource.transaction(async (manager) => {
      const workflow = await this.lock(manager, principal.organizationId, workflowId);
      if (versionNumber === workflow.currentVersion) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            message: 'That version is already the current one.',
          },
        );
      }
      workflow.currentVersion += 1;
      await manager
        .getRepository(Workflow)
        .update({ id: workflow.id }, { currentVersion: workflow.currentVersion });
      await this.appendVersion(
        manager,
        workflow,
        workflow.currentVersion,
        source.graph,
        source.settings,
        report,
        {
          changeNote: changeNote ?? `Restored version ${versionNumber}.`,
          createdById: principal.userId ?? null,
          restoredFromVersion: versionNumber,
        },
      );
      await this.auditService.record(
        {
          action: AuditAction.WORKFLOW_VERSION_RESTORED,
          organizationId: principal.organizationId,
          resourceType: 'workflow',
          resourceId: workflow.id,
          resourceLabel: workflow.name,
          metadata: {
            toVersion: workflow.currentVersion,
            restoredFromVersion: versionNumber,
            digest: source.digest,
          },
        },
        manager,
      );
    });
    return this.get(principal, workflowId);
  }

  /** Soft-deletes the workflow; its active runs are cancelled. Run history remains. */
  async remove(principal: AccessPrincipal, workflowId: string): Promise<void> {
    const workflow = await this.load(principal.organizationId, workflowId);
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(Workflow).softDelete({ id: workflow.id });
      await this.auditService.record(
        {
          action: AuditAction.WORKFLOW_DELETED,
          organizationId: principal.organizationId,
          resourceType: 'workflow',
          resourceId: workflow.id,
          resourceLabel: workflow.name,
          metadata: {
            currentVersion: workflow.currentVersion,
            publishedVersion: workflow.publishedVersion,
          },
        },
        manager,
      );
    });
    const active: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM workflow_runs WHERE workflow_id = $1 AND status IN ($2, $3, $4)`,
      [workflow.id, RunStatus.QUEUED, RunStatus.RUNNING, RunStatus.WAITING_APPROVAL],
    );
    for (const run of active) await this.engine.cancelRun(run.id, principal.userId ?? null);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async load(organizationId: string, workflowId: string): Promise<Workflow> {
    if (!isUuid(workflowId)) throw new NotFoundError(ErrorCode.WORKFLOW_NOT_FOUND);
    const workflow = await this.workflows.findOne({
      where: { id: workflowId, organizationId },
    });
    if (!workflow) throw new NotFoundError(ErrorCode.WORKFLOW_NOT_FOUND);
    return workflow;
  }

  async getVersionRow(
    organizationId: string,
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersion> {
    const row = await this.versions.findOne({
      where: { workflowId, version, organizationId },
    });
    if (!row) throw new NotFoundError(ErrorCode.WORKFLOW_VERSION_NOT_FOUND);
    return row;
  }

  private async lock(
    manager: EntityManager,
    organizationId: string,
    workflowId: string,
  ): Promise<Workflow> {
    const workflow = await manager
      .getRepository(Workflow)
      .createQueryBuilder('workflow')
      .setLock('pessimistic_write')
      .where('workflow.id = :workflowId AND workflow.organization_id = :organizationId', {
        workflowId,
        organizationId,
      })
      .getOne();
    if (!workflow) throw new NotFoundError(ErrorCode.WORKFLOW_NOT_FOUND);
    return workflow;
  }

  private async requireVersion(
    workflow: Workflow,
    version: number,
    manager?: EntityManager,
  ): Promise<WorkflowVersion> {
    const repository = manager ? manager.getRepository(WorkflowVersion) : this.versions;
    const row = await repository.findOne({ where: { workflowId: workflow.id, version } });
    if (!row) throw new NotFoundError(ErrorCode.WORKFLOW_VERSION_NOT_FOUND);
    return row;
  }

  private async appendVersion(
    manager: EntityManager,
    workflow: Workflow,
    version: number,
    graph: unknown,
    settings: WorkflowSettings,
    report: GraphReport,
    meta: {
      changeNote: string | null;
      createdById: string | null;
      restoredFromVersion?: number;
    },
  ): Promise<WorkflowVersion> {
    const stored = (report.normalized ?? graph) as WorkflowGraph;
    return manager.getRepository(WorkflowVersion).save(
      manager.getRepository(WorkflowVersion).create({
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        version,
        graph: stored,
        settings,
        digest: definitionDigest(stored, settings),
        valid: report.valid,
        validation: {
          errors: report.errors.slice(0, 100),
          warnings: report.warnings.slice(0, 100),
          ...(report.compiled ? { stepBound: report.compiled.stepBound } : {}),
        },
        changeNote: meta.changeNote,
        restoredFromVersion: meta.restoredFromVersion ?? null,
        createdById: meta.createdById,
      }),
    );
  }

  resolveSettings(input: WorkflowSettingsDto | undefined): WorkflowSettings {
    if (!input) return {};
    const settings: WorkflowSettings = {};
    if (input.maxSteps !== undefined)
      settings.maxSteps = Math.min(input.maxSteps, this.config.maxSteps);
    if (input.maxTokens !== undefined)
      settings.maxTokens = Math.min(input.maxTokens, this.config.maxTokensPerRun);
    if (input.runTimeoutMs !== undefined) {
      settings.runTimeoutMs = Math.min(input.runTimeoutMs, this.config.runTimeoutMs);
    }
    return settings;
  }

  private async withNameGuard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code =
        (error as { driverError?: { code?: string } }).driverError?.code ??
        (error as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION)
        throw new ConflictError(ErrorCode.WORKFLOW_NAME_TAKEN);
      throw error;
    }
  }

  toSummary(workflow: Workflow): WorkflowSummaryDto {
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      currentVersion: workflow.currentVersion,
      publishedVersion: workflow.publishedVersion,
      createdById: workflow.createdById,
      publishedAt: workflow.publishedAt,
      lastRunAt: workflow.lastRunAt,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
  }

  private toVersionDto(workflow: Workflow, version: WorkflowVersion): WorkflowVersionDto {
    return {
      version: version.version,
      graph: version.graph as unknown as Record<string, unknown>,
      settings: version.settings,
      digest: version.digest,
      valid: version.valid,
      validation: toReportDto(version),
      changeNote: version.changeNote,
      restoredFromVersion: version.restoredFromVersion,
      createdById: version.createdById,
      createdAt: version.createdAt,
      isCurrent: version.version === workflow.currentVersion,
      isPublished: version.version === workflow.publishedVersion,
    };
  }
}

export function definitionDigest(graph: unknown, settings: WorkflowSettings): string {
  return createHash('sha256').update(stableStringify({ graph, settings })).digest('hex');
}

function toReportDto(version: WorkflowVersion): ValidationReportDto {
  return {
    valid: version.valid,
    errors: version.validation.errors ?? [],
    warnings: version.validation.warnings ?? [],
    stepBound: version.validation.stepBound ?? null,
  };
}

function shapeOf(report: GraphReport): Record<string, unknown> {
  const compiled = report.compiled;
  if (!compiled) return {};
  const byType: Record<string, number> = {};
  for (const node of compiled.nodes.values())
    byType[node.type] = (byType[node.type] ?? 0) + 1;
  return {
    nodes: compiled.nodes.size,
    nodeTypes: byType,
    loops: compiled.loops.length,
    stepBound: compiled.stepBound,
  };
}
