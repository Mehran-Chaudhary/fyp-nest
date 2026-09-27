import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import {
  INGESTION_CONFIG_KEY,
  type IngestionConfig,
} from '../../../config/ingestion.config';
import { returnedRows } from '../../../database/query.util';
import { RequestContextService } from '../../../shared/context/request-context.service';
import { ObjectStorageService } from '../../../shared/storage/object-storage.service';
import { VectorStoreService } from '../../../shared/vector-store/vector-store.service';
import { AuditService } from '../../audit/audit.service';
import { MAINTENANCE_JOB, type MaintenanceJobData } from './knowledge-jobs';
import { KnowledgeJobsService } from './knowledge-jobs.service';

const SWEEP_BATCH = 100;

export interface SweepReport {
  enqueuedUploads: number;
  resumedStalled: number;
  failedStalled: number;
  documentPurges: number;
  knowledgeBasePurges: number;
  organizationPurges: number;
  vectorSyncs: number;
}

/**
 * Background reconciliation for the knowledge layer.
 *
 * The platform keeps state in three independently hosted systems — PostgreSQL,
 * the object store and the vector store — and no transaction spans all three.
 * Rather than pretend otherwise, PostgreSQL is made the single source of truth
 * and this service periodically drives the other two towards it. Every
 * operation here is idempotent, so running one twice, or concurrently on two
 * workers, is harmless.
 *
 * The periodic sweep is the safety net under every "best effort" in the
 * request path: an upload whose enqueue failed, a job whose worker died, a
 * purge that hit a storage outage, a reclassification whose vector update was
 * lost. Each leaves a durable marker in PostgreSQL; the sweep finds the marker
 * and finishes the work.
 */
