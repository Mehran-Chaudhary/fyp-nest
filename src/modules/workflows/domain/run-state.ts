/**
 * Run and step lifecycles.
 *
 *     run:   QUEUED ─▶ RUNNING ⇄ WAITING_APPROVAL ─▶ COMPLETED | FAILED | CANCELLED | TIMED_OUT
 *
 *     step:  QUEUED ─▶ RUNNING ─▶ SUCCEEDED | FAILED
 *              ▲         │ └────▶ WAITING_APPROVAL ─▶ SUCCEEDED
 *              └─ retry ─┘
 *            (created SKIPPED when its branch was not taken; CANCELLED when the run ends first)
 *
 * PostgreSQL holds this state and is the source of truth. Every transition is
 * a compare-and-set on the expected current state, so a duplicated or
 * replayed queue message finds nothing to do.
 */

export enum RunStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  WAITING_APPROVAL = 'WAITING_APPROVAL',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  TIMED_OUT = 'TIMED_OUT',
}

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  RunStatus.QUEUED,
  RunStatus.RUNNING,
  RunStatus.WAITING_APPROVAL,
];

export const FINISHED_RUN_STATUSES: readonly RunStatus[] = [
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.TIMED_OUT,
];

export function isRunActive(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

export enum StepStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  WAITING_APPROVAL = 'WAITING_APPROVAL',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
  CANCELLED = 'CANCELLED',
}

export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  StepStatus.SUCCEEDED,
  StepStatus.FAILED,
  StepStatus.SKIPPED,
  StepStatus.CANCELLED,
];

export function isStepTerminal(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.includes(status);
}

/** How a step failure is treated. */
export enum FailureClass {
  /** A dependency blinked: retry with backoff. */
  TRANSIENT = 'TRANSIENT',
  /** The step can never succeed as defined: fail now. */
  PERMANENT = 'PERMANENT',
  /** The step ran out of time. Retried: a slow model is usually a busy one. */
  TIMEOUT = 'TIMEOUT',
  /** A policy refused it: access, information flow, personal data. Never retried. */
  POLICY = 'POLICY',
}

export enum RunTrigger {
  MANUAL = 'MANUAL',
  API = 'API',
}
