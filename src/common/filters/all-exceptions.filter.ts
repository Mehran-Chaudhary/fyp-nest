import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { QueryFailedError, EntityNotFoundError } from 'typeorm';
import { APP_CONFIG_KEY, type AppConfig } from '../../config/app.config';
import { HEADER } from '../constants/app.constants';
import { ERROR_CODE_MESSAGES, ErrorCode } from '../enums/error-code.enum';
import { AppException } from '../exceptions/app.exception';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { deepRedact, LOG_SENSITIVE_KEYS } from '../utils/redact.util';

/**
 * HTTP status to {@link ErrorCode}, for exceptions raised by Nest itself rather
 * than by this application's domain layer.
 */
const STATUS_TO_ERROR_CODE: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.AUTH_REQUIRED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.RESOURCE_NOT_FOUND,
  [HttpStatus.REQUEST_TIMEOUT]: ErrorCode.REQUEST_TIMEOUT,
  [HttpStatus.CONFLICT]: ErrorCode.RESOURCE_CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMIT_EXCEEDED,
  [HttpStatus.NOT_IMPLEMENTED]: ErrorCode.NOT_IMPLEMENTED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
  [HttpStatus.GATEWAY_TIMEOUT]: ErrorCode.REQUEST_TIMEOUT,
};

/** PostgreSQL error codes this filter translates into domain errors. */
const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  RESTRICT_VIOLATION: '23001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  QUERY_CANCELED: '57014',
} as const;

