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
import { GenerationParametersDto } from '../../llm/dto/llm.dto';
import {
  AgentAccessMode,
  AgentVisibility,
  type AgentTone,
  type GroundingMode,
} from '../domain/agent-config';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Instructions are long-form; generous, but bounded so one agent cannot fill a context window. */
export const MAX_INSTRUCTIONS_LENGTH = 12_000;

// ── Configuration sections ──────────────────────────────────────────────────

export class AgentPersonaDto {
  @ApiPropertyOptional({
    example: 'a strict HR policy auditor',
    description: 'Completes "You are <name>, …".',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Trim()
  role?: string | null;

  @ApiPropertyOptional({ enum: ['neutral', 'formal', 'friendly', 'concise'] })
  @IsOptional()
  @IsIn(['neutral', 'formal', 'friendly', 'concise'])
  tone?: AgentTone;

  @ApiPropertyOptional({
    example: 'English',
    nullable: true,
    description: 'Answer language. Null: the language the user writes in.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Trim()
  language?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Shown when a conversation starts. Never sent to the model.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Trim()
  greeting?: string | null;
}

export class AgentRetrievalDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Knowledge bases the agent consults. You must be able to read each one you add. ' +
      'Whoever uses the agent only ever retrieves what they could retrieve themselves.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  knowledgeBaseIds?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number;

  @ApiPropertyOptional({ enum: ['hybrid', 'dense'] })
  @IsOptional()
  @IsIn(['hybrid', 'dense'])
  mode?: 'hybrid' | 'dense';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  rerank?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 65_536,
    description: 'Token budget for passages.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65_536)
  maxContextTokens?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minScore?: number | null;

  @ApiPropertyOptional({
    enum: Classification,
    nullable: true,
    description:
      'Most sensitive classification this agent may retrieve, for anyone. Null: the user’s ' +
      'own clearance (and the model endpoint’s ceiling) decide.',
  })
  @IsOptional()
  @IsEnum(Classification)
  maxClassification?: Classification | null;
}

export class AgentMemoryDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 500, description: '0 disables memory.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  maxMessages?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 262_144 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(262_144)
  maxHistoryTokens?: number;
}

export class AgentToolsDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Tools the agent may call (ids from GET …/tools). Requires tool:read to grant. A grant ' +
      'is necessary, never sufficient: a tool is offered only when the person using the ' +
      'agent may run it (tool:execute and the tool’s own permissions).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  toolIds?: string[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 32,
    description:
      'Reason → act iterations per answer, up to TOOL_MAX_ITERATIONS. 0 disables tools.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32)
  maxIterations?: number;
}

/** Fields shared by create and update. */
class AgentBehaviourDto {
  @ApiPropertyOptional({ type: AgentPersonaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AgentPersonaDto)
  persona?: AgentPersonaDto;

  @ApiPropertyOptional({
    nullable: true,
    example: 'llama3.1:8b',
    description: 'Null: the workspace default model.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string | null;

  @ApiPropertyOptional({ type: GenerationParametersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GenerationParametersDto)
  parameters?: GenerationParametersDto;

  @ApiPropertyOptional({ nullable: true, minimum: 512 })
  @IsOptional()
  @IsInt()
  @Min(512)
  @Max(1_048_576)
  contextWindow?: number | null;

  @ApiPropertyOptional({ type: AgentRetrievalDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AgentRetrievalDto)
  retrieval?: AgentRetrievalDto;

  @ApiPropertyOptional({ type: AgentMemoryDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AgentMemoryDto)
  memory?: AgentMemoryDto;

  @ApiPropertyOptional({
    enum: ['STRICT', 'BALANCED'],
    description:
      'STRICT answers only from retrieved material; BALANCED may use general knowledge.',
  })
  @IsOptional()
  @IsIn(['STRICT', 'BALANCED'])
  grounding?: GroundingMode;

  @ApiPropertyOptional({ description: 'Ask the model to cite sources as [S1], [S2].' })
  @IsOptional()
  @IsBoolean()
  citations?: boolean;

  @ApiPropertyOptional({ type: AgentToolsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AgentToolsDto)
  tools?: AgentToolsDto;

  @ApiPropertyOptional({
    maxLength: MAX_INSTRUCTIONS_LENGTH,
    description: 'The system prompt: how the agent should behave. Stored encrypted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INSTRUCTIONS_LENGTH)
  instructions?: string;

  @ApiPropertyOptional({
    enum: AgentAccessMode,
    description:
      'WORKSPACE: any member with agent:execute may use it once published. RESTRICTED: only ' +
      'members holding one of allowedRoleIds.',
  })
  @IsOptional()
  @IsEnum(AgentAccessMode)
  accessMode?: AgentAccessMode;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  allowedRoleIds?: string[];
}

export class CreateAgentDto extends AgentBehaviourDto {
  @ApiProperty({ example: 'HR Assistant', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Trim()
  name: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string;
}

export class UpdateAgentDto extends AgentBehaviourDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Trim()
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string | null;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Recorded with the new version, like a commit message.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Trim()
  changeNote?: string;

  @ApiPropertyOptional({
    description:
      'The version you edited. If the agent has moved on, 409 instead of overwriting.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class RestoreVersionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Trim()
  changeNote?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ListAgentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AgentVisibility })
  @IsOptional()
  @IsEnum(AgentVisibility)
  visibility?: AgentVisibility;
}

export class PromptPreviewDto {
  @ApiProperty({ maxLength: 100_000, example: 'What is Ayesha Raza’s salary?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  content: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Include this conversation’s history, as the next turn would.',
  })
  @IsOptional()
  @IsUUID('4')
  conversationId?: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class AgentPersonaViewDto {
  @ApiProperty({ nullable: true }) role: string | null;
  @ApiProperty() tone: string;
  @ApiProperty({ nullable: true }) language: string | null;
  @ApiProperty({ nullable: true }) greeting: string | null;
}

export class AgentRetrievalViewDto {
  @ApiProperty() enabled: boolean;
  @ApiProperty({ type: [String], description: 'Only the bases you can see.' })
  knowledgeBaseIds: string[];
  @ApiProperty({
    description: 'Attached bases you cannot see. They stay attached when you edit.',
  })
  hiddenKnowledgeBases: number;
  @ApiProperty() topK: number;
  @ApiProperty() mode: string;
  @ApiProperty() rerank: boolean;
  @ApiProperty() maxContextTokens: number;
  @ApiProperty({ nullable: true }) minScore: number | null;
  @ApiProperty({ enum: Classification, nullable: true })
  maxClassification: Classification | null;
}

export class AgentConfigViewDto {
  @ApiProperty({ type: AgentPersonaViewDto }) persona: AgentPersonaViewDto;
  @ApiProperty({ nullable: true }) model: string | null;
  @ApiProperty({ type: GenerationParametersDto }) parameters: GenerationParametersDto;
  @ApiProperty({ nullable: true }) contextWindow: number | null;
  @ApiProperty({ type: AgentRetrievalViewDto }) retrieval: AgentRetrievalViewDto;
  @ApiProperty({ type: AgentMemoryDto }) memory: AgentMemoryDto;
  @ApiProperty({ enum: ['STRICT', 'BALANCED'] }) grounding: string;
  @ApiProperty() citations: boolean;
  @ApiProperty({ type: AgentToolsDto }) tools: AgentToolsDto;
}

export class AgentSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) description: string | null;
  @ApiProperty({ enum: AgentVisibility }) visibility: AgentVisibility;
  @ApiProperty({ enum: AgentAccessMode }) accessMode: AgentAccessMode;
  @ApiProperty() currentVersion: number;
  @ApiProperty({ nullable: true }) model: string | null;
  @ApiProperty({ nullable: true }) role: string | null;
  @ApiProperty({ nullable: true }) greeting: string | null;
  @ApiProperty() knowledgeBaseCount: number;
  @ApiProperty({ nullable: true }) createdById: string | null;
  @ApiProperty({ nullable: true }) publishedAt: Date | null;
  @ApiProperty({ nullable: true }) lastUsedAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ description: 'You may edit this agent.' }) canEdit: boolean;
}

export class AgentDto extends AgentSummaryDto {
  @ApiProperty({ type: AgentConfigViewDto }) config: AgentConfigViewDto;
  @ApiProperty({ description: 'The system prompt.' }) instructions: string;
  @ApiProperty({ type: [String] }) allowedRoleIds: string[];
}

export class AgentVersionDto {
  @ApiProperty() version: number;
  @ApiProperty({ type: AgentConfigViewDto }) config: AgentConfigViewDto;
  @ApiProperty() instructions: string;
  @ApiProperty({ description: 'SHA-256 of config and instructions.' }) configDigest: string;
  @ApiProperty({ nullable: true }) changeNote: string | null;
  @ApiProperty({ nullable: true }) restoredFromVersion: number | null;
  @ApiProperty({ nullable: true }) createdById: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() isCurrent: boolean;
}

export class PromptMessageDto {
  @ApiProperty({ enum: ['system', 'user', 'assistant'] }) role: string;
  @ApiProperty({ description: 'Exactly what the model receives: masked.' }) content: string;
}

export class ContextAccountingDto {
  @ApiProperty() contextWindow: number;
  @ApiProperty({ description: 'Prompt budget after reserving the answer and a margin.' })
  promptBudget: number;
  @ApiProperty() reservedForAnswer: number;
  @ApiProperty() systemTokens: number;
  @ApiProperty() passageTokens: number;
  @ApiProperty() historyTokens: number;
  @ApiProperty() userTokens: number;
  @ApiProperty() passagesIncluded: number;
  @ApiProperty() passagesDropped: number;
  @ApiProperty() historyIncluded: number;
  @ApiProperty({ description: 'Earlier messages left out by budget, limit or access.' })
  historyExcluded: number;
}

export class PromptPreviewResultDto {
  @ApiProperty() model: string;
  @ApiProperty() agentVersion: number;
  @ApiProperty() promptTemplateVersion: number;
  @ApiProperty({ type: [PromptMessageDto] }) messages: PromptMessageDto[];
  @ApiProperty({ type: ContextAccountingDto }) context: ContextAccountingDto;
  @ApiProperty({ type: 'object', additionalProperties: true }) redaction: Record<
    string,
    unknown
  >;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  retrieval: Record<string, unknown> | null;
}
