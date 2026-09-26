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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Classification } from '../../knowledge/domain/classification';
import { Integrity } from '../../tools/domain/information-flow';
import { FailureClass, RunStatus, RunTrigger, StepStatus } from '../domain/run-state';
import { WorkflowStatus } from '../entities/workflow.entity';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

// ── Definitions ─────────────────────────────────────────────────────────────

export class WorkflowSettingsDto {
  @ApiPropertyOptional({
    minimum: 2,
    description: 'Step ceiling for one run, up to WORKFLOW_MAX_STEPS.',
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(10_000)
  maxSteps?: number;

  @ApiPropertyOptional({
    minimum: 1000,
    description: 'Token budget for one run, up to WORKFLOW_MAX_TOKENS_PER_RUN.',
  })
  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(100_000_000)
  maxTokens?: number;

  @ApiPropertyOptional({
    minimum: 1000,
    description: 'Milliseconds, up to WORKFLOW_RUN_TIMEOUT.',
  })
  @IsOptional()
  @IsInt()
  @Min(1_000)
  runTimeoutMs?: number;
}

export class CreateWorkflowDto {
  @ApiProperty({ example: 'Policy question pipeline', maxLength: 80 })
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

  @ApiPropertyOptional({
    description:
      'The canvas graph (see docs/contracts/workflow-graph-v1.md). Default: trigger → output.',
  })
  @IsOptional()
  @IsObject()
  graph?: Record<string, unknown>;

  @ApiPropertyOptional({ type: WorkflowSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowSettingsDto)
  settings?: WorkflowSettingsDto;
}

export class SaveDefinitionDto {
  @ApiProperty({
    description: 'The whole canvas graph. Saved even when invalid, with its report.',
  })
  @IsObject()
  graph: Record<string, unknown>;

  @ApiPropertyOptional({ type: WorkflowSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowSettingsDto)
  settings?: WorkflowSettingsDto;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Trim()
  changeNote?: string;

  @ApiPropertyOptional({ description: 'The version you edited; 409 if it has moved on.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ValidateWorkflowDto {
  @ApiProperty()
  @IsObject()
  graph: Record<string, unknown>;
}

export class UpdateWorkflowDto {
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
}

export class PublishWorkflowDto {
  @ApiPropertyOptional({ description: 'Default: the current version. It must be valid.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class RestoreWorkflowVersionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Trim()
  changeNote?: string;
}

export class ListWorkflowsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WorkflowStatus })
  @IsOptional()
  @IsEnum(WorkflowStatus)
  status?: WorkflowStatus;
}

export class GraphIssueDto {
  @ApiProperty() code: string;
  @ApiProperty() message: string;
  @ApiPropertyOptional() nodeId?: string;
  @ApiPropertyOptional() edgeId?: string;
}

export class ValidationReportDto {
  @ApiProperty() valid: boolean;
  @ApiProperty({ type: [GraphIssueDto] }) errors: GraphIssueDto[];
  @ApiProperty({ type: [GraphIssueDto] }) warnings: GraphIssueDto[];
  @ApiProperty({ nullable: true, description: 'Worst-case steps a run can schedule.' })
  stepBound: number | null;
}

export class WorkflowVersionDto {
  @ApiProperty() version: number;
  @ApiProperty({ description: 'The canvas graph.' }) graph: Record<string, unknown>;
  @ApiProperty({ type: WorkflowSettingsDto }) settings: WorkflowSettingsDto;
  @ApiProperty({ description: 'SHA-256 of the graph and settings.' }) digest: string;
  @ApiProperty() valid: boolean;
  @ApiProperty({ type: ValidationReportDto }) validation: ValidationReportDto;
  @ApiProperty({ nullable: true }) changeNote: string | null;
  @ApiProperty({ nullable: true }) restoredFromVersion: number | null;
  @ApiProperty({ nullable: true }) createdById: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() isCurrent: boolean;
  @ApiProperty() isPublished: boolean;
}

export class WorkflowSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) description: string | null;
  @ApiProperty({ enum: WorkflowStatus }) status: WorkflowStatus;
  @ApiProperty() currentVersion: number;
  @ApiProperty({ nullable: true, description: 'The version runs use.' }) publishedVersion:
    number | null;
  @ApiProperty({ nullable: true }) createdById: string | null;
  @ApiProperty({ nullable: true }) publishedAt: Date | null;
  @ApiProperty({ nullable: true }) lastRunAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class WorkflowDto extends WorkflowSummaryDto {
  @ApiProperty({
    type: WorkflowVersionDto,
    description: 'The current (latest saved) version.',
  })
  definition: WorkflowVersionDto;
}

// ── Runs ────────────────────────────────────────────────────────────────────

export class StartRunDto {
  @ApiProperty({
    description:
      'Must match the trigger’s input schema. Default schema: { "input": string }.',
    example: { input: 'Summarise our annual leave policy for new joiners.' },
  })
  @IsObject()
  input: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Starting a run twice with the same key returns the first run.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;

  @ApiPropertyOptional({
    description:
      'Run a specific version instead of the published one — a test run of a draft. ' +
      'Requires workflow:update.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class ListRunsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['mine', 'all'],
    description: 'all requires workflow:read_all.',
  })
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: 'mine' | 'all';

  @ApiPropertyOptional({ enum: RunStatus })
  @IsOptional()
  @IsEnum(RunStatus)
  status?: RunStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  workflowId?: string;
}

export class RunContentQueryDto {
  @ApiPropertyOptional({
    description:
      'In someone else’s run, show personal data unmasked. Requires pii:reveal; audited.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  reveal?: boolean;
}

export class ApprovalDecisionDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @ApiPropertyOptional({ maxLength: 2000, description: 'Stored encrypted with the run.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class DeadLettersQueryDto extends PaginationQueryDto {}

export class StepToolCallDto {
  @ApiProperty() executionId: string;
  @ApiProperty() tool: string;
  @ApiProperty({ enum: ['ok', 'error', 'denied'] }) status: string;
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional() reason?: string;
  @ApiProperty() durationMs: number;
}

export class StepDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() nodeId: string;
  @ApiProperty() nodeType: string;
  @ApiProperty() iteration: number;
  @ApiProperty({ enum: StepStatus }) status: StepStatus;
  @ApiProperty({ type: [String], description: 'The outcomes taken: which edges are live.' })
  handles: string[];
  @ApiProperty({
    type: [String],
    description: '`nodeId#iteration` of the steps that made this one ready.',
  })
  predecessors: string[];
  @ApiProperty() attempt: number;
  @ApiProperty() maxAttempts: number;
  @ApiProperty({ enum: Classification }) classification: Classification;
  @ApiProperty({ enum: Integrity }) integrity: Integrity;
  @ApiProperty({ nullable: true }) agentId: string | null;
  @ApiProperty({ nullable: true }) agentVersion: number | null;
  @ApiProperty({ nullable: true }) toolId: string | null;
  @ApiProperty({ nullable: true }) toolVersion: number | null;
  @ApiProperty({ nullable: true }) model: string | null;
  @ApiProperty() promptTokens: number;
  @ApiProperty() completionTokens: number;
  @ApiProperty({ type: [StepToolCallDto] }) toolCalls: StepToolCallDto[];
  @ApiProperty({ nullable: true }) errorCode: string | null;
  @ApiProperty({ enum: FailureClass, nullable: true }) failureClass: FailureClass | null;
  @ApiProperty() deadLettered: boolean;
  @ApiProperty({ nullable: true }) approval: {
    requestedAt: string;
    expiresAt: string;
    decision?: string;
    decidedAt?: string;
    decidedBy?: string;
    decidedById?: string | null;
  } | null;
  @ApiProperty() inputBytes: number;
  @ApiProperty() outputBytes: number;
  @ApiProperty({ nullable: true }) startedAt: Date | null;
  @ApiProperty({ nullable: true }) completedAt: Date | null;
  @ApiProperty({ nullable: true }) durationMs: number | null;
  @ApiProperty() createdAt: Date;
}

export class RunDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) workflowId: string;
  @ApiProperty() workflowVersion: number;
  @ApiProperty({ enum: RunStatus }) status: RunStatus;
  @ApiProperty({ enum: RunTrigger }) trigger: RunTrigger;
  @ApiProperty({ nullable: true }) initiatorUserId: string | null;
  @ApiProperty({ nullable: true }) initiatorApiKeyId: string | null;
  @ApiProperty({
    enum: Classification,
    description: 'The most sensitive data the run touched.',
  })
  classification: Classification;
  @ApiProperty({ enum: Integrity }) integrity: Integrity;
  @ApiProperty() maxSteps: number;
  @ApiProperty() stepsScheduled: number;
  @ApiProperty() maxTokens: number;
  @ApiProperty() tokensUsed: number;
  @ApiProperty() toolCalls: number;
  @ApiProperty({ nullable: true }) errorCode: string | null;
  @ApiProperty({ nullable: true }) errorStepId: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true }) startedAt: Date | null;
  @ApiProperty({ nullable: true }) completedAt: Date | null;
  @ApiProperty() deadlineAt: Date;
  @ApiPropertyOptional({
    description: 'Set when this run was returned for a repeated idempotency key.',
  })
  duplicate?: boolean;
}

export class RunDetailDto extends RunDto {
  @ApiProperty({ type: [StepDto] }) steps: StepDto[];
}

export class ContentDto {
  @ApiProperty({ enum: ['VISIBLE', 'MASKED', 'WITHHELD'] })
  contentState: 'VISIBLE' | 'MASKED' | 'WITHHELD';
  @ApiPropertyOptional({
    enum: ['CLEARANCE', 'COMPARTMENT', 'SOURCE_DELETED', 'NOT_AVAILABLE'],
  })
  withheldReason?: string;
  @ApiPropertyOptional({ description: 'Null when withheld.' }) input?: unknown;
  @ApiPropertyOptional({ description: 'Null when withheld.' }) output?: unknown;
  @ApiProperty({ enum: Classification }) classification: Classification;
}

export class ApprovalItemDto {
  @ApiProperty({ format: 'uuid' }) runId: string;
  @ApiProperty({ format: 'uuid' }) stepId: string;
  @ApiProperty({ format: 'uuid' }) workflowId: string;
  @ApiProperty() nodeId: string;
  @ApiProperty() requestedAt: string;
  @ApiProperty() expiresAt: string;
  @ApiProperty({ nullable: true }) initiatorUserId: string | null;
  @ApiProperty({ enum: Classification }) classification: Classification;
  @ApiProperty({ nullable: true, description: 'Withheld when you are not cleared for it.' })
  message: string | null;
  @ApiProperty() canDecide: boolean;
}

export class DeadLetterDto {
  @ApiProperty({ format: 'uuid' }) runId: string;
  @ApiProperty({ format: 'uuid' }) stepId: string;
  @ApiProperty({ format: 'uuid' }) workflowId: string;
  @ApiProperty() workflowVersion: number;
  @ApiProperty() nodeId: string;
  @ApiProperty() nodeType: string;
  @ApiProperty() iteration: number;
  @ApiProperty() attempts: number;
  @ApiProperty({ nullable: true }) errorCode: string | null;
  @ApiProperty({ enum: FailureClass, nullable: true }) failureClass: FailureClass | null;
  @ApiProperty() deadLetteredAt: Date;
  @ApiProperty({ enum: RunStatus }) runStatus: RunStatus;
}

export class TraceDto {
  @ApiProperty() runId: string;
  @ApiProperty({ description: 'The trace rebuilt from the hash-chained audit log alone.' })
  complete: boolean;
  @ApiProperty({ type: [String] }) problems: string[];
  @ApiProperty({ type: 'object', additionalProperties: true }) trace: Record<
    string,
    unknown
  >;
}
