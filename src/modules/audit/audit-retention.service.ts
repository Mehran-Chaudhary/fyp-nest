import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DataSource, MoreThan } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException, NotFoundError } from '../../common/exceptions/app.exception';
import { LIFECYCLE_CONFIG_KEY, type LifecycleConfig } from '../../config/lifecycle.config';
import { returnedRows } from '../../database/query.util';
import { MetricsService } from '../../observability/metrics.service';
import { ContentEncryptionService } from '../../shared/crypto/content-encryption.service';
import { ObjectStorageService } from '../../shared/storage/object-storage.service';
import { AUDIT_LOCK_NAMESPACE, AuditService } from './audit.service';
import { AuditChainAnchor } from './entities/audit-chain-anchor.entity';
import { AuditLog, PLATFORM_CHAIN_ID } from './entities/audit-log.entity';

const DAY_MS = 86_400_000;
/** Records pruned per chain per sweep: bounds the transaction and the archive's size. */
const MAX_RECORDS_PER_SWEEP = 20_000;
const ARCHIVE_MAGIC = 'DAIAP-AUDIT-ARCHIVE/1';
/** Largest archive read back for download. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

interface ArchiveHeader {
  organizationId: string;
  firstSequence: string;
  lastSequence: string;
  records: number;
  binding: string;
  wrappedKey: string;
  createdAt: string;
}

export interface PruneOutcome {
  organizationId: string;
  firstSequence: string;
  lastSequence: string;
  pruned: number;
  archiveKey: string | null;
}

/**
 * Audit retention: the documented escape hatch in the append-only log
 * (phase 5).
 *
 * The audit log refuses UPDATE and DELETE at the storage layer. Retention is
 * the one sanctioned exception, and it is built so that pruning cannot be
 * mistaken for — or used to hide — tampering:
 *
 *  1. **Archive first.** The records to be pruned are written, as the same
 *     verifiable NDJSON the export produces, gzipped and encrypted under a
 *     fresh data key (wrapped by the master key), to object storage — under a
 *     prefix that a workspace's own purge does not touch, because evidence
 *     outlives the tenant it describes. With AUDIT_ARCHIVE_BEFORE_PRUNE (the
 *     default), nothing is pruned that could not first be archived.
 *  2. **Prune under the chain lock**, in one transaction with the deletion
 *     escape hatch opened only for that transaction (`daiap.allow_audit_deletion`,
 *     visible in the PostgreSQL log), so no append can interleave.
 *  3. **Anchor.** The sequence and hash of the last pruned record are kept,
 *     MAC'd with the audit secret. Verification resumes from the anchor; an
 *     anchor that does not verify, or a gap an anchor does not explain, is
 *     reported as tampering.
 *  4. **Record it.** `audit.log.pruned` is appended to the same chain, in
 *     the same transaction: the log says what was removed, when, and where the
 *     archive is.
 *
 * Only whole prefixes of a chain are ever pruned, oldest first.
 */
