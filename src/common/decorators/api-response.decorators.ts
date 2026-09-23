import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ErrorCode } from '../enums/error-code.enum';

/**
 * OpenAPI helpers.
 *
 * Every response the API produces is wrapped in a `{ success, data, meta }`
 * envelope by the response interceptor. Swagger cannot infer that from a
 * handler's return type, so these decorators describe it — which matters because
 * the React frontend generates its typed client from the emitted OpenAPI
 * document, and an unenveloped schema would produce a client that does not
 * compile against the real responses.
 */

/** Documents a single-object success response inside the standard envelope. */
export const ApiEnvelopedResponse = <TModel extends Type<unknown>>(
  model: TModel,
  description = 'Successful response',
) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: getSchemaPath(model) },
          meta: { $ref: getSchemaPath('ResponseMeta') },
        },
      },
    }),
  );

/** Documents a paginated list response inside the standard envelope. */
export const ApiPaginatedResponse = <TModel extends Type<unknown>>(
  model: TModel,
  description = 'Paginated list',
) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'array',
            items: { $ref: getSchemaPath(model) },
          },
          meta: {
            type: 'object',
            properties: {
              requestId: { type: 'string', format: 'uuid' },
              timestamp: { type: 'string', format: 'date-time' },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer', example: 1 },
                  limit: { type: 'integer', example: 20 },
                  totalItems: { type: 'integer', example: 137 },
                  totalPages: { type: 'integer', example: 7 },
                  hasPreviousPage: { type: 'boolean', example: false },
                  hasNextPage: { type: 'boolean', example: true },
                },
              },
            },
          },
        },
      },
    }),
  );

/**
 * Documents an error response with its stable {@link ErrorCode}.
 *
 * Listing the exact codes a route can return is what lets the frontend branch on
 * them with confidence rather than string-matching messages.
 */
export const ApiErrorResponse = (
  status: number,
  codes: ErrorCode[],
  description?: string,
) =>
  ApiResponse({
    status,
    description: description ?? `Possible codes: ${codes.join(', ')}`,
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', enum: codes },
            message: { type: 'string' },
            details: { type: 'object', nullable: true, additionalProperties: true },
          },
        },
        meta: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
            path: { type: 'string' },
          },
        },
      },
    },
  });

/** The error responses essentially every authenticated route can produce. */
export const ApiStandardErrors = () =>
  applyDecorators(
    ApiErrorResponse(
      401,
      [
        ErrorCode.AUTH_REQUIRED,
        ErrorCode.AUTH_TOKEN_INVALID,
        ErrorCode.AUTH_TOKEN_EXPIRED,
        ErrorCode.AUTH_TOKEN_REVOKED,
      ],
      'Authentication failed or the token is no longer valid.',
    ),
    ApiErrorResponse(
      403,
      [
        ErrorCode.PERMISSION_DENIED,
        ErrorCode.CROSS_TENANT_ACCESS_DENIED,
        ErrorCode.IP_NOT_ALLOWED,
        ErrorCode.ORGANIZATION_SUSPENDED,
      ],
      'The caller is authenticated but not authorised.',
    ),
    ApiErrorResponse(
      422,
      [ErrorCode.VALIDATION_FAILED],
      'Request body or query parameters failed validation.',
    ),
    ApiErrorResponse(
      429,
      [ErrorCode.RATE_LIMIT_EXCEEDED, ErrorCode.QUOTA_EXCEEDED],
      'Rate limit or quota exceeded.',
    ),
  );