@Injectable()
export class KnowledgeMaintenanceService {
  private readonly logger = new Logger(KnowledgeMaintenanceService.name);
  private readonly config: IngestionConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: ObjectStorageService,
    private readonly vectorStore: VectorStoreService,
    private readonly jobs: KnowledgeJobsService,
    private readonly auditService: AuditService,
    private readonly requestContext: RequestContextService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<IngestionConfig>(INGESTION_CONFIG_KEY);
  }

  /** BullMQ processor entry point for the maintenance queue. */
  async handle(job: Job<MaintenanceJobData>): Promise<unknown> {
    return this.requestContext.run(
      {
        requestId: job.data.requestId ?? `job-${job.id}`,
        startTime: Date.now(),
        ip: 'internal',
        actorLabel: 'knowledge maintenance',
      },
      async () => {
        const { organizationId, documentId, knowledgeBaseId } = job.data;
        // A job about one workspace works for that workspace only (row-level
        // security, phase 5). The sweep spans every workspace and stays unbound.
        if (organizationId && job.name !== MAINTENANCE_JOB.SWEEP) {
          this.requestContext.bindTenant(organizationId);
        }

        switch (job.name) {
          case MAINTENANCE_JOB.SWEEP:
            return this.sweep();
          case MAINTENANCE_JOB.PURGE_DOCUMENT:
            return this.purgeDocument(organizationId as string, documentId as string);
          case MAINTENANCE_JOB.PURGE_KNOWLEDGE_BASE:
            return this.purgeKnowledgeBase(
              organizationId as string,
              knowledgeBaseId as string,
            );
          case MAINTENANCE_JOB.PURGE_ORGANIZATION:
            return this.purgeOrganization(organizationId as string);
          case MAINTENANCE_JOB.SYNC_DOCUMENT_VECTORS:
            return this.syncDocumentVectors(organizationId as string, documentId as string);
          default:
            this.logger.warn(`Ignoring unknown maintenance job "${job.name}".`);
            return null;
        }
      },
    );
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────

  async sweep(): Promise<SweepReport> {
    const report: SweepReport = {
      enqueuedUploads: 0,
      resumedStalled: 0,
      failedStalled: 0,
      documentPurges: 0,
      knowledgeBasePurges: 0,
      organizationPurges: 0,
      vectorSyncs: 0,
    };
    const stallMs = this.config.stallThresholdMs;

    // 1. Outbox relay: uploads (and reindex requests) never handed to the
    //    queue, or handed over so long ago that the job must have been lost.
    const waiting: Array<{ id: string; organization_id: string; index_version: number }> =
      await this.dataSource.query(
        `SELECT id, organization_id, index_version FROM documents
          WHERE deleted_at IS NULL AND status = 'UPLOADED'
            AND ((enqueued_at IS NULL AND last_status_at < now() - interval '1 minute')
              OR (enqueued_at IS NOT NULL AND last_status_at < now() - $1 * interval '1 millisecond'))
          ORDER BY last_status_at ASC
          LIMIT ${SWEEP_BATCH}`,
        [stallMs],
      );

    for (const row of waiting) {
      const enqueued = await this.jobs.enqueueIngestion(
        {
          id: row.id,
          organizationId: row.organization_id,
          indexVersion: row.index_version,
        },
        { replaceFinished: true },
      );
      if (enqueued) {
        await this.dataSource.query(
          'UPDATE documents SET enqueued_at = now() WHERE id = $1',
          [row.id],
        );
        report.enqueuedUploads += 1;
      }
    }

    // 2. Stalled runs: in flight with no heartbeat for the stall threshold.
    //    Resume them (every stage is idempotent) — unless they have stalled so
    //    often that the document itself is the problem.
    const stalled: Array<{
      id: string;
      organization_id: string;
      index_version: number;
      attempts: number;
    }> = await this.dataSource.query(
      `SELECT id, organization_id, index_version, attempts FROM documents
        WHERE deleted_at IS NULL AND status IN ('PARSING','CHUNKING','EMBEDDING')
          AND last_status_at < now() - $1 * interval '1 millisecond'
        ORDER BY last_status_at ASC
        LIMIT ${SWEEP_BATCH}`,
      [stallMs],
    );

    for (const row of stalled) {
      if (row.attempts >= this.config.maxAttempts * 2) {
        await this.failStalled(
          row.id,
          row.organization_id,
          row.index_version,
          row.attempts,
        );
        report.failedStalled += 1;
        continue;
      }
      const resumed = await this.jobs.enqueueIngestion(
        {
          id: row.id,
          organizationId: row.organization_id,
          indexVersion: row.index_version,
        },
        { replaceFinished: true },
      );
      if (resumed) report.resumedStalled += 1;
    }

    // 3. Deleted documents whose content has not yet been destroyed everywhere.
    const documents: Array<{ id: string; organization_id: string }> =
      await this.dataSource.query(
        `SELECT id, organization_id FROM documents
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL
          AND deleted_at < now() - interval '2 minutes'
        LIMIT ${SWEEP_BATCH}`,
      );
    for (const row of documents) {
      if (
        await this.jobs.enqueueMaintenance(
          MAINTENANCE_JOB.PURGE_DOCUMENT,
          { organizationId: row.organization_id, documentId: row.id },
          row.id,
        )
      ) {
        report.documentPurges += 1;
      }
    }

    // 4. Deleted knowledge bases, likewise.
    const bases: Array<{ id: string; organization_id: string }> =
      await this.dataSource.query(
        `SELECT id, organization_id FROM knowledge_bases
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL
          AND deleted_at < now() - interval '2 minutes'
        LIMIT ${SWEEP_BATCH}`,
      );
    for (const row of bases) {
      if (
        await this.jobs.enqueueMaintenance(
          MAINTENANCE_JOB.PURGE_KNOWLEDGE_BASE,
          { organizationId: row.organization_id, knowledgeBaseId: row.id },
          row.id,
        )
      ) {
        report.knowledgeBasePurges += 1;
      }
    }

    // 5. Workspaces deleted longer ago than the grace period that still hold
    //    unpurged knowledge.
    const organizations: Array<{ id: string }> = await this.dataSource.query(
      `SELECT o.id FROM organizations o
        WHERE o.deleted_at IS NOT NULL
          AND o.deleted_at < now() - $1 * interval '1 millisecond'
          AND EXISTS (SELECT 1 FROM knowledge_bases kb
                       WHERE kb.organization_id = o.id AND kb.purged_at IS NULL)
        LIMIT ${SWEEP_BATCH}`,
      [this.config.organizationPurgeGraceMs],
    );
    for (const row of organizations) {
      if (
        await this.jobs.enqueueMaintenance(
          MAINTENANCE_JOB.PURGE_ORGANIZATION,
          { organizationId: row.id },
          row.id,
        )
      ) {
        report.organizationPurges += 1;
      }
    }

    // 6. Reclassified documents whose vector payloads still carry the old level.
    const syncs: Array<{ id: string; organization_id: string }> =
      await this.dataSource.query(
        `SELECT id, organization_id FROM documents
        WHERE vector_sync_required = true AND deleted_at IS NULL
          AND updated_at < now() - interval '1 minute'
        LIMIT ${SWEEP_BATCH}`,
      );
    for (const row of syncs) {
      if (
        await this.jobs.enqueueMaintenance(
          MAINTENANCE_JOB.SYNC_DOCUMENT_VECTORS,
          { organizationId: row.organization_id, documentId: row.id },
          row.id,
        )
      ) {
        report.vectorSyncs += 1;
      }
    }

    const acted = Object.values(report).some((count) => count > 0);
    if (acted) this.logger.log(`Maintenance sweep: ${JSON.stringify(report)}`);

    return report;
  }

  private async failStalled(
    documentId: string,
    organizationId: string,
    indexVersion: number,
    attempts: number,
  ): Promise<void> {
    const updated = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `UPDATE documents
            SET status = 'FAILED', failure_code = 'INGESTION_STALLED', last_status_at = now(),
                status_message = 'Processing repeatedly stopped without finishing. The file may be too complex to process.'
          WHERE id = $1 AND index_version = $2 AND deleted_at IS NULL
            AND status IN ('PARSING','CHUNKING','EMBEDDING')
        RETURNING id`,
        [documentId, indexVersion],
      ),
    );
    if (updated.length === 0) return;

    await this.auditService.recordSafe({
      action: AuditAction.DOCUMENT_INGESTION_FAILED,
      organizationId,
      resourceType: 'document',
      resourceId: documentId,
      errorCode: 'INGESTION_STALLED',
      metadata: { indexVersion, attempts },
    });
  }

  // ── Purges ────────────────────────────────────────────────────────────────

  /**
   * Destroys a deleted document's remaining traces: vectors, the stored object,
   * any chunk rows. Refuses to touch a document that is not deleted.
   */
  async purgeDocument(organizationId: string, documentId: string): Promise<string> {
    const [document]: Array<{
      storage_key: string;
      knowledge_base_id: string;
      deleted_at: Date | null;
      purged_at: Date | null;
    }> = await this.dataSource.query(
      `SELECT storage_key, knowledge_base_id, deleted_at, purged_at
         FROM documents WHERE id = $1 AND organization_id = $2`,
      [documentId, organizationId],
    );

    if (!document) return 'not found';
    if (!document.deleted_at) return 'not deleted';
    if (document.purged_at) return 'already purged';

    if (this.vectorStore.isConfigured) {
      await this.vectorStore.deleteDocument(organizationId, documentId);
    }
    if (this.storage.isConfigured) {
      await this.storage.delete(document.storage_key);
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query('DELETE FROM document_chunks WHERE document_id = $1', [
        documentId,
      ]);
      await manager.query(
        'UPDATE documents SET purged_at = now(), wrapped_data_key = NULL WHERE id = $1',
        [documentId],
      );
    });

    await this.auditService.recordSafe({
      action: AuditAction.DOCUMENT_PURGED,
      organizationId,
      resourceType: 'document',
      resourceId: documentId,
      metadata: { knowledgeBaseId: document.knowledge_base_id },
    });

    return 'purged';
  }

  async purgeKnowledgeBase(
    organizationId: string,
    knowledgeBaseId: string,
  ): Promise<string> {
    const [base]: Array<{ deleted_at: Date | null; purged_at: Date | null }> =
      await this.dataSource.query(
        'SELECT deleted_at, purged_at FROM knowledge_bases WHERE id = $1 AND organization_id = $2',
        [knowledgeBaseId, organizationId],
      );

    if (!base) return 'not found';
    if (!base.deleted_at) return 'not deleted';
    if (base.purged_at) return 'already purged';

    // Shred first, so anything that fails below leaves only unreadable ciphertext.
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE documents SET deleted_at = COALESCE(deleted_at, now()), wrapped_data_key = NULL
          WHERE knowledge_base_id = $1`,
        [knowledgeBaseId],
      );
      await manager.query(
        `DELETE FROM document_chunks
          WHERE document_id IN (SELECT id FROM documents WHERE knowledge_base_id = $1)`,
        [knowledgeBaseId],
      );
    });

    if (this.vectorStore.isConfigured) {
      await this.vectorStore.deleteKnowledgeBase(organizationId, knowledgeBaseId);
    }
    let objects = 0;
    if (this.storage.isConfigured) {
      objects = await this.storage.deletePrefix(
        `${this.storage.key('orgs', organizationId, 'kbs', knowledgeBaseId)}/`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        'UPDATE documents SET purged_at = now() WHERE knowledge_base_id = $1 AND purged_at IS NULL',
        [knowledgeBaseId],
      );
      await manager.query('UPDATE knowledge_bases SET purged_at = now() WHERE id = $1', [
        knowledgeBaseId,
      ]);
    });

    await this.auditService.recordSafe({
      action: AuditAction.DOCUMENT_PURGED,
      organizationId,
      resourceType: 'knowledge_base',
      resourceId: knowledgeBaseId,
      metadata: { objectsDeleted: objects },
    });

    return 'purged';
  }

  /**
   * Destroys everything a deleted workspace held in the knowledge layer, once
   * its grace period has passed. The workspace's audit chain is untouched: it
   * must outlive the workspace it describes.
   */
  async purgeOrganization(organizationId: string): Promise<string> {
    const [organization]: Array<{ deleted_at: Date | null }> = await this.dataSource.query(
      'SELECT deleted_at FROM organizations WHERE id = $1',
      [organizationId],
    );

    if (!organization?.deleted_at) return 'not deleted';
    if (
      Date.now() - new Date(organization.deleted_at).getTime() <
      this.config.organizationPurgeGraceMs
    ) {
      return 'within grace period';
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE knowledge_bases SET deleted_at = COALESCE(deleted_at, now())
          WHERE organization_id = $1`,
        [organizationId],
      );
      await manager.query(
        `UPDATE documents SET deleted_at = COALESCE(deleted_at, now()), wrapped_data_key = NULL
          WHERE organization_id = $1`,
        [organizationId],
      );
      await manager.query('DELETE FROM document_chunks WHERE organization_id = $1', [
        organizationId,
      ]);
    });

    if (this.vectorStore.isConfigured) {
      await this.vectorStore.dropOrganization(organizationId);
    }
    let objects = 0;
    if (this.storage.isConfigured) {
      objects = await this.storage.deletePrefix(
        this.storage.organizationPrefix(organizationId),
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        'UPDATE documents SET purged_at = now() WHERE organization_id = $1 AND purged_at IS NULL',
        [organizationId],
      );
      await manager.query(
        'UPDATE knowledge_bases SET purged_at = now() WHERE organization_id = $1 AND purged_at IS NULL',
        [organizationId],
      );
    });

    await this.auditService.recordSafe({
      action: AuditAction.DOCUMENT_PURGED,
      organizationId,
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: { objectsDeleted: objects },
    });

    return 'purged';
  }

  /** Brings a reclassified document's vector payloads in line with PostgreSQL. */
  async syncDocumentVectors(organizationId: string, documentId: string): Promise<string> {
    const [document]: Array<{ classification: string; vector_sync_required: boolean }> =
      await this.dataSource.query(
        `SELECT classification, vector_sync_required FROM documents
          WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [documentId, organizationId],
      );

    if (!document?.vector_sync_required) return 'nothing to do';

    if (this.vectorStore.isConfigured) {
      await this.vectorStore.setDocumentClassification(
        organizationId,
        documentId,
        document.classification,
      );
    }

    // Conditional on the classification we just wrote: if it changed again in
    // the meantime, the flag stays set and the next run picks up the new value.
    await this.dataSource.query(
      `UPDATE documents SET vector_sync_required = false
        WHERE id = $1 AND classification = $2`,
      [documentId, document.classification],
    );

    return 'synced';
  }
}
