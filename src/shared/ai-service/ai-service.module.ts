import { Global, Module } from '@nestjs/common';
import { AiServiceClient } from './ai-service.client';

/**
 * Client for the Python AI service. Global: the ingestion worker uses it in
 * phase 2, and the LLM gateway and PII engine will in phase 3.
 */
@Global()
@Module({
  providers: [AiServiceClient],
  exports: [AiServiceClient],
})
export class AiServiceModule {}
