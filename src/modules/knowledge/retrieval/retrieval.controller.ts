import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { SECURITY_SCHEME } from '../../../common/constants/app.constants';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../../common/decorators/api-response.decorators';
import {
  Auth,
  RequirePermissions,
  ThrottlePolicy,
  TimeoutBudget,
} from '../../../common/decorators/auth.decorators';
import { AuthType } from '../../../common/enums/auth-type.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { THROTTLE_POLICY } from '../../../config/throttle.config';
import type { AccessPrincipal } from '../domain/access';
import { CurrentAccessPrincipal } from '../knowledge.decorators';
import {
  AccessScopeDto,
  RetrievalQueryDto,
  RetrievalResponseDto,
} from './dto/retrieval.dto';
import { RetrievalService } from './retrieval.service';

/**
 * Secure retrieval (proposal module 6.6).
 *
 * Accepts user tokens and workspace API keys, so the Python AI service's agents
 * (phase 3) retrieve through exactly the same policy as a person does.
 */
@ApiTags('Retrieval')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId/rag', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class RetrievalController {
  constructor(private readonly retrieval: RetrievalService) {}

  @Post('query')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('rag:query')
  @ThrottlePolicy(THROTTLE_POLICY.RAG)
  @TimeoutBudget('retrieval')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retrieve passages relevant to a question',
    description:
      'The access policy — your knowledge-base compartments and your clearance — is ' +
      'applied inside the vector search and again when passage text is read. It is ' +
      'built on the server from your resolved permissions; nothing in the request ' +
      'can widen it. Passages you may not see are never retrieved, not retrieved and ' +
      'then hidden.',
  })
  @ApiEnvelopedResponse(RetrievalResponseDto)
  @ApiErrorResponse(404, [ErrorCode.KNOWLEDGE_BASE_NOT_FOUND])
  @ApiErrorResponse(503, [
    ErrorCode.KNOWLEDGE_LAYER_NOT_CONFIGURED,
    ErrorCode.AI_SERVICE_UNAVAILABLE,
    ErrorCode.VECTOR_STORE_UNAVAILABLE,
  ])
  @ApiStandardErrors()
  query(
    @Param('organizationId') _identifier: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: RetrievalQueryDto,
  ): Promise<RetrievalResponseDto> {
    return this.retrieval.retrieve(principal, dto);
  }

  @Get('access-scope')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('rag:query')
  @ApiOperation({
    summary: 'What your queries can reach',
    description:
      'Your clearance and the knowledge bases a query would search. Useful for ' +
      'explaining an empty answer without revealing what lies outside it.',
  })
  @ApiEnvelopedResponse(AccessScopeDto)
  @ApiStandardErrors()
  accessScope(
    @Param('organizationId') _identifier: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<AccessScopeDto> {
    return this.retrieval.describeScope(principal);
  }
}
