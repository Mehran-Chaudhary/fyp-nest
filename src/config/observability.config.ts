import { registerAs } from '@nestjs/config';

/**
 * Metrics and tracing (phase 5).
 *
 * Tracing itself is started before the application (it has to patch modules
 * before they load — see `src/observability/tracing.ts`) and is driven by the
 * standard `OTEL_*` variables; what is here is what the running application
 * needs to know about it.
 */
export interface ObservabilityConfig {
  metrics: {
    enabled: boolean;
    /** Leading slash, no trailing one: `/metrics`. */
    path: string;
    /** Bearer token a scraper must present; empty means none configured. */
    token: string;
  };
  /** Port of the dedicated worker's health and metrics server; 0 = none. */
  workerHttpPort: number;
  tracing: {
    /** Whether an OTLP endpoint is configured and the SDK is not disabled. */
    enabled: boolean;
    endpoint: string;
  };
}

export const OBSERVABILITY_CONFIG_KEY = 'observability';

export default registerAs(OBSERVABILITY_CONFIG_KEY, (): ObservabilityConfig => {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    '';

  return {
    metrics: {
      enabled: process.env.METRICS_ENABLED !== 'false',
      path: `/${(process.env.METRICS_PATH ?? '/metrics').replace(/^\/+|\/+$/g, '')}`,
      token: process.env.METRICS_TOKEN ?? '',
    },
    workerHttpPort: Number(process.env.WORKER_HTTP_PORT ?? 0),
    tracing: {
      enabled: endpoint.length > 0 && process.env.OTEL_SDK_DISABLED !== 'true',
      endpoint,
    },
  };
});
