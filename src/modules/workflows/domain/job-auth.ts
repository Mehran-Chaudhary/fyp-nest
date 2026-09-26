import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Authentication of queued workflow jobs.
 *
 * The broker (Redis) is a third-party service, and the proposal asks for
 * Zero-Trust between agents: nothing is trusted for having arrived through
 * the queue. So a job carries no payload — only references — and a MAC over
 * those references, keyed by a key derived from the run's own data key:
 *
 *  - **No payload.** The inter-agent message itself (a step's input and
 *    output) lives in PostgreSQL, encrypted under the per-run key. A
 *    compromised broker, its snapshots or its replicas yield no content, not
 *    even ciphertext.
 *  - **No forgery.** Without the run key — which exists only wrapped by the
 *    master key, in PostgreSQL — nobody can mint a job the worker accepts.
 *  - **No redirection.** The MAC covers the workspace, run, step and dispatch
 *    number; a job cannot be pointed at another step or another tenant.
 *  - **No effective replay.** Re-sending a genuine job is harmless: a step
 *    runs only from the state the compare-and-set expects.
 *  - **Crypto-shredding reaches the queue.** Deleting a run destroys its key,
 *    so any of its jobs still queued can no longer be verified, and are
 *    rejected.
 */

export interface StepJobData {
  v: 1;
  organizationId: string;
  runId: string;
  stepId: string;
  /** Increases every time the step is (re-)dispatched: part of the job id. */
  dispatch: number;
  issuedAt: number;
  /** Correlation id of the request that started the run. Not a secret. */
  requestId?: string;
  mac: string;
}

const MAC_INFO = 'daiap/workflow-job-mac/v1';

export function jobMacKey(runDataKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', runDataKey, 'daiap-workflow-job', MAC_INFO, 32));
}

function canonical(data: Omit<StepJobData, 'mac' | 'requestId'>): string {
  return [
    'wfjob',
    data.v,
    data.organizationId,
    data.runId,
    data.stepId,
    data.dispatch,
    data.issuedAt,
  ].join('|');
}

export function signStepJob(
  key: Buffer,
  data: Omit<StepJobData, 'mac' | 'v'>,
): StepJobData {
  const unsigned = { ...data, v: 1 as const };
  return {
    ...unsigned,
    mac: createHmac('sha256', key).update(canonical(unsigned)).digest('base64url'),
  };
}

export function verifyStepJob(key: Buffer, data: StepJobData): boolean {
  if (data?.v !== 1 || typeof data.mac !== 'string') return false;
  const expected = createHmac('sha256', key).update(canonical(data)).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(data.mac, 'base64url');
  } catch {
    return false;
  }
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Deterministic job id: re-enqueueing the same dispatch is a no-op in BullMQ. */
export function stepJobId(stepId: string, dispatch: number): string {
  return `wfs_${stepId}_${dispatch}`;
}
