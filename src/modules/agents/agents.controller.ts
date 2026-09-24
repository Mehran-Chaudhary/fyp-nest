import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
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
import { SECURITY_SCHEME } from '../../common/constants/app.constants';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiPaginatedResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  Auth,
  RequirePermissions,
  ThrottlePolicy,
  TimeoutBudget,
} from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { PaginatedResult } from '../../common/utils/pagination.util';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentsService } from './agents.service';
import {
  AgentDto,
  AgentSummaryDto,
  AgentVersionDto,
  CreateAgentDto,
  ListAgentsQueryDto,
  PromptPreviewDto,
  PromptPreviewResultDto,
  RestoreVersionDto,
  UpdateAgentDto,
} from './dto/agent.dto';

const agentIdPipe = new ParseUUIDPipe({ version: '4' });

/**
 * The Agent Builder and Persona Engine (proposal module 6.8).
 */
@ApiTags('Agents')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/agents', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly runtime: AgentRuntimeService,
  ) {}

  @Get()
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('agent:read')
  @ApiOperation({
    summary: 'List agents',
    description:
      'Published agents you may use, your own drafts, and — if you manage agents — every ' +
      'agent. A restricted agent is listed only for members holding one of its roles.',
  })
  @ApiPaginatedResponse(AgentSummaryDto)
  @ApiStandardErrors()
  list(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListAgentsQueryDto,
  ): Promise<PaginatedResult<AgentSummaryDto>> {
    return this.agents.list(principal, query);
  }

  @Post()
  @RequirePermissions('agent:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an agent',
    description:
      'Creates version 1 as a private draft. Attaching a knowledge base requires being able ' +
      'to read it. Publish to make the agent available to the workspace.',
  })
  @ApiEnvelopedResponse(AgentDto)
  @ApiErrorResponse(409, [ErrorCode.AGENT_NAME_TAKEN])
  @ApiErrorResponse(404, [ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, ErrorCode.ROLE_NOT_FOUND])
  @ApiErrorResponse(422, [ErrorCode.LLM_MODEL_NOT_ALLOWED])
  @ApiStandardErrors()
  create(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: CreateAgentDto,
  ): Promise<AgentDto> {
    return this.agents.create(principal, dto);
  }

  @Get(':agentId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('agent:read')
  @ApiOperation({
    summary: 'Get an agent, with its current configuration and instructions',
  })
  @ApiEnvelopedResponse(AgentDto)
  @ApiErrorResponse(404, [ErrorCode.AGENT_NOT_FOUND])
  @ApiStandardErrors()
  get(
    @Param('agentId', agentIdPipe) agentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<AgentDto> {
    return this.agents.get(principal, agentId);
  }

  @Patch(':agentId')
  @RequirePermissions('agent:update')
  @ApiOperation({
    summary: 'Update an agent',
    description:
      'A change to behaviour — persona, instructions, model, parameters, retrieval, memory — ' +
      'creates a new immutable version; an unchanged configuration creates none. Name, ' +
      'description and access are edited in place and audited. Send expectedVersion to avoid ' +
      'overwriting a concurrent edit.',
  })
  @ApiEnvelopedResponse(AgentDto)
  @ApiErrorResponse(409, [ErrorCode.AGENT_VERSION_CONFLICT, ErrorCode.AGENT_NAME_TAKEN])
  @ApiErrorResponse(404, [ErrorCode.AGENT_NOT_FOUND, ErrorCode.KNOWLEDGE_BASE_NOT_FOUND])
  @ApiStandardErrors()
  update(
    @Param('agentId', agentIdPipe) agentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdateAgentDto,
  ): Promise<AgentDto> {
    return this.agents.update(principal, agentId, dto);
  }

  @Delete(':agentId')
  @RequirePermissions('agent:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete an agent',
    description: 'Its conversations remain readable; no new turns can run.',
  })
  @ApiErrorResponse(404, [ErrorCode.AGENT_NOT_FOUND])
  @ApiStandardErrors()
  async remove(
    @Param('agentId', agentIdPipe) agentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ deleted: true }> {
    await this.agents.remove(principal, agentId);
    return { deleted: true };
  }

  @Post(':agentId/publish')
  @RequirePermissions('agent:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish an agent to the workspace' })
  @ApiEnvelopedResponse(AgentDto)
  @ApiStandardErrors()
  publish(
    @Param('agentId', agentIdPipe) agentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<AgentDto> {
    return this.agents.setPublished(principal, agentId, true);
  }

  @Post(':agentId/unpublish')
  @RequirePermissions('agent:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return an agent to draft' })
  @ApiEnvelopedResponse(AgentDto)
  @ApiStandardErrors()
  unpublish(
    @Param('agentId', agentIdPipe) agentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<AgentDto> {
    return this.agents.setPublished(principal, agentId, false);
  }

  @Get(':agentId/versions')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Version history, newest first' })
  @ApiPaginatedResponse(AgentVersionDto)
  @ApiStandardErrors()
  versions(
    @Param('agentId', agentIdPipe) agentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResult<AgentVersionDto>> {
    return this.agents.listVersions(
      principal,
      agentId,
      query.page,
      Math.min(query.take, 50),
    );
  }

  @Get(':agentId/versions/:version')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'One version of an agent' })
  @ApiEnvelopedResponse(AgentVersionDto)
  @ApiErrorResponse(404, [ErrorCode.AGENT_VERSION_NOT_FOUND])
  @ApiStandardErrors()
  version(
    @Param('agentId', agentIdPipe) agentId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<AgentVersionDto> {
    return this.agents.getVersion(principal, agentId, version);
  }

  @Post(':agentId/versions/:version/restore')
  @RequirePermissions('agent:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Roll back to an earlier version',
    description:
      'Appends a new version identical to the chosen one; history is never rewritten. ' +
      'Audited as agent.version.restored.',
  })
  @ApiEnvelopedResponse(AgentDto)
  @ApiErrorResponse(409, [ErrorCode.AGENT_VERSION_CONFLICT])
  @ApiStandardErrors()
  restore(
    @Param('agentId', agentIdPipe) agentId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: RestoreVersionDto,
  ): Promise<AgentDto> {
    return this.agents.restoreVersion(principal, agentId, version, dto);
  }

  @Post(':agentId/prompt-preview')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('agent:execute')
  @ThrottlePolicy(THROTTLE_POLICY.RAG)
  @TimeoutBudget('retrieval')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'See exactly what the model would receive',
    description:
      'Builds the prompt for a question — retrieval as you, token budgeting, masking — ' +
      'without calling the model or storing anything, and runs the gateway’s egress check ' +
      'over it. Every value in the response is masked.',
  })
  @ApiEnvelopedResponse(PromptPreviewResultDto)
  @ApiErrorResponse(503, [
    ErrorCode.PII_DETECTION_UNAVAILABLE,
    ErrorCode.KNOWLEDGE_LAYER_NOT_CONFIGURED,
  ])
  @ApiStandardErrors()
  preview(
    @Param('agentId', agentIdPipe) agentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: PromptPreviewDto,
  ): Promise<PromptPreviewResultDto> {
    return this.runtime.preview(principal, agentId, dto);
  }
}
