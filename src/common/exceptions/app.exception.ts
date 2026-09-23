import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODE_MESSAGES, ErrorCode } from '../enums/error-code.enum';

export interface AppExceptionOptions {
  /** Overrides the catalogue's default message for this code. */
  message?: string;
  /** Structured, client-safe detail (field errors, offending ids, and so on). */
  details?: Record<string, unknown> | Array<Record<string, unknown>>;
  /** Original error, retained for server-side logging only. Never serialised. */
  cause?: unknown;
  /**
   * Extra key/values merged into the audit record written for this failure.
   * Redacted before storage like any other metadata.
   */
  auditMetadata?: Record<string, unknown>;
}

/**
 * Base class for every deliberate, domain-level failure.
 *
 * Throwing `AppException` (rather than a bare `HttpException`) guarantees the
 * response carries a stable {@link ErrorCode}, which is the contract the React
 * frontend branches on. The global exception filter knows how to serialise it;
 * anything else that reaches the filter is treated as an unexpected fault and
 * has its message suppressed in production.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown> | Array<Record<string, unknown>>;
  readonly auditMetadata?: Record<string, unknown>;

  constructor(code: ErrorCode, status: HttpStatus, options: AppExceptionOptions = {}) {
    const message = options.message ?? ERROR_CODE_MESSAGES[code] ?? 'An error occurred.';
    super({ code, message }, status, { cause: options.cause });

    this.code = code;
    this.details = options.details;
    this.auditMetadata = options.auditMetadata;
    this.name = new.target.name;
  }

  /** Message as a plain string, regardless of how the payload was constructed. */
  get displayMessage(): string {
    const response = this.getResponse();
    if (typeof response === 'string') return response;
    const asRecord = response as { message?: unknown };
    return typeof asRecord.message === 'string' ? asRecord.message : this.message;
  }
}

// ── 400 ─────────────────────────────────────────────────────────────────────

export class BadRequestError extends AppException {
  constructor(code: ErrorCode = ErrorCode.BAD_REQUEST, options?: AppExceptionOptions) {
    super(code, HttpStatus.BAD_REQUEST, options);
  }
}

export class ValidationError extends AppException {
  constructor(options?: AppExceptionOptions) {
    super(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, options);
  }
}

// ── 401 ─────────────────────────────────────────────────────────────────────

export class UnauthorizedError extends AppException {
  constructor(code: ErrorCode = ErrorCode.AUTH_REQUIRED, options?: AppExceptionOptions) {
    super(code, HttpStatus.UNAUTHORIZED, options);
  }
}

// ── 403 ─────────────────────────────────────────────────────────────────────

export class ForbiddenError extends AppException {
  constructor(code: ErrorCode = ErrorCode.FORBIDDEN, options?: AppExceptionOptions) {
    super(code, HttpStatus.FORBIDDEN, options);
  }
}

/**
 * Raised when a caller lacks one or more required permissions.
 *
 * The missing keys are returned to the client on purpose: the frontend uses them
 * to render an actionable "ask your administrator for `agent:create`" message
 * rather than a bare 403. This discloses only the *names* of permissions, which
 * are already public via the role editor, never whether a resource exists.
 */
export class PermissionDeniedError extends ForbiddenError {
  constructor(missing: readonly string[], options?: AppExceptionOptions) {
    super(ErrorCode.PERMISSION_DENIED, {
      ...options,
      details: { missingPermissions: [...missing], ...(options?.details as object) },
    });
  }
}

// ── 404 ─────────────────────────────────────────────────────────────────────

export class NotFoundError extends AppException {
  constructor(code: ErrorCode = ErrorCode.RESOURCE_NOT_FOUND, options?: AppExceptionOptions) {
    super(code, HttpStatus.NOT_FOUND, options);
  }
}

// ── 409 ─────────────────────────────────────────────────────────────────────

export class ConflictError extends AppException {
  constructor(code: ErrorCode = ErrorCode.RESOURCE_CONFLICT, options?: AppExceptionOptions) {
    super(code, HttpStatus.CONFLICT, options);
  }
}

// ── 429 ─────────────────────────────────────────────────────────────────────

export class RateLimitError extends AppException {
  readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number,
    code: ErrorCode = ErrorCode.RATE_LIMIT_EXCEEDED,
    options?: AppExceptionOptions,
  ) {
    super(code, HttpStatus.TOO_MANY_REQUESTS, {
      ...options,
      details: { retryAfterSeconds, ...(options?.details as object) },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ── 5xx ─────────────────────────────────────────────────────────────────────

export class InternalError extends AppException {
  constructor(options?: AppExceptionOptions) {
    super(ErrorCode.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR, options);
  }
}

export class DependencyFailureError extends AppException {
  constructor(dependency: string, options?: AppExceptionOptions) {
    super(ErrorCode.DEPENDENCY_FAILURE, HttpStatus.BAD_GATEWAY, {
      message: `The ${dependency} service is not responding.`,
      ...options,
      details: { dependency, ...(options?.details as object) },
    });
  }
}

export class ServiceUnavailableError extends AppException {
  constructor(options?: AppExceptionOptions) {
    super(ErrorCode.SERVICE_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE, options);
  }
}

export class NotImplementedError extends AppException {
  constructor(feature: string, phase?: number) {
    super(ErrorCode.NOT_IMPLEMENTED, HttpStatus.NOT_IMPLEMENTED, {
      message: phase
        ? `${feature} is scheduled for phase ${phase} and is not available yet.`
        : `${feature} is not available yet.`,
    });
  }
}
