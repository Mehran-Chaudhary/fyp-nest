import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
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

  @ApiPropertyOptional({ description: 'Two-step verification is enabled (phase 5).' })
  mfaEnabled?: boolean;
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
  @ApiProperty({ nullable: true, maxLength: 2048 })
  avatarUrl: string | null;

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

// ── Two-step verification (phase 5) ────────────────────────────────────────

export class MfaChallengeDto {
  @ApiProperty({
    description:
      'Signed, single-use and short-lived. Send it back with a code to POST /auth/mfa/verify.',
  })
  token: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ type: [String], enum: ['totp', 'recovery_code'] })
  methods: string[];
}

/**
 * Sign-in with two-step verification: the password was right; a code is
 * needed to finish. Returned by POST /auth/login instead of tokens.
 */
export class MfaRequiredResponseDto {
  @ApiProperty({ enum: [true] })
  mfaRequired: true;

  @ApiProperty({ type: MfaChallengeDto })
  challenge: MfaChallengeDto;
}

/** Exactly one of `code` and `recoveryCode`. */
export class SecondFactorDto {
  @ApiPropertyOptional({
    description: 'The six-digit code from the authenticator app.',
    example: '492039',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\s*\d{3}\s?\d{3}\s*$/, { message: 'code must be six digits.' })
  code?: string;

  @ApiPropertyOptional({
    description: 'A single-use recovery code.',
    example: 'k7m2p-x9qrt',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  recoveryCode?: string;
}

export class VerifyMfaDto extends SecondFactorDto {
  @ApiProperty({ description: 'The challenge token from POST /auth/login.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  challengeToken: string;
}

export class BeginMfaSetupDto {
  @ApiProperty({
    description: 'Your password: a session alone cannot attach an authenticator.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password: string;
}

export class MfaSetupResponseDto {
  @ApiProperty({ description: 'Base32 secret, for manual entry. Shown once.' })
  secret: string;

  @ApiProperty({ description: 'otpauth:// URI: render it as a QR code.' })
  otpauthUri: string;

  @ApiProperty() issuer: string;
  @ApiProperty() account: string;
}

export class EnableMfaDto {
  @ApiProperty({
    description: 'A current code from the authenticator app.',
    example: '492039',
  })
  @IsString()
  @Matches(/^\s*\d{3}\s?\d{3}\s*$/, { message: 'code must be six digits.' })
  code: string;
}

export class EnableMfaResponseDto {
  @ApiProperty({
    type: [String],
    description: 'Single-use recovery codes. Shown once: store them somewhere safe.',
  })
  recoveryCodes: string[];

  @ApiPropertyOptional({
    description:
      'A new access token for this session, carrying the second factor it just proved.',
  })
  accessToken?: string;

  @ApiPropertyOptional() expiresIn?: number;
}

export class DisableMfaDto extends SecondFactorDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password: string;
}

export class RegenerateRecoveryCodesDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password: string;

  @ApiProperty({ example: '492039' })
  @IsString()
  @Matches(/^\s*\d{3}\s?\d{3}\s*$/, { message: 'code must be six digits.' })
  code: string;
}

export class RecoveryCodesDto {
  @ApiProperty({ type: [String] }) recoveryCodes: string[];
}

export class MfaStatusDto {
  @ApiProperty() enabled: boolean;
  @ApiProperty({ nullable: true, format: 'date-time' }) enrolledAt: Date | null;
  @ApiProperty() recoveryCodesRemaining: number;
  @ApiProperty({ description: 'Whether the current session passed a second factor.' })
  sessionVerified: boolean;
}
