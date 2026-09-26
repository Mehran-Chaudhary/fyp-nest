import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
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
import { AGENTS_CONFIG_KEY, type AgentsConfig } from '../../config/agents.config';
import { RAG_CONFIG_KEY, type RagConfig } from '../../config/rag.config';
import { TOOLS_CONFIG_KEY, type ToolsConfig } from '../../config/tools.config';
import { hasPermission } from '../../common/utils/permission.util';
import { PermissionDeniedError } from '../../common/exceptions/app.exception';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { EncryptionService } from '../../shared/crypto/encryption.service';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { KnowledgeBaseAccessService } from '../knowledge/knowledge-bases/knowledge-base-access.service';
import { LlmPolicyService } from '../llm/llm-policy.service';
import { Role } from '../rbac/entities/role.entity';
import { canManageAgents, canSeeAgent, type AgentViewer } from './domain/agent-access';
import {
  AgentAccessMode,
  AgentVisibility,
  applyConfigPatch,
  configDigest,
  defaultAgentConfig,
  normalizeAgentConfig,
  toolsOf,
  type AgentConfig,
  type AgentConfigPatch,
} from './domain/agent-config';
import type {
  AgentConfigViewDto,
  AgentDto,
  AgentSummaryDto,
  AgentVersionDto,
  CreateAgentDto,
  ListAgentsQueryDto,
  RestoreVersionDto,
  UpdateAgentDto,
} from './dto/agent.dto';
import { AgentVersion } from './entities/agent-version.entity';
import { Agent } from './entities/agent.entity';

const PG_UNIQUE_VIOLATION = '23505';

/** An agent ready to answer: its current version, with the instructions decrypted. */
export interface ExecutableAgent {
  agent: Agent;
  version: AgentVersion;
  config: AgentConfig;
  instructions: string;
}

/**
 * Agents and their versions (proposal module 6.8, the Agent Builder and
 * Persona Engine).
 *
 * ## Versions are append-only
 *
 * A change to anything that affects behaviour — persona, instructions, model,
 * parameters, retrieval, memory — creates a new immutable version. Rolling back
 * creates another, copying an old one. Identity (name, description) and access
 * (publication, allowed roles) are edited in place and audited, because they
 * say who may use the agent, not what it does.
 *
 * ## Editors change only what they can see
 *
 * An agent's knowledge bases may include a compartment the current editor
 * cannot read — the HR manager attached HR; the administrator editing the
 * agent's tone cannot see HR. Such a base is hidden from the editor (it is
 * neither listed nor counted by name) and preserved on save. Adding a base
 * requires being able to read it: a compartment's id is not something one can
 * attach by guessing.
 */
@Injectable()
export class AgentsService {
  private readonly agentsConfig: AgentsConfig;
  private readonly ragConfig: RagConfig;
  private readonly toolsConfig: ToolsConfig;

  constructor(
    @InjectRepository(Agent) private readonly agentRepository: Repository<Agent>,
    @InjectRepository(AgentVersion)
    private readonly versionRepository: Repository<AgentVersion>,
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly knowledgeAccess: KnowledgeBaseAccessService,
    private readonly llmPolicies: LlmPolicyService,
    private readonly auditService: AuditService,
    private readonly tools: ToolRegistryService,
    configService: ConfigService,
  ) {
    this.agentsConfig = configService.getOrThrow<AgentsConfig>(AGENTS_CONFIG_KEY);
    this.ragConfig = configService.getOrThrow<RagConfig>(RAG_CONFIG_KEY);
    this.toolsConfig = configService.getOrThrow<ToolsConfig>(TOOLS_CONFIG_KEY);
  }

  // ── Viewers ───────────────────────────────────────────────────────────────

