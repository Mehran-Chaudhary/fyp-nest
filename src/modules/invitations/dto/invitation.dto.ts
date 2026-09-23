import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { InvitationStatus } from '../entities/invitation.entity';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateInvitationDto {
  @ApiProperty({ example: 'new.colleague@example.com', maxLength: 320 })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(320)
  @Trim()
  email: string;

  @ApiPropertyOptional({
    description:
      "Role to grant on acceptance. Defaults to the workspace's default role. " +
      'You cannot invite into a role that ranks at or above your own.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  roleId?: string;

  @ApiPropertyOptional({
    description: 'Personal note included in the invitation email.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Trim()
  message?: string;
}

export class AcceptInvitationDto {
  @ApiProperty({ description: 'Token from the invitation link.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;
}

export class ListInvitationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: InvitationStatus })
  @IsOptional()
  @IsEnum(InvitationStatus)
  status?: InvitationStatus;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class InvitationRoleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;
}

export class InvitationInviterDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

export class InvitationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: InvitationStatus })
  status: InvitationStatus;

  @ApiProperty({ type: InvitationRoleDto, nullable: true })
  role: InvitationRoleDto | null;

  @ApiProperty({ type: InvitationInviterDto, nullable: true })
  invitedBy: InvitationInviterDto | null;

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastSentAt: Date | null;

  @ApiProperty({ description: 'Times the invitation email has been sent.' })
  sendCount: number;
}

/**
 * What the invitation landing page shows before the recipient signs in.
 *
 * The email address is returned masked: this endpoint is reachable by anyone
 * holding the link, and an unmasked address would turn a forwarded invitation
 * into a disclosure.
 */
export class InvitationPreviewDto {
  @ApiProperty()
  organizationName: string;

  @ApiProperty()
  organizationSlug: string;

  @ApiProperty()
  roleName: string;

  @ApiProperty()
  inviterName: string;

  @ApiProperty({ description: 'Masked.', example: 'ne****@example.com' })
  email: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({
    description: 'True when no account exists for the invited address yet.',
  })
  requiresRegistration: boolean;
}
