import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsOptionalNotNull } from '../../../common/validation/optional';
import {
  QuotaEnforcement,
  QuotaManager,
  QuotaPeriod,
  QuotaScope,
} from '../domain/quota-model';

/** Largest single limit accepted: a trillion tokens is beyond any real budget. */
const MAX_LIMIT = 1_000_000_000_000;

export class CreateQuotaDto {
  @ApiProperty({
    enum: QuotaScope,
    description:
      'ORGANIZATION: the whole workspace. MEMBER, AGENT, API_KEY: one member (user id), agent or key.',
  })
  @IsEnum(QuotaScope)
  scope: QuotaScope;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The member’s user id, the agent id or the API key id. Omit for ORGANIZATION.',
  })
  @ValidateIf((dto: CreateQuotaDto) => dto.scope !== QuotaScope.ORGANIZATION)
  @IsUUID()
  subjectId?: string;

  @ApiProperty({
    enum: QuotaPeriod,
    description:
      'MINUTE is a rate (a token bucket that refills continuously); DAY and MONTH are ' +
      'budgets reset at the start of each UTC calendar period.',
  })
  @IsEnum(QuotaPeriod)
  period: QuotaPeriod;

  @ApiProperty({ description: 'Tokens (prompt and completion together).', example: 500000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  tokenLimit: number;

  @ApiPropertyOptional({
    enum: QuotaEnforcement,
    default: QuotaEnforcement.HARD,
    description: 'HARD refuses calls past the limit; SOFT alerts and lets them through.',
  })
  @IsOptionalNotNull()
  @IsEnum(QuotaEnforcement)
  enforcement?: QuotaEnforcement;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 80,
    description: 'Percentage at which quota managers are alerted, once per period.',
  })
  @IsOptionalNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  alertThreshold?: number;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  label?: string;
}

export class UpdateQuotaDto {
  @ApiPropertyOptional({ example: 750000 })
  @IsOptionalNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  tokenLimit?: number;

  @ApiPropertyOptional({ enum: QuotaEnforcement })
  @IsOptionalNotNull()
  @IsEnum(QuotaEnforcement)
  enforcement?: QuotaEnforcement;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptionalNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  alertThreshold?: number;

  @ApiPropertyOptional({ maxLength: 120, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class QuotaHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 36, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  periods?: number;
}

export class QuotaUsageDto {
  @ApiProperty() used: number;
  @ApiProperty({ description: 'Held by calls in flight (their worst case).' }) reserved: number;
  @ApiProperty() remaining: number;
  @ApiProperty({ description: 'Percentage of the limit consumed, in-flight calls included.' })
  percent: number;
  @ApiProperty({ format: 'date-time' }) periodStart: Date;
  @ApiProperty({ format: 'date-time' }) resetsAt: Date;
}

export class QuotaRateDto {
  @ApiProperty({
    nullable: true,
    description: 'Tokens that could be spent right now; null when the rate store is unavailable.',
  })
  available: number | null;
}

export class QuotaDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: QuotaScope }) scope: QuotaScope;
  @ApiProperty({ nullable: true, format: 'uuid' }) subjectId: string | null;
  @ApiProperty({ enum: QuotaPeriod }) period: QuotaPeriod;
  @ApiProperty() tokenLimit: number;
  @ApiProperty({ enum: QuotaEnforcement }) enforcement: QuotaEnforcement;
  @ApiProperty() alertThreshold: number;
  @ApiProperty({
    enum: QuotaManager,
    description: 'PLATFORM rows are the deployment’s limits and cannot be changed here.',
  })
  managedBy: QuotaManager;
  @ApiProperty({ nullable: true }) label: string | null;
  @ApiProperty({ type: QuotaUsageDto, nullable: true, description: 'For DAY and MONTH budgets.' })
  usage: QuotaUsageDto | null;
  @ApiProperty({ type: QuotaRateDto, nullable: true, description: 'For MINUTE rates.' })
  rate: QuotaRateDto | null;
}

export class QuotaHistoryEntryDto {
  @ApiProperty({ format: 'date-time' }) periodStart: Date;
  @ApiProperty() tokensUsed: number;
  @ApiProperty() requests: number;
  @ApiProperty({ description: 'Calls refused against this budget in the period.' })
  rejected: number;
  @ApiProperty({ nullable: true, format: 'date-time' }) alertedAt: Date | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) exhaustedAt: Date | null;
}

export class AgentCircuitDto {
  @ApiProperty({ format: 'uuid' }) agentId: string;
  @ApiProperty({ enum: ['closed', 'open'] }) state: 'closed' | 'open';
  @ApiPropertyOptional({ enum: ['RUNAWAY_SPEND', 'REPEATED_FAILURES'] }) reason?: string;
  @ApiPropertyOptional({ format: 'date-time' }) openedAt?: string;
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'When the circuit lets the next call through by itself.',
  })
  retryAt?: string;
}
