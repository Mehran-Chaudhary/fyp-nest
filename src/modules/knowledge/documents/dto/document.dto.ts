import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import { Classification } from '../../domain/classification';
import { DocumentFileType, DocumentStatus } from '../../domain/document-status';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Tags arrive from a multipart form as one comma-separated string and from JSON
 * as an array; both normalise to a trimmed, de-duplicated, lower-cased list.
 */
const NormaliseTags = () =>
  Transform(({ value }: { value: unknown }) => {
    const raw = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : value;
    if (!Array.isArray(raw)) return raw;
    return [
      ...new Set(
        raw
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  });

/** The file as multer hands it over, held in memory up to UPLOAD_MAX_FILE_SIZE. */
export interface UploadedDocumentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** The non-file fields of the multipart upload form. */
export class UploadDocumentDto {
  @ApiPropertyOptional({
    description: 'Defaults to the filename without its extension.',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Trim()
  title?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string;

  @ApiPropertyOptional({
    enum: Classification,
    description:
      'Defaults to the knowledge base’s default classification. Cannot exceed your clearance.',
  })
  @IsOptional()
  @IsEnum(Classification)
  classification?: Classification;

  @ApiPropertyOptional({
    description: 'Comma-separated labels.',
    example: 'policy,2026,leave',
    type: String,
  })
  @IsOptional()
  @NormaliseTags()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Trim()
  title?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string;

  @ApiPropertyOptional({
    enum: Classification,
    description:
      'Reclassification. Requires clearance for both the old and the new level — ' +
      'you cannot declassify what you are not cleared to read.',
  })
  @IsOptional()
  @IsEnum(Classification)
  classification?: Classification;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @NormaliseTags()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}

export class ListDocumentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  knowledgeBaseId?: string;

  @ApiPropertyOptional({ enum: DocumentStatus })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @ApiPropertyOptional({ enum: Classification })
  @IsOptional()
  @IsEnum(Classification)
  classification?: Classification;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class DocumentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  knowledgeBaseId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty()
  originalFilename: string;

  @ApiProperty({ enum: DocumentFileType })
  fileType: DocumentFileType;

  @ApiProperty({ description: 'Detected from the content, not taken from the client.' })
  mimeType: string;

  @ApiProperty({ example: '1048576', description: 'Bytes, as a string (bigint).' })
  sizeBytes: string;

  @ApiProperty({ enum: Classification })
  classification: Classification;

  @ApiProperty({
    enum: DocumentStatus,
    description: 'Progress of the latest processing run.',
  })
  status: DocumentStatus;

  @ApiProperty({ nullable: true })
  statusMessage: string | null;

  @ApiProperty({ nullable: true, example: 'DOCUMENT_UNPARSEABLE' })
  failureCode: string | null;

  @ApiProperty({
    description:
      'Whether retrieval currently serves this document. Stays true during a reindex: the ' +
      'previous version answers queries until the new one is complete.',
  })
  isSearchable: boolean;

  @ApiProperty()
  indexVersion: number;

  @ApiProperty({ nullable: true })
  activeIndexVersion: number | null;

  @ApiProperty()
  chunkCount: number;

  @ApiProperty()
  tokenCount: number;

  @ApiProperty({ nullable: true })
  pageCount: number | null;

  @ApiProperty({ nullable: true })
  language: string | null;

  @ApiProperty({ nullable: true })
  embeddingModel: string | null;

  @ApiProperty({
    description: 'Per-stage timings in milliseconds from the latest run.',
    example: { parseMs: 1840, embedMs: 3120, totalMs: 5410 },
  })
  processingMetrics: Record<string, number>;

  @ApiProperty({ format: 'uuid', nullable: true })
  uploadedById: string | null;

  @ApiProperty({ format: 'date-time' })
  lastStatusAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  processingCompletedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class DocumentChunkDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Also the chunk’s point id in the vector store.',
  })
  id: string;

  @ApiProperty()
  chunkIndex: number;

  @ApiProperty({ description: 'Decrypted text, exactly as it was embedded.' })
  text: string;

  @ApiProperty()
  tokenCount: number;

  @ApiProperty({ nullable: true })
  pageStart: number | null;

  @ApiProperty({ nullable: true })
  pageEnd: number | null;
}
