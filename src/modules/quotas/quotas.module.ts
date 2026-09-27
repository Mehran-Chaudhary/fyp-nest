import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentCircuitService } from './agent-circuit.service';
import { UsageCounter } from './entities/usage-counter.entity';
import { UsageQuota } from './entities/usage-quota.entity';
import { GovernorService } from './governor.service';
import { QuotaMaintenanceService } from './quota-maintenance.service';
import { QuotaManagementService } from './quota-management.service';
import { QuotaService } from './quota.service';
import { QuotasController } from './quotas.controller';
import { TokenRateLimiterService } from './token-rate-limiter.service';

/**
 * Token quotas, throttling and agent circuit breaking (proposal module 6.14,
 * completed in phase 5).
 *
 * `GovernorService` is exported for the LLM gateway, which consults it before
 * every model call; `AgentCircuitService` for the agent runtime, which reports
 * agent-caused failures that happen outside a model call.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UsageQuota, UsageCounter])],
  controllers: [QuotasController],
  providers: [
    QuotaService,
    TokenRateLimiterService,
    AgentCircuitService,
    GovernorService,
    QuotaManagementService,
    QuotaMaintenanceService,
  ],
  exports: [GovernorService, QuotaService, AgentCircuitService],
})
export class QuotasModule {}
