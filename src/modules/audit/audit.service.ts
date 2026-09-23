import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac } from 'node:crypto';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import {
  AuditAction,
  AuditSeverity,
  AuditStatus,
  severityForAction,
} from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { deepRedact } from '../../common/utils/redact.util';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { RequestContextService } from '../../shared/context/request-context.service';
import { AuditLog, GENESIS_HASH, PLATFORM_CHAIN_ID } from './entities/audit-log.entity';

/**
 * PostgreSQL advisory-lock namespace for audit chain appends.
 *
 * Advisory locks share one global 64-bit space, so an arbitrary but fixed
 * namespace keeps these locks from colliding with any other component's.
 */
const AUDIT_LOCK_NAMESPACE = 918_273;

export interface AuditEntryInput {
  action: AuditAction;
  status?: AuditStatus;
  /** Defaults to the active workspace from the request context. */
  organizationId?: string | null;
  resourceType?: string;
  resourceId?: string;
  resourceLabel?: string;
  metadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: number;
  durationMs?: number;
  /**
   * Overrides the actor taken from the request context. For flows where the
   * actor is known before authentication completes — a failed sign-in, where
   * there is no authenticated principal but the attempted identity matters.
   */
  actor?: {
    type: ActorType;
    id?: string | null;
    label?: string | null;
  };
  /** Overrides transport details, for events raised outside an HTTP request. */
  context?: {
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    httpMethod?: string | null;
    httpPath?: string | null;
  };
}

export interface ChainVerificationResult {
  organizationId: string;
  valid: boolean;
  recordsChecked: number;
  /** Sequence number of the first record that failed verification. */
  brokenAtSequence?: string;
  brokenRecordId?: string;
  reason?: string;
  verifiedAt: string;
}

