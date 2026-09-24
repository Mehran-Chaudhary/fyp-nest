import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { User } from '../../users/entities/user.entity';
import { Classification } from '../domain/classification';
import { DocumentFileType, DocumentStatus } from '../domain/document-status';
import { KnowledgeBase } from './knowledge-base.entity';

/** Per-stage timings recorded by the ingestion worker, for the benchmark. */
export interface DocumentProcessingMetrics {
  queueWaitMs?: number;
  downloadMs?: number;
  parseMs?: number;
  persistMs?: number;
  embedMs?: number;
  indexMs?: number;
  totalMs?: number;
  attempts?: number;
  embeddingTokens?: number;
}

/**
 * An uploaded document and the state of its processing.
 *
 * ## Content is never stored here
 *
 * This row holds metadata. The file lives in object storage and the extracted
 * text in `document_chunks`, both encrypted under this document's own data key.
 * That key is stored only wrapped (`wrapped_data_key`), and deleting a document
 * nulls it in the same transaction — after which every copy of the content,
 * backups included, is unreadable. The row itself survives as a tombstone so
 * audit records that reference it stay resolvable.
 *
 * ## Versions
 *
 * `indexVersion` is the version the latest run is producing; `activeIndexVersion`
 * is the version currently served to retrieval. They differ while a reindex is
 * running, which is what lets a document keep answering queries throughout.
 */
@Entity('documents')
@Index('idx_documents_org_kb', ['organizationId', 'knowledgeBaseId'])
export class Document extends SoftDeletableEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'uuid', name: 'knowledge_base_id' })
  knowledgeBaseId: string;

  @ManyToOne(() => KnowledgeBase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'knowledge_base_id' })
  knowledgeBase?: KnowledgeBase;

  @Column({ type: 'varchar', length: 255, name: 'title' })
  title: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  @Column({ type: 'jsonb', name: 'tags', default: () => "'[]'::jsonb" })
  tags: string[];

  @Column({ type: 'varchar', length: 255, name: 'original_filename' })
  originalFilename: string;

  @Column({ type: 'varchar', length: 16, name: 'file_type' })
  fileType: DocumentFileType;

  /** Determined from the content, never taken from the client. */
  @Column({ type: 'varchar', length: 127, name: 'mime_type' })
  mimeType: string;

  @Column({ type: 'bigint', name: 'size_bytes' })
  sizeBytes: string;

  /** Keyed digest of the plaintext, for duplicate detection. See ContentEncryptionService. */
  @Column({ type: 'varchar', length: 64, name: 'content_fingerprint' })
  contentFingerprint: string;

  @Column({ type: 'varchar', length: 512, name: 'storage_key' })
  storageKey: string;

  /** The document's data key, encrypted under the master key. Null once shredded. */
  @Column({ type: 'text', name: 'wrapped_data_key', nullable: true, select: false })
  wrappedDataKey?: string | null;

  @Column({ type: 'varchar', length: 16, name: 'classification' })
  classification: Classification;

  @Column({ type: 'varchar', length: 16, name: 'status', default: DocumentStatus.UPLOADED })
  status: DocumentStatus;

  /** User-presentable reason for the latest failure, or progress note while retrying. */
  @Column({ type: 'varchar', length: 500, name: 'status_message', nullable: true })
  statusMessage: string | null;

  @Column({ type: 'varchar', length: 64, name: 'failure_code', nullable: true })
  failureCode: string | null;

  @Column({ type: 'timestamptz', name: 'last_status_at' })
  lastStatusAt: Date;

  @Column({ type: 'integer', name: 'index_version', default: 1 })
  indexVersion: number;

  @Column({ type: 'integer', name: 'active_index_version', nullable: true })
  activeIndexVersion: number | null;

  @Column({ type: 'integer', name: 'chunk_count', default: 0 })
  chunkCount: number;

  @Column({ type: 'integer', name: 'token_count', default: 0 })
  tokenCount: number;

  @Column({ type: 'integer', name: 'page_count', nullable: true })
  pageCount: number | null;

  @Column({ type: 'varchar', length: 16, name: 'language', nullable: true })
  language: string | null;

  @Column({ type: 'varchar', length: 64, name: 'parser', nullable: true })
  parser: string | null;

  @Column({ type: 'varchar', length: 128, name: 'embedding_model', nullable: true })
  embeddingModel: string | null;

  @Column({ type: 'integer', name: 'attempts', default: 0 })
  attempts: number;

  @Column({ type: 'jsonb', name: 'processing_metrics', default: () => "'{}'::jsonb" })
  processingMetrics: DocumentProcessingMetrics;

  @Column({ type: 'timestamptz', name: 'processing_started_at', nullable: true })
  processingStartedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'processing_completed_at', nullable: true })
  processingCompletedAt: Date | null;

  /**
   * When the ingestion job was last handed to the queue. Null means "not yet":
   * the maintenance sweep treats such rows as an outbox and enqueues them, so a
   * Redis blip at upload time delays a document instead of losing it.
   */
  @Column({ type: 'timestamptz', name: 'enqueued_at', nullable: true })
  enqueuedAt: Date | null;

  /** Set after a reclassification until the vector payloads have been updated. */
  @Column({ type: 'boolean', name: 'vector_sync_required', default: false })
  vectorSyncRequired: boolean;

  @Column({ type: 'timestamptz', name: 'purged_at', nullable: true })
  purgedAt: Date | null;

  @Column({ type: 'uuid', name: 'uploaded_by_id', nullable: true })
  uploadedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'uploaded_by_id' })
  uploadedBy?: User | null;

  @Column({ type: 'uuid', name: 'uploaded_by_api_key_id', nullable: true })
  uploadedByApiKeyId: string | null;

  get isSearchable(): boolean {
    return this.activeIndexVersion !== null && !this.deletedAt;
  }
}
