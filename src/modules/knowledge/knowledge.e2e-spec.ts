// Must stay first: disables queue workers before configuration is read.
import '../../database/seeds/seed-env';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { AuditService } from '../audit/audit.service';
import { AiServiceClient } from '../../shared/ai-service/ai-service.client';
import { RequestContextService } from '../../shared/context/request-context.service';
import { ObjectStorageService } from '../../shared/storage/object-storage.service';
import { VectorStoreService } from '../../shared/vector-store/vector-store.service';
import {
  FakeAiService,
  ingestionJob as job,
  MemoryObjectStorage,
  MemoryVectorStore,
  RecordingJobs,
} from '../../testing/cloud-stand-ins';
import type { AccessPrincipal } from './domain/access';
import { Classification } from './domain/classification';
import { DocumentStatus } from './domain/document-status';
import { DocumentsService } from './documents/documents.service';
import { IngestionPipeline } from './ingestion/ingestion.pipeline';
import { KnowledgeJobsService } from './ingestion/knowledge-jobs.service';
import { KnowledgeMaintenanceService } from './ingestion/knowledge-maintenance.service';
import { RetrievalService } from './retrieval/retrieval.service';

/**
 * End-to-end verification of the knowledge layer against real PostgreSQL.
 *
 * Boots the real application module graph — every service, every SQL query,
 * the audit chain, the encryption — and replaces only the three cloud
 * endpoints with in-memory stand-ins that honour the same contracts:
 *
 *  - object storage   → a Map of objects,
 *  - the vector store → a point list searched with Qdrant's filter semantics
 *                       (`matchesFilter`) and cosine similarity,
 *  - the AI service   → paragraph chunking and deterministic bag-of-words
 *                       embeddings.
 *
 * Run against a DISPOSABLE database that has been migrated and seeded with
 * demo data (it writes and deletes documents in the demo workspace):
 *
 *   DB_HOST=… DB_NAME=… npm run migration:run
 *   DB_HOST=… DB_NAME=… SEED_DEMO_DATA=true npm run seed
 *   DB_HOST=… DB_NAME=… KNOWLEDGE_E2E=true npm run test:e2e:knowledge
 */

