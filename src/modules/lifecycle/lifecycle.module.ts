import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RbacModule } from '../rbac/rbac.module';
import { UsersModule } from '../users/users.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { DataLifecycleService } from './data-lifecycle.service';
import { PersonalDataController } from './personal-data.controller';
import { PersonalDataService } from './personal-data.service';

/**
 * The data lifecycle (phase 5): retention sweeps, audit archival and pruning,
 * and the self-service data-subject rights (export and erasure).
 */
@Module({
  imports: [
    UsersModule,
    AuthModule,
    AgentsModule,
    WorkflowsModule,
    OrganizationsModule,
    RbacModule,
  ],
  controllers: [PersonalDataController],
  providers: [DataLifecycleService, PersonalDataService],
  exports: [DataLifecycleService, PersonalDataService],
})
export class LifecycleModule {}
