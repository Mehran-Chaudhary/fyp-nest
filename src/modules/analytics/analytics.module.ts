import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { QuotasModule } from '../quotas/quotas.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * The Command Centre's backend (phase 5): per-workspace analytics over the
 * usage ledger, the tool ledger, workflow runs and the audit log.
 */
@Module({
  imports: [LlmModule, QuotasModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
