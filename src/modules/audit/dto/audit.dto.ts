import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  AuditAction,
  AuditSeverity,
  AuditStatus,
} from '../../../common/enums/audit-action.enum';
import { ActorType } from '../../../common/enums/auth-type.enum';

export class QueryAuditLogsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: AuditAction,
    description: 'Exact action to filter by.',
  })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    description:
      'Action prefix, e.g. `member.` to see every membership event. Applied when ' +
      '`action` is not supplied.',
    example: 'member.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actionPrefix?: string;

  @ApiPropertyOptional({ enum: AuditStatus })
  @IsOptional()
  @IsEnum(AuditStatus)
  status?: AuditStatus;

  @ApiPropertyOptional({
    enum: AuditSeverity,
    description: 'Filter by severity. Use WARNING or CRITICAL for security triage.',
  })
  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @ApiPropertyOptional({ enum: ActorType })
  @IsOptional()
  @IsEnum(ActorType)
  actorType?: ActorType;

  @ApiPropertyOptional({ description: 'User id or API key id.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  actorId?: string;

  @ApiPropertyOptional({ example: 'role' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceType?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  resourceId?: string;

  @ApiPropertyOptional({
    description: 'Correlation id, for pulling every record from one request.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Inclusive lower bound.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ format: 'date-time', description: 'Inclusive upper bound.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional({ description: 'Source IP address.' })
  @IsOptional()
  @IsString()
  @MaxLength(45)
  ipAddress?: string;
}

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Position in this workspace’s hash chain, starting at 1.',
    example: '1042',
  })
  sequence: string;

  @ApiProperty({ enum: AuditAction })
  action: AuditAction;

  @ApiProperty({ enum: AuditStatus })
  status: AuditStatus;

  @ApiProperty({ enum: AuditSeverity })
  severity: AuditSeverity;

  @ApiProperty({ enum: ActorType })
  actorType: ActorType;

  @ApiProperty({ format: 'uuid', nullable: true })
  actorId: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Actor label as it was at the time, not as it is now.',
  })
  actorLabel: string | null;

  @ApiProperty({ nullable: true })
  resourceType: string | null;

  @ApiProperty({ nullable: true })
  resourceId: string | null;

  @ApiProperty({ nullable: true })
  resourceLabel: string | null;

  @ApiProperty({ nullable: true })
  ipAddress: string | null;

  @ApiProperty({ nullable: true })
  userAgent: string | null;

  @ApiProperty({ nullable: true })
  requestId: string | null;

  @ApiProperty({ nullable: true })
  httpMethod: string | null;

  @ApiProperty({ nullable: true })
  httpPath: string | null;

  @ApiProperty({ nullable: true })
  httpStatus: number | null;

  @ApiProperty({ nullable: true })
  durationMs: number | null;

  @ApiProperty({ nullable: true })
  errorCode: string | null;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({
    description: 'Structured context, with sensitive keys already redacted.',
  })
  metadata: Record<string, unknown>;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

/**
 * Result of recomputing a workspace's hash chain.
 *
 * A `valid: false` result names the exact sequence number at which the chain
 * diverges, which is what makes the verification actionable rather than merely
 * alarming.
 */
export class ChainVerificationDto {
  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty({
    description: 'False means the log has been altered since it was written.',
  })
  valid: boolean;

  @ApiProperty()
  recordsChecked: number;

  @ApiPropertyOptional({ description: 'Sequence number of the first failing record.' })
  brokenAtSequence?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  brokenRecordId?: string;

  @ApiPropertyOptional({ description: 'What specifically failed.' })
  reason?: string;

  @ApiProperty({ format: 'date-time' })
  verifiedAt: string;
}

export class AuditStatisticsDto {
  @ApiProperty({ description: 'Total records in this workspace’s chain.' })
  totalRecords: string;

  @ApiProperty({ description: 'Sequence number of the newest record.' })
  headSequence: string;

  @ApiProperty({ description: 'Counts by severity.' })
  bySeverity: Record<string, number>;

  @ApiProperty({ description: 'Counts by status.' })
  byStatus: Record<string, number>;

  @ApiProperty({ description: 'The ten most frequent actions.' })
  topActions: Array<{ action: string; count: number }>;
}
