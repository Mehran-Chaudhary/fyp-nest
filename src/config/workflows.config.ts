import { registerAs } from '@nestjs/config';
import { parseByteSize } from '../common/utils/byte-size.util';
import { parseDuration } from '../common/utils/duration.util';

/**
 * The multi-agent workflow engine (proposal modules 6.9 and 6.13).
 *
 * Every value here is a platform ceiling. A workflow can ask for less — fewer
 * steps, a shorter timeout — but never more, so an administrator can reason
 * about the worst case one workflow can cost from this file alone.
 */
export interface WorkflowsConfig {
  /** Canvas size limits, checked when a definition is saved. */
  maxNodes: number;
  maxEdges: number;
  /**
   * Most steps one run may schedule, loops and supervisor rounds included.
   * The engine counts steps as it schedules them, so a runaway loop is stopped
   * by this ceiling before its next step reaches the queue.
   */
  maxSteps: number;
  maxLoopIterations: number;
  maxSupervisorRounds: number;
  /** Largest run input accepted, in bytes of JSON. */
  maxInputBytes: number;
  /** Largest output one step may hand to the next, in bytes. */
  maxStepOutputBytes: number;
  runTimeoutMs: number;
  stepTimeoutMs: number;
  stepMaxAttempts: number;
  stepBackoffMs: number;
  stepBackoffMaxMs: number;
  /** Steps executed at once by one worker process. */
  concurrency: number;
  /** Runs in progress at once per workspace; more are refused with 429. */
  maxActiveRunsPerOrganization: number;
  /** Prompt plus completion tokens one run may spend across all its model calls. */
  maxTokensPerRun: number;
  /** How often a running step proves it is alive, and checks for cancellation. */
  heartbeatIntervalMs: number;
  /** A running step silent for this long is presumed dead and taken over. */
  stallThresholdMs: number;
  sweepIntervalMs: number;
  approvalTimeoutMs: number;
  /** Finished runs are deleted (their keys destroyed) after this long. 0 keeps them. */
  runRetentionMs: number;
}

export const WORKFLOWS_CONFIG_KEY = 'workflows';

export default registerAs(WORKFLOWS_CONFIG_KEY, (): WorkflowsConfig => ({
  maxNodes: Number(process.env.WORKFLOW_MAX_NODES),
  maxEdges: Number(process.env.WORKFLOW_MAX_EDGES),
  maxSteps: Number(process.env.WORKFLOW_MAX_STEPS),
  maxLoopIterations: Number(process.env.WORKFLOW_MAX_LOOP_ITERATIONS),
  maxSupervisorRounds: Number(process.env.WORKFLOW_MAX_SUPERVISOR_ROUNDS),
  maxInputBytes: parseByteSize(process.env.WORKFLOW_MAX_INPUT_SIZE as string),
  maxStepOutputBytes: parseByteSize(process.env.WORKFLOW_MAX_STEP_OUTPUT_SIZE as string),
  runTimeoutMs: parseDuration(process.env.WORKFLOW_RUN_TIMEOUT as string),
  stepTimeoutMs: parseDuration(process.env.WORKFLOW_STEP_TIMEOUT as string),
  stepMaxAttempts: Number(process.env.WORKFLOW_STEP_MAX_ATTEMPTS),
  stepBackoffMs: parseDuration(process.env.WORKFLOW_STEP_BACKOFF as string),
  stepBackoffMaxMs: parseDuration(process.env.WORKFLOW_STEP_BACKOFF_MAX as string),
  concurrency: Number(process.env.WORKFLOW_CONCURRENCY),
  maxActiveRunsPerOrganization: Number(process.env.WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG),
  maxTokensPerRun: Number(process.env.WORKFLOW_MAX_TOKENS_PER_RUN),
  heartbeatIntervalMs: parseDuration(process.env.WORKFLOW_HEARTBEAT_INTERVAL as string),
  stallThresholdMs: parseDuration(process.env.WORKFLOW_STALL_THRESHOLD as string),
  sweepIntervalMs: parseDuration(process.env.WORKFLOW_SWEEP_INTERVAL as string),
  approvalTimeoutMs: parseDuration(process.env.WORKFLOW_APPROVAL_TIMEOUT as string),
  runRetentionMs: parseDuration(process.env.WORKFLOW_RUN_RETENTION as string),
}));
