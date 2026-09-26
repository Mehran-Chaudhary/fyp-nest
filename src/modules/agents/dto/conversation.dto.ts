import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Classification } from '../../knowledge/domain/classification';
import { ConversationStatus } from '../entities/conversation.entity';
import { MessageRole, MessageStatus } from '../entities/conversation-message.entity';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateConversationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  agentId: string;

  @ApiPropertyOptional({
    maxLength: 120,
    description: 'Defaults to the start of the first message. Stored encrypted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Trim()
  title?: string;
}

export class UpdateConversationDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Trim()
  title?: string;

  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;
}

export class ListConversationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  agentId?: string;

  @ApiPropertyOptional({
    enum: ['mine', 'all'],
    default: 'mine',
    description:
      '`all` lists every member’s conversations and requires conversation:read_all.',
  })
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: 'mine' | 'all';

  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;
}

export class TurnOverridesDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 65_536 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_536)
  maxOutputTokens?: number;
}

export class TurnRetrievalDto {
  @ApiPropertyOptional({ description: 'Skip retrieval for this turn.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Search only these of the agent’s knowledge bases this turn.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  knowledgeBaseIds?: string[];
}

export class SendMessageDto {
  @ApiProperty({ example: 'How many days of annual leave do I get?', maxLength: 100_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  content: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Idempotency key. Resending a message with the same key returns 409 MESSAGE_DUPLICATE ' +
      'instead of answering it twice.',
  })
  @IsOptional()
  @IsUUID('4')
  clientMessageId?: string;

  @ApiPropertyOptional({ type: TurnOverridesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TurnOverridesDto)
  parameters?: TurnOverridesDto;

  @ApiPropertyOptional({ type: TurnRetrievalDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TurnRetrievalDto)
  retrieval?: TurnRetrievalDto;
}

export class ListMessagesQueryDto {
  @ApiPropertyOptional({
    description: 'Return messages before this sequence number (for paging backwards).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({
    description:
      'For a conversation that is not yours: show personal data unmasked. Requires pii:reveal; ' +
      'audited as pii.unmasked.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  reveal?: boolean;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class ConversationDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) agentId: string;
  @ApiProperty({ nullable: true }) agentName: string | null;
  @ApiProperty({
    nullable: true,
    description:
      'Masked when the conversation is not yours; null if it could not be masked.',
  })
  title: string | null;
  @ApiProperty({ enum: ConversationStatus }) status: ConversationStatus;
  @ApiProperty() messageCount: number;
  @ApiProperty({ nullable: true }) lastMessageAt: Date | null;
  @ApiProperty({
    enum: Classification,
    description: 'The most sensitive material this conversation has drawn on.',
  })
  classification: Classification;
  @ApiProperty() isOwner: boolean;
  @ApiProperty({ enum: ['user', 'api_key'] }) ownerKind: 'user' | 'api_key';
  @ApiProperty({ nullable: true }) ownerUserId: string | null;
  @ApiProperty() createdAt: Date;
}

export class CitationDto {
  @ApiProperty({ example: 'S1' }) tag: string;
  @ApiProperty({ format: 'uuid' }) documentId: string;
  @ApiProperty({ nullable: true }) documentTitle: string | null;
  @ApiProperty({ format: 'uuid' }) knowledgeBaseId: string;
  @ApiProperty({ format: 'uuid' }) chunkId: string;
  @ApiProperty() rank: number;
  @ApiProperty() score: number;
  @ApiProperty({ description: 'The answer cited it, rather than it only being provided.' })
  cited: boolean;
}

export class MessageRedactionDto {
  @ApiProperty() enabled: boolean;
  @ApiProperty() degraded: boolean;
  @ApiProperty({ description: 'Entities masked before the model saw the prompt.' })
  entities: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  byType: Record<string, number>;
}

export class MessageToolCallDto {
  @ApiProperty({ format: 'uuid' }) executionId: string;
  @ApiProperty() tool: string;
  @ApiProperty({ enum: ['ok', 'error', 'denied'] }) status: 'ok' | 'error' | 'denied';
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional({ description: 'Why a call was refused.' }) reason?: string;
  @ApiProperty() durationMs: number;
}

export class MessageDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() sequence: number;
  @ApiProperty({ enum: MessageRole }) role: MessageRole;
  @ApiProperty({ enum: MessageStatus }) status: MessageStatus;
  @ApiProperty({ nullable: true, description: 'Null when withheld.' }) content:
    string | null;
  @ApiProperty({
    enum: ['VISIBLE', 'MASKED', 'WITHHELD'],
    description:
      'VISIBLE: as written. MASKED: personal data replaced by placeholders because the ' +
      'conversation is not yours. WITHHELD: drawn on material you cannot currently read.',
  })
  contentState: 'VISIBLE' | 'MASKED' | 'WITHHELD';
  @ApiPropertyOptional({
    enum: ['CLEARANCE', 'COMPARTMENT', 'SOURCE_DELETED', 'REDACTION_UNAVAILABLE'],
  })
  withheldReason?: string;
  @ApiProperty({ enum: Classification }) classification: Classification;
  @ApiProperty({ type: [CitationDto] }) citations: CitationDto[];
  @ApiProperty({ nullable: true }) agentVersion: number | null;
  @ApiProperty({ nullable: true }) model: string | null;
  @ApiProperty({ nullable: true, type: MessageRedactionDto })
  redaction: MessageRedactionDto | null;
  @ApiProperty({ nullable: true }) errorCode: string | null;
  @ApiProperty({
    type: [MessageToolCallDto],
    description:
      'Tools the agent called for this answer: which, and how it went. No content.',
  })
  toolCalls: MessageToolCallDto[];
  @ApiProperty() createdAt: Date;
}

export class MessagePageDto {
  @ApiProperty({ type: [MessageDto], description: 'Chronological.' })
  messages: MessageDto[];
  @ApiProperty({ nullable: true, description: 'Pass as `before` for the previous page.' })
  nextBefore: number | null;
  @ApiProperty() masked: boolean;
  @ApiProperty() revealed: boolean;
}

export class TurnTimingsDto {
  @ApiProperty() retrievalMs: number;
  @ApiProperty({ description: 'Detection, masking, the egress check and unmasking.' })
  redactionMs: number;
  @ApiProperty() queueMs: number;
  @ApiProperty({ nullable: true }) timeToFirstTokenMs: number | null;
  @ApiProperty() generationMs: number;
  @ApiProperty() totalMs: number;
}

export class TurnUsageDto {
  @ApiProperty() promptTokens: number;
  @ApiProperty() completionTokens: number;
  @ApiProperty() estimated: boolean;
}

export class TurnRetrievalSummaryDto {
  @ApiProperty({ format: 'uuid', nullable: true }) retrievalId: string | null;
  @ApiProperty() passagesProvided: number;
  @ApiProperty() passagesCited: number;
  @ApiProperty({ enum: Classification, nullable: true })
  effectiveClearance: Classification | null;
}

export class TurnResultDto {
  @ApiProperty({ format: 'uuid' }) conversationId: string;
  @ApiProperty({ type: MessageDto }) userMessage: MessageDto;
  @ApiProperty({ type: MessageDto }) assistantMessage: MessageDto;
  @ApiProperty({ type: TurnUsageDto }) usage: TurnUsageDto;
  @ApiProperty({ type: TurnTimingsDto }) timings: TurnTimingsDto;
  @ApiProperty({ type: TurnRetrievalSummaryDto }) retrieval: TurnRetrievalSummaryDto;
  @ApiProperty({ type: 'object', additionalProperties: true })
  context: Record<string, number>;
}
