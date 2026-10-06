import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ChatRole } from '../domain/generation';
import { IsOptionalNotNull } from '../../../common/validation/optional';

// ── Generation parameters ───────────────────────────────────────────────────

export class GenerationParametersDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 2, example: 0.3 })
  @IsOptionalNotNull()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ minimum: 0.01, maximum: 1 })
  @IsOptionalNotNull()
  @IsNumber()
  @Min(0.01)
  @Max(1)
  topP?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, description: 'Ollama only.' })
  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(500)
  topK?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 65536,
    description:
      'Capped by the platform and workspace ceilings, and by half the context window.',
  })
  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(65_536)
  maxOutputTokens?: number;

  @ApiPropertyOptional({ minimum: 0.5, maximum: 2, description: 'Ollama only.' })
  @IsOptionalNotNull()
  @IsNumber()
  @Min(0.5)
  @Max(2)
  repeatPenalty?: number;

  @ApiPropertyOptional({ description: 'For reproducible sampling.' })
  @IsOptionalNotNull()
  @IsInt()
  seed?: number;

  @ApiPropertyOptional({ type: [String], maxItems: 4 })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  stop?: string[];
}

// ── Direct chat ─────────────────────────────────────────────────────────────

export class ChatMessageDto {
  @ApiProperty({ enum: ['system', 'user', 'assistant'] })
  @IsIn(['system', 'user', 'assistant'])
  role: ChatRole;

  @ApiProperty({ maxLength: 32_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32_000)
  content: string;
}

export class DirectChatDto {
  @ApiProperty({
    type: [ChatMessageDto],
    description:
      'The conversation so far. Every message — system prompt included — is masked by the ' +
      'workspace redaction policy before it reaches the model.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];

  @ApiPropertyOptional({ description: 'Defaults to the workspace default model.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @ApiPropertyOptional({ type: GenerationParametersDto })
  @IsOptionalNotNull()
  @ValidateNested()
  @Type(() => GenerationParametersDto)
  parameters?: GenerationParametersDto;
}

export class TokenUsageDto {
  @ApiProperty() promptTokens: number;
  @ApiProperty() completionTokens: number;
  @ApiProperty({ description: 'The endpoint did not report counts; these are estimates.' })
  estimated: boolean;
}

export class RedactionReportDto {
  @ApiProperty() enabled: boolean;
  @ApiProperty({
    description: 'NER was unavailable; only pattern-based types were masked.',
  })
  degraded: boolean;
  @ApiProperty({ description: 'Distinct entities replaced by placeholders.' })
  entitiesMasked: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  byType: Record<string, number>;
  @ApiProperty({ description: 'Placeholders in the answer restored to real values.' })
  placeholdersResolved: number;
  @ApiProperty({ description: 'Placeholders the model invented, left as written.' })
  placeholdersUnresolved: number;
}

export class InferenceTimingsDto {
  @ApiProperty() redactionMs: number;
  @ApiProperty() queueMs: number;
  @ApiProperty({ nullable: true }) timeToFirstTokenMs: number | null;
  @ApiProperty() generationMs: number;
  @ApiProperty() totalMs: number;
}

export class ChatCompletionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Identifies this call in the usage ledger and the audit log.',
  })
  invocationId: string;

  @ApiProperty() model: string;

  @ApiProperty({ description: 'The answer, with placeholders restored for you.' })
  content: string;

  @ApiProperty({ nullable: true }) finishReason: string | null;

  @ApiProperty({ type: TokenUsageDto }) usage: TokenUsageDto;

  @ApiProperty({ type: RedactionReportDto }) redaction: RedactionReportDto;

  @ApiProperty({ type: InferenceTimingsDto }) timings: InferenceTimingsDto;
}

// ── Models and policy ───────────────────────────────────────────────────────

export class LlmModelDto {
  @ApiProperty({ example: 'llama3.1:8b' }) name: string;
  @ApiProperty({ nullable: true }) family: string | null;
  @ApiProperty({ nullable: true }) parameterSize: string | null;
  @ApiProperty({ nullable: true }) quantization: string | null;
  @ApiProperty({ nullable: true }) contextLength: number | null;
  @ApiProperty({ nullable: true }) sizeBytes: number | null;
  @ApiProperty({ description: 'Allowed for this workspace.' }) allowed: boolean;
  @ApiProperty() isDefault: boolean;
}

export class LlmModelsDto {
  @ApiProperty({ type: [LlmModelDto] }) models: LlmModelDto[];
  @ApiProperty({
    description:
      'False when the endpoint could not be reached and the list comes from configuration.',
  })
  verified: boolean;
}

export class UpdateLlmPolicyDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Models the workspace may use. Empty: every model the platform allows.',
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  allowedModels?: string[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null returns to the platform default.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  defaultModel?: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 16 })
  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(65_536)
  maxOutputTokens?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 512 })
  @IsOptional()
  @IsInt()
  @Min(512)
  @Max(1_048_576)
  maxContextTokens?: number | null;

  @ApiPropertyOptional({ description: 'The version you edited; a mismatch returns 409.' })
  @IsOptionalNotNull()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class EffectiveLlmLimitsDto {
  @ApiProperty() defaultModel: string;
  @ApiProperty() maxOutputTokens: number;
  @ApiProperty() maxContextTokens: number;
  @ApiProperty({
    type: [String],
    description: 'LLM_ALLOWED_MODELS; empty means unrestricted.',
  })
  platformAllowlist: string[];
  @ApiProperty({
    description:
      'The most sensitive document classification whose masked content may be sent to this ' +
      'endpoint (LLM_MAX_CLASSIFICATION). Agents never retrieve above it.',
  })
  maxClassification: string;
}

