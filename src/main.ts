// Must stay first: OpenTelemetry instruments modules as they load (phase 5).
import './observability/tracing';
import { ClassSerializerInterceptor, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { useContainer } from 'class-validator';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RealtimeIoAdapter } from './modules/realtime/realtime-io.adapter';
import { REALTIME_CONFIG_KEY, type RealtimeConfig } from './config/realtime.config';
import { HEADER, SECURITY_SCHEME } from './common/constants/app.constants';
import { APP_CONFIG_KEY, type AppConfig } from './config/app.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from './config/security.config';
import {
  OBSERVABILITY_CONFIG_KEY,
  type ObservabilityConfig,
} from './config/observability.config';
import { findInsecureDefaults } from './config/env.validation';
import { createMetricsHandler } from './observability/metrics-endpoint';
import { MetricsService } from './observability/metrics.service';
import {
  ApiErrorBody,
  ApiErrorResponseDto,
  ResponseMeta,
  ValidationErrorDetails,
} from './common/dto/api-response.dto';
import { createValidationPipe } from './common/validation/validation-pipe';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffered so that nothing is written with the default logger before pino
    // takes over — otherwise the first few lines of every boot are unstructured.
    bufferLogs: true,
  });

  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
  const securityConfig = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);

  const bootLogger = new Logger('Bootstrap');

  // ── Configuration warnings ────────────────────────────────────────────────
  // Loud, early, and impossible to miss. A deployment running on a development
  // signing secret is compromised the moment anyone reads this repository.
  const insecure = findInsecureDefaults(process.env);
  if (insecure.length > 0) {
    const message =
      `Using built-in development values for: ${insecure.join(', ')}. ` +
      'These are public constants in this repository and provide no security. ' +
      'Generate real ones with `npm run generate:secrets`.';

    if (appConfig.isProduction) {
      // Should be unreachable — the schema requires these in production — but a
      // misconfigured NODE_ENV must not be the thing that lets it through.
      bootLogger.error(message);
      throw new Error(message);
    }
    bootLogger.warn(message);
  }

  // ── Real-time events (phase 4) ────────────────────────────────────────────
  // Socket.IO on the same HTTP server, configured from the environment: path,
  // transports, origin check, message ceilings. See RealtimeIoAdapter.
  app.useWebSocketAdapter(
    new RealtimeIoAdapter(
      app,
      configService.getOrThrow<RealtimeConfig>(REALTIME_CONFIG_KEY),
      securityConfig,
    ),
  );

  // ── Metrics (phase 5) ─────────────────────────────────────────────────────
  // Mounted on the raw HTTP adapter, ahead of the Nest router and outside the
  // API prefix and versioning: `/metrics`, like the health probes, is for
  // infrastructure. It authenticates with its own bearer token (METRICS_TOKEN),
  // not with user credentials, so the global guards do not apply to it.
  const observability = configService.getOrThrow<ObservabilityConfig>(
    OBSERVABILITY_CONFIG_KEY,
  );
  if (observability.metrics.enabled) {
    const serveMetrics = createMetricsHandler(app.get(MetricsService), {
      token: observability.metrics.token,
      isProduction: appConfig.isProduction,
    });
    const express = app.getHttpAdapter().getInstance();
    express.get(observability.metrics.path, (request, response) =>
      serveMetrics(request, response),
    );
    if (appConfig.isProduction && !observability.metrics.token) {
      bootLogger.warn(
        `Metrics are enabled but METRICS_TOKEN is not set: ${observability.metrics.path} ` +
          'answers 401 until it is.',
      );
    }
  }

  // ── Proxy awareness ───────────────────────────────────────────────────────
  // Must be set before anything reads `req.ip`. The IP allowlist and the rate
  // limiter both depend on it; getting it wrong means either every client
  // appears to come from the load balancer, or `X-Forwarded-For` is trusted from
  // arbitrary clients and both controls become spoofable.
  app.set('trust proxy', securityConfig.trustProxy);

  // ── Security headers ──────────────────────────────────────────────────────
  if (securityConfig.helmet.enabled) {
    app.use(
      helmet({
        contentSecurityPolicy: appConfig.swagger.enabled
          ? // Swagger UI needs inline styles and scripts. Rather than weaken the
            // policy API-wide, CSP is disabled only where the docs are served and
            // the API itself returns JSON, which is not a script execution context.
            false
          : undefined,
        crossOriginEmbedderPolicy: false,
        hsts: appConfig.isProduction
          ? {
              maxAge: securityConfig.helmet.hstsMaxAge,
              includeSubDomains: true,
              preload: true,
            }
          : false,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      }),
    );
  }

  app.use(compression());
  app.use(cookieParser(securityConfig.refreshCookie.secret));

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: securityConfig.cors.allowAnyOrigin ? true : securityConfig.cors.origins,
    credentials: securityConfig.cors.credentials,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      HEADER.ORGANIZATION_ID,
      HEADER.ORGANIZATION_SLUG,
      HEADER.REQUEST_ID,
      HEADER.API_KEY,
      // W3C trace context (phase 5): lets the frontend's trace continue here.
      'traceparent',
      'tracestate',
    ],
    // Without this the browser hides these from `fetch`, and the frontend cannot
    // read its own correlation id or the rate-limit budget.
    exposedHeaders: [
      HEADER.REQUEST_ID,
      HEADER.RATE_LIMIT_LIMIT,
      HEADER.RATE_LIMIT_REMAINING,
      HEADER.RATE_LIMIT_RESET,
      HEADER.RETRY_AFTER,
      // So the frontend can name a downloaded document correctly.
      'content-disposition',
    ],
    maxAge: 86_400,
  });

  if (securityConfig.cors.allowAnyOrigin && appConfig.isProduction) {
    bootLogger.warn(
      'CORS_ORIGINS contains "*" in production. Any website can then issue ' +
        'credentialed requests on a signed-in user’s behalf. Set an explicit origin list.',
    );
  }

  // ── Routing ───────────────────────────────────────────────────────────────
  if (appConfig.globalPrefix) {
    app.setGlobalPrefix(appConfig.globalPrefix, {
      // Health probes stay at the root so orchestrator configuration does not
      // have to track the API prefix.
      exclude: ['health', 'health/live', 'health/ready'],
    });
  }

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: appConfig.apiVersion,
  });

  // ── Validation ────────────────────────────────────────────────────────────
  // Lets class-validator constraints be resolved through Nest's container, which
  // is what allows `@IsStrongPassword()` to read the live password policy.
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // Whitelisting, 422s, and field errors keyed by property path: see the factory.
  app.useGlobalPipes(createValidationPipe());

  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // ── OpenAPI ───────────────────────────────────────────────────────────────
  if (appConfig.swagger.enabled) {
    const documentConfig = new DocumentBuilder()
      .setTitle(appConfig.name)
      .setDescription(
        [
          'Backend API for the Distributed AI Agent Management Platform.',
          '',
          '## Authentication',
          '',
          'Most endpoints require a Bearer access token from `POST /api/v1/auth/login`.',
          'Machine callers — notably the Python AI service — use a workspace-scoped',
          'API key in the `X-API-Key` header instead.',
          '',
          '## Workspace context',
          '',
          'Workspace-scoped endpoints resolve their tenant from the `X-Organization-Id`',
          'header (a UUID or a slug) or from the `:organizationId` path segment.',
          'Membership is re-verified against the database on every request, so a token',
          'minted before a removal stops working immediately rather than at expiry.',
          '',
          '## Response shape',
          '',
          'Every response is `{ success, data, meta }` on success and',
          '`{ success: false, error: { code, message, details }, meta }` on failure.',
          'Branch on `error.code`, never on the message: codes are stable, messages',
          'may be reworded or localised.',
          '',
          '## Errors',
          '',
          'The `meta.requestId` value is also returned in the `X-Request-Id` header and',
          'written into both the application log and the audit log, so one identifier',
          'links a user report to the exact server-side trace.',
        ].join('\n'),
      )
      .setVersion(appConfig.apiVersion)
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token from POST /api/v1/auth/login.',
        },
        SECURITY_SCHEME.BEARER,
      )
      .addApiKey(
        {
          type: 'apiKey',
          name: HEADER.API_KEY,
          in: 'header',
          description: 'Workspace-scoped API key for machine callers.',
        },
        SECURITY_SCHEME.API_KEY,
      )
      .addGlobalParameters({
        name: HEADER.ORGANIZATION_ID,
        in: 'header',
        required: false,
        description: 'Active workspace: a UUID or a slug.',
        schema: { type: 'string' },
      })
      .addServer(appConfig.url)
      .addTag('Authentication', 'Registration, sign-in, token rotation and recovery')
      .addTag('Workspaces', 'Multi-tenant workspace management')
      .addTag('Members', 'Workspace member directory and lifecycle')
      .addTag('Invitations', 'Inviting people into a workspace')
      .addTag('Access control', 'Roles and the permission catalogue')
      .addTag('API keys', 'Machine credentials for service-to-service calls')
      .addTag('Audit', 'Tamper-evident compliance log')
      .addTag('Knowledge bases', 'Document collections and access compartments')
      .addTag('Documents', 'The Document Vault: upload, processing status, download')
      .addTag('Retrieval', 'Access-controlled retrieval for RAG')
      .addTag('Agents', 'Agent Builder and Persona Engine: versioned agents')
      .addTag('Conversations', 'Conversations with agents: memory and streamed turns')
      .addTag('LLM gateway', 'Models, the workspace model policy, direct inference, usage')
      .addTag('Privacy', 'The PII redaction engine: policy, analysis and reports')
      .addTag(
        'Tools',
        'The Tool Execution Engine: built-in and HTTP tools, and the tool ledger',
      )
      .addTag(
        'Workflows',
        'Workflow definitions: the canvas, versions, validation, publishing',
      )
      .addTag(
        'Workflow runs',
        'Runs, their steps, approvals, the audit trace and dead letters',
      )
      .addTag('Governance', 'Token quotas, the token rate and agent circuit breakers')
      .addTag(
        'Command Centre',
        'Analytics: throughput, latency, spend, privacy and security',
      )
      .addTag('Personal data', 'Your data: a copy of it, and the erasure of your account')
      .addTag('Health', 'Liveness and readiness probes')
      .build();

    const document = SwaggerModule.createDocument(app, documentConfig, {
      // The envelope types are referenced only from decorator schemas, so they
      // must be declared explicitly or the generated client loses them.
      extraModels: [
        ResponseMeta,
        ApiErrorBody,
        ApiErrorResponseDto,
        ValidationErrorDetails,
      ],
      operationIdFactory: (controllerKey, methodKey) =>
        `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
    });

    SwaggerModule.setup(appConfig.swagger.path, app, document, {
      jsonDocumentUrl: appConfig.swagger.jsonPath,
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: true,
        tagsSorter: 'alpha',
      },
      customSiteTitle: `${appConfig.name} — API`,
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  // Lets Nest run `onApplicationShutdown` hooks, which is how the Redis and
  // PostgreSQL connections are closed cleanly rather than being severed.
  app.enableShutdownHooks();

  await app.listen(appConfig.port, appConfig.host);

  const baseUrl = `http://${appConfig.host === '0.0.0.0' ? 'localhost' : appConfig.host}:${appConfig.port}`;
  const apiPath = appConfig.globalPrefix
    ? `/${appConfig.globalPrefix}/v${appConfig.apiVersion}`
    : `/v${appConfig.apiVersion}`;

  bootLogger.log(`${appConfig.name} is running in ${appConfig.env} mode.`);
  bootLogger.log(`API      ${baseUrl}${apiPath}`);
  bootLogger.log(`Health   ${baseUrl}/health`);
  if (observability.metrics.enabled) {
    bootLogger.log(`Metrics  ${baseUrl}${observability.metrics.path}`);
  }
  const realtime = configService.getOrThrow<RealtimeConfig>(REALTIME_CONFIG_KEY);
  if (realtime.enabled) {
    bootLogger.log(
      `Realtime ${baseUrl.replace(/^http/, 'ws')}${realtime.path} (Socket.IO)`,
    );
  }
  if (appConfig.swagger.enabled) {
    bootLogger.log(`Docs     ${baseUrl}/${appConfig.swagger.path}`);
    bootLogger.log(`OpenAPI  ${baseUrl}/${appConfig.swagger.jsonPath}`);
  }
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet, so this deliberately uses console.

  console.error('Failed to start the application:\n', error);
  process.exit(1);
});
