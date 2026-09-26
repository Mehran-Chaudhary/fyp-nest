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
  Put,
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
  RequireAnyPermission,
  RequirePermissions,
  ThrottlePolicy,
} from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { PaginatedResult } from '../../common/utils/pagination.util';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import { NODE_CATALOGUE, type NodeTypeDescriptor } from './domain/node-catalogue';
import {
  CreateWorkflowDto,
  ListWorkflowsQueryDto,
  PublishWorkflowDto,
  RestoreWorkflowVersionDto,
  RunDto,
  SaveDefinitionDto,
  StartRunDto,
  UpdateWorkflowDto,
  ValidateWorkflowDto,
  ValidationReportDto,
  WorkflowDto,
  WorkflowSummaryDto,
  WorkflowVersionDto,
} from './dto/workflow.dto';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsService } from './workflows.service';

const workflowIdPipe = new ParseUUIDPipe({ version: '4' });

/**
 * Workflow definitions — the canvas's backend (proposal module 6.13) — and the
 * endpoint that starts runs of them (module 6.9).
 */
@ApiTags('Workflows')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId/workflows', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly runs: WorkflowRunsService,
  ) {}

  @Get()
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({ summary: 'List workflows' })
  @ApiPaginatedResponse(WorkflowSummaryDto)
  @ApiStandardErrors()
  list(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListWorkflowsQueryDto,
  ): Promise<PaginatedResult<WorkflowSummaryDto>> {
    return this.workflows.list(principal, query);
  }

  @Get('node-types')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({
    summary: 'The canvas palette',
    description:
      'Node types, their handles, what they produce and their configuration fields.',
  })
  nodeTypes(): { nodeTypes: readonly NodeTypeDescriptor[] } {
    return { nodeTypes: NODE_CATALOGUE };
  }

  @Post('validate')
  @Auth(AuthType.Bearer)
  @RequireAnyPermission('workflow:create', 'workflow:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate a graph without saving it',
    description:
      'For live feedback on the canvas: structure, loops, templates, types, and whether you ' +
      'can reference each agent, tool and knowledge base. Errors carry the node or edge id.',
  })
  @ApiEnvelopedResponse(ValidationReportDto)
  @ApiStandardErrors()
  async validate(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: ValidateWorkflowDto,
  ): Promise<ValidationReportDto> {
    const report = await this.workflows.validate(principal, dto.graph);
    return {
      valid: report.valid,
      errors: report.errors,
      warnings: report.warnings,
      stepBound: report.compiled?.stepBound ?? null,
    };
  }

  @Post()
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a workflow',
    description: 'Starts as a draft; publish to let members run it.',
  })
  @ApiEnvelopedResponse(WorkflowDto)
  @ApiErrorResponse(409, [ErrorCode.WORKFLOW_NAME_TAKEN])
  @ApiStandardErrors()
  create(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: CreateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.workflows.create(principal, dto);
  }

  @Get(':workflowId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({ summary: 'Get a workflow and its current definition' })
  @ApiEnvelopedResponse(WorkflowDto)
  @ApiErrorResponse(404, [ErrorCode.WORKFLOW_NOT_FOUND])
  @ApiStandardErrors()
  get(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<WorkflowDto> {
    return this.workflows.get(principal, workflowId);
  }

  @Patch(':workflowId')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:update')
  @ApiOperation({ summary: 'Rename a workflow or change its description' })
  @ApiEnvelopedResponse(WorkflowDto)
  @ApiStandardErrors()
  update(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.workflows.update(principal, workflowId, dto);
  }

  @Put(':workflowId/definition')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:update')
  @ApiOperation({
    summary: 'Save the canvas',
    description:
      'Appends an immutable version — even an invalid one, so work in progress is never ' +
      'lost — with its validation report. Runs keep using the published version until you ' +
      'publish again.',
  })
  @ApiEnvelopedResponse(WorkflowDto)
  @ApiErrorResponse(409, [ErrorCode.WORKFLOW_VERSION_CONFLICT])
  @ApiStandardErrors()
  saveDefinition(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: SaveDefinitionDto,
  ): Promise<WorkflowDto> {
    return this.workflows.saveDefinition(principal, workflowId, dto);
  }

  @Get(':workflowId/versions')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({ summary: 'Version history' })
  @ApiPaginatedResponse(WorkflowVersionDto)
  @ApiStandardErrors()
  versions(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResult<WorkflowVersionDto>> {
    return this.workflows.listVersions(principal, workflowId, query.page, query.take);
  }

  @Get(':workflowId/versions/:version')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({ summary: 'Get one version' })
  @ApiEnvelopedResponse(WorkflowVersionDto)
  @ApiErrorResponse(404, [ErrorCode.WORKFLOW_VERSION_NOT_FOUND])
  @ApiStandardErrors()
  version(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<WorkflowVersionDto> {
    return this.workflows.getVersion(principal, workflowId, version);
  }

  @Post(':workflowId/versions/:version/restore')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:update')
  @ApiOperation({
    summary: 'Restore a version',
    description: 'Appends a copy; history is never rewritten.',
  })
  @ApiEnvelopedResponse(WorkflowDto)
  @ApiStandardErrors()
  restore(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: RestoreWorkflowVersionDto,
  ): Promise<WorkflowDto> {
    return this.workflows.restoreVersion(principal, workflowId, version, dto.changeNote);
  }

  @Post(':workflowId/publish')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a version',
    description:
      'Members with workflow:execute can then run it. The version must be valid, and is re-checked.',
  })
  @ApiEnvelopedResponse(WorkflowDto)
  @ApiErrorResponse(422, [ErrorCode.WORKFLOW_INVALID])
  @ApiStandardErrors()
  publish(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: PublishWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.workflows.publish(principal, workflowId, dto);
  }

  @Post(':workflowId/archive')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a workflow',
    description: 'No new runs; history stays.',
  })
  @ApiEnvelopedResponse(WorkflowDto)
  @ApiStandardErrors()
  archive(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<WorkflowDto> {
    return this.workflows.archive(principal, workflowId);
  }

  @Delete(':workflowId')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a workflow',
    description: 'Runs in progress are cancelled; run history stays.',
  })
  @ApiErrorResponse(404, [ErrorCode.WORKFLOW_NOT_FOUND])
  @ApiStandardErrors()
  async remove(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ deleted: true }> {
    await this.workflows.remove(principal, workflowId);
    return { deleted: true };
  }

  @Post(':workflowId/runs')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:execute')
  @ThrottlePolicy(THROTTLE_POLICY.WORKFLOW)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start a run',
    description:
      'Returns at once (202) with the run; its steps execute in the background. Watch it over ' +
      'the real-time socket (subscribe to the run id) or poll GET …/workflow-runs/{runId}. ' +
      'The run acts with your access, re-checked before every step.',
  })
  @ApiEnvelopedResponse(RunDto)
  @ApiErrorResponse(409, [ErrorCode.WORKFLOW_NOT_ACTIVE])
  @ApiErrorResponse(422, [ErrorCode.WORKFLOW_INPUT_INVALID, ErrorCode.WORKFLOW_INVALID])
  @ApiErrorResponse(429, [ErrorCode.WORKFLOW_CONCURRENCY_LIMIT])
  @ApiStandardErrors()
  start(
    @Param('workflowId', workflowIdPipe) workflowId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: StartRunDto,
  ): Promise<RunDto> {
    return this.runs.start(principal, workflowId, dto);
  }
}
