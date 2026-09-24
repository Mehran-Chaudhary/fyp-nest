import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { SECURITY_SCHEME } from '../../common/constants/app.constants';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  Auth,
  RequireAnyPermission,
  RequirePermissions,
  ThrottlePolicy,
  TimeoutBudget,
} from '../../common/decorators/auth.decorators';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { runAsEventStream } from '../../common/utils/sse-stream';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import { DirectChatService } from './direct-chat.service';
import {
  ChatCompletionDto,
  DirectChatDto,
  LlmModelsDto,
  LlmPolicyDto,
  UpdateLlmPolicyDto,
  UsageQueryDto,
  UsageSummaryDto,
} from './dto/llm.dto';
import { LlmPolicyService } from './llm-policy.service';
import { UsageService } from './usage.service';

const INFERENCE_ERRORS = [
  ErrorCode.LLM_NOT_CONFIGURED,
  ErrorCode.LLM_UNAVAILABLE,
  ErrorCode.LLM_BUSY,
  ErrorCode.PII_DETECTION_UNAVAILABLE,
];

/**
 * The LLM gateway (proposal module 6.7): models, the workspace model policy,
 * direct inference and the usage ledger.
 */
@ApiTags('LLM gateway')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId/llm', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class LlmController {
  constructor(
    private readonly policies: LlmPolicyService,
    private readonly directChat: DirectChatService,
    private readonly usage: UsageService,
  ) {}

  @Get('models')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequireAnyPermission('llm:invoke', 'llm:manage', 'agent:read')
  @ApiOperation({
    summary: 'Models this workspace can use',
    description:
      'What the model endpoint serves, filtered by the platform allowlist, each marked as ' +
      'allowed or not by the workspace policy.',
  })
  @ApiEnvelopedResponse(LlmModelsDto)
  @ApiStandardErrors()
  models(@CurrentAccessPrincipal() principal: AccessPrincipal): Promise<LlmModelsDto> {
    return this.policies.listModels(principal.organizationId);
  }

  @Get('policy')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequireAnyPermission('llm:invoke', 'llm:manage', 'agent:read')
  @ApiOperation({ summary: 'The workspace model policy and effective limits' })
  @ApiEnvelopedResponse(LlmPolicyDto)
  @ApiStandardErrors()
  policy(@CurrentAccessPrincipal() principal: AccessPrincipal): Promise<LlmPolicyDto> {
    return this.policies.describe(principal.organizationId);
  }

  @Put('policy')
  @RequirePermissions('llm:manage')
  @ApiOperation({
    summary: 'Change which models the workspace may use',
    description:
      'Choose among the models the platform allows, set the default, and lower the output ' +
      'and context ceilings. Audited as llm.policy.updated.',
  })
  @ApiEnvelopedResponse(LlmPolicyDto)
  @ApiErrorResponse(422, [ErrorCode.LLM_MODEL_NOT_ALLOWED, ErrorCode.VALIDATION_FAILED])
  @ApiErrorResponse(409, [ErrorCode.RESOURCE_CONFLICT])
  @ApiStandardErrors()
  updatePolicy(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdateLlmPolicyDto,
  ): Promise<LlmPolicyDto> {
    return this.policies.update(principal.organizationId, principal.userId, dto);
  }

  @Post('chat')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('llm:invoke')
  @ThrottlePolicy(THROTTLE_POLICY.INFERENCE)
  @TimeoutBudget('inference')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a conversation to the model',
    description:
      'Every message is masked by the workspace PII policy before it leaves; the answer is ' +
      'unmasked for you. Nothing is stored except a content-free usage record.',
  })
  @ApiEnvelopedResponse(ChatCompletionDto)
  @ApiErrorResponse(503, INFERENCE_ERRORS)
  @ApiErrorResponse(422, [
    ErrorCode.LLM_MODEL_NOT_ALLOWED,
    ErrorCode.LLM_MODEL_NOT_FOUND,
    ErrorCode.LLM_CONTEXT_OVERFLOW,
  ])
  @ApiStandardErrors()
  chat(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: DirectChatDto,
  ): Promise<ChatCompletionDto> {
    return this.directChat.chat(principal, dto);
  }

  @Post('chat/stream')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('llm:invoke')
  @ThrottlePolicy(THROTTLE_POLICY.INFERENCE)
  @TimeoutBudget('inference')
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Send a conversation to the model, streaming the answer',
    description:
      'Server-Sent Events over a POST, so use fetch() with a stream reader (or ' +
      '@microsoft/fetch-event-source), not EventSource. Events: `meta` {invocationId, model} ' +
      'once preflight passes; `status` {stage: redacting | queued | generating | thinking}; ' +
      '`delta` {text}; then `done` (the same body as POST …/llm/chat) or `error` {code, ' +
      'message}. Failures before `meta` are ordinary JSON errors with their HTTP status.',
  })
  @ApiErrorResponse(503, INFERENCE_ERRORS)
  @ApiStandardErrors()
  async chatStream(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: DirectChatDto,
    @Res() response: Response,
  ): Promise<void> {
    await runAsEventStream(
      response,
      (channel, signal) =>
        this.directChat.chat(
          principal,
          dto,
          {
            onOpen: (meta) => channel.open('meta', meta),
            onStatus: (stage, detail) => channel.send('status', { stage, ...detail }),
            onDelta: (text) => channel.send('delta', { text }),
          },
          signal,
        ),
      (result) => result,
    );
  }

  @Get('usage')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('usage:read')
  @ApiOperation({
    summary: 'Token usage, latency and redaction overhead',
    description:
      'Aggregated from the usage ledger: invocations by outcome, tokens, latency percentiles, ' +
      'and the processing time the PII engine added (p50/p95/p99 and share of total).',
  })
  @ApiEnvelopedResponse(UsageSummaryDto)
  @ApiStandardErrors()
  usageSummary(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: UsageQueryDto,
  ): Promise<UsageSummaryDto> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 30 * 86_400_000);
    return this.usage.summary(principal.organizationId, from, to);
  }
}
