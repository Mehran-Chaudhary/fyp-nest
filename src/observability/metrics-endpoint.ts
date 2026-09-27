import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { MetricsService } from './metrics.service';

export interface MetricsEndpointOptions {
  token: string;
  /** Without a token, production refuses to serve metrics at all. */
  isProduction: boolean;
}

/**
 * The `/metrics` handler, shared by the API (mounted ahead of the Nest router,
 * at the root, outside the API prefix) and the dedicated worker's small HTTP
 * server.
 *
 * Metrics are operational data, not tenant data (see MetricsService), but they
 * still describe the platform's traffic and failure modes, so outside
 * development a scraper must present `METRICS_TOKEN` as a bearer token —
 * which Grafana Agent, Prometheus (`authorization.credentials`) and every
 * hosted collector support.
 */
export function createMetricsHandler(
  metrics: MetricsService,
  options: MetricsEndpointOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const expected = options.token ? digest(options.token) : null;

  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }

    if (expected) {
      const header = request.headers.authorization ?? '';
      const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      if (!presented || !timingSafeEqual(digest(presented), expected)) {
        response
          .writeHead(401, { 'www-authenticate': 'Bearer realm="metrics"' })
          .end('Unauthorized\n');
        return;
      }
    } else if (options.isProduction) {
      response
        .writeHead(401, { 'content-type': 'text/plain' })
        .end('Metrics require METRICS_TOKEN to be configured in production.\n');
      return;
    }

    metrics
      .render()
      .then((body) => {
        response.writeHead(200, {
          'content-type': metrics.contentType,
          'cache-control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
      })
      .catch(() => {
        response.writeHead(500).end();
      });
  };
}

/** Fixed-length digests, so the comparison is constant-time whatever the input length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
