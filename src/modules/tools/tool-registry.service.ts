import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
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
import { isUuid } from '../../common/utils/uuid.util';
import { TOOLS_CONFIG_KEY, type ToolsConfig } from '../../config/tools.config';
import { EncryptionService } from '../../shared/crypto/encryption.service';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { classificationRank } from '../knowledge/domain/classification';
import { BUILTIN_TOOLS, type BuiltinTool } from './builtins/builtin-tool';
import { isHostAllowed } from './domain/egress-guard';
import {
  defaultDataPolicy,
  Integrity,
  integrityRank,
  type ToolDataPolicy,
} from './domain/information-flow';
import type { JsonSchema, SchemaIssue } from './domain/json-schema';
import {
  builtinToolId,
  checkHttpDefinition,
  checkParameters,
  descriptorDigest,
  splitToolUrl,
  ToolKind,
  type HttpToolConfig,
  type ToolDescriptor,
} from './domain/tool-definition';
import type {
  CreateToolDto,
  ListToolsQueryDto,
  ToolDto,
  UpdateToolDto,
} from './dto/tool.dto';
import { Tool } from './entities/tool.entity';
import { HttpToolRunner } from './http/http-tool.runner';
import { definedOnly } from '../../common/utils/object.util';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * The tool catalogue: the platform's built-in tools and each workspace's own
 * HTTP tools (proposal module 6.11, "a registry of executable functions with
 * JSON Schema signatures").
 *
 * Defining a tool is a privileged act — it decides where data can be sent —
 * so `tool:create` and `tool:update` are dangerous permissions, every change is
 * audited with a digest of the new definition, and any setting that loosens a
 * tool's data policy below the safe default is recorded as a weakening, the
 * same way the PII policy records one.
 */
@Injectable()
export class ToolRegistryService {
  private readonly config: ToolsConfig;
  private readonly builtinsByName: Map<string, BuiltinTool>;
  private readonly builtinsById: Map<string, BuiltinTool>;

  constructor(
    @InjectRepository(Tool) private readonly toolRepository: Repository<Tool>,
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly auditService: AuditService,
    private readonly httpRunner: HttpToolRunner,
    @Inject(BUILTIN_TOOLS) builtins: BuiltinTool[],
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<ToolsConfig>(TOOLS_CONFIG_KEY);
    this.builtinsByName = new Map(builtins.map((tool) => [tool.definition.name, tool]));
    this.builtinsById = new Map(
      builtins.map((tool) => [builtinToolId(tool.definition.name), tool]),
    );
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  builtin(name: string): BuiltinTool | undefined {
    return this.builtinsByName.get(name);
  }

  // ── Descriptors ───────────────────────────────────────────────────────────

  builtinDescriptor(tool: BuiltinTool): ToolDescriptor {
    const definition = tool.definition;
    const base = {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      dataPolicy: definition.dataPolicy,
      requiresApproval: definition.requiresApproval,
      timeoutMs: definition.timeoutMs,
    };
    return {
      ...base,
      id: builtinToolId(definition.name),
      kind: ToolKind.BUILTIN,
      displayName: definition.displayName,
      resultIntegrity: definition.resultIntegrity,
      requiredPermissions: [...definition.requiredPermissions],
      maxCallsPerRun: definition.maxCallsPerRun,
      version: 1,
      digest: descriptorDigest(base),
      enabled:
        this.config.enabled && !this.config.disabledBuiltins.includes(definition.name),
    };
  }

  private customDescriptor(tool: Tool): ToolDescriptor {
    return {
      id: tool.id,
      kind: ToolKind.HTTP,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      parameters: tool.parameters,
      dataPolicy: tool.dataPolicy,
      resultIntegrity: Integrity.EXTERNAL,
      requiresApproval: tool.requiresApproval,
      requiredPermissions: [],
      timeoutMs: tool.timeoutMs,
      version: tool.version,
      digest: tool.definitionDigest,
      enabled: this.config.enabled && tool.enabled && !tool.deletedAt,
      http: tool.config,
    };
  }

  /** Whether a tool can run on this deployment right now (its dependencies exist). */
  isAvailable(descriptor: ToolDescriptor): boolean {
    if (descriptor.kind === ToolKind.HTTP) return this.httpRunner.isAvailable;
    return this.builtinsById.get(descriptor.id)?.isAvailable() ?? false;
  }

  /**
   * Descriptors for `ids` in a workspace. Missing and deleted ids are absent
   * from the map; disabled tools are present, marked disabled.
   */
  async resolveMany(
    organizationId: string,
    ids: readonly string[],
  ): Promise<Map<string, ToolDescriptor>> {
    const result = new Map<string, ToolDescriptor>();
    const customIds: string[] = [];
    for (const id of new Set(ids)) {
      const builtin = this.builtinsById.get(id);
      if (builtin) result.set(id, this.builtinDescriptor(builtin));
      else if (isUuid(id)) customIds.push(id);
    }
    if (customIds.length > 0) {
      const tools = await this.toolRepository.find({
        where: { id: In(customIds), organizationId },
      });
      for (const tool of tools) result.set(tool.id, this.customDescriptor(tool));
    }
    return result;
  }

  /** The decrypted credential of an HTTP tool, for the executor only. */
  async loadSecret(organizationId: string, toolId: string): Promise<string | null> {
    const row = await this.toolRepository
      .createQueryBuilder('tool')
      .addSelect('tool.secretCiphertext')
      .where('tool.id = :toolId AND tool.organization_id = :organizationId', {
        toolId,
        organizationId,
      })
      .getOne();
    if (!row?.secretCiphertext) return null;
    return this.encryption.decrypt(row.secretCiphertext, secretBinding(row.id));
  }

  /**
   * Checks tool ids an agent editor wants to grant: each must exist in the
   * workspace (or be a built-in) and be enabled. Unknown ids are 404, like
   * any other reference to something that is not there.
   */
  async assertGrantable(organizationId: string, ids: readonly string[]): Promise<void> {
    const resolved = await this.resolveMany(organizationId, ids);
    for (const id of ids) {
      const tool = resolved.get(id);
      if (!tool) {
        throw new NotFoundError(ErrorCode.TOOL_NOT_FOUND, { details: { toolId: id } });
      }
      if (!tool.enabled) {
        throw new ConflictError(ErrorCode.TOOL_DISABLED, { details: { toolId: id } });
      }
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(
    principal: AccessPrincipal,
    query: ListToolsQueryDto,
  ): Promise<PaginatedResult<ToolDto>> {
    const builtins =
      query.kind === ToolKind.HTTP
        ? []
        : [...this.builtinsByName.values()]
            .map((tool) => this.toDto(this.builtinDescriptor(tool)))
            .filter((tool) => matches(tool, query.search));

    const builder = this.toolRepository
      .createQueryBuilder('tool')
      .where('tool.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });
    if (query.search) {
      builder.andWhere('(tool.name ILIKE :search OR tool.display_name ILIKE :search)', {
        search: `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      });
    }
    const custom =
      query.kind === ToolKind.BUILTIN
        ? []
        : (await builder.orderBy('tool.name', 'ASC').getMany()).map((tool) =>
            this.toDto(this.customDescriptor(tool), tool),
          );

    // Built-ins are few and fixed, so the combined list pages in memory.
    const all = [...builtins, ...custom];
    const start = (query.page - 1) * query.take;
    return {
      items: all.slice(start, start + query.take),
      meta: buildPaginationMeta(all.length, query.page, query.take),
    };
  }

  async get(principal: AccessPrincipal, toolId: string): Promise<ToolDto> {
    const builtin = this.builtinsById.get(toolId);
    if (builtin) return this.toDto(this.builtinDescriptor(builtin));
    const tool = await this.loadCustom(principal.organizationId, toolId);
    return this.toDto(this.customDescriptor(tool), tool);
  }

  // ── Writes (custom HTTP tools) ────────────────────────────────────────────

  async create(principal: AccessPrincipal, input: CreateToolDto): Promise<ToolDto> {
    if (this.builtinsByName.has(input.name)) {
      throw new ConflictError(ErrorCode.TOOL_NAME_TAKEN, {
        message: `"${input.name}" is the name of a built-in tool.`,
      });
    }

    const http = normalizeHttp(input.http as HttpToolConfig);
    const parameters = input.parameters as JsonSchema;
    const dataPolicy = this.resolvePolicy(http, input.dataPolicy);
    const timeoutMs = this.resolveTimeout(input.timeoutMs);
    this.assertDefinition(http, parameters);

    const digest = descriptorDigest({
      name: input.name,
      description: input.description,
      parameters,
      dataPolicy,
      requiresApproval: input.requiresApproval ?? false,
      timeoutMs,
      http,
    });

    const saved = await this.withNameGuard(() =>
      this.dataSource.transaction(async (manager) => {
        const tool = await manager.getRepository(Tool).save(
          manager.getRepository(Tool).create({
            organizationId: principal.organizationId,
            name: input.name,
            displayName: input.displayName,
            description: input.description,
            kind: ToolKind.HTTP,
            parameters,
            config: http,
            dataPolicy,
            requiresApproval: input.requiresApproval ?? false,
            timeoutMs,
            enabled: input.enabled ?? true,
            version: 1,
            definitionDigest: digest,
            hasSecret: false,
            createdById: principal.userId ?? null,
            updatedById: principal.userId ?? null,
          }),
        );
        if (input.secret) {
          await manager.getRepository(Tool).update(
            { id: tool.id },
            {
              secretCiphertext: this.encryption.encrypt(
                input.secret,
                secretBinding(tool.id),
              ),
              hasSecret: true,
            },
          );
        }

        const weakened = weakenings(http, dataPolicy);
        await this.auditService.record(
          {
            action: AuditAction.TOOL_CREATED,
            organizationId: principal.organizationId,
            resourceType: 'tool',
            resourceId: tool.id,
            resourceLabel: tool.name,
            metadata: {
              version: 1,
              digest,
              method: http.method,
              origin: splitToolUrl(http.url).origin,
              dataPolicy,
              requiresApproval: tool.requiresApproval,
              hasSecret: Boolean(input.secret),
              weakened: weakened.length > 0,
              weakenings: weakened,
            },
          },
          manager,
        );
        return tool;
      }),
    );

    return this.get(principal, saved.id);
  }

  async update(
    principal: AccessPrincipal,
    toolId: string,
    input: UpdateToolDto,
  ): Promise<ToolDto> {
    if (this.builtinsById.has(toolId)) {
      throw new AppException(ErrorCode.TOOL_DEFINITION_INVALID, HttpStatus.CONFLICT, {
        message:
          'Built-in tools cannot be edited. Disable one with TOOLS_DISABLED_BUILTINS.',
      });
    }

    await this.dataSource.transaction(async (manager) => {
      const tool = await manager
        .getRepository(Tool)
        .createQueryBuilder('tool')
        .setLock('pessimistic_write')
        .where('tool.id = :toolId AND tool.organization_id = :organizationId', {
          toolId,
          organizationId: principal.organizationId,
        })
        .getOne();
      if (!tool) throw new NotFoundError(ErrorCode.TOOL_NOT_FOUND);
      if (input.expectedVersion !== undefined && input.expectedVersion !== tool.version) {
        throw new ConflictError(ErrorCode.RESOURCE_CONFLICT, {
          message:
            'The tool was changed by someone else. Reload it and apply your change again.',
          details: { expectedVersion: input.expectedVersion, currentVersion: tool.version },
        });
      }

      const http = input.http ? normalizeHttp(input.http as HttpToolConfig) : tool.config;
      const parameters = (input.parameters as JsonSchema | undefined) ?? tool.parameters;
      const dataPolicy = input.dataPolicy
        ? // Only the policy fields the client sent: the DTO instance carries the
          // others as `undefined`, and spreading it would reset them to defaults.
          this.resolvePolicy(http, { ...tool.dataPolicy, ...definedOnly(input.dataPolicy) })
        : input.http
          ? this.resolvePolicy(http, tool.dataPolicy)
          : tool.dataPolicy;
      const timeoutMs =
        input.timeoutMs !== undefined
          ? this.resolveTimeout(input.timeoutMs)
          : tool.timeoutMs;
      this.assertDefinition(http, parameters);

      const next = {
        name: tool.name,
        description: input.description ?? tool.description,
        parameters,
        dataPolicy,
        requiresApproval: input.requiresApproval ?? tool.requiresApproval,
        timeoutMs,
        http,
      };
      const digest = descriptorDigest(next);
      const behaviourChanged = digest !== tool.definitionDigest;
      const secretChanged = input.secret !== undefined;

      tool.displayName = input.displayName ?? tool.displayName;
      tool.description = next.description;
      tool.parameters = parameters;
      tool.config = http;
      tool.dataPolicy = dataPolicy;
      tool.requiresApproval = next.requiresApproval;
      tool.timeoutMs = timeoutMs;
      tool.enabled = input.enabled ?? tool.enabled;
      tool.definitionDigest = digest;
      tool.updatedById = principal.userId ?? null;
      if (behaviourChanged || secretChanged) tool.version += 1;

      await manager.getRepository(Tool).save(tool);
      if (secretChanged) {
        await manager.getRepository(Tool).update(
          { id: tool.id },
          input.secret
            ? {
                secretCiphertext: this.encryption.encrypt(
                  input.secret,
                  secretBinding(tool.id),
                ),
                hasSecret: true,
              }
            : { secretCiphertext: null, hasSecret: false },
        );
      }

      const weakened = weakenings(http, dataPolicy);
      await this.auditService.record(
        {
          action: AuditAction.TOOL_UPDATED,
          organizationId: principal.organizationId,
          resourceType: 'tool',
          resourceId: tool.id,
          resourceLabel: tool.name,
          metadata: {
            version: tool.version,
            digest,
            behaviourChanged,
            secretChanged,
            enabled: tool.enabled,
            dataPolicy,
            weakened: weakened.length > 0,
            weakenings: weakened,
          },
        },
        manager,
      );
    });

    return this.get(principal, toolId);
  }

  /**
   * Soft-deletes the tool and destroys its credential. Agents granted it stop
   * being offered it at once; the ledger keeps its history.
   */
  async remove(principal: AccessPrincipal, toolId: string): Promise<void> {
    const tool = await this.loadCustom(principal.organizationId, toolId);
    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(Tool)
        .update(
          { id: tool.id },
          { secretCiphertext: null, hasSecret: false, enabled: false },
        );
      await manager.getRepository(Tool).softDelete({ id: tool.id });
      await this.auditService.record(
        {
          action: AuditAction.TOOL_DELETED,
          organizationId: principal.organizationId,
          resourceType: 'tool',
          resourceId: tool.id,
          resourceLabel: tool.name,
          metadata: { version: tool.version, digest: tool.definitionDigest },
        },
        manager,
      );
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async loadCustom(organizationId: string, toolId: string): Promise<Tool> {
    if (!isUuid(toolId)) throw new NotFoundError(ErrorCode.TOOL_NOT_FOUND);
    const tool = await this.toolRepository.findOne({
      where: { id: toolId, organizationId },
    });
    if (!tool) throw new NotFoundError(ErrorCode.TOOL_NOT_FOUND);
    return tool;
  }

  private resolvePolicy(
    http: HttpToolConfig,
    requested: Partial<ToolDataPolicy> | undefined,
  ): ToolDataPolicy {
    const sideEffects = requested?.sideEffects ?? http.method !== 'GET';
    const defaults = defaultDataPolicy({ external: true, sideEffects });
    return {
      maxClassification: requested?.maxClassification ?? defaults.maxClassification,
      minIntegrity: requested?.minIntegrity ?? defaults.minIntegrity,
      piiArguments: requested?.piiArguments ?? defaults.piiArguments,
      sideEffects,
    };
  }

  private resolveTimeout(requested: number | undefined): number {
    return Math.min(requested ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs);
  }

  private assertDefinition(http: HttpToolConfig, parameters: JsonSchema): void {
    const issues: SchemaIssue[] = checkParameters(parameters).map((issue) => ({
      path: `/parameters${issue.path}`,
      message: issue.message,
    }));
    const check = checkHttpDefinition(http, parameters);
    issues.push(...check.issues);

    if (http.auth.type === 'header' && !http.auth.headerName) {
      issues.push({ path: '/http/auth/headerName', message: 'headerName is required.' });
    }
    if (http.auth.type === 'basic' && !http.auth.username) {
      issues.push({ path: '/http/auth/username', message: 'username is required.' });
    }
    if (check.origin) {
      const origin = new URL(check.origin);
      if (origin.protocol === 'http:' && !this.config.http.allowInsecure) {
        issues.push({ path: '/http/url', message: 'Only https:// URLs are permitted.' });
      }
      if (!isHostAllowed(origin, this.httpRunner.allowedHosts)) {
        issues.push({
          path: '/http/url',
          message:
            `${origin.host} is not on the platform egress allowlist (TOOL_HTTP_ALLOWED_HOSTS). ` +
            'Ask the platform operator to add it.',
        });
      }
    }

    if (issues.length > 0) {
      throw new AppException(
        ErrorCode.TOOL_DEFINITION_INVALID,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          details: { issues: issues.slice(0, 50) },
        },
      );
    }
  }

  private async withNameGuard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code =
        (error as { driverError?: { code?: string } }).driverError?.code ??
        (error as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) throw new ConflictError(ErrorCode.TOOL_NAME_TAKEN);
      throw error;
    }
  }

  toDto(descriptor: ToolDescriptor, row?: Tool): ToolDto {
    return {
      id: descriptor.id,
      kind: descriptor.kind,
      name: descriptor.name,
      displayName: descriptor.displayName,
      description: descriptor.description,
      parameters: descriptor.parameters as Record<string, unknown>,
      dataPolicy: { ...descriptor.dataPolicy },
      resultIntegrity: descriptor.resultIntegrity,
      requiresApproval: descriptor.requiresApproval,
      requiredPermissions: descriptor.requiredPermissions,
      timeoutMs: descriptor.timeoutMs,
      version: descriptor.version,
      digest: descriptor.digest,
      enabled: descriptor.enabled,
      available: this.isAvailable(descriptor),
      ...(descriptor.http ? { http: descriptor.http } : {}),
      ...(row
        ? { hasSecret: row.hasSecret, createdAt: row.createdAt, updatedAt: row.updatedAt }
        : {}),
    };
  }
}

/** Associated data binding an HTTP tool's credential to that tool. */
function secretBinding(toolId: string): string {
  return `tool:${toolId}:secret`;
}

function normalizeHttp(http: HttpToolConfig): HttpToolConfig {
  const { origin, path } = splitToolUrl(http.url.trim());
  const auth = http.auth ?? { type: 'none' };
  return {
    method: http.method,
    url: `${origin}${path}`,
    ...(http.query && Object.keys(http.query).length > 0 ? { query: http.query } : {}),
    ...(http.headers && Object.keys(http.headers).length > 0
      ? { headers: http.headers }
      : {}),
    ...(http.body !== undefined ? { body: http.body } : {}),
    auth:
      auth.type === 'header'
        ? { type: 'header', headerName: auth.headerName }
        : auth.type === 'basic'
          ? { type: 'basic', username: auth.username }
          : { type: auth.type },
    ...(http.responsePath ? { responsePath: http.responsePath } : {}),
  };
}

/** Where a policy is looser than the safe default for a tool that reaches a third party. */
function weakenings(http: HttpToolConfig, policy: ToolDataPolicy): string[] {
  const safe = defaultDataPolicy({ external: true, sideEffects: http.method !== 'GET' });
  const found: string[] = [];
  if (
    classificationRank(policy.maxClassification) >
    classificationRank(safe.maxClassification)
  ) {
    found.push(`maxClassification=${policy.maxClassification}`);
  }
  if (integrityRank(policy.minIntegrity) < integrityRank(safe.minIntegrity)) {
    found.push(`minIntegrity=${policy.minIntegrity}`);
  }
  if (policy.piiArguments === 'unmask') found.push('piiArguments=unmask');
  if (!policy.sideEffects && http.method !== 'GET') found.push('sideEffects=false');
  return found;
}

function matches(tool: ToolDto, search?: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return tool.name.includes(needle) || tool.displayName.toLowerCase().includes(needle);
}
