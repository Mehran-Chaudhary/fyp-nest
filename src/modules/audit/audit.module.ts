import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller';
import { AuditRetentionService } from './audit-retention.service';
import { AuditService } from './audit.service';
import { AuditChainAnchor } from './entities/audit-chain-anchor.entity';
import { AuditLog } from './entities/audit-log.entity';

/**
 * The tamper-evident compliance log (proposal module 6.15).
 *
 * Marked `@Global` because auditing genuinely is cross-cutting: the permissions
 * guard, the rate limiter, the audit interceptor and almost every feature
 * service write to it. Threading the import through every module would add noise
 * without adding isolation, and — more importantly — would make it easy for a new
 * module to skip auditing simply by forgetting to import it.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, AuditChainAnchor])],
  controllers: [AuditController],
  // Phase 5: retention through the documented escape hatch, with signed anchors.
  providers: [AuditService, AuditRetentionService],
  exports: [AuditService, AuditRetentionService],
})
export class AuditModule {}
