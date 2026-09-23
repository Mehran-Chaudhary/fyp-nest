import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationMember } from '../memberships/entities/organization-member.entity';
import { RbacModule } from '../rbac/rbac.module';
import { OrganizationIpRule } from './entities/organization-ip-rule.entity';
import { Organization } from './entities/organization.entity';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

/**
 * Tenants (proposal module 6.2).
 *
 * Exported because the global organization-context guard calls
 * `resolveAccessContext` on every workspace-scoped request — this module owns the
 * tenant isolation boundary.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, OrganizationMember, OrganizationIpRule]),
    RbacModule,
  ],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
