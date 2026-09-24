import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PII_CONFIG_KEY, type PiiConfig } from '../../config/pii.config';
import { AiServiceClient } from '../../shared/ai-service/ai-service.client';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiServiceNerDetector } from './detection/ai-service-ner.detector';
import {
  DisabledNerDetector,
  NER_DETECTOR,
  type NerDetector,
} from './detection/ner-detector';
import { PiiDetectionService } from './detection/pii-detection.service';
import { PresidioNerDetector } from './detection/presidio-ner.detector';
import { PiiPolicy } from './entities/pii-policy.entity';
import { PiiPolicyService } from './pii-policy.service';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
import { RedactionService } from './redaction.service';

/**
 * The PII redaction engine (proposal module 6.12, the research component).
 *
 * `RedactionService` is exported: the LLM gateway and the agent runtime mask
 * every prompt through it, and the conversation service masks one member's
 * data before another member sees it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PiiPolicy]), KnowledgeModule],
  controllers: [PrivacyController],
  providers: [
    {
      provide: NER_DETECTOR,
      inject: [ConfigService, AiServiceClient],
      useFactory: (
        configService: ConfigService,
        aiService: AiServiceClient,
      ): NerDetector => {
        const config = configService.getOrThrow<PiiConfig>(PII_CONFIG_KEY);
        switch (config.nerProvider) {
          case 'presidio':
            return new PresidioNerDetector(config);
          case 'none':
            return new DisabledNerDetector();
          case 'ai-service':
          default:
            return new AiServiceNerDetector(aiService, config.timeoutMs);
        }
      },
    },
    PiiDetectionService,
    PiiPolicyService,
    RedactionService,
    PrivacyService,
  ],
  exports: [RedactionService, PiiPolicyService, PiiDetectionService, NER_DETECTOR],
})
export class PrivacyModule {}
