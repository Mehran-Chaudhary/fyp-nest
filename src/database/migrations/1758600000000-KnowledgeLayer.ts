import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 schema: knowledge bases, their access grants, documents and chunks.
 *
 * Hand-written, like the initial migration, for the constructs decorators
 * cannot express: partial and expression unique indexes, CHECK constraints on
 * every enumerated column, and an exactly-one-subject constraint on grants.
 *
 * Everything here is tenant-scoped with a non-null `organization_id`, following
 * the discriminator strategy of ADR 0001.
 */
export class KnowledgeLayer1758600000000 implements MigrationInterface {
  name = 'KnowledgeLayer1758600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── knowledge_bases ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "knowledge_bases" (
        "id"                      uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"              timestamptz  NOT NULL DEFAULT now(),
        "updated_at"              timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"              timestamptz,
        "version"                 integer      NOT NULL DEFAULT 1,
        "organization_id"         uuid         NOT NULL,
        "name"                    varchar(120) NOT NULL,
        "description"             text,
        "access_mode"             varchar(16)  NOT NULL DEFAULT 'WORKSPACE',
        "default_classification"  varchar(16)  NOT NULL DEFAULT 'INTERNAL',
        "embedding_model"         varchar(128) NOT NULL,
        "embedding_dimensions"    integer      NOT NULL,
        "chunk_size"              integer,
        "chunk_overlap"           integer,
        "created_by_id"           uuid,
        "purged_at"               timestamptz,
        CONSTRAINT "pk_knowledge_bases" PRIMARY KEY ("id"),
        CONSTRAINT "fk_knowledge_bases_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_knowledge_bases_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_knowledge_bases_access_mode"
          CHECK ("access_mode" IN ('WORKSPACE','RESTRICTED')),
        CONSTRAINT "chk_knowledge_bases_classification"
          CHECK ("default_classification" IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
        CONSTRAINT "chk_knowledge_bases_dimensions"
          CHECK ("embedding_dimensions" BETWEEN 1 AND 65536),
        CONSTRAINT "chk_knowledge_bases_chunk_size"
          CHECK ("chunk_size" IS NULL OR "chunk_size" BETWEEN 64 AND 4096),
        CONSTRAINT "chk_knowledge_bases_chunk_overlap"
          CHECK ("chunk_overlap" IS NULL OR ("chunk_overlap" >= 0 AND "chunk_overlap" <= 1024))
      )
    `);
    // Names are unique per workspace, case-insensitively, among live bases.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_knowledge_bases_org_name"
        ON "knowledge_bases" ("organization_id", lower("name")) WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_knowledge_bases_org"
        ON "knowledge_bases" ("organization_id") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_knowledge_bases_unpurged"
        ON "knowledge_bases" ("deleted_at") WHERE "deleted_at" IS NOT NULL AND "purged_at" IS NULL
    `);

    // ── knowledge_base_grants ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "knowledge_base_grants" (
        "id"                 uuid        NOT NULL DEFAULT gen_random_uuid(),
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        "organization_id"    uuid        NOT NULL,
        "knowledge_base_id"  uuid        NOT NULL,
        "role_id"            uuid,
        "member_id"          uuid,
        "api_key_id"         uuid,
        "access_level"       varchar(16) NOT NULL,
        "granted_by_id"      uuid,
        CONSTRAINT "pk_knowledge_base_grants" PRIMARY KEY ("id"),
        CONSTRAINT "fk_kb_grants_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_kb_grants_knowledge_base" FOREIGN KEY ("knowledge_base_id")
          REFERENCES "knowledge_bases"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_kb_grants_role" FOREIGN KEY ("role_id")
          REFERENCES "roles"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_kb_grants_member" FOREIGN KEY ("member_id")
          REFERENCES "organization_members"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_kb_grants_api_key" FOREIGN KEY ("api_key_id")
          REFERENCES "api_keys"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_kb_grants_granted_by" FOREIGN KEY ("granted_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        -- A grant names exactly one subject. Enforced here so no code path,
        -- present or future, can write an ambiguous one.
        CONSTRAINT "chk_kb_grants_one_subject"
          CHECK (num_nonnulls("role_id", "member_id", "api_key_id") = 1),
        CONSTRAINT "chk_kb_grants_access_level"
          CHECK ("access_level" IN ('READ','WRITE','MANAGE'))
      )
    `);
    for (const column of ['role_id', 'member_id', 'api_key_id']) {
      await queryRunner.query(`
        CREATE UNIQUE INDEX "uq_kb_grants_${column}"
          ON "knowledge_base_grants" ("knowledge_base_id", "${column}") WHERE "${column}" IS NOT NULL
      `);
      await queryRunner.query(`
        CREATE INDEX "idx_kb_grants_${column}"
          ON "knowledge_base_grants" ("${column}") WHERE "${column}" IS NOT NULL
      `);
    }
    await queryRunner.query(
      `CREATE INDEX "idx_kb_grants_organization" ON "knowledge_base_grants" ("organization_id")`,
    );

    // ── documents ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id"                       uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"               timestamptz  NOT NULL DEFAULT now(),
        "updated_at"               timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"               timestamptz,
        "organization_id"          uuid         NOT NULL,
        "knowledge_base_id"        uuid         NOT NULL,
        "title"                    varchar(255) NOT NULL,
        "description"              text,
        "tags"                     jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "original_filename"        varchar(255) NOT NULL,
        "file_type"                varchar(16)  NOT NULL,
        "mime_type"                varchar(127) NOT NULL,
        "size_bytes"               bigint       NOT NULL,
        "content_fingerprint"      varchar(64)  NOT NULL,
        "storage_key"              varchar(512) NOT NULL,
        "wrapped_data_key"         text,
        "classification"           varchar(16)  NOT NULL,
        "status"                   varchar(16)  NOT NULL DEFAULT 'UPLOADED',
        "status_message"           varchar(500),
        "failure_code"             varchar(64),
        "last_status_at"           timestamptz  NOT NULL DEFAULT now(),
        "index_version"            integer      NOT NULL DEFAULT 1,
        "active_index_version"     integer,
        "chunk_count"              integer      NOT NULL DEFAULT 0,
        "token_count"              integer      NOT NULL DEFAULT 0,
        "page_count"               integer,
        "language"                 varchar(16),
        "parser"                   varchar(64),
        "embedding_model"          varchar(128),
        "attempts"                 integer      NOT NULL DEFAULT 0,
        "processing_metrics"       jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "processing_started_at"    timestamptz,
        "processing_completed_at"  timestamptz,
        "enqueued_at"              timestamptz,
        "vector_sync_required"     boolean      NOT NULL DEFAULT false,
        "purged_at"                timestamptz,
        "uploaded_by_id"           uuid,
        "uploaded_by_api_key_id"   uuid,
        CONSTRAINT "pk_documents" PRIMARY KEY ("id"),
        CONSTRAINT "fk_documents_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_documents_knowledge_base" FOREIGN KEY ("knowledge_base_id")
          REFERENCES "knowledge_bases"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_documents_uploaded_by" FOREIGN KEY ("uploaded_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_documents_uploaded_by_api_key" FOREIGN KEY ("uploaded_by_api_key_id")
          REFERENCES "api_keys"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_documents_status"
          CHECK ("status" IN ('UPLOADED','PARSING','CHUNKING','EMBEDDING','READY','FAILED')),
        CONSTRAINT "chk_documents_classification"
          CHECK ("classification" IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
        CONSTRAINT "chk_documents_file_type"
          CHECK ("file_type" IN ('PDF','DOCX','TXT','MARKDOWN')),
        CONSTRAINT "chk_documents_size" CHECK ("size_bytes" > 0),
        CONSTRAINT "chk_documents_versions" CHECK (
          "index_version" >= 1
          AND ("active_index_version" IS NULL OR "active_index_version" BETWEEN 1 AND "index_version")
        ),
        CONSTRAINT "chk_documents_counts" CHECK (
          "chunk_count" >= 0 AND "token_count" >= 0 AND "attempts" >= 0
        ),
        -- A live document always has a key; only a deleted one may have been shredded.
        CONSTRAINT "chk_documents_key_present"
          CHECK ("wrapped_data_key" IS NOT NULL OR "deleted_at" IS NOT NULL)
      )
    `);
    // The same file cannot be uploaded twice into one base (keyed fingerprint).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_documents_kb_fingerprint"
        ON "documents" ("knowledge_base_id", "content_fingerprint") WHERE "deleted_at" IS NULL
    `);
    // The Document Vault's main listing, newest first.
    await queryRunner.query(`
      CREATE INDEX "idx_documents_org_kb_created"
        ON "documents" ("organization_id", "knowledge_base_id", "created_at" DESC)
        WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_documents_org_created"
        ON "documents" ("organization_id", "created_at" DESC) WHERE "deleted_at" IS NULL
    `);
    // The maintenance sweep: in-flight work, outstanding purges and syncs. Each
    // qualifies a tiny fraction of rows, so partial indexes stay small.
    await queryRunner.query(`
      CREATE INDEX "idx_documents_in_flight"
        ON "documents" ("status", "last_status_at")
        WHERE "deleted_at" IS NULL AND "status" IN ('UPLOADED','PARSING','CHUNKING','EMBEDDING')
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_documents_unpurged"
        ON "documents" ("deleted_at") WHERE "deleted_at" IS NOT NULL AND "purged_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_documents_vector_sync"
        ON "documents" ("updated_at") WHERE "vector_sync_required" = true AND "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_documents_title_trgm"
        ON "documents" USING gin ("title" gin_trgm_ops) WHERE "deleted_at" IS NULL
    `);

    // ── document_chunks ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "document_chunks" (
        "id"                  uuid        NOT NULL,
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now(),
        "organization_id"     uuid        NOT NULL,
        "document_id"         uuid        NOT NULL,
        "index_version"       integer     NOT NULL,
        "chunk_index"         integer     NOT NULL,
        "content_ciphertext"  text        NOT NULL,
        "token_count"         integer     NOT NULL DEFAULT 0,
        "char_count"          integer     NOT NULL DEFAULT 0,
        "page_start"          integer,
        "page_end"            integer,
        "embedded_at"         timestamptz,
        CONSTRAINT "pk_document_chunks" PRIMARY KEY ("id"),
        CONSTRAINT "fk_document_chunks_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_document_chunks_document" FOREIGN KEY ("document_id")
          REFERENCES "documents"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_document_chunks_position" CHECK (
          "index_version" >= 1 AND "chunk_index" >= 0 AND "token_count" >= 0 AND "char_count" >= 0
        ),
        CONSTRAINT "chk_document_chunks_pages"
          CHECK ("page_start" IS NULL OR "page_end" IS NULL OR "page_end" >= "page_start")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_document_chunks_position"
        ON "document_chunks" ("document_id", "index_version", "chunk_index")
    `);
    // Resume point after a crash: the chunks of a version not yet embedded.
    await queryRunner.query(`
      CREATE INDEX "idx_document_chunks_pending"
        ON "document_chunks" ("document_id", "index_version", "chunk_index")
        WHERE "embedded_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_document_chunks_organization" ON "document_chunks" ("organization_id")`,
    );

    // ── updated_at maintenance (function created by the initial migration) ─
    for (const table of [
      'knowledge_bases',
      'knowledge_base_grants',
      'documents',
      'document_chunks',
    ]) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_touch_updated_at"
          BEFORE UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "daiap_touch_updated_at"()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'document_chunks',
      'documents',
      'knowledge_base_grants',
      'knowledge_bases',
    ]) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "trg_${table}_touch_updated_at" ON "${table}"`,
      );
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "document_chunks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "documents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_base_grants"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_bases"`);
  }
}
