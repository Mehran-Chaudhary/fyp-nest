import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Where a pruned audit chain now begins (phase 5).
 *
 * Retention deletes the oldest records of a workspace's hash chain. Without
 * more, verification — which starts from the genesis hash at sequence 1 —
 * would report the first surviving record as a broken link. An anchor records
 * the sequence and hash of the last record removed, so verification resumes
 * from it; it is MAC'd with `AUDIT_HASH_SECRET`, so an attacker holding only
 * the database cannot forge one to paper over records they deleted.
 *
 * Append-only, like the log itself (a trigger refuses UPDATE and DELETE), and
 * deliberately without a foreign key to the workspace: evidence outlives the
 * tenant it describes.
 */
@Entity('audit_chain_anchors')
export class AuditChainAnchor {
  @PrimaryColumn({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  /** Sequence of the last record pruned. The chain continues at `sequence + 1`. */
  @PrimaryColumn({ type: 'bigint', name: 'sequence' })
  sequence: string;

  /** Hash of that record: the surviving chain's first `previousHash`. */
  @Column({ type: 'varchar', length: 64, name: 'hash' })
  hash: string;

  /** First sequence removed by this pruning (the previous anchor's sequence + 1). */
  @Column({ type: 'bigint', name: 'first_sequence' })
  firstSequence: string;

  @Column({ type: 'bigint', name: 'records_pruned' })
  recordsPruned: string;

  /** Records created before this instant were pruned. */
  @Column({ type: 'timestamptz', name: 'cutoff' })
  cutoff: Date;

  /** Object-storage key of the encrypted NDJSON archive of the pruned records. */
  @Column({ type: 'text', name: 'archive_key', nullable: true })
  archiveKey: string | null;

  /** SHA-256 of the archive as stored (ciphertext), to detect a swapped object. */
  @Column({ type: 'varchar', length: 64, name: 'archive_sha256', nullable: true })
  archiveSha256: string | null;

  @Column({ type: 'varchar', length: 64, name: 'mac' })
  mac: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
