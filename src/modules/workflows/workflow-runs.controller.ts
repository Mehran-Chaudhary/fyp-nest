import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { Auth, RequirePermissions } from '../../common/decorators/auth.decorators';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { PaginatedResult } from '../../common/utils/pagination.util';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import {
  ApprovalDecisionDto,
  ApprovalItemDto,
  ContentDto,
  DeadLetterDto,
  DeadLettersQueryDto,
  ListRunsQueryDto,
  RunContentQueryDto,
  RunDetailDto,
  RunDto,
  TraceDto,
} from './dto/workflow.dto';
import { WorkflowRunsService } from './workflow-runs.service';

const uuid = new ParseUUIDPipe({ version: '4' });
/** Step ids are name-based (v5) UUIDs. */
const stepUuid = new ParseUUIDPipe();

/**
 * Workflow runs: watching, reading, controlling, approving — and the two
 * views that exist for when things go wrong, the audit-derived trace and the
 * metadata-only dead-letter queue.
 */
@ApiTags('Workflow runs')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId/workflow-runs', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class WorkflowRunsController {
  constructor(private readonly runs: WorkflowRunsService) {}

  @Get()
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({
    summary: 'List runs',
    description:
      'Yours by default; scope=all lists everyone’s and requires workflow:read_all.',
  })
  @ApiPaginatedResponse(RunDto)
  @ApiStandardErrors()
  list(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListRunsQueryDto,
  ): Promise<PaginatedResult<RunDto>> {
    return this.runs.list(principal, query);
  }

  @Get('approvals')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:approve')
  @ApiOperation({
    summary: 'Steps waiting for approval',
    description:
      'Each with its message when you are cleared for its label, and whether you may decide ' +
      '(not for runs you started yourself, unless the workflow allows it).',
  })
  @ApiEnvelopedResponse(ApprovalItemDto, 'An array of waiting steps')
  @ApiStandardErrors()
  approvals(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<ApprovalItemDto[]> {
    return this.runs.listApprovals(principal);
  }

  @Get('dead-letters')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:update')
  @ApiOperation({
    summary: 'Dead-lettered steps',
    description:
      'Steps that failed for good, as metadata only: node, failure code and class, attempts. ' +
      'No payload — debugging works from metadata alone. Resume the run to try again.',
  })
  @ApiPaginatedResponse(DeadLetterDto)
  @ApiStandardErrors()
  deadLetters(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: DeadLettersQueryDto,
  ): Promise<PaginatedResult<DeadLetterDto>> {
    return this.runs.deadLetters(principal, query.page, query.take);
  }

  @Get(':runId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({
    summary: 'A run and its steps',
    description:
      'Metadata only: statuses, timings, tokens, tool calls, labels. For content, see …/content.',
  })
  @ApiEnvelopedResponse(RunDetailDto)
  @ApiErrorResponse(404, [ErrorCode.WORKFLOW_RUN_NOT_FOUND])
  @ApiStandardErrors()
  get(
    @Param('runId', uuid) runId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<RunDetailDto> {
    return this.runs.get(principal, runId);
  }

  @Get(':runId/content')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({
    summary: 'A run’s input and output',
    description:
      'Withheld when its label is above your current access. In someone else’s run, ' +
      'personal data is masked unless reveal=true (pii:reveal, audited).',
  })
  @ApiEnvelopedResponse(ContentDto)
  @ApiStandardErrors()
  content(
    @Param('runId', uuid) runId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: RunContentQueryDto,
  ): Promise<ContentDto> {
    return this.runs.runContent(principal, runId, query.reveal === true);
  }

  @Get(':runId/steps/:stepId/content')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @ApiOperation({
    summary: 'What one step was given and what it handed on',
    description:
      'The inter-agent message, decrypted for you under the same rules as the run’s content.',
  })
  @ApiEnvelopedResponse(ContentDto)
  @ApiErrorResponse(404, [ErrorCode.WORKFLOW_STEP_NOT_FOUND])
  @ApiStandardErrors()
  stepContent(
    @Param('runId', uuid) runId: string,
    @Param('stepId', stepUuid) stepId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: RunContentQueryDto,
  ): Promise<ContentDto> {
    return this.runs.stepContent(principal, runId, stepId, query.reveal === true);
  }

  @Get(':runId/trace')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:read', 'audit:read')
  @ApiOperation({
    summary: 'The run’s trace, rebuilt from the audit log alone',
    description:
      'Every step, its predecessors, outcomes, agent and tool versions and tool calls — from ' +
      'the tamper-evident audit chain, not the run tables. `complete` says whether every fact ' +
      'the run’s final record promised is present.',
  })
  @ApiEnvelopedResponse(TraceDto)
  @ApiStandardErrors()
  trace(
    @Param('runId', uuid) runId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<TraceDto> {
    return this.runs.trace(principal, runId);
  }

  @Post(':runId/cancel')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a run',
    description:
      'Steps in flight are aborted wherever they run; a model call stops on the GPU.',
  })
  @ApiEnvelopedResponse(RunDto)
  @ApiErrorResponse(409, [ErrorCode.WORKFLOW_RUN_FINISHED])
  @ApiStandardErrors()
  cancel(
    @Param('runId', uuid) runId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<RunDto> {
    return this.runs.cancel(principal, runId);
  }

  @Post(':runId/resume')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume a failed or timed-out run',
    description:
      'Re-runs only what failed or was cancelled; completed steps keep their outputs.',
  })
  @ApiEnvelopedResponse(RunDto)
  @ApiErrorResponse(409, [ErrorCode.WORKFLOW_RUN_NOT_RESUMABLE])
  @ApiStandardErrors()
  resume(
    @Param('runId', uuid) runId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<RunDto> {
    return this.runs.resume(principal, runId);
  }

  @Post(':runId/steps/:stepId/approval')
  @Auth(AuthType.Bearer)
  @RequirePermissions('workflow:approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a waiting step' })
  @ApiEnvelopedResponse(RunDto)
  @ApiErrorResponse(403, [ErrorCode.WORKFLOW_SELF_APPROVAL_FORBIDDEN])
  @ApiErrorResponse(409, [ErrorCode.WORKFLOW_APPROVAL_NOT_PENDING])
  @ApiStandardErrors()
  decide(
    @Param('runId', uuid) runId: string,
    @Param('stepId', stepUuid) stepId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: ApprovalDecisionDto,
  ): Promise<RunDto> {
    return this.runs.decide(principal, runId, stepId, dto.decision, dto.comment);
  }

  @Delete(':runId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('workflow:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a finished run',
    description:
      'Your own, or anyone’s with workflow:delete. The run’s key is destroyed: its content is ' +
      'unrecoverable at once, from backups too. The audit trail stays.',
  })
  @ApiStandardErrors()
  async remove(
    @Param('runId', uuid) runId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ deleted: true }> {
    await this.runs.remove(principal, runId);
    return { deleted: true };
  }
}
