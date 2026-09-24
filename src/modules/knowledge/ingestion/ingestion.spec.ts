import { AiServiceError } from '../../../shared/ai-service/ai-service.types';
import { ObjectStorageError } from '../../../shared/storage/object-storage.service';
import { VectorStoreError } from '../../../shared/vector-store/vector-store.service';
import { returnedRows } from '../../../database/query.util';
import { chunkId } from '../entities/document-chunk.entity';
import { ingestionJobId } from './knowledge-jobs';
import { classifyFailure, IngestionError } from './ingestion.pipeline';

/**
 * The properties ingestion's crash safety rests on, and its failure policy.
 * (The pipeline's database choreography is exercised against real PostgreSQL
 * by the integration suite; these pin down the pure decisions it makes.)
 */
describe('ingestion', () => {
  describe('idempotency by construction', () => {
    const document = '6a3c1f2e-0000-4000-8000-000000000001';

    it('derives the same chunk id for the same position, so a retried write overwrites', () => {
      expect(chunkId(document, 1, 0)).toBe(chunkId(document, 1, 0));
    });

    it('derives distinct ids across positions and versions, so versions never collide', () => {
      const ids = new Set([
        chunkId(document, 1, 0),
        chunkId(document, 1, 1),
        chunkId(document, 2, 0),
        chunkId('6a3c1f2e-0000-4000-8000-000000000002', 1, 0),
      ]);
      expect(ids.size).toBe(4);
    });

    it('derives one queue job id per document version, so double enqueueing is a no-op', () => {
      expect(ingestionJobId(document, 3)).toBe(ingestionJobId(document, 3));
      expect(ingestionJobId(document, 3)).not.toBe(ingestionJobId(document, 4));
      // BullMQ rejects custom ids containing ':'.
      expect(ingestionJobId(document, 3)).not.toContain(':');
    });
  });

  describe('failure classification', () => {
    it('retries a transient AI outage', () => {
      const failure = classifyFailure(
        new AiServiceError('AI_SERVICE_TIMEOUT', 'timed out', true),
      );
      expect(failure).toMatchObject({ code: 'AI_SERVICE_UNAVAILABLE', retryable: true });
    });

    it('fails a document problem immediately, relaying the reason', () => {
      const failure = classifyFailure(
        new AiServiceError(
          'ENCRYPTED_DOCUMENT',
          'The PDF is password protected.',
          false,
          422,
        ),
      );
      expect(failure).toEqual({
        code: 'ENCRYPTED_DOCUMENT',
        message: 'The PDF is password protected.',
        retryable: false,
      });
    });

    it('retries a vector store outage but not a rejection', () => {
      expect(classifyFailure(new VectorStoreError('503', true)).retryable).toBe(true);
      expect(classifyFailure(new VectorStoreError('dims', false)).retryable).toBe(false);
    });

    it('treats a missing stored object as permanent', () => {
      expect(classifyFailure(new ObjectStorageError('gone', false, true))).toMatchObject({
        code: 'CONTENT_MISSING',
        retryable: false,
      });
      expect(classifyFailure(new ObjectStorageError('503', true)).retryable).toBe(true);
    });

    it('keeps an explicit ingestion decision', () => {
      expect(
        classifyFailure(new IngestionError('DOCUMENT_EMPTY', 'no text', false)),
      ).toEqual({
        code: 'DOCUMENT_EMPTY',
        message: 'no text',
        retryable: false,
      });
    });

    it('retries the unknown, bounded by the attempt limit', () => {
      expect(classifyFailure(new Error('surprise'))).toMatchObject({
        code: 'INGESTION_ERROR',
        retryable: true,
      });
    });
  });

  describe('raw query results', () => {
    it('unwraps the [rows, count] shape PostgreSQL UPDATE ... RETURNING produces', () => {
      expect(returnedRows([[{ id: 'a' }], 1])).toEqual([{ id: 'a' }]);
      expect(returnedRows([[], 0])).toEqual([]);
    });

    it('passes SELECT rows through', () => {
      expect(returnedRows([{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
    });
  });
});
