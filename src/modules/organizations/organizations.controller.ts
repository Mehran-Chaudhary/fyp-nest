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
import {
  RequirePermissions,
  SkipOrganizationContext,
} from '../../common/decorators/auth.decorators';
import {
  CurrentOrganizationId,
  CurrentUser,
} from '../../common/decorators/param.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { ForbiddenError } from '../../common/exceptions/app.exception';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-request.interface';
import type { PaginatedResult } from '../../common/utils/pagination.util';
import {
  CreateIpRuleDto,
  CreateOrganizationDto,
  IpRuleDto,
  OrganizationDto,
  OrganizationWithMembershipDto,
  SetIpEnforcementDto,
  TransferOwnershipDto,
  UpdateOrganizationDto,
} from './dto/organization.dto';
import type { Organization } from './entities/organization.entity';
import { OrganizationsService } from './organizations.service';

/**
 * Workspace endpoints (proposal module 6.2).
 *
 * Note the split in how the active workspace is addressed. Routes under
 * `/organizations/:organizationId/...` are resolved by the organization-context
 * guard from the path parameter, so no header is needed and the URL is
 * self-describing. The two collection routes — "create a workspace" and "list my
 * workspaces" — carry `@SkipOrganizationContext()` because they necessarily
 * operate outside any single tenant.
 */
