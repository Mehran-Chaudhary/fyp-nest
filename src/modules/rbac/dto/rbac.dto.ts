import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsHexColor,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Permission-key format.
 *
 * Validated at the DTO layer as well as against the catalogue in the service.
 * The pattern check rejects obviously malformed input before it reaches any
 * lookup, and — because these strings end up in a JSONB column and in audit
 * metadata — constrains what can be stored at all.
 */
const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*(:[a-z0-9_*]+)+$|^\*:\*$/;

export class CreateRoleDto {
  @ApiProperty({ example: 'Compliance Auditor', maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(60)
  @Trim()
  name: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Trim()
  description?: string;

  @ApiProperty({
    description:
      'Permission keys this role grants. Wildcards such as `document:*` are ' +
      'accepted. You cannot grant a permission you do not hold yourself.',
    example: ['audit:read', 'audit:export', 'document:read'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'a role must grant at least one permission' })
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Matches(PERMISSION_KEY_PATTERN, {
    each: true,
    message: 'each permission must look like "resource:action"',
  })
  permissionKeys: string[];

  @ApiPropertyOptional({
    description:
      'Ranking used to decide who may act on whom. Must be strictly below your ' +
      'own, so a role you create can never be used against you.',
    minimum: 0,
    maximum: 99,
    default: 40,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  priority?: number;

  @ApiPropertyOptional({ example: '#4f46e5' })
  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Trim()
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Trim()
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Matches(PERMISSION_KEY_PATTERN, {
    each: true,
    message: 'each permission must look like "resource:action"',
  })
  permissionKeys?: string[];

  @ApiPropertyOptional({ minimum: 0, maximum: 99 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  color?: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class PermissionDto {
  @ApiProperty({ example: 'document:read' })
  key: string;

  @ApiProperty({ example: 'document' })
  resource: string;

  @ApiProperty({ example: 'read' })
  action: string;

  @ApiProperty({ example: 'knowledge' })
  category: string;

  @ApiProperty()
  description: string;

  @ApiProperty({
    description:
      'Granting this is itself an escalation risk; the grantor must already hold it.',
  })
  isDangerous: boolean;

  @ApiProperty({
    description: 'The implementation phase that starts enforcing this permission.',
    minimum: 1,
    maximum: 5,
  })
  phase: number;
}

export class RoleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ description: 'Built-in roles cannot be edited or deleted.' })
  isSystem: boolean;

  @ApiProperty({ description: 'Assigned to members who join without an explicit role.' })
  isDefault: boolean;

  @ApiProperty()
  priority: number;

  @ApiProperty({ nullable: true })
  color: string | null;

  @ApiProperty({ type: [String], description: 'Granted keys, wildcards included.' })
  permissionKeys: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class PermissionCatalogueDto {
  @ApiProperty({ type: [PermissionDto] })
  permissions: PermissionDto[];

  @ApiProperty({
    description: 'Permission keys grouped by category, for rendering the role editor.',
    example: { workspace: ['workspace:read'], members: ['member:read'] },
  })
  byCategory: Record<string, string[]>;
}
