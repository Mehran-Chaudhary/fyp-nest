import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AccessLevel, KnowledgeBaseAccessMode } from '../../domain/access';
import { Classification } from '../../domain/classification';

export class RetrievalQueryDto {
  @ApiProperty({
    description: 'The question or search text.',
    example: 'How many days of annual leave do new employees get?',
    maxLength: 16384,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16_384)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  query: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Search only these knowledge bases. Narrows your access; it can never widen it — ' +
      'naming a base you cannot read returns 404.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  knowledgeBaseIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Search only these documents.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  documentIds?: string[];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 200,
    description: 'Defaults to RAG_DEFAULT_TOP_K.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  topK?: number;

  @ApiPropertyOptional({
    enum: ['hybrid', 'dense'],
    description:
      'hybrid: dense vectors and BM25 keyword matching fused with reciprocal rank fusion. ' +
      'dense: vectors only.',
  })
  @IsOptional()
  @IsIn(['hybrid', 'dense'])
  mode?: 'hybrid' | 'dense';

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: 'Minimum cosine similarity. Dense mode only.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minScore?: number;

  @ApiPropertyOptional({
    description:
      'Rerank candidates with the AI service’s cross-encoder, when it offers one.',
  })
  @IsOptional()
  @IsBoolean()
  rerank?: boolean;
}

export class RetrievedChunkDto {
  @ApiProperty({ format: 'uuid' })
  chunkId: string;

  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty()
  documentTitle: string;

  @ApiProperty({ format: 'uuid' })
  knowledgeBaseId: string;

  @ApiProperty()
  knowledgeBaseName: string;

  @ApiProperty({ enum: Classification })
  classification: Classification;

  @ApiProperty()
  chunkIndex: number;

  @ApiProperty({ nullable: true })
  pageStart: number | null;

  @ApiProperty({ nullable: true })
  pageEnd: number | null;

  @ApiProperty({ description: 'Rank, starting at 1.' })
  rank: number;

  @ApiProperty({
    description:
      'Relevance score. Cosine similarity in dense mode, a fused rank score in hybrid mode, ' +
      'a cross-encoder score when reranked. Comparable only within one response.',
  })
  score: number;

  @ApiProperty()
  text: string;
}

export class RetrievalTimingsDto {
  @ApiProperty() accessMs: number;
  @ApiProperty() embedMs: number;
  @ApiProperty() searchMs: number;
  @ApiProperty() hydrateMs: number;
  @ApiProperty() rerankMs: number;
  @ApiProperty() totalMs: number;
}

export class RetrievalResponseDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Identifies this retrieval in the audit log (`rag.query.executed`).',
  })
  retrievalId: string;

  @ApiProperty({ enum: ['hybrid', 'dense'] })
  mode: 'hybrid' | 'dense';

  @ApiProperty()
  topK: number;

  @ApiProperty()
  reranked: boolean;

  @ApiProperty()
  embeddingModel: string;

  @ApiProperty({ description: 'How many knowledge bases the search covered.' })
  knowledgeBasesSearched: number;

  @ApiProperty({
    enum: Classification,
    description: 'Your clearance, which bounded the search.',
  })
  clearance: Classification;

  @ApiProperty({
    enum: Classification,
    description:
      'The clearance actually applied: yours, or lower when an agent or the model endpoint ' +
      'imposes a ceiling.',
  })
  effectiveClearance: Classification;

  @ApiProperty({ type: [RetrievedChunkDto] })
  results: RetrievedChunkDto[];

  @ApiProperty({ type: RetrievalTimingsDto })
  timings: RetrievalTimingsDto;
}

export class AccessScopeKnowledgeBaseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: KnowledgeBaseAccessMode }) accessMode: KnowledgeBaseAccessMode;
  @ApiProperty({ enum: AccessLevel }) access: AccessLevel;
}

export class AccessScopeDto {
  @ApiProperty({ enum: Classification })
  clearance: Classification;

  @ApiProperty({ type: [String], enum: Classification })
  readableClassifications: Classification[];

  @ApiProperty({ description: 'True for the workspace owner, who bypasses compartments.' })
  bypassesCompartments: boolean;

  @ApiProperty({ type: [AccessScopeKnowledgeBaseDto] })
  knowledgeBases: AccessScopeKnowledgeBaseDto[];
}