  async viewerFor(principal: AccessPrincipal): Promise<AgentViewer> {
    let roleIds: string[] = [];
    if (principal.kind === 'user' && principal.membershipId) {
      const rows: Array<{ role_id: string }> = await this.dataSource.query(
        `SELECT mr.role_id FROM member_roles mr
           JOIN roles r ON r.id = mr.role_id AND r.deleted_at IS NULL
          WHERE mr.member_id = $1`,
        [principal.membershipId],
      );
      roleIds = rows.map((row) => row.role_id);
    }
    return {
      kind: principal.kind,
      userId: principal.userId,
      permissions: principal.permissions,
      roleIds: new Set(roleIds),
    };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(
    principal: AccessPrincipal,
    query: ListAgentsQueryDto,
  ): Promise<PaginatedResult<AgentSummaryDto>> {
    const viewer = await this.viewerFor(principal);
    const builder = this.agentRepository
      .createQueryBuilder('agent')
      .leftJoinAndSelect('agent.allowedRoles', 'role')
      .where('agent.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });

    if (!canManageAgents(viewer) && !principal.permissions.includes('*:*')) {
      // The same rule as `canSeeAgent`, in SQL, so paging counts are right.
      builder.andWhere(
        `(
           (:userId::uuid IS NOT NULL AND agent.created_by_id = :userId::uuid)
           OR (agent.visibility = 'WORKSPACE' AND (
                 agent.access_mode = 'WORKSPACE'
                 OR (:isUser AND EXISTS (
                       SELECT 1 FROM agent_allowed_roles ar
                        WHERE ar.agent_id = agent.id AND ar.role_id = ANY(:roleIds::uuid[])))
               ))
         )`,
        {
          userId: principal.kind === 'user' ? (principal.userId ?? null) : null,
          isUser: principal.kind === 'user',
          roleIds: [...viewer.roleIds],
        },
      );
    }

    if (query.visibility) {
      builder.andWhere('agent.visibility = :visibility', { visibility: query.visibility });
    }
    if (query.search) {
      builder.andWhere('agent.name ILIKE :search', {
        search: `%${escapeLike(query.search)}%`,
      });
    }

    const [agents, total] = await builder
      .orderBy('agent.name', 'ASC')
      .addOrderBy('agent.id', 'ASC')
      .skip((query.page - 1) * query.take)
      .take(query.take)
      .getManyAndCount();

    const versions = await this.currentVersions(agents);
    return {
      items: agents.map((agent) =>
        this.toSummary(agent, versions.get(agent.id)?.config ?? null, viewer),
      ),
      meta: buildPaginationMeta(total, query.page, query.take),
    };
  }

  async get(principal: AccessPrincipal, agentId: string): Promise<AgentDto> {
    const { agent, viewer } = await this.loadVisible(principal, agentId);
    const version = await this.requireVersion(agent, agent.currentVersion);
    return this.toDto(principal, agent, version, viewer);
  }

  async listVersions(
    principal: AccessPrincipal,
    agentId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<AgentVersionDto>> {
    const { agent } = await this.loadVisible(principal, agentId);
    const [versions, total] = await this.versionRepository.findAndCount({
      where: { agentId: agent.id, organizationId: principal.organizationId },
      order: { version: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const visible = await this.visibleKnowledgeBases(principal);
    return {
      items: versions.map((version) => this.toVersionDto(agent, version, visible)),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async getVersion(
    principal: AccessPrincipal,
    agentId: string,
    versionNumber: number,
  ): Promise<AgentVersionDto> {
    const { agent } = await this.loadVisible(principal, agentId);
    const version = await this.requireVersion(agent, versionNumber);
    return this.toVersionDto(agent, version, await this.visibleKnowledgeBases(principal));
  }

  /**
   * The agent a turn will run: visible to the caller, not deleted, with its
   * current version. A conversation whose agent was deleted is 409, not 404 —
   * the conversation is still there to read.
   */
  async resolveForExecution(
    principal: AccessPrincipal,
    agentId: string,
  ): Promise<ExecutableAgent> {
    const agent = await this.agentRepository.findOne({
      where: { id: agentId, organizationId: principal.organizationId },
      relations: { allowedRoles: true },
      withDeleted: true,
    });
    if (!agent) throw new NotFoundError(ErrorCode.AGENT_NOT_FOUND);
    if (agent.deletedAt) {
      throw new ConflictError(ErrorCode.AGENT_UNAVAILABLE);
    }

    const viewer = await this.viewerFor(principal);
    if (!canSeeAgent(this.accessFacts(agent), viewer)) {
      throw new NotFoundError(ErrorCode.AGENT_NOT_FOUND);
    }

    const version = await this.requireVersion(agent, agent.currentVersion);
    return {
      agent,
      version,
      config: version.config,
      instructions: this.openInstructions(agent.id, version),
    };
  }

  /** Records use, for the builder's "last used" column. Best effort. */
  async touch(agentId: string): Promise<void> {
    await this.agentRepository
      .update({ id: agentId }, { lastUsedAt: new Date() })
      .catch(() => undefined);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(principal: AccessPrincipal, input: CreateAgentDto): Promise<AgentDto> {
    const config = applyConfigPatch(
      this.defaults(),
      toPatch(input),
      this.toolsConfig.defaultIterations,
    );
    const instructions = input.instructions ?? '';

    await this.assertKnowledgeBasesReadable(principal, config.retrieval.knowledgeBaseIds);
    await this.assertToolsGrantable(principal, toolsOf(config).toolIds);
    this.assertIterations(toolsOf(config).maxIterations);
    await this.assertModelAllowed(principal.organizationId, config.model);
    const roles = await this.loadRoles(
      principal.organizationId,
      input.allowedRoleIds ?? [],
    );

    const saved = await this.withNameGuard(() =>
      this.dataSource.transaction(async (manager) => {
        const agent = await manager.getRepository(Agent).save(
          manager.getRepository(Agent).create({
            organizationId: principal.organizationId,
            name: input.name,
            description: input.description ?? null,
            visibility: AgentVisibility.PRIVATE,
            accessMode: input.accessMode ?? AgentAccessMode.WORKSPACE,
            allowedRoles: roles,
            currentVersion: 1,
            createdById: principal.userId ?? null,
          }),
        );

        await this.appendVersion(manager, agent, 1, config, instructions, {
          changeNote: 'Created.',
          createdById: principal.userId ?? null,
        });

        await this.auditService.record(
          {
            action: AuditAction.AGENT_CREATED,
            organizationId: principal.organizationId,
            resourceType: 'agent',
            resourceId: agent.id,
            resourceLabel: agent.name,
            metadata: {
              version: 1,
              model: config.model,
              knowledgeBases: config.retrieval.knowledgeBaseIds.length,
              tools: toolsOf(config).toolIds,
              accessMode: agent.accessMode,
              allowedRoles: roles.length,
            },
          },
          manager,
        );

        return agent;
      }),
    );

    return this.get(principal, saved.id);
  }

  async update(
    principal: AccessPrincipal,
    agentId: string,
    input: UpdateAgentDto,
  ): Promise<AgentDto> {
    await this.loadVisible(principal, agentId);
    const visible = await this.visibleKnowledgeBases(principal);

    const result = await this.withNameGuard(() =>
      this.dataSource.transaction(async (manager) => {
        const agent = await this.lockAgent(manager, principal.organizationId, agentId);
        if (
          input.expectedVersion !== undefined &&
          input.expectedVersion !== agent.currentVersion
        ) {
          throw new ConflictError(ErrorCode.AGENT_VERSION_CONFLICT, {
            details: {
              expectedVersion: input.expectedVersion,
              currentVersion: agent.currentVersion,
            },
          });
        }

        const current = await this.requireVersion(agent, agent.currentVersion, manager);
        const currentInstructions = this.openInstructions(agent.id, current);
        const patch = toPatch(input);

        // Knowledge bases: the editor's visible choice, plus whatever they cannot
        // see. Every id the editor names must be one they can read — even one
        // already attached: naming a hidden compartment's id is a probe.
        if (patch.retrieval?.knowledgeBaseIds !== undefined) {
          const hidden = current.config.retrieval.knowledgeBaseIds.filter(
            (id) => !visible.has(id),
          );
          await this.assertKnowledgeBasesReadable(
            principal,
            patch.retrieval.knowledgeBaseIds,
          );
          patch.retrieval.knowledgeBaseIds = [
            ...patch.retrieval.knowledgeBaseIds,
            ...hidden,
          ];
        }

        const nextConfig = applyConfigPatch(
          current.config,
          patch,
          this.toolsConfig.defaultIterations,
        );
        const nextInstructions = input.instructions ?? currentInstructions;
        if (nextConfig.model !== current.config.model) {
          await this.assertModelAllowed(principal.organizationId, nextConfig.model);
        }
        if (patch.tools !== undefined) {
          // Only newly granted tools are checked: a tool deleted since it was
          // granted must not block an unrelated edit.
          const before = new Set(toolsOf(current.config).toolIds);
          await this.assertToolsGrantable(
            principal,
            toolsOf(nextConfig).toolIds.filter((id) => !before.has(id)),
          );
          this.assertIterations(toolsOf(nextConfig).maxIterations);
        }

        const changedSections = diffSections(
          normalizeAgentConfig(current.config, this.toolsConfig.defaultIterations),
          nextConfig,
          currentInstructions !== nextInstructions,
        );
        const fromVersion = agent.currentVersion;

        if (changedSections.length > 0) {
          agent.currentVersion += 1;
          await this.appendVersion(
            manager,
            agent,
            agent.currentVersion,
            nextConfig,
            nextInstructions,
            {
              changeNote: input.changeNote ?? null,
              createdById: principal.userId ?? null,
            },
          );
        }

        // Identity.
        const renamed = input.name !== undefined && input.name !== agent.name;
        if (input.name !== undefined) agent.name = input.name;
        if (input.description !== undefined) agent.description = input.description;

        // Access.
        const accessBefore = {
          accessMode: agent.accessMode,
          allowedRoleIds: (agent.allowedRoles ?? []).map((role) => role.id).sort(),
        };
        if (input.accessMode !== undefined) agent.accessMode = input.accessMode;
        if (input.allowedRoleIds !== undefined) {
          agent.allowedRoles = await this.loadRoles(
            principal.organizationId,
            input.allowedRoleIds,
            manager,
          );
        }
        const accessAfter = {
          accessMode: agent.accessMode,
          allowedRoleIds: (agent.allowedRoles ?? []).map((role) => role.id).sort(),
        };

        await manager.getRepository(Agent).save(agent);

        if (changedSections.length > 0 || renamed || input.description !== undefined) {
          await this.auditService.record(
            {
              action: AuditAction.AGENT_UPDATED,
              organizationId: principal.organizationId,
              resourceType: 'agent',
              resourceId: agent.id,
              resourceLabel: agent.name,
              metadata: {
                fromVersion,
                toVersion: agent.currentVersion,
                changedSections,
                renamed: renamed || undefined,
                changeNote: input.changeNote,
              },
            },
            manager,
          );
        }

        if (JSON.stringify(accessBefore) !== JSON.stringify(accessAfter)) {
          await this.auditService.record(
            {
              action: AuditAction.AGENT_ACCESS_UPDATED,
              organizationId: principal.organizationId,
              resourceType: 'agent',
              resourceId: agent.id,
              resourceLabel: agent.name,
              metadata: { before: accessBefore, after: accessAfter },
            },
            manager,
          );
        }

        return agent;
      }),
    );

    return this.get(principal, result.id);
  }

  async restoreVersion(
    principal: AccessPrincipal,
    agentId: string,
    versionNumber: number,
    input: RestoreVersionDto,
  ): Promise<AgentDto> {
    await this.loadVisible(principal, agentId);

    await this.dataSource.transaction(async (manager) => {
      const agent = await this.lockAgent(manager, principal.organizationId, agentId);
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== agent.currentVersion
      ) {
        throw new ConflictError(ErrorCode.AGENT_VERSION_CONFLICT, {
          details: {
            expectedVersion: input.expectedVersion,
            currentVersion: agent.currentVersion,
          },
        });
      }
      if (versionNumber === agent.currentVersion) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            message: 'That version is already the current one.',
          },
        );
      }

      const source = await this.requireVersion(agent, versionNumber, manager);
      const instructions = this.openInstructions(agent.id, source);
      await this.assertModelAllowed(principal.organizationId, source.config.model);

      const fromVersion = agent.currentVersion;
      agent.currentVersion += 1;
      await this.appendVersion(
        manager,
        agent,
        agent.currentVersion,
        source.config,
        instructions,
        {
          changeNote: input.changeNote ?? `Restored version ${versionNumber}.`,
          createdById: principal.userId ?? null,
          restoredFromVersion: versionNumber,
        },
      );
      await manager
        .getRepository(Agent)
        .update({ id: agent.id }, { currentVersion: agent.currentVersion });

      await this.auditService.record(
        {
          action: AuditAction.AGENT_VERSION_RESTORED,
          organizationId: principal.organizationId,
          resourceType: 'agent',
          resourceId: agent.id,
          resourceLabel: agent.name,
          metadata: {
            fromVersion,
            toVersion: agent.currentVersion,
            restoredFromVersion: versionNumber,
            configDigest: source.configDigest,
          },
        },
        manager,
      );
    });

    return this.get(principal, agentId);
  }

  async setPublished(
    principal: AccessPrincipal,
    agentId: string,
    published: boolean,
  ): Promise<AgentDto> {
    const { agent } = await this.loadVisible(principal, agentId);
    const target = published ? AgentVisibility.WORKSPACE : AgentVisibility.PRIVATE;

    if (agent.visibility !== target) {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(Agent).update(
          { id: agent.id },
          {
            visibility: target,
            publishedAt: published ? new Date() : null,
            publishedById: published ? (principal.userId ?? null) : null,
          },
        );
        await this.auditService.record(
          {
            action: published ? AuditAction.AGENT_PUBLISHED : AuditAction.AGENT_UNPUBLISHED,
            organizationId: principal.organizationId,
            resourceType: 'agent',
            resourceId: agent.id,
            resourceLabel: agent.name,
            metadata: { version: agent.currentVersion, accessMode: agent.accessMode },
          },
          manager,
        );
      });
    }

    return this.get(principal, agentId);
  }

  /**
   * Soft-deletes the agent. Its conversations stay readable — they are the
   * members' records — but no new turn can run.
   */
  async remove(principal: AccessPrincipal, agentId: string): Promise<void> {
    const { agent } = await this.loadVisible(principal, agentId);
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(Agent).softDelete({ id: agent.id });
      await this.auditService.record(
        {
          action: AuditAction.AGENT_DELETED,
          organizationId: principal.organizationId,
          resourceType: 'agent',
          resourceId: agent.id,
          resourceLabel: agent.name,
          metadata: { version: agent.currentVersion },
        },
        manager,
      );
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private defaults(): AgentConfig {
    return defaultAgentConfig({
      retrievalTopK: this.ragConfig.defaultTopK,
      maxContextTokens: this.agentsConfig.retrieval.defaultMaxContextTokens,
      memoryMaxMessages: this.agentsConfig.memory.defaultMaxMessages,
      memoryMaxHistoryTokens: this.agentsConfig.memory.defaultMaxHistoryTokens,
      toolIterations: this.toolsConfig.defaultIterations,
    });
  }

  /**
   * Checks tools an editor grants: they must be able to see the tool catalogue,
   * and each tool must exist and be enabled. A grant confers nothing by itself —
   * each user's own `tool:execute` is checked when the agent runs.
   */
  private async assertToolsGrantable(
    principal: AccessPrincipal,
    toolIds: readonly string[],
  ): Promise<void> {
    if (toolIds.length === 0) return;
    if (!hasPermission(principal.permissions, 'tool:read')) {
      throw new PermissionDeniedError(['tool:read'], {
        message: 'Granting tools to an agent requires tool:read.',
      });
    }
    await this.tools.assertGrantable(principal.organizationId, toolIds);
  }

  private assertIterations(maxIterations: number): void {
    if (maxIterations > this.toolsConfig.maxIterations) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, {
        message: `tools.maxIterations cannot exceed ${this.toolsConfig.maxIterations} (TOOL_MAX_ITERATIONS).`,
      });
    }
  }

  private async loadVisible(
    principal: AccessPrincipal,
    agentId: string,
  ): Promise<{ agent: Agent; viewer: AgentViewer }> {
    const agent = await this.agentRepository.findOne({
      where: { id: agentId, organizationId: principal.organizationId },
      relations: { allowedRoles: true },
    });
    const viewer = await this.viewerFor(principal);
    if (!agent || !canSeeAgent(this.accessFacts(agent), viewer)) {
      throw new NotFoundError(ErrorCode.AGENT_NOT_FOUND);
    }
    return { agent, viewer };
  }

  private async lockAgent(
    manager: EntityManager,
    organizationId: string,
    agentId: string,
  ): Promise<Agent> {
    // Lock the row first, then load the relation: FOR UPDATE cannot apply to
    // the nullable side of an outer join.
    const locked = await manager
      .getRepository(Agent)
      .createQueryBuilder('agent')
      .setLock('pessimistic_write')
      .where('agent.id = :agentId AND agent.organization_id = :organizationId', {
        agentId,
        organizationId,
      })
      .getOne();
    if (!locked) throw new NotFoundError(ErrorCode.AGENT_NOT_FOUND);

    const withRoles = await manager.getRepository(Agent).findOne({
      where: { id: locked.id },
      relations: { allowedRoles: true },
    });
    return withRoles ?? locked;
  }

  private accessFacts(agent: Agent) {
    return {
      visibility: agent.visibility,
      accessMode: agent.accessMode,
      allowedRoleIds: (agent.allowedRoles ?? []).map((role) => role.id),
      createdById: agent.createdById,
    };
  }

  private async requireVersion(
    agent: Agent,
    versionNumber: number,
    manager?: EntityManager,
  ): Promise<AgentVersion> {
    const repository = manager
      ? manager.getRepository(AgentVersion)
      : this.versionRepository;
    const version = await repository.findOne({
      where: { agentId: agent.id, version: versionNumber },
    });
    if (!version) throw new NotFoundError(ErrorCode.AGENT_VERSION_NOT_FOUND);
    return version;
  }

  private async currentVersions(agents: Agent[]): Promise<Map<string, AgentVersion>> {
    if (agents.length === 0) return new Map();
    const versions = await this.versionRepository
      .createQueryBuilder('version')
      .innerJoin(
        Agent,
        'agent',
        'agent.id = version.agent_id AND agent.current_version = version.version',
      )
      .where('version.agent_id IN (:...ids)', { ids: agents.map((agent) => agent.id) })
      .getMany();
    return new Map(versions.map((version) => [version.agentId, version]));
  }

  private async appendVersion(
    manager: EntityManager,
    agent: Agent,
    versionNumber: number,
    config: AgentConfig,
    instructions: string,
    meta: {
      changeNote: string | null;
      createdById: string | null;
      restoredFromVersion?: number;
    },
  ): Promise<AgentVersion> {
    return manager.getRepository(AgentVersion).save(
      manager.getRepository(AgentVersion).create({
        organizationId: agent.organizationId,
        agentId: agent.id,
        version: versionNumber,
        config,
        instructionsCiphertext: this.encryption.encrypt(
          instructions,
          instructionsBinding(agent.id, versionNumber),
        ),
        configDigest: configDigest(config, instructions),
        changeNote: meta.changeNote,
        restoredFromVersion: meta.restoredFromVersion ?? null,
        createdById: meta.createdById,
      }),
    );
  }

  private openInstructions(agentId: string, version: AgentVersion): string {
    return this.encryption.decrypt(
      version.instructionsCiphertext,
      instructionsBinding(agentId, version.version),
    );
  }

  private async visibleKnowledgeBases(
    principal: AccessPrincipal,
  ): Promise<ReadonlySet<string>> {
    const scope = await this.knowledgeAccess.resolveScope(principal);
    return new Set(scope.knowledgeBases.keys());
  }

  private async assertKnowledgeBasesReadable(
    principal: AccessPrincipal,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const scope = await this.knowledgeAccess.resolveScope(principal);
    for (const id of ids) {
      if (!scope.knowledgeBases.has(id)) {
        await this.knowledgeAccess.recordHiddenProbe(principal, 'knowledge_base', id);
        throw new NotFoundError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, {
          details: { knowledgeBaseId: id },
        });
      }
    }
  }

  private async assertModelAllowed(
    organizationId: string,
    model: string | null,
  ): Promise<void> {
    if (!model) return;
    const policy = await this.llmPolicies.getEffective(organizationId);
    if (!this.llmPolicies.isAllowed(policy, model)) {
      throw new AppException(
        ErrorCode.LLM_MODEL_NOT_ALLOWED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          details: { model },
        },
      );
    }
  }

