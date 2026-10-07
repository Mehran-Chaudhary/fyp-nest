import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Equals, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { IsOptionalNotNull } from '../../common/validation/optional';
import type { Response } from 'express';
import {
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  SkipOrganizationContext,
  SkipResponseEnvelope,
  ThrottlePolicy,
} from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/param.decorators';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-request.interface';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import { PersonalDataService, type ErasureOutcome } from './personal-data.service';

export class EraseAccountDto {
  @ApiProperty({ description: 'Your password.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password: string;

  @ApiPropertyOptional({ description: 'A current authenticator code, if two-step verification is on.' })
  @IsOptionalNotNull()
  @IsString()
  @Matches(/^\s*\d{3}\s?\d{3}\s*$/, { message: 'code must be six digits.' })
  code?: string;

  @ApiPropertyOptional({ description: 'Or a recovery code.' })
  @IsOptionalNotNull()
  @IsString()
  @MaxLength(32)
  recoveryCode?: string;

  @ApiProperty({
    description: 'Type ERASE MY ACCOUNT: erasure cannot be undone.',
    example: 'ERASE MY ACCOUNT',
  })
  @Equals('ERASE MY ACCOUNT', { message: 'confirmation must be exactly "ERASE MY ACCOUNT".' })
  confirmation: string;
}

/**
 * The data-subject rights, self-service (phase 5): a copy of your data, and
 * the erasure of your account.
 */
@ApiTags('Personal data')
@ApiBearerAuth()
@Controller({ path: 'auth/me', version: '1' })
@SkipOrganizationContext()
export class PersonalDataController {
  constructor(private readonly personalData: PersonalDataService) {}

  @Get('export')
  @ThrottlePolicy(THROTTLE_POLICY.EMAIL)
  @SkipResponseEnvelope()
  @ApiProduces('application/json')
  @ApiOperation({
    summary: 'Download a copy of your personal data',
    description:
      'Everything the platform holds about you and from you, across every workspace: ' +
      'profile, memberships, devices, your conversations and workflow runs (decrypted), ' +
      'the API keys you issued, your usage and your activity trail. A JSON file. Audited ' +
      'as user.data.exported.',
  })
  @ApiStandardErrors()
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const data = await this.personalData.export(user.id);
    const date = new Date().toISOString().slice(0, 10);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), {
      type: 'application/json',
      disposition: `attachment; filename="personal-data-${date}.json"`,
    });
  }

  @Delete()
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Erase your account',
    description:
      'Your conversations and workflow runs are crypto-shredded, your API keys revoked, ' +
      'your memberships ended and your identity anonymised. Refused while you own a ' +
      'workspace other people belong to: transfer it first. Requires your password (and ' +
      'a second factor if enabled) and the confirmation phrase. Irreversible.',
  })
  @ApiErrorResponse(401, [ErrorCode.AUTH_PASSWORD_MISMATCH, ErrorCode.MFA_CODE_INVALID])
  @ApiErrorResponse(403, [ErrorCode.ACCOUNT_ERASURE_DISABLED])
  @ApiErrorResponse(409, [ErrorCode.ACCOUNT_ERASURE_BLOCKED])
  @ApiStandardErrors()
  erase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EraseAccountDto,
  ): Promise<ErasureOutcome> {
    return this.personalData.erase(user.id, dto.password, {
      code: dto.code,
      recoveryCode: dto.recoveryCode,
    });
  }
}
