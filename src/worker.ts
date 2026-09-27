// Must stay first: it enables queue workers before configuration is read.
import './worker-env';
// Then tracing, before anything it instruments is loaded (phase 5).
import './observability/tracing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { createServer, type Server } from 'node:http';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { APP_CONFIG_KEY, type AppConfig } from './config/app.config';
import {
  OBSERVABILITY_CONFIG_KEY,
  type ObservabilityConfig,
} from './config/observability.config';
import { createMetricsHandler } from './observability/metrics-endpoint';
import { MetricsService } from './observability/metrics.service';

/**
 * Dedicated background worker: `npm run start:worker` (or
 * `node dist/worker` in production).
 *
 * Boots the same application context as the API — same configuration, same
 * services, same audit trail — without the API, and consumes the document
 * ingestion and maintenance queues, the workflow step and workflow maintenance
 * queues, and (phase 5) the governance queue: quota reconciliation and the
 * data-lifecycle sweep. It opens no WebSocket: workflow progress reaches
 * clients through the shared event bus (Redis), whichever API instance holds
 * the socket.
 *
 * Optional. With the default `QUEUE_WORKERS_ENABLED=true` the API process
 * consumes jobs itself. Run this as a separate service (a Railway/Render
 * background worker, a second Fly machine) and set `QUEUE_WORKERS_ENABLED=false`
 * on the API once document or workflow volume makes it worth isolating: a burst
 * of large PDFs or long agent workflows then slows the worker, not the API.
 * Any number of workers may run side by side — workflow steps are claimed with
 * a compare-and-set in PostgreSQL, so no step runs twice.
 *
 * With `WORKER_HTTP_PORT` set, it also serves `/health/live`, `/health/ready`
 * and the metrics endpoint, for a platform health check and a scraper.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  // Closes workers gracefully on SIGTERM, letting in-flight jobs finish within
  // APP_SHUTDOWN_TIMEOUT. Anything cut off is recovered by stalled-job
  // detection and resumes from its last checkpoint.
  app.enableShutdownHooks();

  const logger = new Logger('Worker');
  const configService = app.get(ConfigService);
  const observability = configService.getOrThrow<ObservabilityConfig>(OBSERVABILITY_CONFIG_KEY);
  if (observability.workerHttpPort > 0) {
    const server = startHttpServer(
      observability,
      configService.getOrThrow<AppConfig>(APP_CONFIG_KEY),
      app.get(MetricsService),
      app.get(DataSource),
    );
    const close = () => server.close();
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    logger.log(`Health and metrics on port ${observability.workerHttpPort}.`);
  }

  logger.log('Background worker running. Waiting for jobs.');
}

/** A minimal server: the worker has no API, only probes and a scrape endpoint. */
function startHttpServer(
  observability: ObservabilityConfig,
  appConfig: AppConfig,
  metrics: MetricsService,
  dataSource: DataSource,
): Server {
  const metricsHandler = observability.metrics.enabled
    ? createMetricsHandler(metrics, {
        token: observability.metrics.token,
        isProduction: appConfig.isProduction,
      })
    : null;

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/health/live' || path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', role: 'worker', uptime: process.uptime() }));
      return;
    }
    if (path === '/health/ready') {
      dataSource
        .query('SELECT 1')
        .then(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'ok', database: 'up' }));
        })
        .catch(() => {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'error', database: 'down' }));
        });
      return;
    }
    if (metricsHandler && path === observability.metrics.path) {
      metricsHandler(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(observability.workerHttpPort, appConfig.host);
  return server;
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet, so this deliberately uses console.
  console.error('Failed to start the worker:\n', error);
  process.exit(1);
});
