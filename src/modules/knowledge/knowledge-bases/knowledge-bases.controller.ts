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
} from '../../../common/decorators/api-response.decorators';
import { Auth, RequirePermissions } from '../../../common/decorators/auth.decorators';
import { AuthType } from '../../../common/enums/auth-type.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import type { PaginatedResult } from '../../../common/utils/pagination.util';
import type { AccessPrincipal } from '../domain/access';
import { CurrentAccessPrincipal } from '../knowledge.decorators';
import {
  CreateKnowledgeBaseDto,
  KnowledgeBaseDto,
  KnowledgeBaseGrantDto,
  ListKnowledgeBasesQueryDto,
  UpdateKnowledgeBaseDto,
  UpsertGrantDto,
} from './dto/knowledge-base.dto';
import { KnowledgeBasesService } from './knowledge-bases.service';

/**
 * Knowledge bases — the grouping and access-compartment layer of the Document
 * Vault (proposal module 6.4).
 */
@ApiTags('Knowledge bases')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/knowledge-bases', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class KnowledgeBasesController {
  constructor(private readonly knowledgeBases: KnowledgeBasesService) {}

  @Get()
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('knowledgebase:read')
  @ApiOperation({
    summary: 'List knowledge bases',
    description:
      'Only bases you can read are returned. A RESTRICTED base you hold no grant ' +
      'on is omitted entirely, and document counts include only documents within ' +
      'your clearance.',
  })
  @ApiPaginatedResponse(KnowledgeBaseDto)
  @ApiStandardErrors()
  list(
    @Param('organizationId') _identifier: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListKnowledgeBasesQueryDto,
  ): Promise<PaginatedResult<KnowledgeBaseDto>> {
    return this.knowledgeBases.list(principal, {
      page: query.page,
      limit: query.take,
      search: query.search,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    });
  }

  @Post()
  @RequirePermissions('knowledgebase:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a knowledge base',
    description:
      'The embedding model is fixed at creation. Creating a RESTRICTED base grants ' +
      'you MANAGE on it automatically.',
  })
  @ApiEnvelopedResponse(KnowledgeBaseDto)
  @ApiErrorResponse(409, [ErrorCode.KNOWLEDGE_BASE_NAME_TAKEN])
  @ApiErrorResponse(403, [ErrorCode.CLASSIFICATION_EXCEEDS_CLEARANCE])
  @ApiStandardErrors()
  create(
    @Param('organizationId') _identifier: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: CreateKnowledgeBaseDto,
  ): Promise<KnowledgeBaseDto> {
    return this.knowledgeBases.create(principal, dto);
  }

  @Get(':knowledgeBaseId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('knowledgebase:read')
  @ApiOperation({ summary: 'Get a knowledge base' })
  @ApiEnvelopedResponse(KnowledgeBaseDto)
  @ApiErrorResponse(404, [ErrorCode.KNOWLEDGE_BASE_NOT_FOUND])
  @ApiStandardErrors()
  get(
    @Param('organizationId') _identifier: string,
    @Param('knowledgeBaseId', new ParseUUIDPipe({ version: '4' })) knowledgeBaseId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<KnowledgeBaseDto> {
    return this.knowledgeBases.get(principal, knowledgeBaseId);
  }

  @Patch(':knowledgeBaseId')
  @RequirePermissions('knowledgebase:update')
  @ApiOperation({
    summary: 'Update a knowledge base',
    description:
      'Requires MANAGE on the base. Changing chunking applies to future ingestion.',
  })
  @ApiEnvelopedResponse(KnowledgeBaseDto)
  @ApiErrorResponse(404, [ErrorCode.KNOWLEDGE_BASE_NOT_FOUND])
  @ApiErrorResponse(403, [
    ErrorCode.KNOWLEDGE_BASE_ACCESS_DENIED,
    ErrorCode.CLASSIFICATION_EXCEEDS_CLEARANCE,
  ])
  @ApiStandardErrors()
  update(
    @Param('organizationId') _identifier: string,
    @Param('knowledgeBaseId', new ParseUUIDPipe({ version: '4' })) knowledgeBaseId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdateKnowledgeBaseDto,
  ): Promise<KnowledgeBaseDto> {
    return this.knowledgeBases.update(principal, knowledgeBaseId, dto);
  }

  @Delete(':knowledgeBaseId')
  @RequirePermissions('knowledgebase:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a knowledge base and destroy its content',
    description:
      'Irreversible. Every document’s encryption key is destroyed in the same ' +
      'transaction, so its content is unrecoverable immediately — including from ' +
      'backups. Vectors and stored files are then removed in the background.',
  })
  @ApiErrorResponse(404, [ErrorCode.KNOWLEDGE_BASE_NOT_FOUND])
  @ApiStandardErrors()
  async remove(
    @Param('organizationId') _identifier: string,
    @Param('knowledgeBaseId', new ParseUUIDPipe({ version: '4' })) knowledgeBaseId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ deleted: true }> {
    await this.knowledgeBases.remove(principal, knowledgeBaseId);
    return { deleted: true };
  }

  // ── Grants ────────────────────────────────────────────────────────────────

  @Get(':knowledgeBaseId/grants')
  @RequirePermissions('knowledgebase:read')
  @ApiOperation({
    summary: 'List access grants',
    description: 'Requires MANAGE. Grants only take effect while the base is RESTRICTED.',
  })
  @ApiEnvelopedResponse(KnowledgeBaseGrantDto)
  @ApiStandardErrors()
  listGrants(
    @Param('organizationId') _identifier: string,
    @Param('knowledgeBaseId', new ParseUUIDPipe({ version: '4' })) knowledgeBaseId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<KnowledgeBaseGrantDto[]> {
    return this.knowledgeBases.listGrants(principal, knowledgeBaseId);
  }

  @Put(':knowledgeBaseId/grants')
  @RequirePermissions('knowledgebase:update')
  @ApiOperation({
    summary: 'Grant or change access',
    description:
      'Admits a role, a member (by membership id) or an API key at READ, WRITE or ' +
      'MANAGE. Re-granting an existing subject changes its level.',
  })
  @ApiEnvelopedResponse(KnowledgeBaseGrantDto)
  @ApiStandardErrors()
  upsertGrant(
    @Param('organizationId') _identifier: string,
    @Param('knowledgeBaseId', new ParseUUIDPipe({ version: '4' })) knowledgeBaseId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpsertGrantDto,
  ): Promise<KnowledgeBaseGrantDto> {
    return this.knowledgeBases.upsertGrant(principal, knowledgeBaseId, dto);
  }

  @Delete(':knowledgeBaseId/grants/:grantId')
  @RequirePermissions('knowledgebase:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a grant',
    description: 'Takes effect on the next request.',
  })
  @ApiErrorResponse(404, [ErrorCode.KNOWLEDGE_BASE_GRANT_NOT_FOUND])
  @ApiStandardErrors()
  async revokeGrant(
    @Param('organizationId') _identifier: string,
    @Param('knowledgeBaseId', new ParseUUIDPipe({ version: '4' })) knowledgeBaseId: string,
    @Param('grantId', new ParseUUIDPipe({ version: '4' })) grantId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ revoked: true }> {
    await this.knowledgeBases.revokeGrant(principal, knowledgeBaseId, grantId);
    return { revoked: true };
  }
}
