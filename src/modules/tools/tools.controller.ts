import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { SECURITY_SCHEME } from '../../common/constants/app.constants';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiPaginatedResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import { Auth, RequirePermissions } from '../../common/decorators/auth.decorators';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { PUBLIC_LABEL } from '../agents/domain/labels';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import { Integrity } from './domain/information-flow';
import {
  CreateToolDto,
  ListToolExecutionsQueryDto,
  ListToolsQueryDto,
  TestToolDto,
  ToolDto,
  ToolExecutionDto,
  ToolTestResultDto,
  UpdateToolDto,
} from './dto/tool.dto';
import { ToolExecution } from './entities/tool-execution.entity';
import { InMemoryToolBudget, ToolExecutorService } from './tool-executor.service';
import { ToolRegistryService } from './tool-registry.service';

/**
 * The Tool Execution Engine's catalogue and ledger (proposal module 6.11).
 */
@ApiTags('Tools')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId/tools', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class ToolsController {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly executor: ToolExecutorService,
    @InjectRepository(ToolExecution)
    private readonly ledger: Repository<ToolExecution>,
  ) {}

  @Get()
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('tool:read')
  @ApiOperation({
    summary: 'List tools',
    description:
      'Built-in tools (the same in every workspace) and this workspace’s HTTP tools, with ' +
      'their JSON Schemas, data policies and whether they can run on this deployment.',
  })
  @ApiPaginatedResponse(ToolDto)
  @ApiStandardErrors()
  list(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListToolsQueryDto,
  ): Promise<PaginatedResult<ToolDto>> {
    return this.registry.list(principal, query);
  }

  @Get('executions')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('tool:read', 'usage:read')
  @ApiOperation({
    summary: 'The tool ledger',
    description:
      'Every tool call in the workspace, including refused ones, newest first. Content-free: ' +
      'arguments are represented by a keyed digest, and results by their size.',
  })
  @ApiPaginatedResponse(ToolExecutionDto)
  @ApiStandardErrors()
  async executions(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListToolExecutionsQueryDto,
  ): Promise<PaginatedResult<ToolExecutionDto>> {
    const builder = this.ledger
      .createQueryBuilder('execution')
      .where('execution.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });
    if (query.toolId)
      builder.andWhere('execution.tool_id = :toolId', { toolId: query.toolId });
    if (query.runId) {
      builder.andWhere('execution.workflow_run_id = :runId', { runId: query.runId });
    }
    const [rows, total] = await builder
      .orderBy('execution.created_at', 'DESC')
      .skip(query.skip)
      .take(query.take)
      .getManyAndCount();
    return {
      items: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        toolName: row.toolName,
        toolId: row.toolId,
        toolVersion: row.toolVersion,
        status: row.status,
        denialReason: row.denialReason,
        errorCode: row.errorCode,
        agentId: row.agentId,
        conversationId: row.conversationId,
        workflowRunId: row.workflowRunId,
        workflowStepId: row.workflowStepId,
        durationMs: row.durationMs,
        resultBytes: row.resultBytes,
        contextClassification: row.contextClassification,
        contextIntegrity: row.contextIntegrity,
        sideEffects: row.sideEffects,
        argumentsDigest: row.argumentsDigest,
      })),
      meta: buildPaginationMeta(total, query.page, query.take),
    };
  }

  @Get(':toolId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('tool:read')
  @ApiOperation({ summary: 'Get a tool' })
  @ApiEnvelopedResponse(ToolDto)
  @ApiErrorResponse(404, [ErrorCode.TOOL_NOT_FOUND])
  @ApiStandardErrors()
  get(
    @Param('toolId') toolId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<ToolDto> {
    return this.registry.get(principal, toolId);
  }

  @Post()
  @Auth(AuthType.Bearer)
  @RequirePermissions('tool:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Define an HTTP tool',
    description:
      'The URL’s origin must be on the platform egress allowlist (TOOL_HTTP_ALLOWED_HOSTS). ' +
      'By default the tool accepts only PUBLIC context and refuses calls that carry personal ' +
      'data; loosening either is audited as a weakening.',
  })
  @ApiEnvelopedResponse(ToolDto)
  @ApiErrorResponse(409, [ErrorCode.TOOL_NAME_TAKEN])
  @ApiErrorResponse(422, [ErrorCode.TOOL_DEFINITION_INVALID])
  @ApiStandardErrors()
  create(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: CreateToolDto,
  ): Promise<ToolDto> {
    return this.registry.create(principal, dto);
  }

  @Patch(':toolId')
  @Auth(AuthType.Bearer)
  @RequirePermissions('tool:update')
  @ApiOperation({ summary: 'Edit an HTTP tool, or replace its credential' })
  @ApiEnvelopedResponse(ToolDto)
  @ApiErrorResponse(404, [ErrorCode.TOOL_NOT_FOUND])
  @ApiErrorResponse(422, [ErrorCode.TOOL_DEFINITION_INVALID])
  @ApiStandardErrors()
  update(
    @Param('toolId') toolId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdateToolDto,
  ): Promise<ToolDto> {
    return this.registry.update(principal, toolId, dto);
  }

  @Delete(':toolId')
  @Auth(AuthType.Bearer)
  @RequirePermissions('tool:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete an HTTP tool',
    description: 'Its credential is destroyed at once; its ledger history is kept.',
  })
  @ApiErrorResponse(404, [ErrorCode.TOOL_NOT_FOUND])
  @ApiStandardErrors()
  async remove(
    @Param('toolId') toolId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ deleted: true }> {
    await this.registry.remove(principal, toolId);
    return { deleted: true };
  }

  @Post(':toolId/test')
  @Auth(AuthType.Bearer)
  @RequirePermissions('tool:update', 'tool:execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a tool with arguments you supply',
    description:
      'Runs the tool once, as you, through every check an agent’s call passes — schema, ' +
      'egress allowlist, personal-data inspection — and records it in the ledger. The ' +
      'context is PUBLIC and trusted, because you wrote the arguments yourself.',
  })
  @ApiEnvelopedResponse(ToolTestResultDto)
  @ApiStandardErrors()
  async test(
    @Param('toolId') toolId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: TestToolDto,
  ): Promise<ToolTestResultDto> {
    const resolved = await this.registry.resolveMany(principal.organizationId, [toolId]);
    const tool = resolved.get(toolId) ?? null;
    const outcome = await this.executor.execute(
      tool,
      { name: tool?.name ?? 'unknown', arguments: dto.arguments },
      {
        principal,
        agent: null,
        flow: { label: PUBLIC_LABEL, integrity: Integrity.TRUSTED },
        session: null,
        argumentsAreMasked: false,
        origin: {},
        actorLabel: 'a tool test',
        executionId: randomUUID(),
        budget: new InMemoryToolBudget(1),
        approvalGranted: true,
      },
    );
    return outcome.status === 'ok'
      ? {
          status: 'ok',
          executionId: outcome.executionId,
          durationMs: outcome.durationMs,
          content: outcome.content,
          truncated: outcome.truncated,
        }
      : {
          status: outcome.status,
          executionId: outcome.executionId,
          durationMs: outcome.durationMs,
          code: outcome.code,
          message: outcome.message,
        };
  }
}
