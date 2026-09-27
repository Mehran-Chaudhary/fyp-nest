import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import { createTlsFetch } from '../../shared/http/outbound-tls';
import { PrivacyModule } from '../privacy/privacy.module';
import { QuotasModule } from '../quotas/quotas.module';
import { DirectChatService } from './direct-chat.service';
import { LlmInvocation } from './entities/llm-invocation.entity';
import { LlmPolicy } from './entities/llm-policy.entity';
import { LlmController } from './llm.controller';
import { LlmGatewayService } from './llm-gateway.service';
import { LlmPolicyService } from './llm-policy.service';
import { ModelCatalogueService } from './model-catalogue.service';
import { OllamaProvider } from './providers/ollama.provider';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider';
import {
  LLM_FETCH,
  LLM_PROVIDER,
  type FetchLike,
  type LlmProvider,
} from './providers/provider.types';
import { UsageService } from './usage.service';

/**
 * The LLM gateway (proposal module 6.7).
 *
 * The HTTP transport is a provider of its own (`LLM_FETCH`), so tests can put
 * a scripted model behind the real providers and exercise the whole path —
 * streaming, parsing, deadlines — without a GPU.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([LlmPolicy, LlmInvocation]),
    PrivacyModule,
    // Phase 5: every model call is admitted by the governor (quotas, token
    // rate, agent circuit breakers) before it is sent.
    QuotasModule,
  ],
  controllers: [LlmController],
  providers: [
    {
      provide: LLM_FETCH,
      inject: [ConfigService],
      // Phase 5: a client certificate, when configured, for an endpoint whose
      // proxy verifies them (mutual TLS); the global fetch otherwise.
      useFactory: (configService: ConfigService): FetchLike =>
        createTlsFetch(configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY).tls) ??
        ((input, init) => fetch(input, init)),
    },
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, LLM_FETCH],
      useFactory: (configService: ConfigService, fetchImpl: FetchLike): LlmProvider => {
        const config = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
        return config.provider === 'openai'
          ? new OpenAiCompatibleProvider(config, fetchImpl)
          : new OllamaProvider(config, fetchImpl);
      },
    },
    ModelCatalogueService,
    LlmGatewayService,
    LlmPolicyService,
    UsageService,
    DirectChatService,
  ],
  exports: [LlmGatewayService, LlmPolicyService, UsageService, ModelCatalogueService],
})
export class LlmModule {}
