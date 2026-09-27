import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { performance } from 'node:perf_hooks';
import { MetricsService } from './metrics.service';

/**
 * Counts and times every HTTP request, labelled by route *template*
 * (`/api/v1/organizations/:organizationId/agents`), never by the concrete
 * path: ids in a label would make every request its own time series.
 *
 * A middleware rather than an interceptor so that requests refused by the
 * guards — 401s, 403s, 429s, which are exactly the ones worth watching — are
 * counted too.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const started = performance.now();
    response.once('finish', () => {
      const labels = {
        method: request.method,
        route: routeTemplate(request),
        status: String(response.statusCode),
      };
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, (performance.now() - started) / 1000);
    });
    next();
  }
}

/** The matched route's template, or a fixed label when nothing matched. */
export function routeTemplate(request: Request): string {
  const route = (request as Request & { route?: { path?: unknown } }).route;
  if (route && typeof route.path === 'string') {
    return `${request.baseUrl ?? ''}${route.path}`.slice(0, 200) || '/';
  }
  return 'unmatched';
}
