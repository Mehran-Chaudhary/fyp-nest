import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LlmModule } from '../llm/llm.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { HealthController } from './health.controller';
import { InferenceDependenciesHealthIndicator } from './indicators/inference-dependencies.health';
import { KnowledgeDependenciesHealthIndicator } from './indicators/knowledge-dependencies.health';
import { OrchestrationHealthIndicator } from './indicators/orchestration.health';
import { RedisHealthIndicator } from './indicators/redis.health';

/**
 * Liveness, readiness and dependency probes.
 *
 * `errorLogStyle: 'pretty'` keeps a failed probe readable in the console; the
 * structured logger still records the machine-readable version.
 */
@Module({
  imports: [
    TerminusModule.forRoot({ errorLogStyle: 'pretty' }),
    LlmModule,
    PrivacyModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    RedisHealthIndicator,
    KnowledgeDependenciesHealthIndicator,
    InferenceDependenciesHealthIndicator,
    OrchestrationHealthIndicator,
  ],
})
export class HealthModule {}