@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);
  private readonly config: LifecycleConfig['audit'];
  private warnedNoStorage = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly storage: ObjectStorageService,
    private readonly content: ContentEncryptionService,
    configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.config = configService.getOrThrow<LifecycleConfig>(LIFECYCLE_CONFIG_KEY).audit;
  }

  /** Applies each chain's retention period. Returns what was pruned. */
  async applyRetention(now = new Date()): Promise<PruneOutcome[]> {
    const chains: Array<{ id: string; days: string | null }> = await this.dataSource.query(
      `SELECT id, settings->>'auditRetentionDays' AS days FROM organizations
       UNION ALL SELECT $1::uuid AS id, NULL AS days`,
      [PLATFORM_CHAIN_ID],
    );
    const outcomes: PruneOutcome[] = [];
    for (const chain of chains) {
      const retentionMs = this.retentionFor(chain.days);
      if (retentionMs <= 0) continue;
      try {
        const outcome = await this.pruneChain(chain.id, new Date(now.getTime() - retentionMs));
        if (outcome) outcomes.push(outcome);
      } catch (error) {
        this.logger.error(
          `Audit retention failed for chain ${chain.id}: ${(error as Error).message}`,
        );
      }
    }
    return outcomes;
  }

  /** A workspace's own period (never below the platform floor), else the platform's. */
  retentionFor(days: string | number | null | undefined): number {
    const own = Number(days);
    if (Number.isFinite(own) && own > 0) {
      return Math.max(own * DAY_MS, this.config.minimumRetentionMs);
    }
    return this.config.retentionMs;
  }

  /**
   * Archives, prunes and anchors the records of one chain created before
   * `cutoff` — at most MAX_RECORDS_PER_SWEEP of them; the next sweep continues.
   */
  async pruneChain(organizationId: string, cutoff: Date): Promise<PruneOutcome | null> {
    const [range]: Array<{ first: string | null; last: string | null }> =
      await this.dataSource.query(
        `SELECT min(sequence)::text AS first, max(sequence)::text AS last
           FROM audit_logs WHERE organization_id = $1 AND created_at < $2`,
        [organizationId, cutoff],
      );
    if (!range?.first || !range.last) return null;

    // Only an unbroken prefix may be pruned: the chain must start exactly
    // where the last anchor (or genesis) left it.
    const [previous] = await this.dataSource.getRepository(AuditChainAnchor).find({
      where: { organizationId },
      order: { sequence: 'DESC' },
      take: 1,
    });
    const expectedFirst = previous ? BigInt(previous.sequence) + 1n : 1n;
    if (BigInt(range.first) !== expectedFirst) {
      this.logger.error(
        `Audit chain ${organizationId} starts at ${range.first}, not ${expectedFirst}: ` +
          'records are missing without an anchor. Retention will not prune over a gap; run ' +
          'GET …/audit-logs/verify.',
      );
      return null;
    }

    const first = BigInt(range.first);
    const last = minBigInt(BigInt(range.last), first + BigInt(MAX_RECORDS_PER_SWEEP) - 1n);

    // ── 1. Archive ────────────────────────────────────────────────────────
    let archiveKey: string | null = null;
    let archiveSha256: string | null = null;
    if (this.storage.isConfigured) {
      const archive = await this.buildArchive(organizationId, first, last);
      archiveKey = this.storage.key(
        'audit-archive',
        organizationId,
        `${first.toString()}-${last.toString()}.daa`,
      );
      await this.storage.put(archiveKey, archive.body, {
        contentType: 'application/octet-stream',
        metadata: { 'daiap-kind': 'audit-archive', 'daiap-records': String(archive.records) },
      });
      archiveSha256 = createHash('sha256').update(archive.body).digest('hex');
    } else if (this.config.archiveBeforePrune) {
      if (!this.warnedNoStorage) {
        this.warnedNoStorage = true;
        this.logger.warn(
          'Audit retention is configured but object storage is not: nothing is pruned, ' +
            'because AUDIT_ARCHIVE_BEFORE_PRUNE requires an archive first. Configure ' +
            'STORAGE_S3_* or set AUDIT_ARCHIVE_BEFORE_PRUNE=false.',
        );
      }
      return null;
    }

    // ── 2–4. Prune, anchor and record, atomically, under the chain lock ──
    const pruned = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        AUDIT_LOCK_NAMESPACE,
        organizationId,
      ]);
      const [tail]: Array<{ hash: string }> = await manager.query(
        `SELECT hash FROM audit_logs WHERE organization_id = $1 AND sequence = $2`,
        [organizationId, last.toString()],
      );
      if (!tail) throw new Error(`record ${last} of chain ${organizationId} vanished`);

      // The escape hatch in the append-only trigger, for this transaction only.
      await manager.query(`SELECT set_config('daiap.allow_audit_deletion', 'on', true)`);
      const deleted = returnedRows(
        await manager.query(
          `DELETE FROM audit_logs
            WHERE organization_id = $1 AND sequence BETWEEN $2 AND $3
            RETURNING sequence`,
          [organizationId, first.toString(), last.toString()],
        ),
      ).length;
      await manager.query(`SELECT set_config('daiap.allow_audit_deletion', 'off', true)`);

      const expected = Number(last - first + 1n);
      if (deleted !== expected) {
        throw new Error(`expected to prune ${expected} records, found ${deleted}`);
      }

      const anchor = {
        organizationId,
        sequence: last.toString(),
        hash: tail.hash,
        firstSequence: first.toString(),
        recordsPruned: String(deleted),
        cutoff,
        archiveKey,
        archiveSha256,
      };
      await manager.getRepository(AuditChainAnchor).insert({
        ...anchor,
        mac: this.auditService.anchorMac(anchor),
      });

      await this.auditService.record(
        {
          action: AuditAction.AUDIT_LOG_PRUNED,
          organizationId,
          resourceType: 'audit_chain',
          resourceId: organizationId,
          actor: { type: ActorType.SYSTEM, label: 'audit retention' },
          metadata: {
            firstSequence: anchor.firstSequence,
            lastSequence: anchor.sequence,
            records: deleted,
            cutoff: cutoff.toISOString(),
            archiveKey,
            archiveSha256,
          },
        },
        manager,
      );
      return deleted;
    });

    this.metrics?.lifecycleRemovals.inc({ kind: 'audit_records' }, pruned);
    this.logger.log(
      `Audit chain ${organizationId}: pruned records ${first}–${last}` +
        (archiveKey ? `, archived to ${archiveKey}.` : ' (no archive).'),
    );
    return {
      organizationId,
      firstSequence: first.toString(),
      lastSequence: last.toString(),
      pruned,
      archiveKey,
    };
  }

  /** The anchors of a chain: where retention pruned it, and where each archive is. */
  async anchors(organizationId: string): Promise<AuditChainAnchor[]> {
    return this.dataSource.getRepository(AuditChainAnchor).find({
      where: { organizationId },
      order: { sequence: 'DESC' },
    });
  }

  /**
   * An archive, decrypted, as the NDJSON the export produces — verifiable
   * offline against its anchor: the last line's `hash` is the anchor's hash.
   * The stored object's digest is checked first, so a swapped archive is
   * refused rather than served.
   */
  async readArchive(organizationId: string, sequence: string): Promise<Buffer> {
    const anchor = await this.dataSource.getRepository(AuditChainAnchor).findOne({
      where: { organizationId, sequence },
    });
    if (!anchor) throw new NotFoundError(ErrorCode.RESOURCE_NOT_FOUND);
    if (!anchor.archiveKey || !anchor.archiveSha256) {
      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, HttpStatus.NOT_FOUND, {
        message: 'These records were pruned without an archive.',
      });
    }

    const body = await this.storage.get(anchor.archiveKey, MAX_ARCHIVE_BYTES);
    if (createHash('sha256').update(body).digest('hex') !== anchor.archiveSha256) {
      throw new AppException(ErrorCode.AUDIT_CHAIN_BROKEN, HttpStatus.CONFLICT, {
        message: 'The stored archive does not match the digest its anchor recorded.',
      });
    }

    const headerEnd = body.indexOf(0x0a, ARCHIVE_MAGIC.length + 1);
    const magic = body.subarray(0, ARCHIVE_MAGIC.length).toString('utf8');
    if (magic !== ARCHIVE_MAGIC || headerEnd < 0) {
      throw new AppException(ErrorCode.AUDIT_CHAIN_BROKEN, HttpStatus.CONFLICT, {
        message: 'The stored archive is not in a recognised format.',
      });
    }
    const header = JSON.parse(
      body.subarray(ARCHIVE_MAGIC.length + 1, headerEnd).toString('utf8'),
    ) as ArchiveHeader;
    const key = this.content.unwrapDataKey(header.wrappedKey, header.binding);
    try {
      return gunzipSync(this.content.decrypt(key, body.subarray(headerEnd + 1), header.binding));
    } finally {
      this.content.destroy(key);
    }
  }

  /** `MAGIC\n{header}\n<envelope(gzip(ndjson))>`: the key travels wrapped, with the data. */
  private async buildArchive(
    organizationId: string,
    first: bigint,
    last: bigint,
  ): Promise<{ body: Buffer; records: number }> {
    const lines: string[] = [];
    let after = (first - 1n).toString();
    for (;;) {
      const batch = await this.dataSource.getRepository(AuditLog).find({
        where: { organizationId, sequence: MoreThan(after) },
        order: { sequence: 'ASC' },
        take: 1_000,
      });
      const inRange = batch.filter((record) => BigInt(record.sequence) <= last);
      for (const record of inRange) lines.push(JSON.stringify(record));
      if (inRange.length < batch.length || batch.length < 1_000) break;
      after = batch[batch.length - 1].sequence;
    }

    const binding = `audit-archive:${organizationId}:${first}-${last}`;
    const dataKey = this.content.generateDataKey(binding);
    try {
      const envelope = this.content.encrypt(
        dataKey.plaintext,
        gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')),
        binding,
      );
      const header: ArchiveHeader = {
        organizationId,
        firstSequence: first.toString(),
        lastSequence: last.toString(),
        records: lines.length,
        binding,
        wrappedKey: dataKey.wrapped,
        createdAt: new Date().toISOString(),
      };
      return {
        body: Buffer.concat([
          Buffer.from(`${ARCHIVE_MAGIC}\n${JSON.stringify(header)}\n`, 'utf8'),
          envelope,
        ]),
        records: lines.length,
      };
    } finally {
      this.content.destroy(dataKey.plaintext);
    }
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
