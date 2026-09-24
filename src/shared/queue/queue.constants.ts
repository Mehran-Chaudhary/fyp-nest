/**
 * Queue names.
 *
 * Queue *payloads* across the platform carry references — ids and version
 * numbers — and never content. Redis is a third-party hosted store like any
 * other, and a queue is a notoriously easy place for sensitive data to pile up
 * unnoticed: in retained failed jobs, in dead-letter queues, in monitoring
 * dashboards. A job that needs a document reads it, decrypted, from the
 * authoritative store when it runs.
 */
export const QUEUE_NAME = {
  /** Parse → chunk → embed → index, one job per document version. */
  INGESTION: 'document-ingestion',
  /** Purges, vector payload sync and the periodic reconciliation sweep. */
  MAINTENANCE: 'knowledge-maintenance',
  /**
   * Jobs that exhausted their retries. Holds metadata only — which job, which
   * document, which failure code — so it can be inspected safely.
   */
  DEAD_LETTER: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUE_NAME)[keyof typeof QUEUE_NAME];
