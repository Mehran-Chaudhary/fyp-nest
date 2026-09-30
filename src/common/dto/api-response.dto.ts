import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PaginationMeta } from '../utils/pagination.util';
import type { ErrorCode } from '../enums/error-code.enum';

/**
 * The response envelope.
 *
 * Every response — success or failure — has the same outer shape, so the
 * frontend has exactly one place to read a correlation id and one place to
 * detect failure. The alternative, returning bare payloads, means clients must
 * infer success from the HTTP status and have nowhere consistent to surface the
 * request id when a user reports a problem.
 */

export class ResponseMeta {
  @ApiProperty({
    description: 'Correlation id, also returned in the X-Request-Id header.',
    example: 'b3d1f6e2-7a4c-4f0b-9c2e-1f5a8d3e7b91',
  })
  requestId: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-23T10:15:30.123Z' })
  timestamp: string;

  @ApiPropertyOptional({ description: 'Present on list endpoints.' })
  pagination?: PaginationMeta;

  @ApiPropertyOptional({ description: 'Server-side handling time in milliseconds.' })
  durationMs?: number;
}

export class ApiSuccessResponse<T> {
  @ApiProperty({ example: true })
  success: true;

  @ApiProperty({ description: 'The payload.' })
  data: T;

  @ApiProperty({ type: ResponseMeta })
  meta: ResponseMeta;
}

export class ApiErrorBody {
  @ApiProperty({
    description: 'Stable machine-readable code. Branch on this, never on the message.',
    example: 'PERMISSION_DENIED',
  })
  code: ErrorCode;

  @ApiProperty({
    description: 'Human readable explanation, safe to show to an end user.',
    example: 'You lack the permissions required for this action.',
  })
  message: string;

  @ApiPropertyOptional({
    description:
      'Structured detail: field-level validation errors, missing permission keys, retry hints.',
  })
  details?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: false })
  success: false;

  @ApiProperty({ type: ApiErrorBody })
  error: ApiErrorBody;

  @ApiProperty({ type: ResponseMeta })
  meta: ResponseMeta & { path?: string };
}

/** `error.details` of a `VALIDATION_FAILED` (422) response. */
export class ValidationErrorDetails {
  @ApiProperty({
    description:
      'Messages per field, keyed by the property path in the request: `email`, nested ' +
      'fields as `settings.defaultChunkSize`, array items as `items.0.name`. An unknown ' +
      'field is reported under its own name.',
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    example: {
      email: ['email must be a valid email address'],
      'settings.defaultChunkSize': ['settings.defaultChunkSize must not be less than 64'],
    },
  })
  fields: Record<string, string[]>;
}
