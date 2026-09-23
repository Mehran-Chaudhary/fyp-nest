import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { CreateDateColumn, PrimaryGeneratedColumn } from 'typeorm';
import type {
  AuditAction,
  AuditSeverity,
  AuditStatus,
} from '../../../common/enums/audit-action.enum';
import type { ActorType } from '../../../common/enums/auth-type.enum';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * An immutable, tamper-evident audit record.
 *
 * Proposal module 6.15 requires "immutable logs ... for compliance auditing".
 * Application-level immutability — simply never issuing an UPDATE — is not
 * evidence of anything, because anyone with database access can rewrite history
 * and no one can tell. This entity therefore implements a **hash chain**, the
 * same construction a blockchain uses for its ledger, minus the distributed
 * consensus that a single-tenant compliance log does not need:
 *
 *     hash(n) = HMAC-SHA256(secret, canonical(record n) || hash(n-1))
 *
 * Each record commits to its predecessor. Altering or deleting any historical
 * row breaks every subsequent link, and the `/audit-logs/verify` endpoint
 * recomputes the chain and reports the exact sequence number where it diverges.
 * The HMAC key lives in `AUDIT_HASH_SECRET`, outside the database, so an
 * attacker with only database access cannot recompute a consistent chain to
 * cover their tracks.
 *
 * Immutability is additionally enforced in PostgreSQL by a trigger that raises
 * on UPDATE or DELETE (see the initial migration), so even a mistaken
 * application-level write fails loudly rather than silently corrupting the chain.
 *
 * The chain is **per workspace**: each tenant has an independent sequence, so
 * one tenant's write volume cannot slow another's, and a tenant's log can be
 * exported and verified in isolation.
 *
 * Note this entity deliberately does not extend `BaseEntity` — it has no
 * `updated_at`, because nothing is ever updated.
 */
@Entity('audit_logs')
@Index('idx_audit_logs_org_sequence', ['organizationId', 'sequence'], { unique: true })
@Index('idx_audit_logs_org_created', ['organizationId', 'createdAt'])
@Index('idx_audit_logs_actor', ['actorId'])
@Index('idx_audit_logs_action', ['organizationId', 'action'])
@Index('idx_audit_logs_resource', ['resourceType', 'resourceId'])
@Index('idx_audit_logs_severity', ['organizationId', 'severity'])
@Index('idx_audit_logs_request', ['requestId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Monotonic position within this workspace's chain, starting at 1.
   *
   * Assigned under a PostgreSQL advisory lock held for the duration of the
   * inserting transaction, which is what guarantees that two concurrent requests
   * cannot both claim sequence *n* and fork the chain.
   */
  @Column({ type: 'bigint', name: 'sequence' })
  sequence: string;

  /**
   * The workspace whose chain this record belongs to.
   *
   * Platform-level events that precede or transcend any workspace — a user
   * registering, for instance — use {@link PLATFORM_CHAIN_ID}, the nil UUID,
   * rather than NULL. Two reasons: NULLs do not compare equal in SQL, so a
   * nullable column would defeat the unique `(organization_id, sequence)` index
   * that keeps the chain fork-free; and a single well-defined platform chain is
   * easier to verify than an implicit one.
   *
   * Deliberately **not** a foreign key. An audit record must outlive the tenant
   * it describes — the deletion of a workspace is itself one of the most
   * important things the log records, and a cascade would erase exactly the
   * evidence a compliance reviewer came for.
   */
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { createForeignKeyConstraints: false, nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization | null;

  @Column({ type: 'varchar', length: 64, name: 'action' })
  action: AuditAction;

  @Column({ type: 'varchar', length: 16, name: 'status' })
  status: AuditStatus;

  @Column({ type: 'varchar', length: 16, name: 'severity' })
  severity: AuditSeverity;

  // ── Actor ─────────────────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 16, name: 'actor_type' })
  actorType: ActorType;

  /** User id, API key id, or null for system-originated events. */
  @Column({ type: 'uuid', name: 'actor_id', nullable: true })
  actorId: string | null;

  /**
   * Denormalised actor label, captured at write time.
   *
   * Deliberately a snapshot rather than a join: an audit record must remain
   * readable after the actor is deleted, and must show who they *were* at the
   * time, not who they later became. A join would rewrite history every time
   * someone changed their display name.
   */
  @Column({ type: 'varchar', length: 255, name: 'actor_label', nullable: true })
  actorLabel: string | null;

  // ── Target ────────────────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 64, name: 'resource_type', nullable: true })
  resourceType: string | null;

  @Column({ type: 'varchar', length: 128, name: 'resource_id', nullable: true })
  resourceId: string | null;

  /** Snapshot label for the same reason as `actorLabel`. */
  @Column({ type: 'varchar', length: 255, name: 'resource_label', nullable: true })
  resourceLabel: string | null;

  // ── Request context ───────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 45, name: 'ip_address', nullable: true })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 512, name: 'user_agent', nullable: true })
  userAgent: string | null;

  /** Correlation id, tying this record to application logs for the same request. */
  @Column({ type: 'varchar', length: 128, name: 'request_id', nullable: true })
  requestId: string | null;

  @Column({ type: 'varchar', length: 8, name: 'http_method', nullable: true })
  httpMethod: string | null;

  @Column({ type: 'varchar', length: 512, name: 'http_path', nullable: true })
  httpPath: string | null;

  @Column({ type: 'smallint', name: 'http_status', nullable: true })
  httpStatus: number | null;

  @Column({ type: 'integer', name: 'duration_ms', nullable: true })
  durationMs: number | null;

  // ── Outcome detail ────────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 64, name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage: string | null;

  /**
   * Structured context: which fields changed, which permissions were missing,
   * how many chunks a retrieval returned.
   *
   * Passed through `deepRedact` before it is written. An audit log that leaks
   * the password it was recording a change to would be worse than no log, and on
   * a privacy platform it is the one place where a leak is least excusable.
   */
  @Column({ type: 'jsonb', name: 'metadata', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  // ── Chain ─────────────────────────────────────────────────────────────────

  /** `hash` of the preceding record; a constant genesis value for sequence 1. */
  @Column({ type: 'varchar', length: 64, name: 'previous_hash' })
  previousHash: string;

  /** HMAC-SHA256 over this record's canonical form concatenated with `previousHash`. */
  @Column({ type: 'varchar', length: 64, name: 'hash' })
  hash: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

/**
 * `previousHash` of the first record in any chain.
 *
 * All zeroes, mirroring the convention used for a genesis block, so that the
 * start of a chain is visually unmistakable when reading raw rows.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Stand-in workspace id for platform-level events.
 *
 * The nil UUID, so that platform events form one well-defined chain rather than
 * a chain keyed on NULL — which would make the unique `(organization_id,
 * sequence)` index useless, since NULLs do not compare equal in SQL.
 */
export const PLATFORM_CHAIN_ID = '00000000-0000-0000-0000-000000000000';
