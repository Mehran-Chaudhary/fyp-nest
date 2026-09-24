import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Workspace settings.
 *
 * The model and redaction policies are deliberately *not* here: they have
 * their own endpoints and permissions (`llm:manage`, `pii:policy:update`),
 * because this object is writable with `workspace:update`, and weakening what
 * is masked before data reaches a model must not be a side effect of renaming
 * the workspace. See `PUT …/llm/policy` and `PUT …/pii/policy`.
 */
export class OrganizationSettingsDto {
  @ApiPropertyOptional({
    description: 'Default ingestion chunk size in tokens.',
    example: 512,
  })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(4096)
  defaultChunkSize?: number;

  @ApiPropertyOptional({
    description: 'Token overlap between adjacent chunks.',
    example: 64,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1024)
  defaultChunkOverlap?: number;

  @ApiPropertyOptional({ description: 'Monthly token allowance across the workspace.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyTokenQuota?: number;

  @ApiPropertyOptional({ description: 'Days to retain audit records.', example: 365 })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3650)
  auditRetentionDays?: number;

  @ApiPropertyOptional({ description: 'Require every member to verify their email.' })
  @IsOptional()
  @IsBoolean()
  requireVerifiedEmail?: boolean;

  @ApiPropertyOptional({
    description: 'Restrict invitations to these email domains.',
    example: ['example.com'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @MaxLength(253, { each: true })
  allowedEmailDomains?: string[];
}

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Corporation', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @Trim()
  name: string;

  @ApiPropertyOptional({
    description:
      'URL-safe identifier. Derived from the name when omitted, and given a ' +
      'random suffix if already taken.',
    example: 'acme-corp',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: 'slug may contain only lowercase letters, numbers and hyphens',
  })
  @Trim()
  slug?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string;
}

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Trim()
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Trim()
  description?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Trim()
  logoUrl?: string;

  @ApiPropertyOptional({ type: OrganizationSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OrganizationSettingsDto)
  settings?: OrganizationSettingsDto;
}

export class TransferOwnershipDto {
  @ApiProperty({
    description: 'User id of the new owner. Must already be an active member.',
    format: 'uuid',
  })
  @IsUUID('4')
  newOwnerUserId: string;
}

export class CreateIpRuleDto {
  @ApiProperty({
    description: 'An address or CIDR range. IPv4 and IPv6 are both supported.',
    example: '203.0.113.0/24',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Trim()
  cidr: string;

  @ApiPropertyOptional({ example: 'Head office VPN', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Trim()
  label?: string;
}

export class SetIpEnforcementDto {
  @ApiProperty({
    description:
      'Turns workspace IP restriction on or off. Enabling with no active rules is ' +
      'refused, because it would lock every member out.',
  })
  @IsBoolean()
  enabled: boolean;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class OrganizationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  logoUrl: string | null;

  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] })
  status: string;

  @ApiProperty({ enum: ['FREE', 'PRO', 'ENTERPRISE'] })
  plan: string;

  @ApiProperty({ format: 'uuid' })
  ownerId: string;

  @ApiProperty({ type: OrganizationSettingsDto })
  settings: OrganizationSettingsDto;

  @ApiProperty()
  ipAllowlistEnabled: boolean;

  @ApiProperty()
  memberCount: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class OrganizationWithMembershipDto extends OrganizationDto {
  @ApiProperty({ type: [String], description: 'Your role slugs in this workspace.' })
  roleSlugs: string[];

  @ApiProperty({ description: 'True when you own this workspace.' })
  isOwner: boolean;

  @ApiProperty({ format: 'date-time', nullable: true })
  joinedAt: Date | null;
}

export class IpRuleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  cidr: string;

  @ApiProperty({ nullable: true })
  label: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastMatchedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