// ── Scenario ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env.KNOWLEDGE_E2E !== 'true') {
    console.log(
      'Skipped: set KNOWLEDGE_E2E=true and point DB_* at a disposable, seeded database.',
    );
    return;
  }

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ObjectStorageService)
    .useFactory({
      factory: (config: ConfigService) => new MemoryObjectStorage(config),
      inject: [ConfigService],
    })
    .overrideProvider(VectorStoreService)
    .useFactory({
      factory: (config: ConfigService) => new MemoryVectorStore(config),
      inject: [ConfigService],
    })
    .overrideProvider(AiServiceClient)
    .useFactory({
      factory: (config: ConfigService, context: RequestContextService) =>
        new FakeAiService(config, context),
      inject: [ConfigService, RequestContextService],
    })
    .overrideProvider(KnowledgeJobsService)
    .useValue(new RecordingJobs())
    .compile();
  await moduleRef.init();

  const dataSource = moduleRef.get(DataSource);
  const storage = moduleRef.get<MemoryObjectStorage>(ObjectStorageService);
  const vectors = moduleRef.get<MemoryVectorStore>(VectorStoreService);
  const ai = moduleRef.get<FakeAiService>(AiServiceClient);
  const documents = moduleRef.get(DocumentsService);
  const pipeline = moduleRef.get(IngestionPipeline);
  const retrieval = moduleRef.get(RetrievalService);
  const maintenance = moduleRef.get(KnowledgeMaintenanceService);
  const requestContext = moduleRef.get(RequestContextService);

  // ── Principals from the seeded demo workspace ───────────────────────────
  const principals: Record<string, AccessPrincipal> = {};
  const [{ id: organizationId }]: Array<{ id: string }> = await dataSource.query(
    `SELECT id FROM organizations WHERE slug = 'acme-corp'`,
  );
  const members: Array<{
    email: string;
    member_id: string;
    user_id: string;
    permissions: string[];
  }> = await dataSource.query(
    `SELECT u.email, m.id AS member_id, u.id AS user_id, m.effective_permissions AS permissions
         FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.deleted_at IS NULL`,
    [organizationId],
  );
  for (const member of members) {
    principals[member.email.split('@')[0]] = {
      organizationId,
      kind: 'user',
      userId: member.user_id,
      membershipId: member.member_id,
      permissions: member.permissions,
    };
  }
  const bases: Array<{ id: string; name: string }> = await dataSource.query(
    `SELECT id, name FROM knowledge_bases WHERE organization_id = $1 AND deleted_at IS NULL`,
    [organizationId],
  );
  const handbook = bases.find((base) => base.name === 'Company Handbook')!.id;
  const hr = bases.find((base) => base.name === 'HR Policies')!.id;

  const run = <T>(label: string, fn: () => Promise<T>) =>
    requestContext.run(
      {
        requestId: `e2e-${label}`,
        startTime: Date.now(),
        ip: '127.0.0.1',
        actorLabel: label,
      },
      fn,
    );
  const suffix = Date.now().toString(36);
  const step = (message: string) => console.log(`  ✔ ${message}`);

  console.log('Knowledge layer end-to-end verification');

  // ── 1. Upload and ingest ────────────────────────────────────────────────
  const leaveText = `Annual leave policy ${suffix}.\n\nEvery employee receives twenty five days of annual leave per year.\n\nLeave requests go to your line manager.`;
  const payrollText = `Payroll ${suffix}.\n\nThe CEO salary is 950000 per year with a performance bonus.\n\nExecutive compensation is reviewed by the board.`;

  const leave = await run('employee', () =>
    documents.upload(
      principals.employee,
      handbook,
      {
        originalname: `leave-${suffix}.txt`,
        mimetype: 'application/pdf',
        size: 0,
        buffer: Buffer.from(leaveText),
      },
      {},
    ),
  );
  assert.equal(leave.status, DocumentStatus.UPLOADED);
  assert.equal(
    leave.mimeType,
    'text/plain',
    'type comes from content, not the client’s claim',
  );
  const payroll = await run('hr', () =>
    documents.upload(
      principals.hr,
      hr,
      {
        originalname: `payroll-${suffix}.txt`,
        mimetype: 'text/plain',
        size: 0,
        buffer: Buffer.from(payrollText),
      },
      { classification: Classification.RESTRICTED },
    ),
  );
  step('uploads accepted; type detected from bytes');

  const [stored] = [...storage.objects.values()].slice(-1);
  assert.ok(
    !stored.includes(Buffer.from('CEO salary')),
    'stored object must be ciphertext',
  );
  step('stored object is ciphertext');

  for (const document of [leave, payroll]) {
    const outcome = await pipeline.process(
      job({ organizationId, documentId: document.id, indexVersion: 1 }),
    );
    assert.equal(outcome.outcome, 'ready');
  }
  const ready = await documents.get(principals.hr, payroll.id);
  assert.equal(ready.status, DocumentStatus.READY);
  assert.equal(ready.activeIndexVersion, 1);
  assert.equal(ready.chunkCount, 3);
  assert.equal(vectors.countFor(payroll.id), 3);
  step('ingestion: UPLOADED → PARSING → CHUNKING → EMBEDDING → READY');

  const [{ content_ciphertext: chunkCiphertext }]: Array<{ content_ciphertext: string }> =
    await dataSource.query(
      'SELECT content_ciphertext FROM document_chunks WHERE document_id = $1 LIMIT 1',
      [payroll.id],
    );
  assert.ok(!Buffer.from(chunkCiphertext, 'base64').includes(Buffer.from('salary')));
  assert.ok(
    ![...vectors.points.values()].some((point) =>
      JSON.stringify(point.payload).includes('salary'),
    ),
  );
  step('chunk text encrypted in PostgreSQL; vector payloads carry no text');

  // ── 2. Secure retrieval ─────────────────────────────────────────────────
  const question = {
    query: `what is the CEO salary ${suffix}`,
    topK: 10,
    mode: 'dense' as const,
  };
  const employeeAnswer = await run('employee', () =>
    retrieval.retrieve(principals.employee, question),
  );
  assert.ok(employeeAnswer.results.every((result) => result.knowledgeBaseId === handbook));
  assert.ok(!employeeAnswer.results.some((result) => result.text.includes('950000')));
  const hrAnswer = await run('hr', () => retrieval.retrieve(principals.hr, question));
  // Which of the payroll chunks ranks first depends on the stand-in's hashed
  // bag-of-words embedding and the run's random suffix; what matters is that
  // HR retrieves the payroll document and its salary chunk decrypts.
  const hrPayroll = hrAnswer.results.filter((result) => result.documentId === payroll.id);
  assert.ok(hrPayroll.length > 0, 'HR retrieves the payroll document');
  assert.ok(
    hrPayroll.some((result) => result.text.includes('950000')),
    'and its salary chunk decrypts',
  );
  const adminAnswer = await run('admin', () =>
    retrieval.retrieve(principals.admin, question),
  );
  assert.ok(
    !adminAnswer.results.some((result) => result.documentId === payroll.id),
    'admin role does not bypass compartments',
  );
  step('employee and admin never receive the payroll chunk; HR does');

  const [filtered]: Array<{
    metadata: { withheldDocuments: Array<{ documentId: string; reason: string }> };
  }> = await dataSource.query(
    `SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'rag.access.filtered'
        AND resource_id = $2`,
    [organizationId, employeeAnswer.retrievalId],
  );
  assert.ok(
    filtered.metadata.withheldDocuments.some(
      (entry) => entry.documentId === payroll.id && entry.reason === 'compartment',
    ),
  );
  const [executed]: Array<{ metadata: Record<string, unknown> }> = await dataSource.query(
    `SELECT metadata FROM audit_logs WHERE action = 'rag.query.executed' AND resource_id = $1`,
    [hrAnswer.retrievalId],
  );
  assert.ok(
    !JSON.stringify(executed.metadata).includes('CEO salary'),
    'query text is never audited',
  );
  step(
    'audit: rag.query.executed (no query text) and rag.access.filtered naming the withheld document',
  );

  // ── 3. Crash mid-embedding, then resume without duplicates ──────────────
  const longText = Array.from(
    { length: 70 },
    (_, i) => `Handbook section ${i} ${suffix} about office procedures.`,
  ).join('\n\n');
  const long = await run('employee', () =>
    documents.upload(
      principals.employee,
      handbook,
      {
        originalname: `long-${suffix}.md`,
        mimetype: '',
        size: 0,
        buffer: Buffer.from(longText),
      },
      {},
    ),
  );
  ai.embedCalls = 0;
  ai.failOnEmbedCall = 2; // batch size 32 → dies on the second of three batches
  await assert.rejects(
    pipeline.process(job({ organizationId, documentId: long.id, indexVersion: 1 })),
  );
  const crashed = await documents.get(principals.employee, long.id);
  assert.equal(crashed.status, DocumentStatus.EMBEDDING);
  assert.equal(crashed.isSearchable, false, 'a half-indexed document is not searchable');
  ai.failOnEmbedCall = null;
  const callsBefore = ai.embedCalls;
  await pipeline.process(job({ organizationId, documentId: long.id, indexVersion: 1 }, 1));
  const resumed = await documents.get(principals.employee, long.id);
  assert.equal(resumed.status, DocumentStatus.READY);
  assert.equal(resumed.chunkCount, 70);
  assert.equal(
    vectors.countFor(long.id),
    70,
    'exactly one vector per chunk — no duplicates',
  );
  assert.equal(
    ai.embedCalls - callsBefore,
    2,
    'resumed from the checkpoint, not from scratch',
  );
  step(
    'crash mid-embedding: resumed from checkpoint, 70 chunks, 70 vectors, no duplicates',
  );

  // ── 4. Reindex keeps serving the old version until the new one is ready ─
  const reindexed = await run('employee', () =>
    documents.reindex(principals.employee, leave.id),
  );
  assert.equal(reindexed.indexVersion, 2);
  assert.equal(reindexed.activeIndexVersion, 1);
  assert.equal(reindexed.isSearchable, true, 'still searchable during reindex');
  await assert.rejects(
    run('employee', () => documents.reindex(principals.employee, leave.id)),
    /processed/,
  );
  await pipeline.process(job({ organizationId, documentId: leave.id, indexVersion: 2 }));
  const [{ versions }]: Array<{ versions: number[] }> = await dataSource.query(
    'SELECT array_agg(DISTINCT index_version) AS versions FROM document_chunks WHERE document_id = $1',
    [leave.id],
  );
  assert.deepEqual(versions, [2]);
  assert.ok(
    [...vectors.points.values()]
      .filter((p) => p.payload.document_id === leave.id)
      .every((p) => p.payload.index_version === 2),
  );
  step(
    'reindex: v1 served until v2 complete; v1 chunks and vectors then retired; double request refused',
  );

  // ── 5. The database gate holds while vector payloads lag ────────────────
  await run('hr', () =>
    documents.update(principals.hr, leave.id, {
      classification: Classification.CONFIDENTIAL,
    }),
  );
  // The vector payload still says INTERNAL: the sync job has not run.
  assert.ok(
    [...vectors.points.values()].some(
      (p) => p.payload.document_id === leave.id && p.payload.classification === 'INTERNAL',
    ),
  );
  const lagging = await run('employee', () =>
    retrieval.retrieve(principals.employee, {
      query: `annual leave ${suffix}`,
      topK: 10,
      mode: 'dense',
    }),
  );
  assert.ok(
    !lagging.results.some((result) => result.documentId === leave.id),
    'reclassified document excluded immediately',
  );
  await maintenance.syncDocumentVectors(organizationId, leave.id);
  assert.ok(
    [...vectors.points.values()]
      .filter((p) => p.payload.document_id === leave.id)
      .every((p) => p.payload.classification === 'CONFIDENTIAL'),
  );
  step(
    'reclassification enforced by the SQL gate before the vector payload sync; sync then converges',
  );

  // ── 6. Download, then delete with crypto-shredding and purge ────────────
  const download = await run('hr', () => documents.download(principals.hr, payroll.id));
  assert.equal(download.content.toString('utf8'), payrollText);
  await assert.rejects(
    run('employee', () => documents.download(principals.employee, payroll.id)),
    /not found/i,
  );
  step('download decrypts for HR; the employee gets 404');

  await run('hr', () => documents.remove(principals.hr, payroll.id));
  const [shredded]: Array<{ wrapped_data_key: string | null; chunks: number }> =
    await dataSource.query(
      `SELECT d.wrapped_data_key, (SELECT COUNT(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks
       FROM documents d WHERE d.id = $1`,
      [payroll.id],
    );
  assert.equal(shredded.wrapped_data_key, null, 'key shredded in the delete transaction');
  assert.equal(shredded.chunks, 0);
  const afterDelete = await run('hr', () => retrieval.retrieve(principals.hr, question));
  assert.ok(
    !afterDelete.results.some((result) => result.documentId === payroll.id),
    'gone from retrieval before any purge',
  );
  await dataSource.query(
    `UPDATE documents SET deleted_at = now() - interval '5 minutes' WHERE id = $1`,
    [payroll.id],
  );
  assert.equal(await maintenance.purgeDocument(organizationId, payroll.id), 'purged');
  assert.equal(vectors.countFor(payroll.id), 0);
  assert.ok(![...storage.objects.keys()].some((key) => key.includes(payroll.id)));
  step(
    'delete: key shredded, chunks gone, invisible at once; purge removed vectors and object',
  );

  // ── 7. Sweep finds nothing left undone for these documents ──────────────
  const report = await maintenance.sweep();
  assert.equal(report.failedStalled, 0);
  step(`maintenance sweep ran: ${JSON.stringify(report)}`);

  // ── 8. The audit chain is intact after all of it ────────────────────────
  const verification = await moduleRef.get(AuditService).verifyChain(organizationId);
  assert.equal(verification.valid, true);
  step(`audit chain verified (${verification.recordsChecked} records)`);

  // Tidy up the remaining test documents.
  for (const id of [leave.id, long.id])
    await run('owner', () => documents.remove(principals.owner, id));

  await moduleRef.close();
  console.log('All knowledge-layer checks passed.');
}

main().catch((error) => {
  console.error('E2E verification FAILED:', error);
  process.exit(1);
});
