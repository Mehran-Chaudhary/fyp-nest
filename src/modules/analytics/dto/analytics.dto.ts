import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { UsageSummaryDto } from '../../llm/dto/llm.dto';

export enum SeriesMetric {
  TOKENS = 'tokens',
  INVOCATIONS = 'invocations',
  THROTTLED = 'throttled',
  FAILURES = 'failures',
  LATENCY_P95 = 'latency_p95',
  TTFT_P95 = 'ttft_p95',
  REDACTION_P95 = 'redaction_p95',
  ENTITIES_MASKED = 'entities_masked',
  WORKFLOW_RUNS = 'workflow_runs',
  WORKFLOW_FAILURES = 'workflow_failures',
  TOOL_CALLS = 'tool_calls',
  TOOL_DENIALS = 'tool_denials',
  SECURITY_EVENTS = 'security_events',
  RAG_QUERIES = 'rag_queries',
}

export enum SeriesInterval {
  HOUR = 'hour',
  DAY = 'day',
}

export enum TopDimension {
  AGENTS = 'agents',
  MODELS = 'models',
  MEMBERS = 'members',
  API_KEYS = 'api_keys',
}

export class AnalyticsRangeDto {
  @ApiPropertyOptional({ description: 'Defaults to 30 days ago.', format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Defaults to now.', format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class TimeseriesQueryDto extends AnalyticsRangeDto {
  @ApiProperty({ enum: SeriesMetric })
  @IsEnum(SeriesMetric)
  metric: SeriesMetric;

  @ApiPropertyOptional({
    enum: SeriesInterval,
    default: SeriesInterval.DAY,
    description: 'Hourly series cover at most 14 days; daily ones at most 400.',
  })
  @IsOptional()
  @IsEnum(SeriesInterval)
  interval?: SeriesInterval;
}

export class TopQueryDto extends AnalyticsRangeDto {
  @ApiProperty({
    enum: TopDimension,
    description: 'members and api_keys need quota:manage: they rank people and integrations.',
  })
  @IsEnum(TopDimension)
  dimension: TopDimension;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class SecurityEventsQueryDto extends AnalyticsRangeDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Cursor: only events strictly older than this (the last page’s oldest).',
    format: 'date-time',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  before?: Date;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class WorkflowAnalyticsDto {
  @ApiProperty() runs: number;
  @ApiProperty() completed: number;
  @ApiProperty() failed: number;
  @ApiProperty() cancelled: number;
  @ApiProperty() timedOut: number;
  @ApiProperty({ description: 'Queued, running or waiting for approval now.' }) active: number;
  @ApiProperty({ nullable: true }) durationP50Ms: number | null;
  @ApiProperty({ nullable: true }) durationP95Ms: number | null;
  @ApiProperty() tokens: number;
  @ApiProperty({ description: 'Steps that failed for good (metadata-only dead letters).' })
  deadLetters: number;
}

export class ToolAnalyticsDto {
  @ApiProperty() calls: number;
  @ApiProperty() succeeded: number;
  @ApiProperty() failed: number;
  @ApiProperty() timedOut: number;
  @ApiProperty() denied: number;
  @ApiProperty({ description: 'Refusals by reason: permission, information flow, budget…' })
  denialsByReason: Record<string, number>;
}

export class KnowledgeAnalyticsDto {
  @ApiProperty({ description: 'Documents by processing status, now.' })
  documentsByStatus: Record<string, number>;
  @ApiProperty() storedBytes: number;
  @ApiProperty() retrievalQueries: number;
  @ApiProperty({ description: 'Queries where the access policy withheld relevant documents.' })
  withheldEvents: number;
}

export class PrivacyAnalyticsDto {
  @ApiProperty() entitiesMasked: number;
  @ApiProperty() entitiesByType: Record<string, number>;
  @ApiProperty({ description: 'Prompts stopped at the gateway because PII survived masking.' })
  egressBlocked: number;
  @ApiProperty({ description: 'Calls refused because detection was unavailable (fail closed).' })
  refusedForRedaction: number;
  @ApiProperty() degradedRedactions: number;
}

export class GovernanceAnalyticsDto {
  @ApiProperty({ description: 'Model calls refused by a budget, the token rate or a breaker.' })
  throttledCalls: number;
  @ApiProperty() budgetExhaustions: number;
  @ApiProperty() rateLimitEvents: number;
  @ApiProperty() circuitBreaks: number;
  @ApiProperty() openCircuits: number;
  @ApiProperty({ description: 'Budgets at or above their alert threshold this period.' })
  budgetsNearLimit: number;
}

export class SecurityAnalyticsDto {
  @ApiProperty() bySeverity: Record<string, number>;
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  topAlerts: Array<{ action: string; count: number }>;
  @ApiProperty() failedSignIns: number;
  @ApiProperty() accessDenials: number;
}

export class ActivityAnalyticsDto {
  @ApiProperty({ description: 'Members who made at least one model call in the range.' })
  activeMembers: number;
  @ApiProperty() activeApiKeys: number;
  @ApiProperty() activeAgents: number;
  @ApiProperty() conversationsStarted: number;
  @ApiProperty({ description: 'Answers produced in conversations.' }) turns: number;
}

export class AnalyticsOverviewDto {
  @ApiProperty({ format: 'date-time' }) from: Date;
  @ApiProperty({ format: 'date-time' }) to: Date;
  @ApiProperty({ type: UsageSummaryDto }) inference: UsageSummaryDto;
  @ApiProperty({ type: ActivityAnalyticsDto }) activity: ActivityAnalyticsDto;
  @ApiProperty({ type: WorkflowAnalyticsDto }) workflows: WorkflowAnalyticsDto;
  @ApiProperty({ type: ToolAnalyticsDto }) tools: ToolAnalyticsDto;
  @ApiProperty({ type: KnowledgeAnalyticsDto }) knowledge: KnowledgeAnalyticsDto;
  @ApiProperty({ type: PrivacyAnalyticsDto }) privacy: PrivacyAnalyticsDto;
  @ApiProperty({ type: GovernanceAnalyticsDto }) governance: GovernanceAnalyticsDto;
  @ApiProperty({ type: SecurityAnalyticsDto }) security: SecurityAnalyticsDto;
}

export class SeriesPointDto {
  @ApiProperty({ format: 'date-time' }) at: Date;
  @ApiProperty({ nullable: true, description: 'Null where a percentile has no data.' })
  value: number | null;
}

export class TimeseriesDto {
  @ApiProperty({ enum: SeriesMetric }) metric: SeriesMetric;
  @ApiProperty({ enum: SeriesInterval }) interval: SeriesInterval;
  @ApiProperty({ format: 'date-time' }) from: Date;
  @ApiProperty({ format: 'date-time' }) to: Date;
  @ApiProperty({ type: [SeriesPointDto] }) points: SeriesPointDto[];
}

export class TopEntryDto {
  @ApiProperty({ nullable: true, description: 'Agent, member or key id; the model name for models.' })
  key: string | null;
  @ApiProperty({ nullable: true }) label: string | null;
  @ApiProperty() invocations: number;
  @ApiProperty() tokens: number;
  @ApiProperty() throttled: number;
}

export class SecurityEventDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'date-time' }) at: Date;
  @ApiProperty() action: string;
  @ApiProperty({ enum: ['WARNING', 'CRITICAL'] }) severity: string;
  @ApiProperty() status: string;
  @ApiProperty() actorType: string;
  @ApiProperty({ nullable: true }) actorLabel: string | null;
  @ApiProperty({ nullable: true }) resourceType: string | null;
  @ApiProperty({ nullable: true }) resourceId: string | null;
  @ApiProperty({ nullable: true }) errorCode: string | null;
  @ApiProperty({ nullable: true }) ipAddress: string | null;
  @ApiProperty({ nullable: true }) requestId: string | null;
}
