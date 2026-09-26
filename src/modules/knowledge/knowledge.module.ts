import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { STORAGE_CONFIG_KEY, type StorageConfig } from '../../config/storage.config';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { DocumentChunk } from './entities/document-chunk.entity';
import { Document } from './entities/document.entity';
import { KnowledgeBaseGrant } from './entities/knowledge-base-grant.entity';
import { KnowledgeBase } from './entities/knowledge-base.entity';
import { IngestionPipeline } from './ingestion/ingestion.pipeline';
import { KnowledgeJobsService } from './ingestion/knowledge-jobs.service';
import { KnowledgeMaintenanceService } from './ingestion/knowledge-maintenance.service';
import { KnowledgeWorkersService } from './ingestion/knowledge-workers.service';
import { KnowledgeBaseAccessService } from './knowledge-bases/knowledge-base-access.service';
import { KnowledgeBasesController } from './knowledge-bases/knowledge-bases.controller';
import { KnowledgeBasesService } from './knowledge-bases/knowledge-bases.service';
import { KnowledgeReadinessService } from './knowledge-readiness.service';
import { RetrievalController } from './retrieval/retrieval.controller';
import { RetrievalService } from './retrieval/retrieval.service';

/**
 * The knowledge layer: phase 2 (proposal modules 6.4 Document Ingestion,
 * 6.5 Vector Embedding & Storage, 6.6 Secure RAG Retrieval).
 *
 * One module rather than three because the three share one data model and one
 * access policy: retrieval reads the chunks ingestion writes, both authorise
 * through the same compartments, and deleting a knowledge base must reach into
 * all of them. Splitting them would mean circular imports held together by
 * `forwardRef`.
 *
 * `RetrievalService` and `KnowledgeBaseAccessService` are exported for phase
 * 3, whose agents retrieve through this exact policy rather than a copy of it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([KnowledgeBase, KnowledgeBaseGrant, Document, DocumentChunk]),
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const storage = configService.getOrThrow<StorageConfig>(STORAGE_CONFIG_KEY);
        return {
          // No `storage` or `dest`: files are held in memory, bounded below.
          // They are encrypted before anything is written anywhere, so a
          // plaintext temp file on local disk would defeat the point.
          limits: {
            fileSize: storage.uploads.maxFileSizeBytes,
            files: 1,
            fields: 8,
            fieldSize: 16 * 1024,
            parts: 10,
          },
          // Browsers send UTF-8 filenames; multer's default would decode them
          // as Latin-1 and turn "Überblick.pdf" into mojibake.
          defParamCharset: 'utf8',
        };
      },
    }),
  ],
  controllers: [KnowledgeBasesController, DocumentsController, RetrievalController],
  providers: [
    KnowledgeReadinessService,
    KnowledgeBaseAccessService,
    KnowledgeBasesService,
    DocumentsService,
    KnowledgeJobsService,
    IngestionPipeline,
    KnowledgeMaintenanceService,
    KnowledgeWorkersService,
    RetrievalService,
  ],
  // Phase 3 builds on these: agents retrieve through RetrievalService, and the
  // PII engine's document reports read chunks through DocumentsService, so
  // both inherit this module's access checks rather than copying them.
  // Phase 4's knowledge_search tool checks readiness before it is offered.
  exports: [
    RetrievalService,
    KnowledgeBaseAccessService,
    DocumentsService,
    KnowledgeReadinessService,
  ],
})
export class KnowledgeModule {}
