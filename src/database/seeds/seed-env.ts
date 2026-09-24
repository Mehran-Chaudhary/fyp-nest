/**
 * Environment overrides for the seed process, applied before anything reads
 * configuration.
 *
 * Imported for its side effect as the first import of `run-seed.ts` —
 * imports are evaluated in order, so a plain assignment at the top of that file
 * would run too late.
 *
 * The seeder boots the whole application context to reuse its services, which
 * would otherwise start queue workers and begin processing documents from
 * inside a short-lived maintenance command.
 */
process.env.QUEUE_WORKERS_ENABLED = 'false';
