import { Injectable, Logger } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';

/** Refreshes gauges just before a scrape. Must be quick and must not throw. */
export type ScrapeHook = () => Promise<void> | void;

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** Model calls: from a warm few hundred milliseconds to a cold multi-minute load. */
const INFERENCE_BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120, 240];
/** The PII engine's own cost per prompt, in seconds. */
const REDACTION_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5];

/**
 * Prometheus metrics (phase 5).
 *
 * ## Two rules every metric here follows
 *
 *  - **No content, no identities.** Labels are drawn from closed
 *    vocabularies — HTTP method, route *template*, status code, invocation
 *    purpose and status, audit action, model name from the allowlist — never
 *    from a request body, a user, or a workspace. A metrics endpoint is
 *    scraped by, and stored in, systems outside the platform's access
 *    control; it must not become a side channel for what the platform
 *    protects.
 *  - **Bounded cardinality.** For the same reason there is no workspace
 *    label: per-tenant figures are served by the Command Centre API, behind
 *    `usage:read`, not by a time-series database.
 *
 * One registry per process, labelled with the service (`daiap-api` or
 * `daiap-worker`), so a scraper can tell API and worker instances apart.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();
  private readonly hooks: ScrapeHook[] = [];

  // ── HTTP ──────────────────────────────────────────────────────────────────
  readonly httpRequests = new Counter({
    name: 'daiap_http_requests_total',
    help: 'HTTP requests served, by method, route template and status.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'daiap_http_request_duration_seconds',
    help: 'HTTP request duration (for streams, until the stream ended).',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  // ── LLM gateway and the PII engine ────────────────────────────────────────
  readonly llmInvocations = new Counter({
    name: 'daiap_llm_invocations_total',
    help: 'Model calls recorded in the usage ledger, by purpose, outcome and model.',
    labelNames: ['purpose', 'status', 'model'] as const,
    registers: [this.registry],
  });
  readonly llmTokens = new Counter({
    name: 'daiap_llm_tokens_total',
    help: 'Tokens consumed, by purpose, kind (prompt or completion) and model.',
    labelNames: ['purpose', 'kind', 'model'] as const,
    registers: [this.registry],
  });
  readonly llmDuration = new Histogram({
    name: 'daiap_llm_duration_seconds',
    help: 'End-to-end duration of completed model calls.',
    labelNames: ['purpose', 'model'] as const,
    buckets: INFERENCE_BUCKETS,
    registers: [this.registry],
  });
  readonly llmTimeToFirstToken = new Histogram({
    name: 'daiap_llm_time_to_first_token_seconds',
    help: 'Time from request to the first generated token.',
    labelNames: ['model'] as const,
    buckets: INFERENCE_BUCKETS,
    registers: [this.registry],
  });
  readonly redactionDuration = new Histogram({
    name: 'daiap_pii_redaction_seconds',
    help: 'Processing time the PII engine added to a model call (detection, masking, egress check, unmasking).',
    buckets: REDACTION_BUCKETS,
    registers: [this.registry],
  });
  readonly entitiesMasked = new Counter({
    name: 'daiap_pii_entities_masked_total',
    help: 'Sensitive entities masked before prompts left the platform, by entity type.',
    labelNames: ['entity_type'] as const,
    registers: [this.registry],
  });
  readonly llmInFlight = new Gauge({
    name: 'daiap_llm_inflight',
    help: 'Model calls holding a gateway slot in this process.',
    registers: [this.registry],
  });
  readonly llmWaiting = new Gauge({
    name: 'daiap_llm_queue_waiting',
    help: 'Model calls waiting for a gateway slot in this process.',
    registers: [this.registry],
  });
  readonly circuitState = new Gauge({
    name: 'daiap_dependency_circuit_state',
    help: 'Circuit breaker state per dependency: 0 closed, 1 half-open, 2 open.',
    labelNames: ['dependency'] as const,
    registers: [this.registry],
  });

  // ── Governance (quotas, rates, circuit breakers) ──────────────────────────
  readonly quotaDecisions = new Counter({
    name: 'daiap_quota_decisions_total',
    help: 'Admission decisions for model calls, by decision, reason and scope.',
    labelNames: ['decision', 'reason', 'scope'] as const,
    registers: [this.registry],
  });
  readonly agentCircuitOpened = new Counter({
    name: 'daiap_agent_circuit_opened_total',
    help: 'Agent circuit breakers opened, by reason.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly rateLimitRejections = new Counter({
    name: 'daiap_rate_limit_rejections_total',
    help: 'Requests refused by the request rate limiter, by policy.',
    labelNames: ['policy'] as const,
    registers: [this.registry],
  });

  // ── Security ──────────────────────────────────────────────────────────────
  readonly auditEvents = new Counter({
    name: 'daiap_audit_events_total',
    help: 'Audit records written, by action, severity and status.',
    labelNames: ['action', 'severity', 'status'] as const,
    registers: [this.registry],
  });
  readonly auditAppendDuration = new Histogram({
    name: 'daiap_audit_append_seconds',
    help: 'Time to append one record to a hash chain (includes waiting for the chain lock).',
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly mfaVerifications = new Counter({
    name: 'daiap_mfa_verifications_total',
    help: 'Second-factor verifications, by method and outcome.',
    labelNames: ['method', 'outcome'] as const,
    registers: [this.registry],
  });
  readonly breachedPasswordChecks = new Counter({
    name: 'daiap_breached_password_checks_total',
    help: 'Breached-password lookups, by outcome (clean, breached, unavailable).',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  readonly rowLevelSecurity = new Gauge({
    name: 'daiap_row_level_security_enforced',
    help: '1 when PostgreSQL row-level security is in force for this process, else 0.',
    registers: [this.registry],
  });

  // ── Work ──────────────────────────────────────────────────────────────────
  readonly workflowSteps = new Counter({
    name: 'daiap_workflow_steps_total',
    help: 'Workflow steps settled, by node type and outcome.',
    labelNames: ['node_type', 'outcome'] as const,
    registers: [this.registry],
  });
  readonly queueJobs = new Gauge({
    name: 'daiap_queue_jobs',
    help: 'Background jobs by queue and state.',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });
  readonly dbPool = new Gauge({
    name: 'daiap_db_pool_connections',
    help: 'PostgreSQL pool connections in this process, by state.',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });
  readonly realtimeConnections = new Gauge({
    name: 'daiap_realtime_connections',
    help: 'Open WebSocket connections held by this process.',
    registers: [this.registry],
  });
  readonly lifecycleRemovals = new Counter({
    name: 'daiap_lifecycle_records_removed_total',
    help: 'Records removed by the data-lifecycle sweep, by kind.',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  constructor() {
    const service = process.env.DAIAP_PROCESS_ROLE === 'worker' ? 'daiap-worker' : 'daiap-api';
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry });
  }

  /** Registers a hook that refreshes gauges right before each scrape. */
  onScrape(hook: ScrapeHook): void {
    this.hooks.push(hook);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** The exposition text, gauges refreshed first. A failing hook costs its gauges, not the scrape. */
  async render(): Promise<string> {
    await Promise.all(
      this.hooks.map(async (hook) => {
        try {
          await Promise.race([
            hook(),
            new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
          ]);
        } catch (error) {
          this.logger.debug(`A metrics scrape hook failed: ${(error as Error).message}`);
        }
      }),
    );
    return this.registry.metrics();
  }
}

/** Circuit breaker states as a gauge value. */
export function circuitStateValue(state: string): number {
  return state === 'OPEN' ? 2 : state === 'HALF_OPEN' ? 1 : 0;
}
