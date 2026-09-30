import { ClassSerializerInterceptor, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { useContainer } from 'class-validator';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { HEADER } from '../common/constants/app.constants';
import { createValidationPipe } from '../common/validation/validation-pipe';
import { APP_CONFIG_KEY, type AppConfig } from '../config/app.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../config/security.config';
import {
  VECTOR_STORE_CONFIG_KEY,
  type VectorStoreConfig,
} from '../config/vector-store.config';
import { AiServiceClient } from '../shared/ai-service/ai-service.client';
import {
  AiServiceError,
  type EmbedInput,
  type EmbeddingBatch,
  type ParseDocumentInput,
  type ParsedDocument,
  type RerankInput,
  type RerankResult,
} from '../shared/ai-service/ai-service.types';
import { RequestContextService } from '../shared/context/request-context.service';
import {
  ObjectStorageError,
  ObjectStorageService,
} from '../shared/storage/object-storage.service';
import { VectorStoreService } from '../shared/vector-store/vector-store.service';
import { FakeAiService, MemoryObjectStorage, MemoryVectorStore } from './cloud-stand-ins';

/**
 * A development API server for frontend work on the Document Vault before the
 * cloud knowledge layer exists: `npm run start:standins`.
 *
 * The real application — PostgreSQL, Redis, BullMQ workers, guards, access
 * policy, encryption, audit — with the three cloud endpoints (object storage,
 * the vector store, the Python AI service) replaced by the in-memory stand-ins
 * the end-to-end suites use. Uploads go through the real pipeline and statuses,
 * retrieval through the real policy.
 *
 * What differs from production:
 *  - Stored files, chunks' vectors and search state live in this process and are
 *    lost on restart; documents uploaded before a restart then fail to download
 *    (410) or retrieve, so delete and upload them again.
 *  - Text and Markdown are chunked by paragraph. PDF and DOCX text extraction
 *    needs the real AI service, so they get three stand-in pages.
 *  - Scores come from a bag-of-words embedding; ranking is plausible, not good.
 *  - A file whose text contains `STANDIN_FAIL_PERMANENT`, `STANDIN_FAIL_TRANSIENT`
 *    or `STANDIN_NO_TEXT` fails ingestion the way a password-protected PDF, an AI
 *    service outage or a scanned document does, to design those states.
 *
 * Development only: refuses to start with NODE_ENV=production. Mirrors the HTTP
 * setup of `main.ts` (prefix, versioning, validation, CORS, cookies).
 */

const PARSE_DELAY_MS = Number(process.env.STANDIN_PARSE_DELAY_MS ?? 1500);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A missing object is reported the way S3 reports it, so downloads answer 410. */
class DevObjectStorage extends MemoryObjectStorage {
  override get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) {
      return Promise.reject(new ObjectStorageError(`No object ${key}.`, false, true));
    }
    return Promise.resolve(Buffer.from(object));
  }
}

/** Reports the configured embedding model, so knowledge bases look as in production. */
class DevVectorStore extends MemoryVectorStore {
  private readonly embedding: VectorStoreConfig['embedding'];

  constructor(configService: ConfigService) {
    super(configService);
    this.embedding =
      configService.getOrThrow<VectorStoreConfig>(VECTOR_STORE_CONFIG_KEY).embedding;
  }

  override get embeddingModel(): string {
    return this.embedding.model;
  }

  override get embeddingDimensions(): number {
    return this.embedding.dimensions;
  }
}

class DevAiService extends FakeAiService {
  private readonly model: string;

  constructor(configService: ConfigService, context: RequestContextService) {
    super(configService, context);
    this.model =
      configService.getOrThrow<VectorStoreConfig>(VECTOR_STORE_CONFIG_KEY).embedding.model;
    // Names the stand-in NER model tags as PERSON, for the PII report.
    this.knownNames = ['Ayesha Raza', 'Sara Khan', 'Imran Qureshi', 'Ahmad Hanbal'];
  }

  override async parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
    // Slow enough for the UI to show PARSING and EMBEDDING.
    await sleep(PARSE_DELAY_MS);
    const text = input.content.toString('utf8');

