// Must stay first: it enables queue workers before configuration is read.
import './worker-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Dedicated background worker: `npm run start:worker` (or
 * `node dist/worker` in production).
 *
 * Boots the same application context as the API — same configuration, same
 * services, same audit trail — without an HTTP listener, and consumes the
 * document ingestion and maintenance queues and the workflow step and workflow
 * maintenance queues. It opens no WebSocket: workflow progress reaches clients
 * through the shared event bus (Redis), whichever API instance holds the
 * socket.
 *
 * Optional. With the default `QUEUE_WORKERS_ENABLED=true` the API process
 * consumes jobs itself. Run this as a separate service (a Railway/Render
 * background worker, a second Fly machine) and set `QUEUE_WORKERS_ENABLED=false`
 * on the API once document or workflow volume makes it worth isolating: a burst
 * of large PDFs or long agent workflows then slows the worker, not the API.
 * Any number of workers may run side by side — workflow steps are claimed with
 * a compare-and-set in PostgreSQL, so no step runs twice.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  // Closes workers gracefully on SIGTERM, letting in-flight jobs finish within
  // APP_SHUTDOWN_TIMEOUT. Anything cut off is recovered by stalled-job
  // detection and resumes from its last checkpoint.
  app.enableShutdownHooks();

  new Logger('Worker').log('Background worker running. Waiting for jobs.');
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet, so this deliberately uses console.
  console.error('Failed to start the worker:\n', error);
  process.exit(1);
});
