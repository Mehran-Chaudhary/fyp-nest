import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_CONFIG_KEY, type AppConfig } from '../../config/app.config';
import { HEADER } from '../../common/constants/app.constants';

/**
 * Structured logging.
 *
 * pino is used rather than the default Nest logger for three reasons that matter
 * to this project specifically:
 *
 *  1. **Structured output.** Audit and compliance work needs machine-queryable
 *     logs, not formatted prose.
 *  2. **Redaction at the sink.** pino applies a redaction list to every record
 *     before serialisation, so an `Authorization` header cannot reach disk even
 *     if some future code path logs a whole request object by mistake. Given the
 *     platform's privacy remit, a belt-and-braces layer here is worth the cost.
 *  3. **Throughput.** Logging happens on every request including agent
 *     execution traces in later phases; pino's serialiser is an order of
 *     magnitude cheaper than the alternatives.
 *
 * Health check polling is excluded from request logging — otherwise a
 * five-second liveness probe drowns out everything of interest.
 */

/**
 * Header and body paths scrubbed before a record is written.
 *
 * Expressed as pino redaction paths, which are evaluated on the serialised
 * object, and deliberately overlapping with the structural redaction applied in
 * `deepRedact`: the two protect different entry points into the log.
 */
const REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.confirmPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',
  'res.headers["set-cookie"]',
  'responseBody.accessToken',
  'responseBody.refreshToken',
  '*.password',
  '*.passwordHash',
  '*.apiKey',
  '*.secret',
];

/** Paths that should never produce a request log line. */
const IGNORED_PATHS = new Set(['/health', '/health/live', '/health/ready', '/favicon.ico']);

/**
 * The subset of pino's request object this module reads.
 *
 * `raw` is the underlying Express request, which is where the guards attach the
 * resolved principal and workspace — so a log line can carry them without the
 * serialiser having to know about Nest.
 */
interface SerialisableRequest {
  id?: unknown;
  method?: string;
  url?: string;
  raw?: {
    organization?: { id?: string };
    user?: { id?: string };
  };
}

interface SerialisableResponse {
  statusCode?: number;
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const app = configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);

        return {
          pinoHttp: {
            level: app.logLevel,
            autoLogging: app.logHttpRequests
              ? {
                  ignore: (request: IncomingMessage) => {
                    const url = (request as IncomingMessage & { originalUrl?: string })
                      .originalUrl;
                    if (!url) return false;
                    const path = url.split('?')[0];
                    return (
                      IGNORED_PATHS.has(path) ||
                      path.endsWith('/health') ||
                      path.endsWith('/health/live') ||
                      path.endsWith('/health/ready')
                    );
                  },
                }
              : false,

            // Reuse the correlation id the request-context middleware assigned so
            // that pino's `req.id` and our `X-Request-Id` are the same value.
            genReqId: (request: IncomingMessage, response: ServerResponse) => {
              const existing =
                (request as IncomingMessage & { requestId?: string }).requestId ??
                request.headers[HEADER.REQUEST_ID];
              const id =
                (typeof existing === 'string' && existing) ||
                (Array.isArray(existing) && existing[0]) ||
                randomUUID();
              response.setHeader(HEADER.REQUEST_ID, id);
              return id;
            },

            redact: {
              paths: REDACTION_PATHS,
              censor: '[REDACTED]',
              remove: false,
            },

            // Compact serialisers. The defaults log entire header and socket
            // objects, which is both noisy and a leak risk.
            //
            // pino types these callbacks loosely, so the shapes we actually read
            // are declared here rather than reaching into `any`.
            serializers: {
              req: (request: SerialisableRequest) => ({
                id: request.id,
                method: request.method,
                url:
                  typeof request.url === 'string' ? request.url.split('?')[0] : request.url,
                organizationId: request.raw?.organization?.id,
                userId: request.raw?.user?.id,
              }),
              res: (response: SerialisableResponse) => ({
                statusCode: response.statusCode,
              }),
              err: (error: Error & { code?: string; status?: number }) => ({
                type: error.name,
                message: error.message,
                code: error.code,
                status: error.status,
                stack: app.isProduction ? undefined : error.stack,
              }),
            },

            customLogLevel: (_request, response, error) => {
              if (error) return 'error';
              if (response.statusCode >= 500) return 'error';
              if (response.statusCode >= 400) return 'warn';
              return 'info';
            },

            customSuccessMessage: (request, response) =>
              `${request.method} ${(request as IncomingMessage & { originalUrl?: string }).originalUrl ?? request.url} ${response.statusCode}`,

            transport: app.logPretty
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: false,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname',
                    messageFormat: '{context}{if req.id} [{req.id}]{end} {msg}',
                  },
                }
              : undefined,

            base: {
              service: 'daiap-backend',
              env: app.env,
            },
          },
          // Exclude health probes from the request-scoped logger entirely.
          exclude: [],
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
