import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiPaginatedResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import { Audit } from '../../common/decorators/audit.decorator';
import {
  Public,
  RequirePermissions,
  SkipOrganizationContext,
  ThrottlePolicy,
} from '../../common/decorators/auth.decorators';
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
import { UsersService } from '../users/users.service';
import {
  AcceptInvitationDto,
  CreateInvitationDto,
  InvitationDto,
  InvitationPreviewDto,
  InvitationTokenQueryDto,
  ListInvitationsQueryDto,
} from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';

/**
 * Invitation management, scoped to a workspace (proposal module 6.2).
 */
@ApiTags('Invitations')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/invitations', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class OrganizationInvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Get()
  @RequirePermissions('member:read')
  @ApiOperation({ summary: 'List invitations' })
  @ApiPaginatedResponse(InvitationDto)
  @ApiStandardErrors()
  async list(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Query() query: ListInvitationsQueryDto,
  ): Promise<PaginatedResult<InvitationDto>> {
    return this.invitationsService.list(
      organizationId,
      query.page,
      query.limit,
      query.status,
    );
  }

  @Post()
  @RequirePermissions('member:invite')
  @ThrottlePolicy(THROTTLE_POLICY.EMAIL)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invite someone',
    description:
      'Sends an invitation email containing a single-use, expiring token. You ' +
      'cannot invite into a role that ranks at or above your own, or into one ' +
      'granting permissions you do not hold — otherwise `member:invite` would be ' +
      'an escalation path rather than an administrative convenience.',
  })
  @ApiEnvelopedResponse(InvitationDto)
  @ApiErrorResponse(403, [
    ErrorCode.CANNOT_ESCALATE_PRIVILEGES,
    ErrorCode.SEAT_LIMIT_REACHED,
  ])
  @ApiErrorResponse(409, [
    ErrorCode.INVITATION_ALREADY_PENDING,
    ErrorCode.MEMBERSHIP_ALREADY_EXISTS,
    ErrorCode.MEMBERSHIP_SUSPENDED,
  ])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.MEMBER_INVITED,
    resourceType: 'invitation',
    captureBodyFields: ['email', 'roleId'],
  })
  async create(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Body() dto: CreateInvitationDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() permissions: string[],
    @CurrentMembership() membership: RequestMembership,
  ): Promise<InvitationDto> {
    const result = await this.invitationsService.create(
      { organizationId, ...dto, invitedById: user.id },
      permissions,
      membership.highestRolePriority,
    );

    return result.view;
  }

  @Post(':invitationId/resend')
  @RequirePermissions('member:invite')
  @ThrottlePolicy(THROTTLE_POLICY.EMAIL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-send an invitation',
    description:
      'Issues a brand-new token and invalidates the previous one, so a link the ' +
      'administrator believes they replaced is genuinely dead. Revives an expired ' +
      'invitation with a fresh expiry.',
  })
  @ApiEnvelopedResponse(InvitationDto)
  @ApiErrorResponse(409, [
    ErrorCode.INVITATION_ALREADY_ACCEPTED,
    ErrorCode.INVITATION_REVOKED,
    ErrorCode.INVITATION_ALREADY_PENDING,
  ])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.MEMBER_INVITATION_RESENT,
    resourceType: 'invitation',
    resourceIdFrom: 'params.invitationId',
  })
  async resend(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('invitationId', new ParseUUIDPipe({ version: '4' })) invitationId: string,
  ): Promise<InvitationDto> {
    return this.invitationsService.resend(organizationId, invitationId);
  }

  @Delete(':invitationId')
  @RequirePermissions('member:invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke an invitation',
    description: 'The outstanding link stops working immediately.',
  })
  @ApiEnvelopedResponse(InvitationDto)
  @ApiErrorResponse(409, [ErrorCode.INVITATION_ALREADY_ACCEPTED])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.MEMBER_INVITATION_REVOKED,
    resourceType: 'invitation',
    resourceIdFrom: 'params.invitationId',
  })
  async revoke(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('invitationId', new ParseUUIDPipe({ version: '4' })) invitationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvitationDto> {
    return this.invitationsService.revoke(organizationId, invitationId, user.id);
  }
}

/**
 * Invitation redemption.
 *
 * Deliberately outside the `/organizations/:id` tree. A recipient holding an
 * invitation link is, by definition, not yet a member of the workspace, so the
 * organization-context guard would reject them before they could accept.
 */
@ApiTags('Invitations')
@Controller({ path: 'invitations', version: '1' })
@SkipOrganizationContext()
export class InvitationsController {
  constructor(
    private readonly invitationsService: InvitationsService,
    private readonly usersService: UsersService,
  ) {}

  @Get('preview')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @ApiOperation({
    summary: 'Preview an invitation',
    description:
      'Renders the landing page before the recipient signs in. The email address ' +
      'is returned masked: anyone holding the link can reach this endpoint, and an ' +
      'unmasked address would turn a forwarded invitation into a disclosure.',
  })
  @ApiEnvelopedResponse(InvitationPreviewDto)
  @ApiErrorResponse(404, [ErrorCode.INVITATION_NOT_FOUND])
  @ApiErrorResponse(409, [
    ErrorCode.INVITATION_EXPIRED,
    ErrorCode.INVITATION_REVOKED,
    ErrorCode.INVITATION_ALREADY_ACCEPTED,
  ])
  @ApiErrorResponse(422, [ErrorCode.VALIDATION_FAILED])
  async preview(@Query() query: InvitationTokenQueryDto): Promise<InvitationPreviewDto> {
    return this.invitationsService.preview(query.token);
  }

  @Post('accept')
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Requires you to be signed in as the invited address. A forwarded ' +
      'invitation is refused rather than silently granting access to whoever ' +
      'happened to receive the email.',
  })
  @ApiErrorResponse(401, [ErrorCode.INVITATION_EMAIL_MISMATCH])
  @ApiErrorResponse(409, [
    ErrorCode.INVITATION_EXPIRED,
    ErrorCode.INVITATION_REVOKED,
    ErrorCode.INVITATION_ALREADY_ACCEPTED,
    ErrorCode.MEMBERSHIP_ALREADY_EXISTS,
    ErrorCode.MEMBERSHIP_SUSPENDED,
  ])
  @ApiStandardErrors()
  async accept(
    @Body() dto: AcceptInvitationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ organizationId: string; organizationSlug: string; memberId: string }> {
    const account = await this.usersService.findByIdOrFail(user.id);

    return this.invitationsService.accept(dto.token, {
      id: account.id,
      emailNormalized: account.emailNormalized,
    });
  }
}