    if (text.includes('STANDIN_FAIL_PERMANENT')) {
      throw new AiServiceError(
        'ENCRYPTED_DOCUMENT',
        'The PDF is password protected. Remove the password and upload it again.',
        false,
        422,
      );
    }
    if (text.includes('STANDIN_FAIL_TRANSIENT')) {
      throw new AiServiceError('AI_SERVICE_UNAVAILABLE', 'Simulated outage.', true, 503);
    }
    if (text.includes('STANDIN_NO_TEXT')) {
      return { pageCount: 1, language: null, chunks: [], parser: 'standin@1' };
    }

    if (input.fileType === 'pdf' || input.fileType === 'docx') {
      const pages = [1, 2, 3].map(
        (page) =>
          `Stand-in text for page ${page} of ${input.filename}. Real extraction needs ` +
          'the AI service. Contact Ayesha Raza at ayesha.raza@acme.test.',
      );
      return {
        pageCount: pages.length,
        language: 'en',
        parser: 'standin-binary@1',
        chunks: pages.map((chunk, index) => ({
          index,
          text: chunk,
          tokenCount: chunk.split(/\s+/).length,
          pageStart: index + 1,
          pageEnd: index + 1,
        })),
      };
    }

    const parsed = await super.parseDocument(input);
    return {
      ...parsed,
      pageCount: null,
      parser: 'standin-text@1',
      chunks: parsed.chunks.map((chunk) => ({ ...chunk, pageStart: null, pageEnd: null })),
    };
  }

  override async embed(input: EmbedInput): Promise<EmbeddingBatch> {
    if (input.inputType === 'document') await sleep(Math.min(PARSE_DELAY_MS, 800));
    return { ...(await super.embed(input)), model: this.model };
  }

  /** Word overlap with the query: enough to show a reranked order. */
  override rerank(input: RerankInput): Promise<RerankResult> {
    const words = new Set(
      input.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    );
    const results = input.documents
      .map((document, index) => {
        const hits = document
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => words.has(word)).length;
        return { index, score: hits / (hits + 3) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, input.topN);
    return Promise.resolve({ model: 'standin-rerank@1', results });
  }
}

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The stand-ins server is for development only.');
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ObjectStorageService)
    .useFactory({
      factory: (config: ConfigService) => new DevObjectStorage(config),
      inject: [ConfigService],
    })
    .overrideProvider(VectorStoreService)
    .useFactory({
      factory: (config: ConfigService) => new DevVectorStore(config),
      inject: [ConfigService],
    })
    .overrideProvider(AiServiceClient)
    .useFactory({
      factory: (config: ConfigService, context: RequestContextService) =>
        new DevAiService(config, context),
      inject: [ConfigService, RequestContextService],
    })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
  const security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);

  app.set('trust proxy', security.trustProxy);
  app.use(compression());
  app.use(cookieParser(security.refreshCookie.secret));
  app.enableCors({
    origin: security.cors.allowAnyOrigin ? true : security.cors.origins,
    credentials: security.cors.credentials,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      HEADER.ORGANIZATION_ID,
      HEADER.ORGANIZATION_SLUG,
      HEADER.REQUEST_ID,
      HEADER.API_KEY,
    ],
    exposedHeaders: [
      HEADER.REQUEST_ID,
      HEADER.RATE_LIMIT_LIMIT,
      HEADER.RATE_LIMIT_REMAINING,
      HEADER.RATE_LIMIT_RESET,
      HEADER.RETRY_AFTER,
      'content-disposition',
    ],
    maxAge: 86_400,
  });
  if (appConfig.globalPrefix) {
    app.setGlobalPrefix(appConfig.globalPrefix, {
      exclude: ['health', 'health/live', 'health/ready'],
    });
  }
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: appConfig.apiVersion });
  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.enableShutdownHooks();

  await app.listen(appConfig.port, appConfig.host);

  new Logger('Stand-ins').warn(
    `Development API with in-memory object storage, vector store and AI service on ` +
      `port ${appConfig.port}. Uploaded files are lost on restart.`,
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start the stand-ins server:\n', error);
  process.exit(1);
});
