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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import { Audit } from '../../common/decorators/audit.decorator';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import {
  CurrentOrganizationId,
  CurrentPermissions,
  CurrentUser,
} from '../../common/decorators/param.decorators';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-request.interface';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyDto, CreateApiKeyDto, CreatedApiKeyDto, RevokeApiKeyDto } from './dto/api-key.dto';
import type { ApiKey } from './entities/api-key.entity';

/**
 * Machine credentials for a workspace.
 *
 * These are how the Python AI service authenticates to this API on behalf of a
 * workspace from phase 2 onward — a scoped, revocable, attributable service
 * identity rather than a shared static secret, which is what the proposal's
 * "Zero-Trust authorization" objective for internal traffic requires.
 */
@ApiTags('API keys')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/api-keys', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Get('scopes')
  @RequirePermissions('apikey:read')
  @ApiOperation({
    summary: 'Scopes an API key may carry',
    description:
      'A restricted subset of the permission catalogue. Administrative ' +
      'permissions — role editing, member removal, workspace deletion — are ' +
      'deliberately not grantable to a machine credential.',
  })
  @ApiStandardErrors()
  async listScopes(): Promise<{ scopes: readonly string[] }> {
    return { scopes: this.apiKeysService.getAvailableScopes() };
  }

  @Get()
  @RequirePermissions('apikey:read')
  @ApiOperation({
    summary: 'List API keys',
    description:
      'Returns metadata only. The secret is unrecoverable — the platform stores ' +
      'only its HMAC digest.',
  })
  @ApiEnvelopedResponse(ApiKeyDto)
  @ApiStandardErrors()
  async list(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<ApiKeyDto[]> {
    const keys = await this.apiKeysService.list(organizationId);
    return keys.map((key) => this.toDto(key));
  }

  @Post()
  @RequirePermissions('apikey:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Issue an API key',
    description:
      'The plaintext key is returned once and never again. Requested scopes are ' +
      'capped by your own permissions at issue time, so a key can never launder ' +
      'authority its creator did not have.',
  })
  @ApiEnvelopedResponse(CreatedApiKeyDto, 'Key created; the secret is shown once')
  @ApiErrorResponse(403, [ErrorCode.CANNOT_ESCALATE_PRIVILEGES])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.API_KEY_CREATED,
    resourceType: 'api_key',
    resourceLabelFrom: 'body.name',
    // `scopes` and `name` only. The generated secret never appears in a request
    // body, and nothing here should tempt a future maintainer into logging one.
    captureBodyFields: ['name', 'scopes', 'expiresAt'],
  })
  async create(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() permissions: string[],
  ): Promise<CreatedApiKeyDto> {
    const created = await this.apiKeysService.create(
      {
        organizationId,
        createdById: user.id,
        name: dto.name,
        description: dto.description,
        scopes: dto.scopes,
        expiresAt: dto.expiresAt,
        allowedIps: dto.allowedIps,
      },
      permissions,
    );

    return {
      apiKey: this.toDto(created.record),
      plaintextKey: created.plaintextKey,
      warning:
        'Store this key now. It is shown once and cannot be retrieved again — ' +
        'the platform keeps only a cryptographic digest.',
    };
  }

  @Delete(':apiKeyId')
  @RequirePermissions('apikey:revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke an API key',
    description: 'Takes effect immediately; the cached lookup is invalidated first.',
  })
  @ApiEnvelopedResponse(ApiKeyDto)
  @ApiErrorResponse(404, [ErrorCode.API_KEY_NOT_FOUND])
  @ApiStandardErrors()
  @Audit({
    action: AuditAction.API_KEY_REVOKED,
    resourceType: 'api_key',
    resourceIdFrom: 'params.apiKeyId',
    captureBodyFields: ['reason'],
  })
  async revoke(
    @Param('organizationId') _identifier: string,
    @CurrentOrganizationId() organizationId: string,
    @Param('apiKeyId', new ParseUUIDPipe({ version: '4' })) apiKeyId: string,
    @Body() dto: RevokeApiKeyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiKeyDto> {
    const revoked = await this.apiKeysService.revoke(
      organizationId,
      apiKeyId,
      user.id,
      dto.reason,
    );
    return this.toDto(revoked);
  }

  private toDto(key: ApiKey): ApiKeyDto {
    return {
      id: key.id,
      name: key.name,
      description: key.description,
      prefix: key.prefix,
      scopes: key.scopes ?? [],
      createdById: key.createdById,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      lastUsedAt: key.lastUsedAt,
      lastUsedIp: key.lastUsedIp,
      usageCount: String(key.usageCount ?? '0'),
      allowedIps: key.allowedIps ?? [],
      createdAt: key.createdAt,
    };
  }
}
