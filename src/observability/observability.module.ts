import { Global, Module } from '@nestjs/common';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsService } from './metrics.service';

/**
 * Metrics for every module (phase 5). Global because metrics are recorded
 * where things happen — the gateway, the audit log, the guards — and
 * threading an import through each would add noise without isolation.
 *
 * Tracing is not a Nest provider: it must start before Nest loads (see
 * `tracing.ts`); spans are created through `telemetry.ts`.
 */
@Global()
@Module({
  providers: [MetricsService, HttpMetricsMiddleware],
  exports: [MetricsService, HttpMetricsMiddleware],
})
export class ObservabilityModule {}
