import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiPaginatedResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import { Audit } from '../../common/decorators/audit.decorator';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import {
  CurrentMembership,
  CurrentOrganizationId,
  CurrentPermissions,
  CurrentUser,
} from '../../common/decorators/param.decorators';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type {
  AuthenticatedUser,
  RequestMembership,
} from '../../common/interfaces/authenticated-request.interface';
import type { PaginatedResult } from '../../common/utils/pagination.util';
import {
  ListMembersQueryDto,
  MemberDto,
  SetMemberRolesDto,
  SuspendMemberDto,
  UpdateMemberProfileDto,
} from './dto/membership.dto';
import { MembershipsService } from './memberships.service';

/**
 * Member directory and lifecycle (proposal module 6.2).
 *
 * Every mutating route here is additionally constrained by role priority in the
 * service layer, not just by the `member:*` permission on the route. That second
 * check is what stops an administrator from acting on the owner — see
 * `MembershipsService.assertCanActOn`. The permission alone would be a workspace
 * takeover primitive.
 */
@ApiTags('Members')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/members', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get()
  @RequirePermissions('member:read')
  @ApiOperation({
    summary: 'List members',
    description: 'Supports search by name or email, and filtering by status or role.',
  })
  @ApiPaginatedResponse(MemberDto)
  @ApiStandardErrors()
  async list(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Query() query: ListMembersQueryDto,
  ): Promise<PaginatedResult<MemberDto>> {
    return this.membershipsService.list(organizationId, {
      page: query.page,
      limit: query.limit,
      search: query.search,
      status: query.status,
      roleId: query.roleId,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    });
  }

  @Get('me')
  @ApiOperation({
    summary: 'Your own membership of this workspace',
    description: 'Needs no permission: every member may read their own membership.',
  })
  @ApiEnvelopedResponse(MemberDto)
  @ApiStandardErrors()
  async me(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @CurrentMembership() membership: RequestMembership,
  ): Promise<MemberDto> {
    return this.membershipsService.getMemberView(organizationId, membership.id);
  }

  @Get(':memberId')
  @RequirePermissions('member:read')
  @ApiOperation({ summary: 'Read one member' })
  @ApiEnvelopedResponse(MemberDto)
  @ApiErrorResponse(404, [ErrorCode.MEMBERSHIP_NOT_FOUND])
  @ApiStandardErrors()
  async findOne(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('memberId', new ParseUUIDPipe({ version: '4' })) memberId: string,
  ): Promise<MemberDto> {
    return this.membershipsService.getMemberView(organizationId, memberId, {
      includeRemoved: true,
    });
  }

  @Put(':memberId/roles')
  @RequirePermissions('role:assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replace a member's roles",
    description:
      'Replaces the whole set rather than adding to it. Refused if the target ' +
      'ranks at or above you, or if any requested role grants permissions you do ' +
      'not hold yourself.',
  })
  @ApiEnvelopedResponse(MemberDto)
  @ApiErrorResponse(400, [ErrorCode.CANNOT_MODIFY_SELF])
  @ApiErrorResponse(403, [ErrorCode.CANNOT_ESCALATE_PRIVILEGES, ErrorCode.FORBIDDEN])
  @ApiErrorResponse(409, [ErrorCode.CANNOT_REMOVE_LAST_OWNER])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ROLE_ASSIGNED,
    resourceType: 'member',
    resourceIdFrom: 'params.memberId',
    captureBodyFields: ['roleIds'],
  })
  async setRoles(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('memberId', new ParseUUIDPipe({ version: '4' })) memberId: string,
    @Body() dto: SetMemberRolesDto,
    @CurrentMembership() actor: RequestMembership,
    @CurrentPermissions() permissions: string[],
  ): Promise<MemberDto> {
    return this.membershipsService.setRoles(
      organizationId,
      memberId,
      dto.roleIds,
      actor,
      permissions,
    );
  }

  @Patch(':memberId')
  @ApiOperation({
    summary: "Update a member's workspace profile",
    description:
      'Editing your own entry needs no elevated permission; editing someone ' +
      "else's requires `member:update` and a higher role ranking than theirs.",
  })
  @ApiErrorResponse(403, [ErrorCode.PERMISSION_DENIED, ErrorCode.FORBIDDEN])
  @ApiEnvelopedResponse(MemberDto)
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.MEMBER_UPDATED,
    resourceType: 'member',
    resourceIdFrom: 'params.memberId',
    captureBodyFields: ['displayName', 'title'],
  })
  async updateProfile(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('memberId', new ParseUUIDPipe({ version: '4' })) memberId: string,
    @Body() dto: UpdateMemberProfileDto,
    @CurrentMembership() actor: RequestMembership,
    @CurrentPermissions() permissions: string[],
  ): Promise<MemberDto> {
    return this.membershipsService.updateProfile(
      organizationId,
      memberId,
      dto,
      actor,
      permissions,
    );
  }

  @Post(':memberId/suspend')
  @RequirePermissions('member:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend a member',
    description:
      'Blocks access without removing them, preserving their roles for ' +
      'reinstatement. Takes effect on their very next request, because membership ' +
      'status is checked against the database rather than trusted from the token.',
  })
  @ApiEnvelopedResponse(MemberDto)
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.MEMBER_SUSPENDED,
    resourceType: 'member',
    resourceIdFrom: 'params.memberId',
    captureBodyFields: ['reason'],
  })
  async suspend(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('memberId', new ParseUUIDPipe({ version: '4' })) memberId: string,
    @Body() dto: SuspendMemberDto,
    @CurrentMembership() actor: RequestMembership,
  ): Promise<MemberDto> {
    return this.membershipsService.suspend(organizationId, memberId, dto.reason, actor);
  }

  @Post(':memberId/reactivate')
  @RequirePermissions('member:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended member' })
  @ApiEnvelopedResponse(MemberDto)
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.MEMBER_REACTIVATED,
    resourceType: 'member',
    resourceIdFrom: 'params.memberId',
  })
  async reactivate(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('memberId', new ParseUUIDPipe({ version: '4' })) memberId: string,
    @CurrentMembership() actor: RequestMembership,
  ): Promise<MemberDto> {
    return this.membershipsService.reactivate(organizationId, memberId, actor);
  }

  @Delete(':memberId')
  @RequirePermissions('member:remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a member',
    description:
      'Also revokes every API key they created — those keys carry authority ' +
      'derived from permissions they no longer have, and would otherwise be a ' +
      'standing back door that survives the removal.',
  })
  @ApiErrorResponse(409, [ErrorCode.CANNOT_REMOVE_LAST_OWNER])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.MEMBER_REMOVED,
    resourceType: 'member',
    resourceIdFrom: 'params.memberId',
  })
  async remove(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('memberId', new ParseUUIDPipe({ version: '4' })) memberId: string,
    @CurrentMembership() actor: RequestMembership,
  ): Promise<{ removed: true; revokedApiKeys: number }> {
    return this.membershipsService.remove(organizationId, memberId, actor);
  }

  @Post('leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Leave this workspace',
    description: 'Refused for the owner: transfer ownership first.',
  })
  @ApiErrorResponse(409, [ErrorCode.CANNOT_REMOVE_LAST_OWNER])
  @ApiStandardErrors()
  @Audit({ action: AuditAction.MEMBER_LEFT, resourceType: 'member' })
  async leave(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ left: true }> {
    return this.membershipsService.leave(organizationId, user.id);
  }
}
