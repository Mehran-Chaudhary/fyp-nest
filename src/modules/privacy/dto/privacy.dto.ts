import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { DetectorFailureMode, NerProviderKind } from '../../../config/pii.config';
import {
  MAX_CUSTOM_TERM_LENGTH,
  MAX_CUSTOM_TERMS,
} from '../domain/recognizers/custom-terms.recognizer';

const TrimEach = () =>
  Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item: unknown) => (typeof item === 'string' ? item.trim() : item))
      : value,
  );

// ── Policy ──────────────────────────────────────────────────────────────────

export class UpdatePiiPolicyDto {
  @ApiPropertyOptional({
    description:
      'Master switch. false sends prompts to the model unmasked — an explicit, audited decision.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'CREDIT_CARD', 'SALARY'],
    description:
      'Entity types to mask. See GET …/pii/entity-types. CUSTOM is added automatically ' +
      'whenever the deny list is non-empty.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @Matches(/^[A-Za-z][A-Za-z0-9_]{1,40}$/, { each: true })
  entityTypes?: string[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: 'Detections below this confidence are not masked.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  scoreThreshold?: number;

  @ApiPropertyOptional({
    enum: ['REFUSE', 'DEGRADE_TO_PATTERNS'],
    description:
      'When the NER detector is unavailable: REFUSE the request (fail closed, the default) or ' +
      'continue masking only what the pattern recognizers find.',
  })
  @IsOptional()
  @IsIn(['REFUSE', 'DEGRADE_TO_PATTERNS'])
  onDetectorFailure?: DetectorFailureMode;

  @ApiPropertyOptional({ example: 'en', description: 'Language passed to the NER model.' })
  @IsOptional()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  language?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Values never masked, such as the organisation’s own name.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CUSTOM_TERMS)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(MAX_CUSTOM_TERM_LENGTH, { each: true })
  @TrimEach()
  allowList?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Terms always masked as CUSTOM: project code names, clients under NDA. Stored encrypted ' +
      'and shown only to holders of pii:policy:update.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CUSTOM_TERMS)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(MAX_CUSTOM_TERM_LENGTH, { each: true })
  @TrimEach()
  denyList?: string[];

  @ApiPropertyOptional({
    description: 'The version you edited. A mismatch returns 409 instead of overwriting.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class NerDetectorStatusDto {
  @ApiProperty({ enum: ['ai-service', 'presidio', 'none'] })
  kind: NerProviderKind;

  @ApiProperty()
  configured: boolean;

  @ApiProperty({ type: [String] })
  missingConfiguration: string[];
}

export class PiiPolicyDto {
  @ApiProperty({ enum: ['default', 'workspace'] })
  source: 'default' | 'workspace';

  @ApiProperty({ description: '0 while the platform defaults apply.' })
  version: number;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ type: [String] })
  entityTypes: string[];

  @ApiProperty({ type: [String], description: 'The subset that needs the NER detector.' })
  nerEntityTypes: string[];

  @ApiProperty()
  scoreThreshold: number;

  @ApiProperty({ enum: ['REFUSE', 'DEGRADE_TO_PATTERNS'] })
  onDetectorFailure: DetectorFailureMode;

  @ApiProperty()
  language: string;

  @ApiProperty({ type: [String] })
  allowList: string[];

  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'Null unless you hold pii:policy:update.',
  })
  denyList: string[] | null;

  @ApiProperty()
  denyListCount: number;

  @ApiProperty({ type: NerDetectorStatusDto })
  nerDetector: NerDetectorStatusDto;

  @ApiProperty({ type: [String] })
  warnings: string[];

  @ApiProperty({ nullable: true })
  updatedAt: Date | null;
}

export class EntityTypeDto {
  @ApiProperty() type: string;
  @ApiProperty() label: string;
  @ApiProperty() description: string;
  @ApiProperty({ enum: ['pattern', 'ner', 'custom'] }) detector:
    'pattern' | 'ner' | 'custom';
  @ApiProperty({ description: 'Whether this deployment can detect it right now.' })
  available: boolean;
  @ApiProperty() enabled: boolean;
  @ApiProperty() example: string;
}

// ── Analysis ────────────────────────────────────────────────────────────────

export class AnalyzeTextDto {
  @ApiProperty({
    example: 'Ayesha Raza (ayesha.raza@acme.test) earns PKR 950,000 per year.',
    maxLength: 200_000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200_000)
  text: string;

  @ApiPropertyOptional({
    description:
      'Include the detected values in the response. Requires pii:reveal, and is audited as ' +
      'pii.unmasked.',
  })
  @IsOptional()
  @IsBoolean()
  reveal?: boolean;
}

export class DetectedEntityDto {
  @ApiProperty() entityType: string;
  @ApiProperty({ description: 'UTF-16 offset in the canonicalised text.' }) start: number;
  @ApiProperty() end: number;
  @ApiProperty() score: number;
  @ApiProperty({ enum: ['pattern', 'ner', 'custom', 'propagation'] }) source: string;
  @ApiProperty() recognizer: string;
  @ApiProperty({ example: '[PERSON_1]' }) placeholder: string;
  @ApiPropertyOptional({ description: 'Present only when revealed.' }) value?: string;
}

export class RedactionTimingsDto {
  @ApiProperty() patternMs: number;
  @ApiProperty() nerMs: number;
  @ApiProperty() maskingMs: number;
  @ApiProperty() totalMs: number;
}

export class AnalyzeResultDto {
  @ApiProperty({ description: 'The text as the model would receive it.' })
  maskedText: string;

  @ApiProperty({ type: [DetectedEntityDto] })
  entities: DetectedEntityDto[];

  @ApiProperty({ description: 'Distinct entities (placeholders).' })
  entityCount: number;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  byType: Record<string, number>;

  @ApiProperty({
    description: 'NER was unavailable and the policy allowed pattern-only detection.',
  })
  degraded: boolean;

  @ApiProperty({ type: [String] })
  detectors: string[];

  @ApiProperty()
  revealed: boolean;

  @ApiProperty({ type: RedactionTimingsDto })
  timings: RedactionTimingsDto;
}

export class DocumentReportQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit: number = 10;

  @ApiPropertyOptional({ description: 'Include detected values. Requires pii:reveal.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  reveal?: boolean;
}

export class ChunkReportDto {
  @ApiProperty() chunkId: string;
  @ApiProperty() chunkIndex: number;
  @ApiProperty({ nullable: true }) pageStart: number | null;
  @ApiProperty({ description: 'What the model sees when this chunk is retrieved.' })
  maskedText: string;
  @ApiProperty({ type: [DetectedEntityDto] }) entities: DetectedEntityDto[];
}

export class DocumentPiiReportDto {
  @ApiProperty() documentId: string;
  @ApiProperty({ description: 'Chunks in this page of the report.' })
  chunks: ChunkReportDto[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  byType: Record<string, number>;
  @ApiProperty() entityCount: number;
  @ApiProperty() page: number;
  @ApiProperty() totalChunks: number;
  @ApiProperty() degraded: boolean;
  @ApiProperty() revealed: boolean;
  @ApiProperty({ type: RedactionTimingsDto }) timings: RedactionTimingsDto;
}
