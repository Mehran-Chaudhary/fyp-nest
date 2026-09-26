import type { FailureClass } from './run-state';

/**
 * What the dead-letter queue keeps about a workflow step that exhausted its
 * retries.
 *
 * The proposal is explicit (section 7): under Zero-Trust constraints,
 * debugging a failed inter-agent handoff must work *from metadata alone*,
 * because the payloads are encrypted and nobody operating the queue should be
 * able to read them. That is a design input here, not a limitation:
 *
 *  - The record is built field by field from a closed set of typed inputs.
 *    There is no free-text field, so there is nowhere for a prompt, an output
 *    or a tool result to end up, and no error message (which can quote them).
 *  - It carries no ciphertext either. A dead-letter queue is retained for a
 *    long time and read by operators; even encrypted content has no business
 *    there.
 *  - It is still enough to act on: which run, which node, which agent or tool
 *    version, which failure code and class, how many attempts, when — and a
 *    keyed fingerprint of the input, so "the same input fails every time" is
 *    visible without the input.
 */
export interface WorkflowDeadLetterRecord {
  kind: 'workflow-step';
  sourceQueue: string;
  jobId: string;
  organizationId: string;
  workflowId: string;
  workflowVersion: number;
  runId: string;
  stepId: string;
  nodeId: string;
  nodeType: string;
  iteration: number;
  attempts: number;
  failureCode: string;
  failureClass: FailureClass;
  retryable: boolean;
  firstAttemptAt: string | null;
  deadLetteredAt: string;
  lastDurationMs: number | null;
  /** HMAC of the step input under a dedicated key: correlates, never reveals. */
  inputFingerprint: string | null;
  inputBytes: number;
  agentId: string | null;
  agentVersion: number | null;
  toolId: string | null;
  toolVersion: number | null;
}

/** Failure codes are identifiers; anything else is replaced, never passed through. */
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildDeadLetterRecord(input: {
  sourceQueue: string;
  jobId: string;
  organizationId: string;
  workflowId: string;
  workflowVersion: number;
  runId: string;
  stepId: string;
  nodeId: string;
  nodeType: string;
  iteration: number;
  attempts: number;
  failureCode: string;
  failureClass: FailureClass;
  retryable: boolean;
  firstAttemptAt: Date | null;
  lastDurationMs: number | null;
  inputFingerprint: string | null;
  inputBytes: number;
  agentId?: string | null;
  agentVersion?: number | null;
  toolId?: string | null;
  toolVersion?: number | null;
}): WorkflowDeadLetterRecord {
  const uuid = (value: string | null | undefined) =>
    value && UUID.test(value) ? value : null;
  const integer = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isInteger(value) ? value : null;

  return {
    kind: 'workflow-step',
    sourceQueue: ID.test(input.sourceQueue) ? input.sourceQueue : 'unknown',
    jobId: ID.test(input.jobId) ? input.jobId : 'unknown',
    organizationId: uuid(input.organizationId) ?? 'unknown',
    workflowId: uuid(input.workflowId) ?? 'unknown',
    workflowVersion: integer(input.workflowVersion) ?? 0,
    runId: uuid(input.runId) ?? 'unknown',
    stepId: uuid(input.stepId) ?? 'unknown',
    nodeId: ID.test(input.nodeId) ? input.nodeId : 'unknown',
    nodeType: /^[a-z]{1,16}$/.test(input.nodeType) ? input.nodeType : 'unknown',
    iteration: integer(input.iteration) ?? 0,
    attempts: integer(input.attempts) ?? 0,
    failureCode: CODE.test(input.failureCode) ? input.failureCode : 'UNKNOWN',
    failureClass: input.failureClass,
    retryable: input.retryable === true,
    firstAttemptAt: input.firstAttemptAt ? input.firstAttemptAt.toISOString() : null,
    deadLetteredAt: new Date().toISOString(),
    lastDurationMs: integer(input.lastDurationMs),
    inputFingerprint:
      input.inputFingerprint && /^[0-9a-f]{64}$/.test(input.inputFingerprint)
        ? input.inputFingerprint
        : null,
    inputBytes: integer(input.inputBytes) ?? 0,
    agentId: uuid(input.agentId),
    agentVersion: integer(input.agentVersion),
    toolId: uuid(input.toolId),
    toolVersion: integer(input.toolVersion),
  };
}
