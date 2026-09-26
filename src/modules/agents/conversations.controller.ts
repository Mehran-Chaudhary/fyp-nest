import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
  ApiPaginatedResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  Auth,
  RequirePermissions,
  ThrottlePolicy,
  TimeoutBudget,
} from '../../common/decorators/auth.decorators';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { PaginatedResult } from '../../common/utils/pagination.util';
import { runAsEventStream } from '../../common/utils/sse-stream';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import { AgentRuntimeService } from './agent-runtime.service';
import { ConversationsService } from './conversations.service';
import {
  ConversationDto,
  CreateConversationDto,
  ListConversationsQueryDto,
  ListMessagesQueryDto,
  MessagePageDto,
  SendMessageDto,
  TurnResultDto,
  UpdateConversationDto,
} from './dto/conversation.dto';

const conversationIdPipe = new ParseUUIDPipe({ version: '4' });

const TURN_ERRORS_503 = [
  ErrorCode.LLM_NOT_CONFIGURED,
  ErrorCode.LLM_UNAVAILABLE,
  ErrorCode.LLM_BUSY,
  ErrorCode.PII_DETECTION_UNAVAILABLE,
  ErrorCode.KNOWLEDGE_LAYER_NOT_CONFIGURED,
];

/**
 * Conversations with agents: memory (proposal module 6.10) and the chat
 * endpoints that drive a turn.
 */
@ApiTags('Conversations')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId/conversations', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly runtime: AgentRuntimeService,
  ) {}

  @Get()
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('conversation:read')
  @ApiOperation({
    summary: 'List conversations',
    description:
      'Yours by default. scope=all lists everyone’s and requires conversation:read_all; ' +
      'titles of other people’s conversations are masked, and the listing is audited.',
  })
  @ApiPaginatedResponse(ConversationDto)
  @ApiStandardErrors()
  list(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListConversationsQueryDto,
  ): Promise<PaginatedResult<ConversationDto>> {
    return this.conversations.list(principal, query);
  }

  @Post()
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('agent:execute')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start a conversation with an agent' })
  @ApiEnvelopedResponse(ConversationDto)
  @ApiErrorResponse(404, [ErrorCode.AGENT_NOT_FOUND])
  @ApiStandardErrors()
  create(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: CreateConversationDto,
  ): Promise<ConversationDto> {
    return this.conversations.create(principal, dto);
  }

  @Get(':conversationId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Get a conversation' })
  @ApiEnvelopedResponse(ConversationDto)
  @ApiErrorResponse(404, [ErrorCode.CONVERSATION_NOT_FOUND])
  @ApiStandardErrors()
  get(
    @Param('conversationId', conversationIdPipe) conversationId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<ConversationDto> {
    return this.conversations.get(principal, conversationId);
  }

  @Patch(':conversationId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Rename or archive your conversation' })
  @ApiEnvelopedResponse(ConversationDto)
  @ApiStandardErrors()
  update(
    @Param('conversationId', conversationIdPipe) conversationId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdateConversationDto,
  ): Promise<ConversationDto> {
    return this.conversations.update(principal, conversationId, dto);
  }

  @Delete(':conversationId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('conversation:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a conversation',
    description:
      'Its encryption key is destroyed and its messages deleted in one transaction: the ' +
      'content is unrecoverable at once, from backups too.',
  })
  @ApiErrorResponse(404, [ErrorCode.CONVERSATION_NOT_FOUND])
  @ApiStandardErrors()
  async remove(
    @Param('conversationId', conversationIdPipe) conversationId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ deleted: true }> {
    await this.conversations.remove(principal, conversationId);
    return { deleted: true };
  }

  @Get(':conversationId/messages')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('conversation:read')
  @ApiOperation({
    summary: 'Read messages',
    description:
      'Each message carries the sensitivity of what it was drawn from, and is checked ' +
      'against your current access: content from above your clearance, from a compartment ' +
      'you are not in, or from a deleted document is withheld. In someone else’s ' +
      'conversation, personal data is masked unless you request reveal=true (pii:reveal).',
  })
  @ApiEnvelopedResponse(MessagePageDto)
  @ApiStandardErrors()
  messages(
    @Param('conversationId', conversationIdPipe) conversationId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListMessagesQueryDto,
  ): Promise<MessagePageDto> {
    return this.conversations.messages(principal, conversationId, query);
  }

  @Post(':conversationId/messages')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('agent:execute')
  @ThrottlePolicy(THROTTLE_POLICY.INFERENCE)
  @TimeoutBudget('inference')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a message and receive the agent’s answer',
    description:
      'Retrieval runs with your own access; everything sent to the model is masked; the ' +
      'answer is unmasked for you and stored encrypted with its sensitivity label.',
  })
  @ApiEnvelopedResponse(TurnResultDto)
  @ApiErrorResponse(409, [
    ErrorCode.CONVERSATION_BUSY,
    ErrorCode.CONVERSATION_ARCHIVED,
    ErrorCode.MESSAGE_DUPLICATE,
    ErrorCode.AGENT_UNAVAILABLE,
  ])
  @ApiErrorResponse(503, TURN_ERRORS_503)
  @ApiErrorResponse(422, [ErrorCode.LLM_CONTEXT_OVERFLOW, ErrorCode.LLM_MODEL_NOT_ALLOWED])
  @ApiStandardErrors()
  send(
    @Param('conversationId', conversationIdPipe) conversationId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: SendMessageDto,
  ): Promise<TurnResultDto> {
    return this.runtime.runTurn(principal, conversationId, dto);
  }

  @Post(':conversationId/messages/stream')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('agent:execute')
  @ThrottlePolicy(THROTTLE_POLICY.INFERENCE)
  @TimeoutBudget('inference')
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Send a message and stream the answer',
    description:
      'Server-Sent Events over a POST (use fetch() with a stream reader, or ' +
      '@microsoft/fetch-event-source). Events: `meta` {conversationId, agentId, ' +
      'agentVersion, model, userMessageId, assistantMessageId} once preflight passes; ' +
      '`status` {stage: retrieving | redacting | queued | generating | thinking | tool}; ' +
      '`delta` {text}, already unmasked; `tool` {executionId, tool, status, code?, reason?, ' +
      'durationMs} after each tool call (never its arguments or result); then `done` (the ' +
      'same body as the non-streaming endpoint) or ' +
      '`error` {code, message}. Failures before `meta` are ordinary JSON errors. ' +
      'Disconnecting stops generation; the partial answer is kept as a cancelled message.',
  })
  @ApiErrorResponse(409, [ErrorCode.CONVERSATION_BUSY, ErrorCode.MESSAGE_DUPLICATE])
  @ApiErrorResponse(503, TURN_ERRORS_503)
  @ApiStandardErrors()
  async sendStream(
    @Param('conversationId', conversationIdPipe) conversationId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: SendMessageDto,
    @Res() response: Response,
  ): Promise<void> {
    await runAsEventStream(
      response,
      (channel, signal) =>
        this.runtime.runTurn(
          principal,
          conversationId,
          dto,
          {
            onOpen: (meta) => channel.open('meta', meta),
            onStatus: (stage, detail) => channel.send('status', { stage, ...detail }),
            onDelta: (text) => channel.send('delta', { text }),
            onTool: (call) => channel.send('tool', call),
          },
          signal,
        ),
      (result) => result,
    );
  }
}