  private async loadRoles(
    organizationId: string,
    ids: readonly string[],
    manager?: EntityManager,
  ): Promise<Role[]> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const repository = manager
      ? manager.getRepository(Role)
      : this.dataSource.getRepository(Role);
    const roles = await repository.find({ where: { id: In(unique), organizationId } });
    if (roles.length !== unique.length) {
      const found = new Set(roles.map((role) => role.id));
      throw new NotFoundError(ErrorCode.ROLE_NOT_FOUND, {
        details: { roleIds: unique.filter((id) => !found.has(id)) },
      });
    }
    return roles;
  }

  private async withNameGuard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code =
        (error as { code?: string; driverError?: { code?: string } }).driverError?.code ??
        (error as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) throw new ConflictError(ErrorCode.AGENT_NAME_TAKEN);
      throw error;
    }
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private toSummary(
    agent: Agent,
    config: AgentConfig | null,
    viewer: AgentViewer,
  ): AgentSummaryDto {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      visibility: agent.visibility,
      accessMode: agent.accessMode,
      currentVersion: agent.currentVersion,
      model: config?.model ?? null,
      role: config?.persona.role ?? null,
      greeting: config?.persona.greeting ?? null,
      knowledgeBaseCount: config?.retrieval.knowledgeBaseIds.length ?? 0,
      createdById: agent.createdById,
      publishedAt: agent.publishedAt,
      lastUsedAt: agent.lastUsedAt,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      canEdit: canManageAgents(viewer),
    };
  }

  private async toDto(
    principal: AccessPrincipal,
    agent: Agent,
    version: AgentVersion,
    viewer: AgentViewer,
  ): Promise<AgentDto> {
    const visible = await this.visibleKnowledgeBases(principal);
    return {
      ...this.toSummary(agent, version.config, viewer),
      config: configView(version.config, visible),
      instructions: this.openInstructions(agent.id, version),
      allowedRoleIds: (agent.allowedRoles ?? []).map((role) => role.id).sort(),
    };
  }

  private toVersionDto(
    agent: Agent,
    version: AgentVersion,
    visible: ReadonlySet<string>,
  ): AgentVersionDto {
    return {
      version: version.version,
      config: configView(version.config, visible),
      instructions: this.openInstructions(agent.id, version),
      configDigest: version.configDigest,
      changeNote: version.changeNote,
      restoredFromVersion: version.restoredFromVersion,
      createdById: version.createdById,
      createdAt: version.createdAt,
      isCurrent: version.version === agent.currentVersion,
    };
  }
}

