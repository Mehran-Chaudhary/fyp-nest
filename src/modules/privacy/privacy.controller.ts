import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { SECURITY_SCHEME } from '../../common/constants/app.constants';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  Auth,
  RequirePermissions,
  ThrottlePolicy,
} from '../../common/decorators/auth.decorators';
import { CurrentPermissions } from '../../common/decorators/param.decorators';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { hasPermission } from '../../common/utils/permission.util';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import {
  AnalyzeResultDto,
  AnalyzeTextDto,
  DocumentPiiReportDto,
  DocumentReportQueryDto,
  EntityTypeDto,
  PiiPolicyDto,
  UpdatePiiPolicyDto,
} from './dto/privacy.dto';
import { PiiPolicyService } from './pii-policy.service';
import { PrivacyService } from './privacy.service';

/**
 * The PII redaction engine (proposal module 6.12): the workspace policy and
 * redaction reports.
 */
@ApiTags('Privacy')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId/pii', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class PrivacyController {
  constructor(
    private readonly policies: PiiPolicyService,
    private readonly privacy: PrivacyService,
  ) {}

  @Get('policy')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('pii:policy:read')
  @ApiOperation({
    summary: 'The redaction policy applied before prompts reach the model',
    description:
      'Until the workspace saves its own policy, the platform defaults apply (source: ' +
      'default). Deny-list terms are returned only to holders of pii:policy:update.',
  })
  @ApiEnvelopedResponse(PiiPolicyDto)
  @ApiStandardErrors()
  getPolicy(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @CurrentPermissions() permissions: string[],
  ): Promise<PiiPolicyDto> {
    return this.policies.describe(
      principal.organizationId,
      hasPermission(permissions, 'pii:policy:update'),
    );
  }

  @Put('policy')
  @RequirePermissions('pii:policy:update')
  @ApiOperation({
    summary: 'Change the redaction policy',
    description:
      'Takes effect on the next request. Audited as pii.policy.updated with a diff; ' +
      'changes that mask less are flagged as weakened. Send expectedVersion to avoid ' +
      'overwriting a concurrent edit.',
  })
  @ApiEnvelopedResponse(PiiPolicyDto)
  @ApiErrorResponse(409, [ErrorCode.RESOURCE_CONFLICT])
  @ApiStandardErrors()
  updatePolicy(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdatePiiPolicyDto,
  ): Promise<PiiPolicyDto> {
    return this.policies.update(principal.organizationId, principal.userId, dto);
  }

  @Get('entity-types')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('pii:policy:read')
  @ApiOperation({
    summary: 'Entity types the engine can mask',
    description:
      'Built-in types are found by validated pattern recognizers and are always available. ' +
      'NER types (names, places) need the NER detector; any other Presidio entity name is ' +
      'accepted in the policy too.',
  })
  @ApiEnvelopedResponse(EntityTypeDto)
  @ApiStandardErrors()
  entityTypes(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<EntityTypeDto[]> {
    return this.privacy.entityTypes(principal.organizationId);
  }

  @Post('analyze')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('pii:policy:read')
  @ThrottlePolicy(THROTTLE_POLICY.PRIVACY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview redaction of a piece of text',
    description:
      'Runs the workspace policy and returns the masked text exactly as a model would ' +
      'receive it, with every detection. Values are included only with reveal=true, which ' +
      'requires pii:reveal and is audited as pii.unmasked.',
  })
  @ApiEnvelopedResponse(AnalyzeResultDto)
  @ApiErrorResponse(503, [ErrorCode.PII_DETECTION_UNAVAILABLE])
  @ApiStandardErrors()
  analyze(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: AnalyzeTextDto,
  ): Promise<AnalyzeResultDto> {
    return this.privacy.analyze(principal, dto);
  }

  @Get('documents/:documentId/report')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @ApiSecurity(SECURITY_SCHEME.API_KEY)
  @RequirePermissions('document:read', 'pii:policy:read')
  @ThrottlePolicy(THROTTLE_POLICY.PRIVACY)
  @ApiOperation({
    summary: 'Redaction report for a document',
    description:
      'What the model would see for each chunk of the document, a page of chunks at a ' +
      'time. Access follows the document: a document outside your compartments or ' +
      'clearance is 404.',
  })
  @ApiEnvelopedResponse(DocumentPiiReportDto)
  @ApiErrorResponse(404, [ErrorCode.DOCUMENT_NOT_FOUND])
  @ApiErrorResponse(503, [ErrorCode.PII_DETECTION_UNAVAILABLE])
  @ApiStandardErrors()
  documentReport(
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: DocumentReportQueryDto,
  ): Promise<DocumentPiiReportDto> {
    return this.privacy.documentReport(principal, documentId, query);
  }
}
