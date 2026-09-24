/**
 * Integration tests: `npm run test:integration`.
 *
 * These talk to real cloud services and are skipped unless the relevant
 * variables are set — see docs/CLOUD_SETUP.md, "Verifying phase 2". They create
 * their own throwaway resources (a uniquely named collection) and remove them
 * afterwards, so they are safe to point at the same Qdrant cluster the
 * deployment uses.
 */
import base from './jest.config.mjs';

/** @type {import('jest').Config} */
export default {
  ...base,
  testRegex: '.*\\.int-spec\\.ts$',
  testTimeout: 120_000,
};
