import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDate,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinDate,
} from 'class-validator';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'Human label, shown in the key list.',
    example: 'Python AI service (production)',
    maxLength: 120,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
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
      'Permissions this key may exercise. Capped by your own permissions at ' +
      'issue time, so a key can never exceed the authority of its creator.',
    example: ['rag:query', 'document:read'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'an API key must have at least one scope' })
  @ArrayMaxSize(50)
  @IsString({ each: true })
  scopes: string[];

  @ApiPropertyOptional({
    description: 'Expiry. Defaults to API_KEY_DEFAULT_TTL from configuration.',
    format: 'date-time',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @MinDate(() => new Date(), { message: 'expiresAt must be in the future' })
  expiresAt?: Date;

  @ApiPropertyOptional({
    description:
      'Pin the key to specific networks. A key pinned to the AI service host is ' +
      'useless to an attacker who exfiltrates it.',
    example: ['10.0.4.0/24'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedIps?: string[];
}

export class RevokeApiKeyDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Trim()
  reason?: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class ApiKeyDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({
    description: 'Non-secret leading segment, for identifying the key in a list.',
    example: 'daiap_sk_a1b2c3d4',
  })
  prefix: string;

  @ApiProperty({ type: [String] })
  scopes: string[];

  @ApiProperty({ format: 'uuid' })
  createdById: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  revokedAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastUsedAt: Date | null;

  @ApiProperty({ nullable: true })
  lastUsedIp: string | null;

  @ApiProperty({ example: '1420' })
  usageCount: string;

  @ApiProperty({ type: [String] })
  allowedIps: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

/**
 * The response returned exactly once, at creation.
 *
 * The plaintext key is never retrievable again — only its HMAC digest is stored
 * — so the frontend must present it prominently and tell the user to save it.
 */
export class CreatedApiKeyDto {
  @ApiProperty({ type: ApiKeyDto })
  apiKey: ApiKeyDto;

  @ApiProperty({
    description:
      'The secret. Shown once and never again; the platform stores only a digest.',
    example: 'daiap_sk_a1b2c3d4e5f6...',
  })
  plaintextKey: string;

  @ApiProperty({
    example: 'Store this now. It cannot be retrieved again.',
  })
  warning: string;
}
