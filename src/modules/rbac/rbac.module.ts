import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationMember } from '../memberships/entities/organization-member.entity';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';
import { PermissionsController, RolesController } from './rbac.controller';
import { RbacService } from './rbac.service';

/**
 * Roles, permissions and effective-permission materialisation (module 6.3).
 *
 * `OrganizationMember` is registered here as well as in the memberships module:
 * TypeORM repositories are scoped per module, and this module owns the write
 * path for a membership's `effective_permissions` column.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Role, Permission, OrganizationMember])],
  controllers: [PermissionsController, RolesController],
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
