import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HEADER } from '../../common/constants/app.constants';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface';
import { normaliseIp } from '../../common/utils/ip.util';
import { RequestContextService } from './request-context.service';

/**
 * Seeds the ambient request context and the correlation id.
 *
 * Runs before every guard, interceptor and handler so that anything logged
 * during authentication — including a rejected sign-in — already carries a
 * request id and a source IP.
 *
 * An inbound `X-Request-Id` is honoured so a trace can be followed across the
 * React frontend, this service and the Python AI service. It is length-capped
 * and character-restricted before use: the value is echoed in a response header
 * and written into audit metadata, so an unvalidated one would be a header
 * injection and log forgery vector.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private static readonly MAX_REQUEST_ID_LENGTH = 128;
  private static readonly SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

  constructor(private readonly requestContext: RequestContextService) {}

  use(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
    const requestId = this.resolveRequestId(request.headers[HEADER.REQUEST_ID]);
    const startTime = Date.now();

    request.requestId = requestId;
    request.startTime = startTime;
    response.setHeader(HEADER.REQUEST_ID, requestId);

    this.requestContext.run(
      {
        requestId,
        startTime,
        ip: normaliseIp(request.ip),
        userAgent: this.truncate(request.get('user-agent'), 512),
        method: request.method,
        path: request.originalUrl?.split('?')[0],
      },
      () => next(),
    );
  }

  private resolveRequestId(header: string | string[] | undefined): string {
    const candidate = Array.isArray(header) ? header[0] : header;

    if (
      candidate &&
      candidate.length <= RequestContextMiddleware.MAX_REQUEST_ID_LENGTH &&
      RequestContextMiddleware.SAFE_REQUEST_ID.test(candidate)
    ) {
      return candidate;
    }

    return randomUUID();
  }

  private truncate(value: string | undefined, maxLength: number): string | undefined {
    if (!value) return undefined;
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}