/** Associated data binding a version's instructions to that agent and version. */
function instructionsBinding(agentId: string, version: number): string {
  return `agent:${agentId}:v${version}:instructions`;
}

function toPatch(input: CreateAgentDto | UpdateAgentDto): AgentConfigPatch {
  return {
    persona: input.persona,
    model: input.model,
    parameters: input.parameters ? { ...input.parameters } : undefined,
    contextWindow: input.contextWindow,
    retrieval: input.retrieval
      ? {
          ...input.retrieval,
          knowledgeBaseIds: input.retrieval.knowledgeBaseIds
            ? [...input.retrieval.knowledgeBaseIds]
            : undefined,
        }
      : undefined,
    memory: input.memory,
    grounding: input.grounding,
    citations: input.citations,
    tools: input.tools
      ? {
          ...(input.tools.toolIds ? { toolIds: [...input.tools.toolIds] } : {}),
          ...(input.tools.maxIterations !== undefined
            ? { maxIterations: input.tools.maxIterations }
            : {}),
        }
      : undefined,
  };
}

/** Which parts of an agent's behaviour differ between two versions. */
function diffSections(
  before: AgentConfig,
  after: AgentConfig,
  instructionsChanged: boolean,
): string[] {
  const sections = (Object.keys(after) as Array<keyof AgentConfig>).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return instructionsChanged ? ['instructions', ...sections] : sections;
}

/** The config as a viewer may see it: only the knowledge bases they can read are named. */
function configView(config: AgentConfig, visible: ReadonlySet<string>): AgentConfigViewDto {
  const shown = config.retrieval.knowledgeBaseIds.filter((id) => visible.has(id));
  return {
    persona: { ...config.persona },
    model: config.model,
    parameters: { ...config.parameters },
    contextWindow: config.contextWindow,
    retrieval: {
      ...config.retrieval,
      knowledgeBaseIds: shown,
      hiddenKnowledgeBases: config.retrieval.knowledgeBaseIds.length - shown.length,
    },
    memory: { ...config.memory },
    grounding: config.grounding,
    citations: config.citations,
    tools: { ...toolsOf(config) },
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
