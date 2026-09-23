import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { METADATA_KEY } from '../constants/app.constants';
import type { AuditDescriptor } from '../decorators/audit.decorator';
import { AuditStatus } from '../enums/audit-action.enum';
import { AppException } from '../exceptions/app.exception';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { AuditService } from '../../modules/audit/audit.service';

/**
 * Writes an audit record for routes annotated with `@Audit()`.
 *
 * Covers the uniform "who called what, with what arguments, and did it work"
 * case. Records are written on **both** the success and failure paths: from a
 * compliance standpoint the failed attempt is usually the interesting one, and a
 * log that only contains successes cannot answer the question a reviewer
 * actually asks after an incident.
 *
 * Services still call `AuditService` directly for events carrying
 * domain-specific detail — a permission-set diff, a refresh token reuse — where
 * a generic descriptor could not capture what matters. The two paths are
 * complementary, not alternatives.
 *
 * Failures here never fail the request: {@link AuditService.recordSafe} logs and
 * swallows. Failing a user's successful operation because its audit row could
 * not be written trades a real availability loss for a marginal completeness
 * gain. Events where that trade-off runs the other way are written
 * transactionally by their service instead.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const descriptor = this.reflector.getAllAndOverride<AuditDescriptor>(METADATA_KEY.AUDIT, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!descriptor) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap((result) => {
        if (descriptor.onlyOnFailure) return;

        void this.auditService.recordSafe({
          action: descriptor.action,
          status: AuditStatus.SUCCESS,
          organizationId: request.organization?.id,
          resourceType: descriptor.resourceType,
          resourceId: this.resolveResourceId(descriptor, request, result),
          resourceLabel: this.resolveResourceLabel(descriptor, request, result),
          metadata: this.captureMetadata(descriptor, request),
          durationMs: Date.now() - startedAt,
          httpStatus: context.switchToHttp().getResponse<{ statusCode?: number }>()
            .statusCode,
        });
      }),
      catchError((error: unknown) => {
        const isDomainError = error instanceof AppException;

        void this.auditService.recordSafe({
          action: descriptor.action,
          status:
            isDomainError && error.getStatus() === 403
              ? AuditStatus.DENIED
              : AuditStatus.FAILURE,
          organizationId: request.organization?.id,
          resourceType: descriptor.resourceType,
          resourceId: this.resolveResourceId(descriptor, request, undefined),
          resourceLabel: this.resolveResourceLabel(descriptor, request, undefined),
          errorCode: isDomainError ? error.code : 'INTERNAL_SERVER_ERROR',
          errorMessage: (error as Error)?.message,
          metadata: {
            ...this.captureMetadata(descriptor, request),
            ...(isDomainError && error.auditMetadata ? error.auditMetadata : {}),
          },
          durationMs: Date.now() - startedAt,
          httpStatus: isDomainError ? error.getStatus() : 500,
        });

        return throwError(() => error);
      }),
    );
  }

  /**
   * Resolves the audited resource id.
   *
   * Falls back to the handler's return value because on a create route the id
   * does not exist until the handler has run — and a create with no recorded id
   * is close to useless in an audit trail.
   */
  private resolveResourceId(
    descriptor: AuditDescriptor,
    request: AuthenticatedRequest,
    result: unknown,
  ): string | undefined {
    if (descriptor.resourceIdFrom) {
      const value = readPath(
        { params: request.params, body: request.body, query: request.query },
        descriptor.resourceIdFrom,
      );
      if (value !== undefined && value !== null) return String(value);
    }

    const fromResult = (result as { id?: unknown } | undefined)?.id;
    return fromResult !== undefined && fromResult !== null ? String(fromResult) : undefined;
  }

  private resolveResourceLabel(
    descriptor: AuditDescriptor,
    request: AuthenticatedRequest,
    result: unknown,
  ): string | undefined {
    if (descriptor.resourceLabelFrom) {
      const value = readPath(
        { params: request.params, body: request.body, query: request.query },
        descriptor.resourceLabelFrom,
      );
      if (typeof value === 'string') return value;
    }

    const fromResult = (result as { name?: unknown } | undefined)?.name;
    return typeof fromResult === 'string' ? fromResult : undefined;
  }

  /**
   * Copies the allowlisted request fields into the record's metadata.
   *
   * An allowlist, never the whole body. Recording entire request bodies is
   * precisely how audit logs end up containing the secrets they were meant to
   * protect. Values still pass through structural redaction in `AuditService`,
   * but the allowlist is the primary control — redaction is the backstop.
   */
  private captureMetadata(
    descriptor: AuditDescriptor,
    request: AuthenticatedRequest,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};

    if (!descriptor.captureBodyFields?.length) return metadata;

    const body = (request.body ?? {}) as Record<string, unknown>;
    for (const field of descriptor.captureBodyFields) {
      if (field in body) metadata[field] = body[field];
    }

    return metadata;
  }
}

/** Reads a dotted path such as `params.roleId` from a plain object. */
function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, source);
}
