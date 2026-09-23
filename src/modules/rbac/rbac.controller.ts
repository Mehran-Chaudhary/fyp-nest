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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import { Audit } from '../../common/decorators/audit.decorator';
import {
  RequirePermissions,
  SkipOrganizationContext,
} from '../../common/decorators/auth.decorators';
import {
  CurrentMembership,
  CurrentOrganizationId,
  CurrentPermissions,
} from '../../common/decorators/param.decorators';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { RequestMembership } from '../../common/interfaces/authenticated-request.interface';
import { CreateRoleDto, PermissionCatalogueDto, RoleDto, UpdateRoleDto } from './dto/rbac.dto';
import type { Role } from './entities/role.entity';
import { RbacService } from './rbac.service';

/**
 * The permission catalogue.
 *
 * Global rather than workspace-scoped: every workspace draws its custom roles
 * from the same vocabulary, and the catalogue itself contains no tenant data —
 * only the names and descriptions of permissions, which the role editor needs
 * before any workspace is selected.
 */
@ApiTags('Access control')
@ApiBearerAuth()
@Controller({ path: 'permissions', version: '1' })
@SkipOrganizationContext()
export class PermissionsController {
  constructor(private readonly rbacService: RbacService) {}

  @Get()
  @ApiOperation({
    summary: 'The permission catalogue',
    description:
      'Every permission the platform defines, across all five implementation ' +
      'phases, grouped by category for the role editor. Permissions from later ' +
      'phases are listed and assignable now so that a role built today stays ' +
      'meaningful as those modules land.',
  })
  @ApiEnvelopedResponse(PermissionCatalogueDto)
  @ApiStandardErrors()
  async list(): Promise<PermissionCatalogueDto> {
    const definitions = this.rbacService.getPermissionDefinitions();

    const byCategory: Record<string, string[]> = {};
    for (const definition of definitions) {
      (byCategory[definition.category] ??= []).push(definition.key);
    }

    return {
      permissions: definitions.map((definition) => {
        const [resource, action] = definition.key.split(':');
        return {
          key: definition.key,
          resource,
          action,
          category: definition.category,
          description: definition.description,
          isDangerous: definition.dangerous ?? false,
          phase: definition.phase,
        };
      }),
      byCategory,
    };
  }
}

/**
 * Role management within a workspace (proposal module 6.3).
 *
 * Two escalation guards apply to everything here and are enforced in the
 * service, not the route:
 *
 *  - You cannot grant a permission you do not hold.
 *  - You cannot create or edit a role whose priority is at or above your own.
 *
 * Without the first, any member with `role:update` could mint a `*:*` role and
 * assign it to themselves. Without the second, they could create a role that
 * outranks the owner.
 */
@ApiTags('Access control')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/roles', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class RolesController {
  constructor(private readonly rbacService: RbacService) {}

  @Get()
  @RequirePermissions('role:read')
  @ApiOperation({ summary: 'List roles in this workspace' })
  @ApiEnvelopedResponse(RoleDto)
  @ApiStandardErrors()
  async list(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<RoleDto[]> {
    const roles = await this.rbacService.listRoles(organizationId);
    return roles.map((role) => this.toDto(role));
  }

  @Get(':roleId')
  @RequirePermissions('role:read')
  @ApiOperation({ summary: 'Read one role' })
  @ApiEnvelopedResponse(RoleDto)
  @ApiErrorResponse(404, [ErrorCode.ROLE_NOT_FOUND])
  @ApiStandardErrors()
  async findOne(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('roleId', new ParseUUIDPipe({ version: '4' })) roleId: string,
  ): Promise<RoleDto> {
    const role = await this.rbacService.findRoleByIdOrFail(roleId, organizationId);
    return this.toDto(role);
  }

  @Post()
  @RequirePermissions('role:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a custom role',
    description:
      'The "HR Manager" / "Standard Employee" case from the proposal. Wildcards ' +
      'such as `document:*` are accepted, and are expanded before the escalation ' +
      'check so they cannot be used to request more than you hold.',
  })
  @ApiEnvelopedResponse(RoleDto)
  @ApiErrorResponse(403, [ErrorCode.CANNOT_ESCALATE_PRIVILEGES])
  @ApiErrorResponse(409, [ErrorCode.ROLE_ALREADY_EXISTS])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ROLE_CREATED,
    resourceType: 'role',
    resourceLabelFrom: 'body.name',
    captureBodyFields: ['name', 'permissionKeys', 'priority'],
  })
  async create(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Body() dto: CreateRoleDto,
    @CurrentPermissions() permissions: string[],
    @CurrentMembership() membership: RequestMembership,
  ): Promise<RoleDto> {
    const role = await this.rbacService.createRole(
      { organizationId, ...dto },
      permissions,
      membership.highestRolePriority,
    );
    return this.toDto(role);
  }

  @Patch(':roleId')
  @RequirePermissions('role:update')
  @ApiOperation({
    summary: 'Update a custom role',
    description:
      'Built-in roles are immutable, which guarantees a workspace can never lock ' +
      'itself out of its own administration. Changing permissions recomputes the ' +
      'effective set of every member holding the role, in the same transaction.',
  })
  @ApiEnvelopedResponse(RoleDto)
  @ApiErrorResponse(403, [ErrorCode.ROLE_IMMUTABLE, ErrorCode.CANNOT_ESCALATE_PRIVILEGES])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ROLE_PERMISSIONS_UPDATED,
    resourceType: 'role',
    resourceIdFrom: 'params.roleId',
    captureBodyFields: ['name', 'permissionKeys', 'priority'],
  })
  async update(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('roleId', new ParseUUIDPipe({ version: '4' })) roleId: string,
    @Body() dto: UpdateRoleDto,
    @CurrentPermissions() permissions: string[],
    @CurrentMembership() membership: RequestMembership,
  ): Promise<RoleDto> {
    const role = await this.rbacService.updateRole(
      roleId,
      organizationId,
      dto,
      permissions,
      membership.highestRolePriority,
    );
    return this.toDto(role);
  }

  @Delete(':roleId')
  @RequirePermissions('role:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a custom role',
    description: 'Refused while any member still holds it. Reassign them first.',
  })
  @ApiErrorResponse(403, [ErrorCode.ROLE_IMMUTABLE])
  @ApiErrorResponse(409, [ErrorCode.ROLE_IN_USE])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.ROLE_DELETED,
    resourceType: 'role',
    resourceIdFrom: 'params.roleId',
  })
  async remove(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('roleId', new ParseUUIDPipe({ version: '4' })) roleId: string,
    @CurrentMembership() membership: RequestMembership,
  ): Promise<{ deleted: true }> {
    await this.rbacService.deleteRole(
      roleId,
      organizationId,
      membership.highestRolePriority,
    );
    return { deleted: true };
  }

  @Post('recompute')
  @RequirePermissions('role:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recompute every effective permission set',
    description:
      'A repair operation. Effective permissions are materialised onto each ' +
      'membership row for the benefit of the authorization hot path; this rebuilds ' +
      'them from the roles, should that derived state ever be suspected of drifting.',
  })
  @ApiStandardErrors()
  async recompute(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<{ membersRecomputed: number }> {
    const count = await this.rbacService.recomputeOrganization(organizationId);
    return { membersRecomputed: count };
  }

  private toDto(role: Role): RoleDto {
    return {
      id: role.id,
      name: role.name,
      slug: role.slug,
      description: role.description,
      isSystem: role.isSystem,
      isDefault: role.isDefault,
      priority: role.priority,
      color: role.color,
      permissionKeys: role.permissionKeys ?? [],
      createdAt: role.createdAt,
    };
  }
}