export class LlmPolicyDto {
  @ApiProperty({ enum: ['default', 'workspace'] }) source: 'default' | 'workspace';
  @ApiProperty() version: number;
  @ApiProperty({ type: [String] }) allowedModels: string[];
  @ApiProperty({ nullable: true }) defaultModel: string | null;
  @ApiProperty({ nullable: true }) maxOutputTokens: number | null;
  @ApiProperty({ nullable: true }) maxContextTokens: number | null;
  @ApiProperty({ type: EffectiveLlmLimitsDto }) effective: EffectiveLlmLimitsDto;
}

// ── Usage ───────────────────────────────────────────────────────────────────

export class UsageQueryDto {
  @ApiPropertyOptional({ description: 'Defaults to 30 days ago.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Defaults to now.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class UsageTotalsDto {
  @ApiProperty() invocations: number;
  @ApiProperty() completed: number;
  @ApiProperty() failed: number;
  @ApiProperty() cancelled: number;
  @ApiProperty({ description: 'Refused because redaction was unavailable (fail closed).' })
  refused: number;
  @ApiProperty({ description: 'Stopped by the gateway egress check.' })
  blocked: number;
  @ApiProperty({
    description: 'Refused by governance: a token budget, the token rate or an agent circuit (phase 5).',
  })
  throttled: number;
  @ApiProperty() promptTokens: number;
  @ApiProperty() completionTokens: number;
  @ApiProperty() entitiesMasked: number;
  @ApiProperty() degradedRedactions: number;
  @ApiProperty() estimatedTokenCounts: number;
}

export class UsageLatencyDto {
  @ApiProperty({ nullable: true }) totalP50: number | null;
  @ApiProperty({ nullable: true }) totalP95: number | null;
  @ApiProperty({ nullable: true }) timeToFirstTokenP50: number | null;
  @ApiProperty({ nullable: true }) timeToFirstTokenP95: number | null;
}

export class RedactionOverheadDto {
  @ApiProperty({ nullable: true }) p50Ms: number | null;
  @ApiProperty({ nullable: true }) p95Ms: number | null;
  @ApiProperty({ nullable: true }) p99Ms: number | null;
  @ApiProperty({
    nullable: true,
    description: 'Mean fraction of total latency spent in the PII engine.',
  })
  shareOfTotal: number | null;
}

export class UsageByModelDto {
  @ApiProperty() model: string;
  @ApiProperty() invocations: number;
  @ApiProperty() promptTokens: number;
  @ApiProperty() completionTokens: number;
  @ApiProperty({ nullable: true }) totalP50Ms: number | null;
}

export class UsageByAgentDto {
  @ApiProperty({ nullable: true, description: 'Null for direct gateway calls.' }) agentId:
    string | null;
  @ApiProperty() invocations: number;
  @ApiProperty() promptTokens: number;
  @ApiProperty() completionTokens: number;
}

export class UsageSummaryDto {
  @ApiProperty() from: Date;
  @ApiProperty() to: Date;
  @ApiProperty({ type: UsageTotalsDto }) totals: UsageTotalsDto;
  @ApiProperty({ type: UsageLatencyDto }) latencyMs: UsageLatencyDto;
  @ApiProperty({ type: RedactionOverheadDto }) redactionOverhead: RedactionOverheadDto;
  @ApiProperty({ type: [UsageByModelDto] }) byModel: UsageByModelDto[];
  @ApiProperty({ type: [UsageByAgentDto] }) byAgent: UsageByAgentDto[];
}
