/**
 * Real-time events (proposal module 6.16).
 *
 * ## Events carry metadata, never content
 *
 * An event says *that* something happened — a run started, a step finished in
 * 1.8 s using 412 tokens, a tool call was denied — never *what* was said. No
 * prompts, outputs, arguments or results, and no error messages, which can
 * quote content. A client that wants a step's output asks for it over HTTP,
 * where the reader's clearance is checked against the output's label.
 *
 * That makes the event layer safe to fan out through Redis (a third-party
 * store), to keep in a replay buffer, and to deliver to anyone entitled to
 * see that a run exists.
 */

export type RealtimeEventType =
  | 'run.queued'
  | 'run.started'
  | 'run.waiting'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.timed_out'
  | 'run.resumed'
  | 'step.queued'
  | 'step.started'
  | 'step.retrying'
  | 'step.completed'
  | 'step.failed'
  | 'step.skipped'
  | 'step.waiting_approval'
  | 'tool.called'
  | 'tool.denied'
  | 'approval.requested'
  | 'approval.decided'
  | 'notification';

/** Primitive values only: nothing structured enough to smuggle content in. */
export type EventDatum = string | number | boolean | null | string[] | number[];

export interface RealtimeEvent {
  /** Redis stream id, assigned on publish. Clients resume from it. */
  id: string;
  type: RealtimeEventType;
  organizationId: string;
  /** ISO 8601. */
  at: string;
  runId?: string;
  workflowId?: string;
  stepId?: string;
  nodeId?: string;
  /** Who started the run: routes lifecycle events to their personal channel. */
  initiatorUserId?: string;
  initiatorApiKeyId?: string;
  /** For `notification`: exactly who receives it. */
  recipientUserIds?: string[];
  data: Record<string, EventDatum>;
}

export type PublishableEvent = Omit<RealtimeEvent, 'id' | 'at'>;

/** Messages between processes that are not for clients. */
export type ControlMessage =
  /** Abort a run's in-flight steps wherever they execute. */
  | { kind: 'cancel-run'; organizationId: string; runId: string; reason: string }
  /** Re-check the sockets of a user, an API key or a whole workspace now: access changed. */
  | { kind: 'revalidate'; organizationId?: string; userId?: string; apiKeyId?: string };

const MAX_STRING = 200;
const MAX_ARRAY = 50;

/**
 * Enforces the metadata-only rule mechanically: nested objects are dropped,
 * strings are clipped, arrays bounded. A careless publisher cannot put a
 * paragraph of model output on the wire.
 */
export function sanitizeEventData(
  data: Record<string, unknown>,
): Record<string, EventDatum> {
  const clean: Record<string, EventDatum> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || typeof value === 'boolean') clean[key] = value;
    else if (typeof value === 'number') clean[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'string') clean[key] = value.slice(0, MAX_STRING);
    else if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'number')) {
        clean[key] = value.slice(0, MAX_ARRAY);
      } else if (value.every((item) => typeof item === 'string')) {
        clean[key] = value.slice(0, MAX_ARRAY).map((item) => item.slice(0, MAX_STRING));
      }
    }
  }
  return clean;
}
