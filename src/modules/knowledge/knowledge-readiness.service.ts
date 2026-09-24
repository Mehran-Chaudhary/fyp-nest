import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { AiServiceClient } from '../../shared/ai-service/ai-service.client';
import { ObjectStorageService } from '../../shared/storage/object-storage.service';
import { VectorStoreService } from '../../shared/vector-store/vector-store.service';

export type KnowledgeCapability = 'ingestion' | 'retrieval' | 'download';

/**
 * Reports which cloud dependencies the knowledge layer is missing.
 *
 * The platform boots without them, so phase 1 features keep working on a
 * deployment where object storage, the vector store or the AI service have not
 * been provisioned yet. A request that needs one gets a 503 naming the exact
 * environment variables to set, instead of a stack trace from deep inside an
 * SDK.
 */
@Injectable()
export class KnowledgeReadinessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KnowledgeReadinessService.name);

  constructor(
    private readonly storage: ObjectStorageService,
    private readonly vectorStore: VectorStoreService,
    private readonly aiService: AiServiceClient,
  ) {}

  onApplicationBootstrap(): void {
    const missing = this.missing('ingestion');
    if (missing.length > 0) {
      this.logger.warn(
        `Knowledge layer not fully configured; document upload and retrieval are disabled ` +
          `until these are set: ${missing.join(', ')}. See docs/CLOUD_SETUP.md.`,
      );
    }
  }

  missing(capability: KnowledgeCapability): string[] {
    const missing: string[] = [];
    const needsStorage = capability !== 'retrieval';
    const needsCompute = capability !== 'download';

    if (needsStorage && !this.storage.isConfigured) missing.push('STORAGE_S3_BUCKET');
    if (needsCompute && !this.vectorStore.isConfigured) missing.push('QDRANT_URL');
    if (needsCompute && !this.aiService.isConfigured) missing.push('AI_SERVICE_URL');

    return missing;
  }

  assert(capability: KnowledgeCapability): void {
    const missing = this.missing(capability);
    if (missing.length === 0) return;

    throw new AppException(
      ErrorCode.KNOWLEDGE_LAYER_NOT_CONFIGURED,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        message: `This deployment is not configured for document ${capability} yet.`,
        details: { missingConfiguration: missing },
      },
    );
  }
}
