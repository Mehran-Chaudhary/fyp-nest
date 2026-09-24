import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { uuidV5 } from '../../../common/utils/uuid.util';
import { Document } from './document.entity';

/** Namespace for chunk ids. Fixed forever: changing it would re-key every chunk. */
export const CHUNK_ID_NAMESPACE = '6f1c2b0e-8d4a-5e3b-9c7f-2a1d0e4b8c6d';

/** The chunk id is derived, so a retried write lands on the same row and the same vector. */
export function chunkId(
  documentId: string,
  indexVersion: number,
  chunkIndex: number,
): string {
  return uuidV5(`${documentId}:${indexVersion}:${chunkIndex}`, CHUNK_ID_NAMESPACE);
}

/**
 * One chunk of a document's extracted text.
 *
 * The text is encrypted under the document's data key, bound to this chunk's id
 * (see `ContentEncryptionService`). The same id is the chunk's point id in the
 * vector store, which is how a search hit is joined back to its text — through
 * a query that re-applies the access policy (see `RetrievalService`).
 *
 * Deliberately not a `BaseEntity`: the id is derived, not generated.
 */
@Entity('document_chunks')
@Index('uq_document_chunks_position', ['documentId', 'indexVersion', 'chunkIndex'], {
  unique: true,
})
export class DocumentChunk {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'uuid', name: 'document_id' })
  documentId: string;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document?: Document;

  @Column({ type: 'integer', name: 'index_version' })
  indexVersion: number;

  @Column({ type: 'integer', name: 'chunk_index' })
  chunkIndex: number;

  @Column({ type: 'text', name: 'content_ciphertext' })
  contentCiphertext: string;

  @Column({ type: 'integer', name: 'token_count', default: 0 })
  tokenCount: number;

  @Column({ type: 'integer', name: 'char_count', default: 0 })
  charCount: number;

  @Column({ type: 'integer', name: 'page_start', nullable: true })
  pageStart: number | null;

  @Column({ type: 'integer', name: 'page_end', nullable: true })
  pageEnd: number | null;

  /** Set once this chunk's vector is durably in the store — the resume checkpoint. */
  @Column({ type: 'timestamptz', name: 'embedded_at', nullable: true })
  embeddedAt: Date | null;
}
