/**
 * Job names and payloads for the knowledge layer's queues.
 *
 * Every payload is references only — ids and a version number. See the note on
 * `QUEUE_NAME` for why content never enters Redis.
 */

export const INGESTION_JOB = 'ingest';

export interface IngestionJobData {
  organizationId: string;
  documentId: string;
  indexVersion: number;
  /** The upload request's correlation id, carried through to the worker's audit records. */
  requestId?: string;
  enqueuedAt: number;
}

export const MAINTENANCE_JOB = {
  SWEEP: 'sweep',
  PURGE_DOCUMENT: 'purge-document',
  PURGE_KNOWLEDGE_BASE: 'purge-knowledge-base',
  PURGE_ORGANIZATION: 'purge-organization',
  SYNC_DOCUMENT_VECTORS: 'sync-document-vectors',
} as const;

export type MaintenanceJobName = (typeof MAINTENANCE_JOB)[keyof typeof MAINTENANCE_JOB];

export interface MaintenanceJobData {
  organizationId?: string;
  knowledgeBaseId?: string;
  documentId?: string;
  requestId?: string;
}

/**
 * What the dead-letter queue keeps about a job that exhausted its retries:
 * enough to find it, understand it and re-run it — nothing that is content.
 */
export interface DeadLetterRecord {
  sourceQueue: string;
  jobId: string;
  jobName: string;
  organizationId?: string;
  documentId?: string;
  indexVersion?: number;
  failureCode: string;
  attempts: number;
  failedAt: string;
}

/**
 * Deterministic job id. BullMQ refuses to add a job whose id already exists, so
 * enqueueing the same document version twice — from the upload request and
 * from the sweep, say — yields one job, not two.
 */
export function ingestionJobId(documentId: string, indexVersion: number): string {
  return `ingest_${documentId}_v${indexVersion}`;
}
