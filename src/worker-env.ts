/**
 * Environment overrides for the dedicated worker process, applied before
 * anything reads configuration. Imported first by `worker.ts`; see the note in
 * `database/seeds/seed-env.ts` on why this cannot be an assignment in that file.
 */
process.env.QUEUE_WORKERS_ENABLED = 'true';
// Labels this process's metrics and traces as the worker's (phase 5).
process.env.DAIAP_PROCESS_ROLE = 'worker';
