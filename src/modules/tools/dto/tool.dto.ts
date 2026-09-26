import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Classification } from '../../knowledge/domain/classification';
import { Integrity } from '../domain/information-flow';
import { ToolKind } from '../domain/tool-definition';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class ToolAuthDto {
  @ApiProperty({
    enum: ['none', 'bearer', 'header', 'basic'],
    description:
      'bearer: "Authorization: Bearer <secret>". header: "<headerName>: <secret>". ' +
      'basic: HTTP Basic with username and the secret as password.',
  })
  @IsIn(['none', 'bearer', 'header', 'basic'])
  type: 'none' | 'bearer' | 'header' | 'basic';

  @ApiPropertyOptional({ example: 'X-Api-Key' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  headerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  username?: string;
}

export class HttpToolConfigDto {
  @ApiProperty({ enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  @ApiProperty({
    example: 'https://api.example.com/v1/orders/{{orderId}}',
    description:
      'A fixed origin (checked against TOOL_HTTP_ALLOWED_HOSTS) and a path that may contain ' +
      '{{parameter}} placeholders. Arguments never reach the scheme, host or port.',
  })
  @IsString()
  @MaxLength(2048)
  url: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  query?: Record<string, string>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'JSON body for POST/PUT/PATCH. String values may be {{parameter}} templates.',
  })
  @IsOptional()
  body?: unknown;

  @ApiProperty({ type: ToolAuthDto })
  @ValidateNested()
  @Type(() => ToolAuthDto)
  auth: ToolAuthDto;

  @ApiPropertyOptional({
    example: '/data/items',
    description: 'JSON pointer into the response.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  responsePath?: string;
}

export class ToolDataPolicyDto {
  @ApiPropertyOptional({
    enum: Classification,
    description:
      'The most sensitive context that may flow into this tool. Defaults to PUBLIC, because ' +
      'the tool sends data to a third party.',
  })
  @IsOptional()
  @IsEnum(Classification)
  maxClassification?: Classification;

  @ApiPropertyOptional({
    enum: Integrity,
    description:
      'The least trusted context the tool may be called from. Tools with side effects ' +
      'default to INTERNAL: after reading untrusted external content, they are refused.',
  })
  @IsOptional()
  @IsEnum(Integrity)
  minIntegrity?: Integrity;

  @ApiPropertyOptional({
    enum: ['unmask', 'deny'],
    description:
      'deny (default): a call carrying personal data is refused. unmask: masked values are ' +
      'restored before sending — only for a service trusted with personal data. Audited.',
  })
  @IsOptional()
  @IsIn(['unmask', 'deny'])
  piiArguments?: 'unmask' | 'deny';

  @ApiPropertyOptional({
    description:
      'Whether the call changes something. Defaults to true for anything but GET.',
  })
  @IsOptional()
  @IsBoolean()
  sideEffects?: boolean;
}

class ToolWriteDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Trim()
  displayName?: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'What the tool does and when to use it. The model reads this.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  @Trim()
  description?: string;

  @ApiPropertyOptional({
    description:
      'JSON Schema (a strict subset) of the arguments. Must be an object schema. Keywords ' +
      'the platform does not enforce (pattern, oneOf, $ref, …) are rejected.',
  })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({ type: HttpToolConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => HttpToolConfigDto)
  http?: HttpToolConfigDto;

  @ApiPropertyOptional({ type: ToolDataPolicyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ToolDataPolicyDto)
  dataPolicy?: ToolDataPolicyDto;

  @ApiPropertyOptional({
    description:
      'Require a person to approve each call. Such tools run only as workflow tool nodes ' +
      'behind an approval node; agents cannot call them on their own.',
  })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({
    minimum: 500,
    description: 'Milliseconds, up to TOOL_MAX_TIMEOUT.',
  })
  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(600_000)
  timeoutMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateToolDto extends ToolWriteDto {
  @ApiProperty({
    example: 'lookup_order',
    description: 'The name the model calls it by: lower-case letters, digits, underscores.',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{2,47}$/, {
    message:
      'name must be 3–48 lower-case letters, digits or underscores, starting with a letter',
  })
  name: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Trim()
  declare displayName: string;

  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  @Trim()
  declare description: string;

  @ApiProperty()
  @IsObject()
  declare parameters: Record<string, unknown>;

  @ApiProperty({ type: HttpToolConfigDto })
  @ValidateNested()
  @Type(() => HttpToolConfigDto)
  declare http: HttpToolConfigDto;

  @ApiPropertyOptional({
    description: 'The credential. Write-only: stored encrypted and never returned.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  secret?: string;
}

export class UpdateToolDto extends ToolWriteDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Replace the credential; null removes it. Omit to keep it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  secret?: string | null;

  @ApiPropertyOptional({ description: 'The version you edited; 409 if it has moved on.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ListToolsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ToolKind })
  @IsOptional()
  @IsEnum(ToolKind)
  kind?: ToolKind;
}

export class ListToolExecutionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  toolId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  runId?: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class ToolDataPolicyViewDto {
  @ApiProperty({ enum: Classification }) maxClassification: Classification;
  @ApiProperty({ enum: Integrity }) minIntegrity: Integrity;
  @ApiProperty({ enum: ['unmask', 'deny'] }) piiArguments: 'unmask' | 'deny';
  @ApiProperty() sideEffects: boolean;
}

export class ToolDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ToolKind }) kind: ToolKind;
  @ApiProperty() name: string;
  @ApiProperty() displayName: string;
  @ApiProperty() description: string;
  @ApiProperty({ description: 'JSON Schema of the arguments.' })
  parameters: Record<string, unknown>;
  @ApiProperty({ type: ToolDataPolicyViewDto }) dataPolicy: ToolDataPolicyViewDto;
  @ApiProperty({ enum: Integrity }) resultIntegrity: Integrity;
  @ApiProperty() requiresApproval: boolean;
  @ApiProperty({ type: [String] }) requiredPermissions: string[];
  @ApiProperty() timeoutMs: number;
  @ApiProperty() version: number;
  @ApiProperty({ description: 'SHA-256 of the behaviour-defining fields.' }) digest: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ description: 'False when a dependency it needs is not configured.' })
  available: boolean;
  @ApiPropertyOptional({ type: HttpToolConfigDto }) http?: HttpToolConfigDto;
  @ApiPropertyOptional() hasSecret?: boolean;
  @ApiPropertyOptional({ nullable: true }) createdAt?: Date | null;
  @ApiPropertyOptional({ nullable: true }) updatedAt?: Date | null;
}

export class ToolExecutionDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true }) completedAt: Date | null;
  @ApiProperty() toolName: string;
  @ApiProperty({ nullable: true }) toolId: string | null;
  @ApiProperty({ nullable: true }) toolVersion: number | null;
  @ApiProperty() status: string;
  @ApiProperty({ nullable: true }) denialReason: string | null;
  @ApiProperty({ nullable: true }) errorCode: string | null;
  @ApiProperty({ nullable: true }) agentId: string | null;
  @ApiProperty({ nullable: true }) conversationId: string | null;
  @ApiProperty({ nullable: true }) workflowRunId: string | null;
  @ApiProperty({ nullable: true }) workflowStepId: string | null;
  @ApiProperty({ nullable: true }) durationMs: number | null;
  @ApiProperty() resultBytes: number;
  @ApiProperty({ nullable: true }) contextClassification: string | null;
  @ApiProperty({ nullable: true }) contextIntegrity: string | null;
  @ApiProperty() sideEffects: boolean;
  @ApiProperty({ description: 'Keyed digest of the arguments: correlates, never reveals.' })
  argumentsDigest: string | null;
}

export class TestToolDto {
  @ApiProperty({ description: 'Arguments, validated against the tool’s schema.' })
  @IsObject()
  arguments: Record<string, unknown>;
}

export class ToolTestResultDto {
  @ApiProperty({ enum: ['ok', 'error', 'denied'] }) status: 'ok' | 'error' | 'denied';
  @ApiProperty({ format: 'uuid' }) executionId: string;
  @ApiProperty() durationMs: number;
  @ApiPropertyOptional({
    description: 'The result, as the model would receive it (before masking).',
  })
  content?: string;
  @ApiPropertyOptional() truncated?: boolean;
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional() message?: string;
}