@ApiTags('Workspaces')
@ApiBearerAuth()
@Controller({ path: 'organizations', version: '1' })
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  // ── Collection (no workspace context) ─────────────────────────────────────

  @Post()
  @SkipOrganizationContext()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a workspace',
    description:
      'Creates the workspace, seeds its four built-in roles, and makes you the ' +
      'owner — all in one transaction, because a workspace without roles cannot ' +
      'be administered and cannot be repaired through the API.',
  })
  @ApiEnvelopedResponse(OrganizationDto, 'Workspace created')
  @ApiErrorResponse(403, [ErrorCode.ORGANIZATION_LIMIT_REACHED])
  @ApiErrorResponse(409, [
    ErrorCode.ORGANIZATION_SLUG_TAKEN,
    ErrorCode.ORGANIZATION_SLUG_RESERVED,
  ])
  @Audit({
    action: AuditAction.ORGANIZATION_CREATED,
    resourceType: 'organization',
    captureBodyFields: ['name', 'slug'],
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrganizationDto> {
    const organization = await this.organizationsService.create(user.id, dto);
    return this.toDto(organization);
  }

  @Get()
  @SkipOrganizationContext()
  @ApiOperation({ summary: 'List the workspaces you belong to' })
  @ApiPaginatedResponse(OrganizationWithMembershipDto)
  @ApiStandardErrors()
  async listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResult<OrganizationWithMembershipDto>> {
    const result = await this.organizationsService.listForUser(
      user.id,
      query.page,
      query.limit,
    );

    return {
      items: result.items.map((entry) => ({
        ...this.toDto(entry.organization),
        roleSlugs: (entry.membership.roles ?? []).map((role) => role.slug),
        isOwner: entry.organization.ownerId === user.id,
        joinedAt: entry.membership.joinedAt,
      })),
      meta: result.meta,
    };
  }

  // ── Single workspace ──────────────────────────────────────────────────────

  @Get(':organizationId')
  @RequirePermissions('workspace:read')
  @ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
  @ApiOperation({ summary: 'Read a workspace' })
  @ApiEnvelopedResponse(OrganizationDto)
  @ApiStandardErrors()
  async findOne(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<OrganizationDto> {
    // `_identifier` may be a slug; the guard has already resolved it to a UUID
    // and verified membership, so the resolved id is what we read by.
    const organization = await this.organizationsService.findByIdOrFail(organizationId);
    return this.toDto(organization);
  }

  @Patch(':organizationId')
  @RequirePermissions('workspace:update')
  @ApiParam({ name: 'organizationId' })
  @ApiOperation({ summary: 'Update a workspace' })
  @ApiEnvelopedResponse(OrganizationDto)
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ORGANIZATION_UPDATED,
    resourceType: 'organization',
    resourceIdFrom: 'params.organizationId',
    captureBodyFields: ['name', 'description', 'settings'],
  })
  async update(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationDto> {
    const organization = await this.organizationsService.update(organizationId, dto);
    return this.toDto(organization);
  }

  @Delete(':organizationId')
  @RequirePermissions('workspace:delete')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'organizationId' })
  @ApiOperation({
    summary: 'Delete a workspace',
    description:
      'Archives the workspace and its memberships. Never a hard delete: the audit ' +
      'log must survive, since the deletion is itself one of the most significant ' +
      'events it records.',
  })
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ORGANIZATION_DELETED,
    resourceType: 'organization',
    resourceIdFrom: 'params.organizationId',
  })
  async remove(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ deleted: true }> {
    const organization = await this.organizationsService.findByIdOrFail(organizationId);

    // Deleting a workspace is owner-only, over and above the permission. The
    // `workspace:delete` permission could in principle be granted to a custom
    // role; ownership cannot be.
    if (organization.ownerId !== user.id) {
      throw new ForbiddenError(ErrorCode.FORBIDDEN, {
        message: 'Only the workspace owner can delete it.',
      });
    }

    await this.organizationsService.softDelete(organizationId, user.id);
    return { deleted: true };
  }

  @Post(':organizationId/transfer-ownership')
  @RequirePermissions('workspace:transfer')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'organizationId' })
  @ApiOperation({
    summary: 'Transfer ownership',
    description:
      'Moves the Owner role to another active member and demotes you to ' +
      'Administrator. One transaction, because a workspace with two owners or ' +
      'none is unrecoverable through the API.',
  })
  @ApiEnvelopedResponse(OrganizationDto)
  @ApiErrorResponse(404, [ErrorCode.MEMBERSHIP_NOT_FOUND])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ORGANIZATION_OWNERSHIP_TRANSFERRED,
    resourceType: 'organization',
    resourceIdFrom: 'params.organizationId',
    captureBodyFields: ['newOwnerUserId'],
  })
  async transferOwnership(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TransferOwnershipDto,
  ): Promise<OrganizationDto> {
    const organization = await this.organizationsService.transferOwnership(
      organizationId,
      user.id,
      dto.newOwnerUserId,
    );
    return this.toDto(organization);
  }

  // ── IP allowlist (proposal module 6.1) ────────────────────────────────────

  @Get(':organizationId/ip-rules')
  @RequirePermissions('security:read')
  @ApiParam({ name: 'organizationId' })
  @ApiOperation({ summary: 'List allowed networks' })
  @ApiEnvelopedResponse(IpRuleDto)
  @ApiStandardErrors()
  async listIpRules(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<IpRuleDto[]> {
    const rules = await this.organizationsService.listIpRules(organizationId);

    return rules.map((rule) => ({
      id: rule.id,
      cidr: rule.cidr,
      label: rule.label,
      isActive: rule.isActive,
      lastMatchedAt: rule.lastMatchedAt,
      createdAt: rule.createdAt,
    }));
  }

  @Post(':organizationId/ip-rules')
  @RequirePermissions('security:update')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'organizationId' })
  @ApiOperation({
    summary: 'Add an allowed network',
    description: 'Accepts a single address or a CIDR range, IPv4 or IPv6.',
  })
  @ApiEnvelopedResponse(IpRuleDto)
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ORGANIZATION_IP_RULE_ADDED,
    resourceType: 'ip_rule',
    captureBodyFields: ['cidr', 'label'],
  })
  async addIpRule(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateIpRuleDto,
  ): Promise<IpRuleDto> {
    const rule = await this.organizationsService.addIpRule(
      organizationId,
      dto.cidr,
      dto.label,
      user.id,
    );

    return {
      id: rule.id,
      cidr: rule.cidr,
      label: rule.label,
      isActive: rule.isActive,
      lastMatchedAt: rule.lastMatchedAt,
      createdAt: rule.createdAt,
    };
  }

  @Delete(':organizationId/ip-rules/:ruleId')
  @RequirePermissions('security:update')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'organizationId' })
  @ApiOperation({
    summary: 'Remove an allowed network',
    description:
      'Refused when it would remove the last active rule while enforcement is on, ' +
      'which would lock every member out with no way back in.',
  })
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ORGANIZATION_IP_RULE_REMOVED,
    resourceType: 'ip_rule',
    resourceIdFrom: 'params.ruleId',
  })
  async removeIpRule(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('ruleId', new ParseUUIDPipe({ version: '4' })) ruleId: string,
  ): Promise<{ removed: true }> {
    await this.organizationsService.removeIpRule(organizationId, ruleId);
    return { removed: true };
  }

  @Put(':organizationId/ip-enforcement')
  @RequirePermissions('security:update')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'organizationId' })
  @ApiOperation({
    summary: 'Enable or disable IP restriction',
    description: 'Enabling with no active rules is refused, for the same lockout reason.',
  })
  @ApiEnvelopedResponse(OrganizationDto)
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ORGANIZATION_SETTINGS_UPDATED,
    resourceType: 'organization',
    captureBodyFields: ['enabled'],
  })
  async setIpEnforcement(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Body() dto: SetIpEnforcementDto,
  ): Promise<OrganizationDto> {
    const organization = await this.organizationsService.setIpEnforcement(
      organizationId,
      dto.enabled,
    );
    return this.toDto(organization);
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  private toDto(organization: Organization): OrganizationDto {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      description: organization.description,
      logoUrl: organization.logoUrl,
      status: organization.status,
      plan: organization.plan,
      ownerId: organization.ownerId,
      settings: organization.settings,
      ipAllowlistEnabled: organization.ipAllowlistEnabled,
      memberCount: organization.memberCount,
      createdAt: organization.createdAt,
    };
  }
}