/**
 * The single exit point for every error the API produces.
 *
 * Three responsibilities, each of which would otherwise be duplicated across
 * dozens of handlers:
 *
 *  1. **One shape.** Everything leaves as `{ success: false, error, meta }` with
 *     a stable {@link ErrorCode}, so the frontend has exactly one error contract.
 *
 *  2. **No leakage.** An unexpected exception is logged in full server-side and
 *     reported to the client as a generic message with a request id. Database
 *     errors in particular must never reach a client: a unique-violation message
 *     from PostgreSQL discloses table names, column names and the conflicting
 *     value, which on a multi-tenant platform can confirm the existence of
 *     another tenant's data.
 *
 *  3. **Correlation.** Every response carries the request id, so a user reporting
 *     "it failed" hands over the one token needed to find the exact log line.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly isProduction: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isProduction =
      this.configService.get<AppConfig>(APP_CONFIG_KEY)?.isProduction ?? true;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<AuthenticatedRequest>();

    const resolved = this.resolve(exception);

    this.log(exception, resolved, request);

    // A streaming response (Server-Sent Events) has already sent its status
    // and headers; there is no envelope left to write. The stream reports its
    // own errors as events, so all that remains is to end it cleanly.
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }

    if (resolved.retryAfterSeconds !== undefined) {
      response.setHeader(HEADER.RETRY_AFTER, String(resolved.retryAfterSeconds));
    }

    response.status(resolved.status).json({
      success: false,
      error: {
        code: resolved.code,
        message: resolved.message,
        ...(resolved.details ? { details: resolved.details } : {}),
        // The stack is a development aid only. In production it would disclose
        // file paths, dependency versions and internal structure.
        ...(this.isProduction || !resolved.stack ? {} : { stack: resolved.stack }),
      },
      meta: {
        requestId: request.requestId ?? 'unknown',
        timestamp: new Date().toISOString(),
        path: request.originalUrl?.split('?')[0] ?? request.url,
        ...(request.startTime ? { durationMs: Date.now() - request.startTime } : {}),
      },
    });
  }

  private resolve(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    stack?: string;
    retryAfterSeconds?: number;
    isExpected: boolean;
  } {
    // ── Deliberate domain errors ──────────────────────────────────────────
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.displayMessage,
        details: exception.details,
        retryAfterSeconds: exception.retryAfterSeconds,
        isExpected: true,
      };
    }

    // ── Nest built-ins, including ValidationPipe output ───────────────────
    if (exception instanceof HttpException) {
      return this.resolveHttpException(exception);
    }

    // ── TypeORM ───────────────────────────────────────────────────────────
    if (exception instanceof EntityNotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.RESOURCE_NOT_FOUND,
        message: ERROR_CODE_MESSAGES[ErrorCode.RESOURCE_NOT_FOUND],
        isExpected: true,
      };
    }

    if (exception instanceof QueryFailedError) {
      return this.resolveQueryFailure(exception);
    }

    // ── Anything else is a bug ────────────────────────────────────────────
    const error = exception as Error;
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: ERROR_CODE_MESSAGES[ErrorCode.INTERNAL_SERVER_ERROR],
      stack: error?.stack,
      isExpected: false,
    };
  }

  private resolveHttpException(exception: HttpException): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    isExpected: boolean;
  } {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    // class-validator failures arrive as { message: string[], error, statusCode }.
    if (
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { message?: unknown }).message)
    ) {
      const messages = (payload as { message: string[] }).message;
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.VALIDATION_FAILED,
        message: ERROR_CODE_MESSAGES[ErrorCode.VALIDATION_FAILED],
        details: { fields: this.groupValidationMessages(messages) },
        isExpected: true,
      };
    }

    const message =
      typeof payload === 'string'
        ? payload
        : ((payload as { message?: string }).message ?? exception.message);

    return {
      status,
      code: this.statusToErrorCode(status),
      message,
      isExpected: status < 500,
    };
  }

  /**
   * Maps a PostgreSQL failure onto a domain error.
   *
   * The driver's own message is never forwarded. A unique violation reports the
   * constraint name, the table and the offending value, all of which are
   * internal detail and some of which are another tenant's data.
   */
  private resolveQueryFailure(exception: Error & { code?: string }): {
    status: number;
    code: ErrorCode;
    message: string;
    stack?: string;
    isExpected: boolean;
  } {
    const driverCode = exception.code;

    switch (driverCode) {
      case PG_ERROR.UNIQUE_VIOLATION:
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.RESOURCE_CONFLICT,
          message: 'That value is already in use.',
          isExpected: true,
        };

      case PG_ERROR.FOREIGN_KEY_VIOLATION:
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.RESOURCE_CONFLICT,
          message:
            'The request references a resource that does not exist, or is still in use.',
          isExpected: true,
        };

      case PG_ERROR.NOT_NULL_VIOLATION:
      case PG_ERROR.CHECK_VIOLATION:
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The request violates a data integrity rule.',
          isExpected: true,
        };

      // Raised by the audit log's append-only trigger.
      case PG_ERROR.RESTRICT_VIOLATION:
        return {
          status: HttpStatus.FORBIDDEN,
          code: ErrorCode.AUDIT_LOG_IMMUTABLE,
          message: ERROR_CODE_MESSAGES[ErrorCode.AUDIT_LOG_IMMUTABLE],
          isExpected: true,
        };

      case PG_ERROR.SERIALIZATION_FAILURE:
      case PG_ERROR.DEADLOCK_DETECTED:
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.RESOURCE_CONFLICT,
          message: 'The request conflicted with a concurrent change. Please retry.',
          isExpected: true,
        };

      case PG_ERROR.QUERY_CANCELED:
        return {
          status: HttpStatus.GATEWAY_TIMEOUT,
          code: ErrorCode.REQUEST_TIMEOUT,
          message: ERROR_CODE_MESSAGES[ErrorCode.REQUEST_TIMEOUT],
          isExpected: true,
        };

      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: ERROR_CODE_MESSAGES[ErrorCode.INTERNAL_SERVER_ERROR],
          stack: exception.stack,
          isExpected: false,
        };
    }
  }

  /**
   * Maps an HTTP status to the error code returned for it.
   *
   * A lookup table rather than a switch: `HttpException.getStatus()` returns a
   * plain `number`, and switching that against `HttpStatus` members trips
   * `no-unsafe-enum-comparison` — while casting to satisfy it trips
   * `no-unnecessary-type-assertion`. Indexing a numeric record sidesteps both
   * and reads better than thirteen cases.
   */
  private statusToErrorCode(status: number): ErrorCode {
    return (
      STATUS_TO_ERROR_CODE[status] ??
      (status >= 500 ? ErrorCode.INTERNAL_SERVER_ERROR : ErrorCode.BAD_REQUEST)
    );
  }

  /**
   * Turns class-validator's flat message list into per-field groups.
   *
   * Messages arrive as `["email must be an email", "password is too short"]`;
   * a form needs them keyed by field to render inline errors.
   */
  private groupValidationMessages(messages: string[]): Record<string, string[]> {
    const grouped: Record<string, string[]> = {};

    for (const message of messages) {
      const field = message.split(' ')[0] ?? '_';
      (grouped[field] ??= []).push(message);
    }

    return grouped;
  }

  private log(
    exception: unknown,
    resolved: { status: number; code: ErrorCode; isExpected: boolean },
    request: AuthenticatedRequest,
  ): void {
    const context = {
      requestId: request.requestId,
      method: request.method,
      path: request.originalUrl?.split('?')[0],
      status: resolved.status,
      code: resolved.code,
      userId: request.user?.id,
      organizationId: request.organization?.id,
      ip: request.ip,
    };

    if (!resolved.isExpected) {
      // Unexpected: log the whole thing, including the request body, so the bug
      // is diagnosable. Redaction is what makes logging the body acceptable.
      this.logger.error(
        {
          ...context,
          // Free text is redacted as well as secrets: a failed chat request
          // must not copy the user's message into the application log.
          body: deepRedact(request.body as unknown, LOG_SENSITIVE_KEYS),
          err: exception as Error,
        },
        `Unhandled exception: ${(exception as Error)?.message ?? 'unknown'}`,
      );
      return;
    }

    if (resolved.status >= 500) {
      this.logger.error(context, `Server error: ${resolved.code}`);
      return;
    }

    // Expected 4xx responses are normal operation, not incidents. Logged at
    // debug so that a user mistyping a password does not read as a problem —
    // the security-relevant subset is captured by the audit log instead.
    this.logger.debug(context, `Request rejected: ${resolved.code}`);
  }
}
