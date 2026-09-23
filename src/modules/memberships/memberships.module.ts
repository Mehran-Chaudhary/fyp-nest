import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { Organization } from '../organizations/entities/organization.entity';
import { RbacModule } from '../rbac/rbac.module';
import { OrganizationMember } from './entities/organization-member.entity';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';

/**
 * Membership lifecycle (proposal module 6.2).
 *
 * Imports `ApiKeysModule` because removing a member must also revoke the API keys
 * they created — those keys carry authority derived from permissions the member no
 * longer holds, and leaving them live would be a standing back door that survives
 * the removal.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OrganizationMember, Organization]),
    RbacModule,
    ApiKeysModule,
  ],
  controllers: [MembershipsController],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
