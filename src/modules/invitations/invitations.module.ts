import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MembershipsModule } from '../memberships/memberships.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RbacModule } from '../rbac/rbac.module';
import { UsersModule } from '../users/users.module';
import { Invitation } from './entities/invitation.entity';
import {
  InvitationsController,
  OrganizationInvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';

/** Workspace invitations (proposal module 6.2). */
@Module({
  imports: [
    TypeOrmModule.forFeature([Invitation]),
    OrganizationsModule,
    MembershipsModule,
    RbacModule,
    UsersModule,
  ],
  controllers: [OrganizationInvitationsController, InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
