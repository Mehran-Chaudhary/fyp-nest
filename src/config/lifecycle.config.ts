import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

/**
 * Data lifecycle (phase 5): how long each kind of record lives, and the
 * personal-data rights a user can exercise themselves.
 *
 * Every retention period of 0 means "keep forever"; nothing here is deleted
 * unless a deployment opts in, except sessions and one-time tokens, which are
 * security bookkeeping with no value once they have ended.
 */
export interface LifecycleConfig {
  sweepIntervalMs: number;
  audit: {
    /** Platform default; 0 keeps records forever. */
    retentionMs: number;
    /** The shortest period a workspace may choose. */
    minimumRetentionMs: number;
    /** Refuse to prune what could not first be archived to object storage. */
    archiveBeforePrune: boolean;
  };
  sessionRetentionMs: number;
  usageRetentionMs: number;
  conversationRetentionMs: number;
  erasureEnabled: boolean;
  exportMaxItems: number;
}

export const LIFECYCLE_CONFIG_KEY = 'lifecycle';

export default registerAs(
  LIFECYCLE_CONFIG_KEY,
  (): LifecycleConfig => ({
    sweepIntervalMs: parseDuration(process.env.LIFECYCLE_SWEEP_INTERVAL ?? '6h'),
    audit: {
      retentionMs: parseDuration(process.env.AUDIT_RETENTION ?? '0'),
      minimumRetentionMs: parseDuration(process.env.AUDIT_RETENTION_MIN ?? '30d'),
      archiveBeforePrune: process.env.AUDIT_ARCHIVE_BEFORE_PRUNE !== 'false',
    },
    sessionRetentionMs: parseDuration(process.env.SESSION_RETENTION ?? '30d'),
    usageRetentionMs: parseDuration(process.env.USAGE_RETENTION ?? '0'),
    conversationRetentionMs: parseDuration(process.env.CONVERSATION_RETENTION ?? '0'),
    erasureEnabled: process.env.ACCOUNT_ERASURE_ENABLED !== 'false',
    exportMaxItems: Number(process.env.DATA_EXPORT_MAX_ITEMS ?? 20_000),
  }),
);
