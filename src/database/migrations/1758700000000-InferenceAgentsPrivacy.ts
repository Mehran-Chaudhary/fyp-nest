import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 schema: the PII and model policies, the usage ledger, agents and
 * their immutable versions, conversations and messages.
 *
 * Hand-written, like the earlier migrations, for what decorators cannot say:
 * CHECK constraints on every enumerated column, partial and expression
 * indexes, an exactly-one-owner constraint on conversations, and an
 * append-only trigger on agent versions.
 */
export class InferenceAgentsPrivacy1758700000000 implements MigrationInterface {
  name = 'InferenceAgentsPrivacy1758700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const classification = `('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')`;

    // ── pii_policies ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "pii_policies" (
        "organization_id"        uuid        NOT NULL,
        "created_at"             timestamptz NOT NULL DEFAULT now(),
        "updated_at"             timestamptz NOT NULL DEFAULT now(),
        "version"                integer     NOT NULL DEFAULT 1,
        "enabled"                boolean     NOT NULL DEFAULT true,
        "entity_types"           jsonb       NOT NULL,
        "score_threshold"        real        NOT NULL,
        "on_detector_failure"    varchar(24) NOT NULL,
        "language"               varchar(8)  NOT NULL,
        "allow_list_ciphertext"  text,
        "deny_list_ciphertext"   text,
        "updated_by_id"          uuid,
        CONSTRAINT "pk_pii_policies" PRIMARY KEY ("organization_id"),
        CONSTRAINT "fk_pii_policies_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_pii_policies_updated_by" FOREIGN KEY ("updated_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_pii_policies_failure_mode"
          CHECK ("on_detector_failure" IN ('REFUSE','DEGRADE_TO_PATTERNS')),
        CONSTRAINT "chk_pii_policies_threshold" CHECK ("score_threshold" BETWEEN 0 AND 1),
        CONSTRAINT "chk_pii_policies_types" CHECK (jsonb_typeof("entity_types") = 'array')
      )
    `);

    // ── llm_policies ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "llm_policies" (
        "organization_id"     uuid         NOT NULL,
        "created_at"          timestamptz  NOT NULL DEFAULT now(),
        "updated_at"          timestamptz  NOT NULL DEFAULT now(),
        "version"             integer      NOT NULL DEFAULT 1,
        "allowed_models"      jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "default_model"       varchar(200),
        "max_output_tokens"   integer,
        "max_context_tokens"  integer,
        "updated_by_id"       uuid,
        CONSTRAINT "pk_llm_policies" PRIMARY KEY ("organization_id"),
        CONSTRAINT "fk_llm_policies_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_llm_policies_updated_by" FOREIGN KEY ("updated_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_llm_policies_models" CHECK (jsonb_typeof("allowed_models") = 'array'),
        CONSTRAINT "chk_llm_policies_limits" CHECK (
          ("max_output_tokens" IS NULL OR "max_output_tokens" >= 16)
          AND ("max_context_tokens" IS NULL OR "max_context_tokens" >= 512)
        )
      )
    `);

    // ── llm_invocations (usage ledger; no content, no FKs to agents) ────────
    await queryRunner.query(`
      CREATE TABLE "llm_invocations" (
        "id"                  uuid          NOT NULL,
        "created_at"          timestamptz   NOT NULL DEFAULT now(),
        "organization_id"     uuid          NOT NULL,
        "purpose"             varchar(16)   NOT NULL,
        "status"              varchar(16)   NOT NULL,
        "user_id"             uuid,
        "api_key_id"          uuid,
        "agent_id"            uuid,
        "agent_version"       integer,
        "conversation_id"     uuid,
        "message_id"          uuid,
        "provider"            varchar(16)   NOT NULL,
        "model"               varchar(200)  NOT NULL,
        "error_code"          varchar(64),
        "finish_reason"       varchar(32),
        "prompt_tokens"       integer       NOT NULL DEFAULT 0,
        "completion_tokens"   integer       NOT NULL DEFAULT 0,
        "tokens_estimated"    boolean       NOT NULL DEFAULT false,
        "streamed"            boolean       NOT NULL DEFAULT false,
        "total_ms"            integer,
        "ttft_ms"             integer,
        "queue_ms"            integer,
        "retrieval_ms"        integer,
        "redaction_ms"        numeric(10,2),
        "entities_masked"     integer       NOT NULL DEFAULT 0,
        "redaction_degraded"  boolean       NOT NULL DEFAULT false,
        "metrics"             jsonb         NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "pk_llm_invocations" PRIMARY KEY ("id"),
        CONSTRAINT "fk_llm_invocations_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_llm_invocations_purpose" CHECK ("purpose" IN ('AGENT_TURN','DIRECT_CHAT')),
        CONSTRAINT "chk_llm_invocations_status"
          CHECK ("status" IN ('COMPLETED','CANCELLED','FAILED','REFUSED','BLOCKED')),
        CONSTRAINT "chk_llm_invocations_tokens"
          CHECK ("prompt_tokens" >= 0 AND "completion_tokens" >= 0 AND "entities_masked" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_llm_invocations_org_created"
        ON "llm_invocations" ("organization_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_llm_invocations_org_agent"
        ON "llm_invocations" ("organization_id", "agent_id", "created_at" DESC)
        WHERE "agent_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_llm_invocations_org_user"
        ON "llm_invocations" ("organization_id", "user_id", "created_at" DESC)
        WHERE "user_id" IS NOT NULL
    `);

    // ── agents ──────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "agents" (
        "id"               uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       timestamptz  NOT NULL DEFAULT now(),
        "updated_at"       timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"       timestamptz,
        "organization_id"  uuid         NOT NULL,
        "name"             varchar(80)  NOT NULL,
        "description"      text,
        "visibility"       varchar(16)  NOT NULL DEFAULT 'PRIVATE',
        "access_mode"      varchar(16)  NOT NULL DEFAULT 'WORKSPACE',
        "current_version"  integer      NOT NULL DEFAULT 1,
        "created_by_id"    uuid,
        "published_at"     timestamptz,
        "published_by_id"  uuid,
        "last_used_at"     timestamptz,
        CONSTRAINT "pk_agents" PRIMARY KEY ("id"),
        CONSTRAINT "fk_agents_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_agents_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_agents_published_by" FOREIGN KEY ("published_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_agents_visibility" CHECK ("visibility" IN ('PRIVATE','WORKSPACE')),
        CONSTRAINT "chk_agents_access_mode" CHECK ("access_mode" IN ('WORKSPACE','RESTRICTED')),
        CONSTRAINT "chk_agents_version" CHECK ("current_version" >= 1)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_agents_org_name"
        ON "agents" ("organization_id", lower("name")) WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_agents_org" ON "agents" ("organization_id") WHERE "deleted_at" IS NULL
    `);

    // ── agent_allowed_roles ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "agent_allowed_roles" (
        "agent_id"  uuid NOT NULL,
        "role_id"   uuid NOT NULL,
        CONSTRAINT "pk_agent_allowed_roles" PRIMARY KEY ("agent_id", "role_id"),
        CONSTRAINT "fk_agent_allowed_roles_agent" FOREIGN KEY ("agent_id")
          REFERENCES "agents"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_agent_allowed_roles_role" FOREIGN KEY ("role_id")
          REFERENCES "roles"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_agent_allowed_roles_role" ON "agent_allowed_roles" ("role_id")`,
    );

    // ── agent_versions (append-only) ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "agent_versions" (
        "id"                       uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"               timestamptz  NOT NULL DEFAULT now(),
        "organization_id"          uuid         NOT NULL,
        "agent_id"                 uuid         NOT NULL,
        "version"                  integer      NOT NULL,
        "config"                   jsonb        NOT NULL,
        "instructions_ciphertext"  text         NOT NULL,
        "config_digest"            varchar(64)  NOT NULL,
        "change_note"              varchar(500),
        "restored_from_version"    integer,
        "created_by_id"            uuid,
        CONSTRAINT "pk_agent_versions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_agent_versions_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_agent_versions_agent" FOREIGN KEY ("agent_id")
          REFERENCES "agents"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_agent_versions_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_agent_versions_version" CHECK ("version" >= 1),
        CONSTRAINT "chk_agent_versions_restored"
          CHECK ("restored_from_version" IS NULL OR "restored_from_version" < "version")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_agent_versions_agent_version"
        ON "agent_versions" ("agent_id", "version")
    `);
    // History is evidence: a version, once written, is never edited. Deletion
    // remains possible only through the cascade from its agent's workspace.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "daiap_prevent_agent_version_update"() RETURNS trigger AS $BODY$
      BEGIN
        RAISE EXCEPTION 'agent_versions is append-only (agent %, version %)',
          OLD."agent_id", OLD."version"
          USING ERRCODE = 'restrict_violation';
      END;
      $BODY$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_agent_versions_no_update"
        BEFORE UPDATE ON "agent_versions"
        FOR EACH ROW EXECUTE FUNCTION "daiap_prevent_agent_version_update"()
    `);

    // ── conversations ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id"                    uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"            timestamptz  NOT NULL DEFAULT now(),
        "updated_at"            timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"            timestamptz,
        "organization_id"       uuid         NOT NULL,
        "agent_id"              uuid         NOT NULL,
        "user_id"               uuid,
        "api_key_id"            uuid,
        "title_ciphertext"      text,
        "wrapped_data_key"      text,
        "status"                varchar(16)  NOT NULL DEFAULT 'ACTIVE',
        "message_count"         integer      NOT NULL DEFAULT 0,
        "last_message_at"       timestamptz,
        "classification"        varchar(16)  NOT NULL DEFAULT 'PUBLIC',
        "knowledge_base_ids"    jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "turn_lock_id"          uuid,
        "turn_lock_expires_at"  timestamptz,
        "prompt_tokens"         bigint       NOT NULL DEFAULT 0,
        "completion_tokens"     bigint       NOT NULL DEFAULT 0,
        CONSTRAINT "pk_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "fk_conversations_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_conversations_agent" FOREIGN KEY ("agent_id")
          REFERENCES "agents"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_conversations_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_conversations_api_key" FOREIGN KEY ("api_key_id")
          REFERENCES "api_keys"("id") ON DELETE CASCADE,
        -- Exactly one owner: a person or a machine credential, never both or neither.
        CONSTRAINT "chk_conversations_one_owner" CHECK (num_nonnulls("user_id", "api_key_id") = 1),
        CONSTRAINT "chk_conversations_status" CHECK ("status" IN ('ACTIVE','ARCHIVED')),
        CONSTRAINT "chk_conversations_classification" CHECK ("classification" IN ${classification}),
        CONSTRAINT "chk_conversations_counts"
          CHECK ("message_count" >= 0 AND "prompt_tokens" >= 0 AND "completion_tokens" >= 0),
        -- A live conversation always has its key; only a deleted one may be shredded.
        CONSTRAINT "chk_conversations_key_present"
          CHECK ("wrapped_data_key" IS NOT NULL OR "deleted_at" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conversations_org_user_recent"
        ON "conversations" ("organization_id", "user_id", "last_message_at" DESC NULLS LAST)
        WHERE "deleted_at" IS NULL AND "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conversations_org_key_recent"
        ON "conversations" ("organization_id", "api_key_id", "last_message_at" DESC NULLS LAST)
        WHERE "deleted_at" IS NULL AND "api_key_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conversations_org_recent"
        ON "conversations" ("organization_id", "last_message_at" DESC NULLS LAST)
        WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conversations_org_agent"
        ON "conversations" ("organization_id", "agent_id") WHERE "deleted_at" IS NULL
    `);

    // ── conversation_messages ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "conversation_messages" (
        "id"                        uuid          NOT NULL,
        "created_at"                timestamptz   NOT NULL DEFAULT now(),
        "organization_id"           uuid          NOT NULL,
        "conversation_id"           uuid          NOT NULL,
        "sequence"                  integer       NOT NULL,
        "role"                      varchar(16)   NOT NULL,
        "status"                    varchar(16)   NOT NULL,
        "content_ciphertext"        text,
        "char_count"                integer       NOT NULL DEFAULT 0,
        "token_count"               integer       NOT NULL DEFAULT 0,
        "classification"            varchar(16)   NOT NULL,
        "knowledge_base_ids"        jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "document_ids"              jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "citations"                 jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "agent_version"             integer,
        "prompt_template_version"   integer,
        "model"                     varchar(200),
        "invocation_id"             uuid,
        "retrieval_id"              uuid,
        "redaction"                 jsonb         NOT NULL DEFAULT '{}'::jsonb,
        "error_code"                varchar(64),
        "client_message_id"         uuid,
        CONSTRAINT "pk_conversation_messages" PRIMARY KEY ("id"),
        CONSTRAINT "fk_conversation_messages_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_conversation_messages_conversation" FOREIGN KEY ("conversation_id")
          REFERENCES "conversations"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_conversation_messages_role" CHECK ("role" IN ('USER','ASSISTANT')),
        CONSTRAINT "chk_conversation_messages_status"
          CHECK ("status" IN ('COMPLETE','CANCELLED','FAILED')),
        CONSTRAINT "chk_conversation_messages_classification"
          CHECK ("classification" IN ${classification}),
        CONSTRAINT "chk_conversation_messages_counts"
          CHECK ("sequence" >= 1 AND "char_count" >= 0 AND "token_count" >= 0),
        -- A complete message always has content; only a failed one may have none.
        CONSTRAINT "chk_conversation_messages_content"
          CHECK ("content_ciphertext" IS NOT NULL OR "status" <> 'COMPLETE')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_conversation_messages_sequence"
        ON "conversation_messages" ("conversation_id", "sequence")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_conversation_messages_client_id"
        ON "conversation_messages" ("conversation_id", "client_message_id")
        WHERE "client_message_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conversation_messages_organization"
        ON "conversation_messages" ("organization_id")
    `);

    // ── updated_at maintenance (function from the initial migration) ───────
    for (const table of ['pii_policies', 'llm_policies', 'agents', 'conversations']) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_touch_updated_at"
          BEFORE UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "daiap_touch_updated_at"()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['conversations', 'agents', 'llm_policies', 'pii_policies']) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "trg_${table}_touch_updated_at" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_agent_versions_no_update" ON "agent_versions"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "daiap_prevent_agent_version_update"()`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_allowed_roles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_invocations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_policies"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pii_policies"`);
  }
}