/**
 * The immutable, tamper-evident audit log (proposal module 6.15).
 *
 * ## The chain
 *
 * Every record commits to its predecessor:
 *
 *     hash(n) = HMAC-SHA256(secret, canonical(record n) || hash(n-1))
 *
 * Editing or deleting any historical record breaks every link after it, and
 * {@link verifyChain} reports the exact sequence where the break occurs. Because
 * the HMAC key lives outside the database, an attacker with database access
 * alone cannot recompute a consistent chain to hide their edit.
 *
 * ## Why appends are serialised
 *
 * Two concurrent requests in the same workspace must not both read "the last
 * sequence is 41" and both write 42 — that forks the chain and makes
 * verification meaningless. Each append therefore takes a PostgreSQL advisory
 * lock keyed on the workspace, held for the duration of the transaction.
 *
 * This means audit writes for a single workspace are serialised. That is a real
 * throughput ceiling and a deliberate one: an audit log that can be raced is not
 * evidence. The lock is per workspace, so tenants never block one another, and
 * `SERIALIZABLE`-style retry storms are avoided because the lock is taken before
 * any read rather than detected after a conflict.
 *
 * ## Failure posture
 *
 * {@link record} throws on failure so the caller can decide. {@link recordSafe}
 * swallows errors and is what the interceptor uses, because failing a user's
 * successful operation because its audit row could not be written trades a
 * genuine availability loss for a marginal completeness gain. Security-critical
 * events — refresh token reuse, permission changes — use the throwing form
 * inside the same transaction as the change they describe, so the record and the
 * change commit or fail together.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly hashSecret: string;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly requestContext: RequestContextService,
  ) {
    this.hashSecret =
      this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY).auditHashSecret;
  }

  /**
   * Appends a record, throwing on failure.
   *
   * Pass `manager` to enlist in an existing transaction — the right choice when
   * the audited change and its record must be atomic.
   */
  async record(input: AuditEntryInput, manager?: EntityManager): Promise<AuditLog> {
    if (manager) {
      return this.append(manager, input);
    }
    return this.dataSource.transaction((transactionManager) =>
      this.append(transactionManager, input),
    );
  }

  /**
   * Appends a record, logging rather than throwing on failure.
   *
   * For the interceptor-driven path, where a failed audit write must not fail
   * the user's request.
   */
  async recordSafe(input: AuditEntryInput, manager?: EntityManager): Promise<void> {
    try {
      await this.record(input, manager);
    } catch (error) {
      // Escalated to `error`, not `warn`: a gap in the audit log is a compliance
      // problem even when the request it describes succeeded, and it needs to be
      // visible to whoever watches the logs.
      this.logger.error(
        {
          action: input.action,
          organizationId: input.organizationId,
          err: error as Error,
        },
        `Failed to write audit record for "${input.action}".`,
      );
    }
  }

  private async append(manager: EntityManager, input: AuditEntryInput): Promise<AuditLog> {
    const context = this.requestContext.get();

    const organizationId =
      input.organizationId ?? context?.organization?.id ?? PLATFORM_CHAIN_ID;

    const status = input.status ?? AuditStatus.SUCCESS;
    const severity = severityForAction(input.action, status);

    const actorType = input.actor?.type ?? context?.actorType ?? ActorType.SYSTEM;
    const actorId = input.actor?.id ?? context?.actorId ?? null;
    const actorLabel = input.actor?.label ?? context?.actorLabel ?? null;

    // Serialise appends for this workspace. Released automatically at COMMIT or
    // ROLLBACK, so a crashed transaction cannot wedge the chain.
    await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      AUDIT_LOCK_NAMESPACE,
      organizationId,
    ]);

    const previous = await manager
      .getRepository(AuditLog)
      .createQueryBuilder('log')
      .select(['log.sequence', 'log.hash'])
      .where('log.organization_id = :organizationId', { organizationId })
      .orderBy('log.sequence', 'DESC')
      .limit(1)
      .getOne();

    const sequence = previous ? (BigInt(previous.sequence) + 1n).toString() : '1';
    const previousHash = previous ? previous.hash : GENESIS_HASH;

    const record = manager.getRepository(AuditLog).create({
      sequence,
      organizationId,
      action: input.action,
      status,
      severity,
      actorType,
      actorId,
      actorLabel: actorLabel ? actorLabel.slice(0, 255) : null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ? String(input.resourceId).slice(0, 128) : null,
      resourceLabel: input.resourceLabel ? input.resourceLabel.slice(0, 255) : null,
      ipAddress: input.context?.ipAddress ?? context?.ip ?? null,
      userAgent:
        (input.context?.userAgent ?? context?.userAgent ?? null)?.slice(0, 512) ?? null,
      requestId: input.context?.requestId ?? context?.requestId ?? null,
      httpMethod: input.context?.httpMethod ?? context?.method ?? null,
      httpPath: (input.context?.httpPath ?? context?.path ?? null)?.slice(0, 512) ?? null,
      httpStatus: input.httpStatus ?? null,
      durationMs: input.durationMs ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
      // Structural redaction before storage. An audit record that leaked the
      // password it was recording a change to would be worse than no record.
      metadata: input.metadata ? deepRedact(input.metadata) : {},
      previousHash,
    });

    record.hash = this.computeHash(record, previousHash);

    return manager.getRepository(AuditLog).save(record);
  }

  /**
   * Canonical serialisation of the fields the hash covers.
   *
   * Two properties are essential. **Determinism**: the same record must produce
   * the same bytes on every machine and every Node version, so fields are
   * emitted in a fixed order rather than relying on object key ordering, and
   * nested metadata is serialised with sorted keys. **Completeness**: every
   * field a tamperer might want to change is included — flipping a `status` from
   * `DENIED` to `SUCCESS` must break the chain just as loudly as deleting a row.
   *
   * `id` is excluded because it is assigned by the database default and is not
   * semantically part of the event; `created_at` is excluded for the same reason
   * and because its microsecond precision differs between the in-memory value
   * and the stored one, which would make re-verification fail spuriously.
   */
  private canonicalise(record: AuditLog): string {
    // Typed narrowly so the join below is a safe stringification rather than a
    // `String(unknown)` that could silently emit "[object Object]" into a hash.
    const fields: Array<[string, string | number | null]> = [
      ['sequence', record.sequence],
      ['organizationId', record.organizationId],
      ['action', record.action],
      ['status', record.status],
      ['severity', record.severity],
      ['actorType', record.actorType],
      ['actorId', record.actorId],
      ['actorLabel', record.actorLabel],
      ['resourceType', record.resourceType],
      ['resourceId', record.resourceId],
      ['resourceLabel', record.resourceLabel],
      ['ipAddress', record.ipAddress],
      ['userAgent', record.userAgent],
      ['requestId', record.requestId],
      ['httpMethod', record.httpMethod],
      ['httpPath', record.httpPath],
      ['httpStatus', record.httpStatus],
      ['durationMs', record.durationMs],
      ['errorCode', record.errorCode],
      ['errorMessage', record.errorMessage],
      ['metadata', stableStringify(record.metadata ?? {})],
    ];

    return fields
      .map(
        ([key, value]) =>
          `${key}=${value === null || value === undefined ? '' : String(value)}`,
      )
      .join('');
  }

  private computeHash(record: AuditLog, previousHash: string): string {
    return createHmac('sha256', this.hashSecret)
      .update(this.canonicalise(record))
      .update(previousHash)
      .digest('hex');
  }

  /**
   * Recomputes a workspace's chain and reports the first divergence.
   *
   * Streamed in batches rather than loaded at once: a mature workspace's log is
   * expected to reach millions of rows, and verification must not require
   * materialising all of them.
   */
  async verifyChain(
    organizationId: string,
    options: { batchSize?: number; maxRecords?: number } = {},
  ): Promise<ChainVerificationResult> {
    const batchSize = options.batchSize ?? 1_000;
    const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;

    let expectedPreviousHash = GENESIS_HASH;
    let expectedSequence = 1n;
    let checked = 0;
    let offset = 0;

    for (;;) {
      const batch = await this.auditRepository.find({
        where: { organizationId },
        order: { sequence: 'ASC' },
        skip: offset,
        take: batchSize,
      });

      if (batch.length === 0) break;

      for (const record of batch) {
        if (BigInt(record.sequence) !== expectedSequence) {
          return {
            organizationId,
            valid: false,
            recordsChecked: checked,
            brokenAtSequence: record.sequence,
            brokenRecordId: record.id,
            reason: `Sequence gap: expected ${expectedSequence}, found ${record.sequence}. A record was deleted.`,
            verifiedAt: new Date().toISOString(),
          };
        }

        if (record.previousHash !== expectedPreviousHash) {
          return {
            organizationId,
            valid: false,
            recordsChecked: checked,
            brokenAtSequence: record.sequence,
            brokenRecordId: record.id,
            reason:
              'Chain link mismatch: this record does not reference the hash of its predecessor.',
            verifiedAt: new Date().toISOString(),
          };
        }

        const recomputed = this.computeHash(record, record.previousHash);
        if (recomputed !== record.hash) {
          return {
            organizationId,
            valid: false,
            recordsChecked: checked,
            brokenAtSequence: record.sequence,
            brokenRecordId: record.id,
            reason:
              'Content hash mismatch: this record has been modified since it was written.',
            verifiedAt: new Date().toISOString(),
          };
        }

        expectedPreviousHash = record.hash;
        expectedSequence += 1n;
        checked += 1;

        if (checked >= maxRecords) {
          return {
            organizationId,
            valid: true,
            recordsChecked: checked,
            verifiedAt: new Date().toISOString(),
          };
        }
      }

      offset += batch.length;
      if (batch.length < batchSize) break;
    }

    return {
      organizationId,
      valid: true,
      recordsChecked: checked,
      verifiedAt: new Date().toISOString(),
    };
  }

  /** Most recent sequence number for a workspace. Zero when the chain is empty. */
  async getChainHead(organizationId: string): Promise<{ sequence: string; hash: string }> {
    const head = await this.auditRepository.findOne({
      where: { organizationId },
      order: { sequence: 'DESC' },
    });

    return head
      ? { sequence: head.sequence, hash: head.hash }
      : { sequence: '0', hash: GENESIS_HASH };
  }

  /**
   * Convenience wrapper for recording a denied authorization decision.
   *
   * Access denials are among the most useful signals in a compliance log — they
   * are what reveal an account probing beyond its remit — so they get a
   * dedicated, hard-to-forget entry point.
   */
  async recordAccessDenied(
    resource: string,
    missingPermissions: string[],
    organizationId?: string,
  ): Promise<void> {
    await this.recordSafe({
      action: AuditAction.ACCESS_DENIED,
      status: AuditStatus.DENIED,
      organizationId,
      resourceType: resource,
      metadata: { missingPermissions },
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Filtered, paginated read of one workspace's log.
   *
   * `organizationId` is applied first and is never caller-supplied — it comes
   * from the resolved request context. An audit endpoint that let a caller
   * choose which tenant's log to read would be the most damaging possible
   * tenant-isolation failure, since the log contains a summary of everything
   * that has ever happened in that workspace.
   *
   * Ordering is always `(organization_id, created_at DESC)`, matching the
   * composite index, so a workspace with millions of records still pages in
   * constant time.
   */
  async query(
    organizationId: string,
    filters: AuditQueryFilters,
  ): Promise<PaginatedResult<AuditLog>> {
    const builder = this.auditRepository
      .createQueryBuilder('log')
      .where('log.organization_id = :organizationId', { organizationId });

    if (filters.action) {
      builder.andWhere('log.action = :action', { action: filters.action });
    } else if (filters.actionPrefix) {
      // Left-anchored LIKE, so the index on (organization_id, action) is usable.
      builder.andWhere('log.action LIKE :prefix', { prefix: `${filters.actionPrefix}%` });
    }

    if (filters.status)
      builder.andWhere('log.status = :status', { status: filters.status });
    if (filters.severity) {
      builder.andWhere('log.severity = :severity', { severity: filters.severity });
    }
    if (filters.actorType) {
      builder.andWhere('log.actor_type = :actorType', { actorType: filters.actorType });
    }
    if (filters.actorId) {
      builder.andWhere('log.actor_id = :actorId', { actorId: filters.actorId });
    }
    if (filters.resourceType) {
      builder.andWhere('log.resource_type = :resourceType', {
        resourceType: filters.resourceType,
      });
    }
    if (filters.resourceId) {
      builder.andWhere('log.resource_id = :resourceId', { resourceId: filters.resourceId });
    }
    if (filters.requestId) {
      builder.andWhere('log.request_id = :requestId', { requestId: filters.requestId });
    }
    if (filters.ipAddress) {
      builder.andWhere('log.ip_address = :ipAddress', { ipAddress: filters.ipAddress });
    }
    if (filters.from) {
      builder.andWhere('log.created_at >= :from', { from: filters.from });
    }
    if (filters.to) {
      builder.andWhere('log.created_at <= :to', { to: filters.to });
    }

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;

    builder
      .orderBy('log.created_at', 'DESC')
      // Tiebreaker on the chain position, so records written within the same
      // millisecond still page deterministically instead of shuffling between
      // requests.
      .addOrderBy('log.sequence', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await builder.getManyAndCount();

    return { items, meta: buildPaginationMeta(total, page, limit) };
  }

  /** Aggregate counts for the compliance dashboard. */
  async statistics(organizationId: string): Promise<{
    totalRecords: string;
    headSequence: string;
    bySeverity: Record<string, number>;
    byStatus: Record<string, number>;
    topActions: Array<{ action: string; count: number }>;
  }> {
    const head = await this.getChainHead(organizationId);

    const severityRows: Array<{ severity: string; count: string }> =
      await this.auditRepository
        .createQueryBuilder('log')
        .select('log.severity', 'severity')
        .addSelect('COUNT(*)', 'count')
        .where('log.organization_id = :organizationId', { organizationId })
        .groupBy('log.severity')
        .getRawMany();

    const statusRows: Array<{ status: string; count: string }> = await this.auditRepository
      .createQueryBuilder('log')
      .select('log.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('log.organization_id = :organizationId', { organizationId })
      .groupBy('log.status')
      .getRawMany();

    const actionRows: Array<{ action: string; count: string }> = await this.auditRepository
      .createQueryBuilder('log')
      .select('log.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .where('log.organization_id = :organizationId', { organizationId })
      .groupBy('log.action')
      .orderBy('COUNT(*)', 'DESC')
      .limit(10)
      .getRawMany();

    return {
      totalRecords: head.sequence,
      headSequence: head.sequence,
      bySeverity: Object.fromEntries(
        severityRows.map((row) => [row.severity, Number(row.count)]),
      ),
      byStatus: Object.fromEntries(
        statusRows.map((row) => [row.status, Number(row.count)]),
      ),
      topActions: actionRows.map((row) => ({
        action: row.action,
        count: Number(row.count),
      })),
    };
  }

  /**
   * Streams a workspace's log as newline-delimited JSON for external review.
   *
   * NDJSON rather than a single JSON array: an export of a mature workspace is
   * far too large to buffer, and a consumer can process NDJSON a line at a time.
   * Each line carries its `hash` and `previousHash`, so the exported file can be
   * verified offline without access to this system — which is the point of an
   * export destined for an external auditor.
   */
  async *exportChain(
    organizationId: string,
    filters: Pick<AuditQueryFilters, 'from' | 'to'> = {},
    batchSize = 500,
  ): AsyncGenerator<string> {
    let offset = 0;

    for (;;) {
      const builder = this.auditRepository
        .createQueryBuilder('log')
        .where('log.organization_id = :organizationId', { organizationId });

      if (filters.from) builder.andWhere('log.created_at >= :from', { from: filters.from });
      if (filters.to) builder.andWhere('log.created_at <= :to', { to: filters.to });

      const batch = await builder
        .orderBy('log.sequence', 'ASC')
        .skip(offset)
        .take(batchSize)
        .getMany();

      if (batch.length === 0) return;

      for (const record of batch) {
        yield `${JSON.stringify(record)}\n`;
      }

      offset += batch.length;
      if (batch.length < batchSize) return;
    }
  }
}

/** Filters accepted by {@link AuditService.query}. */
export interface AuditQueryFilters {
  page?: number;
  limit?: number;
  action?: AuditAction;
  actionPrefix?: string;
  status?: AuditStatus;
  severity?: AuditSeverity;
  actorType?: ActorType;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  ipAddress?: string;
  from?: Date;
  to?: Date;
}

/**
 * Deterministic JSON serialisation with recursively sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * metadata objects built in different orders would hash differently and a
 * re-verification could fail on a record nobody touched.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}
