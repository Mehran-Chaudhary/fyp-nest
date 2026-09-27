import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { scrubText } from './span-sanitizer';

/**
 * The platform's own spans (phase 5): the model call, the PII engine,
 * retrieval, a workflow step, a quota decision. Built on the OpenTelemetry
 * API alone, so they cost nothing — the API is a no-op — until
 * `observability/tracing.ts` registers the SDK.
 *
 * Span attributes follow the metrics rule: counts, durations, ids, statuses
 * and names from closed vocabularies. Never a prompt, a passage, a tool
 * argument or an answer.
 */
export const tracer = trace.getTracer('daiap');

/** Runs `callback` inside a span, recording its failure (sanitized) if it throws. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  callback: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await callback(span);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined;
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: code ?? scrubText(error instanceof Error ? error.name : 'error'),
      });
      if (code) span.setAttribute('daiap.error_code', code);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Runs `callback` with tracing suppressed: for calls whose very URL is sensitive. */
export function withoutTracing<T>(callback: () => T): T {
  return context.with(suppressTracing(context.active()), callback);
}

/** The active trace id, for correlating a log line or an error report. */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && spanContext.traceId !== '00000000000000000000000000000000'
    ? spanContext.traceId
    : undefined;
}
