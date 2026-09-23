import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsStrongPassword } from '../../../common/validators/is-strong-password.validator';

/**
 * Trims a string field. Applied to every free-text input because a trailing
 * space in an email address is the single most common cause of "my account does
 * not exist" support tickets.
 */
const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class RegisterDto {
  @ApiProperty({ example: 'ahmad.hanbal@example.com', maxLength: 320 })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(320)
  @Trim()
  email: string;

  @ApiProperty({
    description:
      'Must satisfy the configured password policy: minimum length, character ' +
      'classes, no common or sequential patterns, and must not contain your name or email.',
    example: 'correct-horse-battery-7',
    minLength: 12,
  })
  @IsString()
  @IsStrongPassword()
  password: string;

  @ApiProperty({ example: 'Ahmad', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Trim()
  firstName: string;

  @ApiProperty({ example: 'Hanbal', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Trim()
  lastName: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ahmad.hanbal@example.com' })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(320)
  @Trim()
  email: string;

  @ApiProperty({ example: 'correct-horse-battery-7' })
  @IsString()
  @IsNotEmpty({ message: 'password is required' })
  // Deliberately *not* validated against the strength policy. Sign-in must
  // accept whatever is stored, including passwords set before a policy change;
  // rejecting them here would lock users out and, worse, would disclose policy
  // details to an attacker probing with candidate passwords.
  @MaxLength(1024)
  password: string;

  @ApiPropertyOptional({
    description:
      'Workspace to activate on sign-in. Advisory only — membership is always ' +
      're-verified per request.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;
}

export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'The refresh token. Optional when the refresh token is carried in the ' +
      'httpOnly cookie instead, which is the recommended browser configuration.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  refreshToken?: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token from the verification email link.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'ahmad.hanbal@example.com' })
  @IsEmail()
  @MaxLength(320)
  @Trim()
  email: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ahmad.hanbal@example.com' })
  @IsEmail()
  @MaxLength(320)
  @Trim()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token from the password reset email link.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;

  @ApiProperty({ description: 'The new password. Must satisfy the password policy.' })
  @IsString()
  @IsStrongPassword()
  password: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: 'Your current password, required even when signed in.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  currentPassword: string;

  @ApiProperty({ description: 'The new password. Must satisfy the password policy.' })
  @IsString()
  @IsStrongPassword()
  newPassword: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Trim()
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Trim()
  lastName?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Trim()
  displayName?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Trim()
  avatarUrl?: string;
}

// ── Response shapes (for OpenAPI; the frontend generates its client from these) ──

export class TokenPairDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty({
    description:
      'Omitted from the body when the refresh cookie is enabled, in which case ' +
      'it is set as an httpOnly cookie instead.',
    required: false,
  })
  refreshToken?: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ description: 'Access token lifetime in seconds.', example: 900 })
  expiresIn: number;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ description: 'Refresh token lifetime in seconds.', example: 2592000 })
  refreshExpiresIn: number;
}

export class AuthUserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty()
  emailVerified: boolean;

  @ApiProperty()
  isPlatformAdmin: boolean;

  @ApiProperty({ enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] })
  status: string;
}

export class AuthResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;

  @ApiProperty({ type: TokenPairDto })
  tokens: TokenPairDto;
}

export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ nullable: true, example: 'Chrome on Windows' })
  deviceLabel: string | null;

  @ApiProperty({ nullable: true })
  ipAddress: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastUsedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({ description: 'True for the session making this request.' })
  isCurrent: boolean;
}

export class MembershipSummaryDto {
  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty()
  organizationName: string;

  @ApiProperty()
  organizationSlug: string;

  @ApiProperty({ type: [String] })
  roleSlugs: string[];

  @ApiProperty()
  isOwner: boolean;
}

export class CurrentUserDto extends AuthUserDto {
  @ApiProperty({ type: [MembershipSummaryDto] })
  memberships: MembershipSummaryDto[];

  @ApiPropertyOptional({
    description:
      'Effective permissions in the active workspace, wildcards expanded to ' +
      'concrete keys so the frontend can drive per-control visibility directly.',
    type: [String],
  })
  permissions?: string[];

  @ApiPropertyOptional({ description: 'The active workspace, if one was supplied.' })
  activeOrganizationId?: string;
}
