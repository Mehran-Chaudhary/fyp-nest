import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LlmModule } from '../llm/llm.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { HealthController } from './health.controller';
import { InferenceDependenciesHealthIndicator } from './indicators/inference-dependencies.health';
import { KnowledgeDependenciesHealthIndicator } from './indicators/knowledge-dependencies.health';
import { RedisHealthIndicator } from './indicators/redis.health';

/**
 * Liveness, readiness and dependency probes.
 *
 * `errorLogStyle: 'pretty'` keeps a failed probe readable in the console; the
 * structured logger still records the machine-readable version.
 */
@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'pretty' }), LlmModule, PrivacyModule],
  controllers: [HealthController],
  providers: [
    RedisHealthIndicator,
    KnowledgeDependenciesHealthIndicator,
    InferenceDependenciesHealthIndicator,
  ],
})
export class HealthModule {}
