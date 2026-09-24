import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import { AccessLevel, KnowledgeBaseAccessMode } from '../../domain/access';
import { Classification } from '../../domain/classification';
import { GrantSubjectType } from '../../entities/knowledge-base-grant.entity';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateKnowledgeBaseDto {
  @ApiProperty({ example: 'HR Policies', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Trim()
  name: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string;

  @ApiPropertyOptional({
    enum: KnowledgeBaseAccessMode,
    default: KnowledgeBaseAccessMode.WORKSPACE,
    description:
      'WORKSPACE: governed by role permissions like any other resource. RESTRICTED: ' +
      'a compartment — only explicitly granted roles, members or API keys can see it at all.',
  })
  @IsOptional()
  @IsEnum(KnowledgeBaseAccessMode)
  accessMode?: KnowledgeBaseAccessMode;

  @ApiPropertyOptional({
    enum: Classification,
    default: Classification.INTERNAL,
    description:
      'Classification applied to uploads that do not specify one. Cannot exceed your own clearance.',
  })
  @IsOptional()
  @IsEnum(Classification)
  defaultClassification?: Classification;

  @ApiPropertyOptional({
    description: 'Chunk size in tokens. Defaults to the workspace setting.',
    minimum: 64,
    maximum: 4096,
  })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(4096)
  chunkSize?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1024 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1024)
  chunkOverlap?: number;
}

export class UpdateKnowledgeBaseDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Trim()
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string;

  @ApiPropertyOptional({ enum: KnowledgeBaseAccessMode })
  @IsOptional()
  @IsEnum(KnowledgeBaseAccessMode)
  accessMode?: KnowledgeBaseAccessMode;

  @ApiPropertyOptional({ enum: Classification })
  @IsOptional()
  @IsEnum(Classification)
  defaultClassification?: Classification;

  @ApiPropertyOptional({ minimum: 64, maximum: 4096 })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(4096)
  chunkSize?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1024 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1024)
  chunkOverlap?: number;
}

export class ListKnowledgeBasesQueryDto extends PaginationQueryDto {}

export class UpsertGrantDto {
  @ApiProperty({ enum: GrantSubjectType })
  @IsEnum(GrantSubjectType)
  subjectType: GrantSubjectType;

  @ApiProperty({
    format: 'uuid',
    description: 'A role id, a membership id (not a user id) or an API key id.',
  })
  @IsUUID('4')
  subjectId: string;

  @ApiProperty({ enum: AccessLevel })
  @IsEnum(AccessLevel)
  accessLevel: AccessLevel;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class KnowledgeBaseStatsDto {
  @ApiProperty({ description: 'Documents you are cleared to see.' })
  documents: number;

  @ApiProperty()
  ready: number;

  @ApiProperty()
  processing: number;

  @ApiProperty()
  failed: number;

  @ApiProperty({ description: 'Bytes, as a string (bigint).', example: '1048576' })
  totalBytes: string;
}

export class KnowledgeBaseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ enum: KnowledgeBaseAccessMode })
  accessMode: KnowledgeBaseAccessMode;

  @ApiProperty({ enum: Classification })
  defaultClassification: Classification;

  @ApiProperty({ example: 'nomic-embed-text' })
  embeddingModel: string;

  @ApiProperty({ example: 768 })
  embeddingDimensions: number;

  @ApiProperty({ nullable: true })
  chunkSize: number | null;

  @ApiProperty({ nullable: true })
  chunkOverlap: number | null;

  @ApiProperty({ enum: AccessLevel, description: 'Your effective access level.' })
  access: AccessLevel;

  @ApiProperty({ type: KnowledgeBaseStatsDto })
  stats: KnowledgeBaseStatsDto;

  @ApiProperty({ format: 'uuid', nullable: true })
  createdById: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class KnowledgeBaseGrantDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: GrantSubjectType })
  subjectType: GrantSubjectType;

  @ApiProperty({ format: 'uuid' })
  subjectId: string;

  @ApiProperty({ description: 'Role name, member name or API key label.', nullable: true })
  subjectLabel: string | null;

  @ApiProperty({ enum: AccessLevel })
  accessLevel: AccessLevel;

  @ApiProperty({ format: 'uuid', nullable: true })
  grantedById: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
