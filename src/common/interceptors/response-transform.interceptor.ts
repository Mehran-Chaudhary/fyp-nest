import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { METADATA_KEY } from '../constants/app.constants';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import type { PaginatedResult } from '../utils/pagination.util';

/**
 * Marker for a service result that already carries pagination metadata.
 *
 * Services return `{ items, meta }` and this interceptor lifts `meta` into the
 * envelope's `meta.pagination`, so the array reaches the client as a plain
 * `data` array rather than being nested one level deeper.
 */
function isPaginated(value: unknown): value is PaginatedResult<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as PaginatedResult<unknown>).items) &&
    typeof (value as PaginatedResult<unknown>).meta === 'object' &&
    (value as PaginatedResult<unknown>).meta !== null &&
    'totalItems' in (value as PaginatedResult<unknown>).meta
  );
}

/**
 * Wraps every successful response in the standard envelope.
 *
 * Doing this centrally rather than per-handler means controllers return plain
 * domain objects and cannot forget the envelope, and it guarantees the
 * correlation id is present on success responses as well as failures — which is
 * what makes "give me the request id from that screen" a usable support
 * instruction.
 *
 * Routes that must return a raw body — a file download, or a Server-Sent Event
 * stream in a later phase — opt out with `@SkipResponseEnvelope()`.
 */
@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(
      METADATA_KEY.SKIP_RESPONSE_ENVELOPE,
      [context.getHandler(), context.getClass()],
    );

    if (skip) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    return next.handle().pipe(
      map((payload) => {
        const meta: Record<string, unknown> = {
          requestId: request.requestId,
          timestamp: new Date().toISOString(),
        };

        if (request.startTime) {
          meta.durationMs = Date.now() - request.startTime;
        }

        if (isPaginated(payload)) {
          meta.pagination = payload.meta;
          return { success: true, data: payload.items, meta };
        }

        // `undefined` from a 204-style handler becomes `null`: JSON has no
        // undefined, and a client parsing `{"data": null}` is better off than one
        // receiving a body with the key silently missing.
        return { success: true, data: payload ?? null, meta };
      }),
    );
  }
}
