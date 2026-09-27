/* eslint-disable no-console */
/**
 * OpenTelemetry tracing bootstrap (phase 5).
 *
 * Imported FIRST by `main.ts` and `worker.ts`, before Nest or any library it
 * instruments is loaded: instrumentation works by patching modules as they
 * are required, so anything loaded earlier is invisible to it.
 *
 * Off unless an OTLP endpoint is configured (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * the standard variable — Grafana Cloud, Honeycomb, Datadog, New Relic,
 * Jaeger and the OpenTelemetry Collector all accept OTLP over HTTP). Every
 * other standard `OTEL_*` variable applies too: `OTEL_EXPORTER_OTLP_HEADERS`
 * for the vendor's credentials, `OTEL_TRACES_SAMPLER`/`_ARG` for sampling,
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`.
 *
 * The trace follows a request across the platform: the browser's
 * `traceparent` is honoured, and it is propagated on every outgoing call — to
 * the Python AI service, to the model endpoint — so one trace spans
 * frontend → backend → AI service → model.
 *
 * What the trace may contain is decided here, not by each instrumentation:
 * see `span-sanitizer.ts`. Redis command arguments (which include rate-limit
 * keys carrying an attempted email address) are never recorded, SQL parameter
 * values are never recorded, and database and cache spans exist only inside a
 * request or job, not for background pool noise.
 */
import * as dotenv from 'dotenv';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { sanitizeAttributes, type AttributeValue } from './span-sanitizer';

/** Paths never traced: probes and scrapes would drown everything else. */
const UNTRACED_PATHS = /^\/(health(\/live|\/ready)?|metrics|favicon\.ico)(\?|$)/;

/**
 * Wraps the OTLP exporter: every span is sanitized as it leaves, whichever
 * instrumentation produced it and whenever its attributes were set.
 */
class SanitizingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      this.inner.export(spans.map(sanitizeSpan), resultCallback);
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const attributes = sanitizeAttributes(
    span.attributes as Record<string, AttributeValue>,
  ) as ReadableSpan['attributes'];
  const events = span.events.map((event) =>
    event.attributes
      ? {
          ...event,
          attributes: sanitizeAttributes(
            event.attributes as Record<string, AttributeValue>,
          ) as typeof event.attributes,
        }
      : event,
  );
  // A view over the original that overrides two properties; the exporter
  // reads the rest (context, timings, resource) from the span itself.
  return Object.create(span, {
    attributes: { value: attributes, enumerable: true },
    events: { value: events, enumerable: true },
  }) as ReadableSpan;
}

function start(): NodeTracerProvider | null {
  // Local development reads .env; in the cloud the variables are already set.
  dotenv.config({ path: ['.env.local', '.env'], quiet: true } as dotenv.DotenvConfigOptions);

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || process.env.OTEL_SDK_DISABLED === 'true') return null;

  const role = process.env.DAIAP_PROCESS_ROLE === 'worker' ? 'worker' : 'api';
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || `daiap-${role}`,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
      'service.namespace': 'daiap',
    }),
    // The sampler comes from OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG
    // (the SDK reads them); the default is parent-based, always on.
    spanProcessors: [new BatchSpanProcessor(new SanitizingExporter(new OTLPTraceExporter()))],
  });
  // Sets the global tracer provider, the W3C trace-context propagator and an
  // AsyncLocalStorage context manager.
  provider.register();

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => UNTRACED_PATHS.test(request.url ?? ''),
      }),
      new ExpressInstrumentation({
        // Route handlers only: a span per middleware is noise.
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER],
      }),
      new NestInstrumentation(),
      new PgInstrumentation({
        requireParentSpan: true,
        enhancedDatabaseReporting: false,
        ignoreConnectSpans: true,
      }),
      new IORedisInstrumentation({
        requireParentSpan: true,
        // The command name only. Arguments include keys such as the sign-in
        // throttle bucket, which carries the attempted email address.
        dbStatementSerializer: (command) => command,
      }),
      new UndiciInstrumentation(),
      new PinoInstrumentation(),
    ],
  });

  const shutdown = () => {
    provider.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  console.log(`[tracing] OpenTelemetry tracing enabled; exporting OTLP to ${new URL(endpoint).host}.`);
  return provider;
}

export const tracerProvider = start();
