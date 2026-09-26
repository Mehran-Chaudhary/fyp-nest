import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 schema: tools and the tool ledger; workflows, their append-only
 * versions, runs and steps; and the columns earlier tables need to take part
 * (workflow attribution in the usage ledger, integrity and tool calls on
 * conversation messages).
 *
 * Hand-written, like every earlier migration, for what decorators cannot say:
 * CHECK constraints on every enumerated column, partial and expression
 * indexes, exactly one initiator per run, a run key that may be missing only
 * once the run is deleted, and an append-only trigger on workflow versions.
 */
export class OrchestrationToolsRealtime1758800000000 implements MigrationInterface {
  name = 'OrchestrationToolsRealtime1758800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const classification = `('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')`;
    const integrity = `('TRUSTED','INTERNAL','EXTERNAL')`;

    // ── tools ───────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "tools" (
        "id"                  uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"          timestamptz  NOT NULL DEFAULT now(),
        "updated_at"          timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"          timestamptz,
        "organization_id"     uuid         NOT NULL,
        "name"                varchar(48)  NOT NULL,
        "display_name"        varchar(80)  NOT NULL,
        "description"         text         NOT NULL,
        "kind"                varchar(16)  NOT NULL,
        "parameters"          jsonb        NOT NULL,
        "config"              jsonb        NOT NULL,
        "data_policy"         jsonb        NOT NULL,
        "requires_approval"   boolean      NOT NULL DEFAULT false,
        "timeout_ms"          integer      NOT NULL,
        "enabled"             boolean      NOT NULL DEFAULT true,
        "version"             integer      NOT NULL DEFAULT 1,
        "definition_digest"   varchar(64)  NOT NULL,
        "secret_ciphertext"   text,
        "has_secret"          boolean      NOT NULL DEFAULT false,
        "created_by_id"       uuid,
        "updated_by_id"       uuid,
        CONSTRAINT "pk_tools" PRIMARY KEY ("id"),
        CONSTRAINT "fk_tools_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_tools_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_tools_updated_by" FOREIGN KEY ("updated_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_tools_kind" CHECK ("kind" IN ('HTTP')),
        CONSTRAINT "chk_tools_name" CHECK ("name" ~ '^[a-z][a-z0-9_]{2,47}$'),
        CONSTRAINT "chk_tools_timeout" CHECK ("timeout_ms" BETWEEN 500 AND 600000),
        CONSTRAINT "chk_tools_version" CHECK ("version" >= 1),
        CONSTRAINT "chk_tools_json" CHECK (
          jsonb_typeof("parameters") = 'object' AND jsonb_typeof("config") = 'object'
          AND jsonb_typeof("data_policy") = 'object'
        ),
        -- The secret flag and the ciphertext agree.
        CONSTRAINT "chk_tools_secret" CHECK (("secret_ciphertext" IS NOT NULL) = "has_secret")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_tools_org_name"
        ON "tools" ("organization_id", "name") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tools_org" ON "tools" ("organization_id") WHERE "deleted_at" IS NULL
    `);

    // ── tool_executions (the ledger; no content, no foreign keys) ──────────
    await queryRunner.query(`
      CREATE TABLE "tool_executions" (
        "id"                      uuid         NOT NULL,
        "created_at"              timestamptz  NOT NULL DEFAULT now(),
        "completed_at"            timestamptz,
        "organization_id"         uuid         NOT NULL,
        "tool_id"                 uuid,
        "tool_name"               varchar(48)  NOT NULL,
        "tool_kind"               varchar(16),
        "tool_version"            integer,
        "definition_digest"       varchar(64),
        "status"                  varchar(16)  NOT NULL,
        "denial_reason"           varchar(24),
        "error_code"              varchar(64),
        "user_id"                 uuid,
        "api_key_id"              uuid,
        "agent_id"                uuid,
        "agent_version"           integer,
        "conversation_id"         uuid,
        "workflow_run_id"         uuid,
        "workflow_step_id"        uuid,
        "iteration"               smallint,
        "arguments_digest"        varchar(64),
        "result_bytes"            integer      NOT NULL DEFAULT 0,
        "result_truncated"        boolean      NOT NULL DEFAULT false,
        "duration_ms"             integer,
        "context_classification"  varchar(16),
        "context_integrity"       varchar(16),
        "side_effects"            boolean      NOT NULL DEFAULT false,
        "metadata"                jsonb        NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "pk_tool_executions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_tool_executions_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_tool_executions_status"
          CHECK ("status" IN ('RUNNING','SUCCEEDED','FAILED','TIMED_OUT','DENIED')),
        CONSTRAINT "chk_tool_executions_denial" CHECK (
          "denial_reason" IS NULL OR "denial_reason" IN (
            'NOT_GRANTED','DISABLED','PERMISSION','ARGUMENTS','CONFIDENTIALITY','INTEGRITY',
            'PII','EGRESS','APPROVAL','CALL_LIMIT','RECIPIENT','DUPLICATE')
        ),
        CONSTRAINT "chk_tool_executions_counts"
          CHECK ("result_bytes" >= 0 AND ("duration_ms" IS NULL OR "duration_ms" >= 0))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tool_executions_org_created"
        ON "tool_executions" ("organization_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tool_executions_run"
        ON "tool_executions" ("workflow_run_id", "tool_id") WHERE "workflow_run_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tool_executions_org_tool"
        ON "tool_executions" ("organization_id", "tool_id", "created_at" DESC)
    `);

    // ── workflows ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "workflows" (
        "id"                 uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"         timestamptz  NOT NULL DEFAULT now(),
        "updated_at"         timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"         timestamptz,
        "organization_id"    uuid         NOT NULL,
        "name"               varchar(80)  NOT NULL,
        "description"        text,
        "status"             varchar(16)  NOT NULL DEFAULT 'DRAFT',
        "current_version"    integer      NOT NULL DEFAULT 1,
        "published_version"  integer,
        "created_by_id"      uuid,
        "published_by_id"    uuid,
        "published_at"       timestamptz,
        "last_run_at"        timestamptz,
        CONSTRAINT "pk_workflows" PRIMARY KEY ("id"),
        CONSTRAINT "fk_workflows_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_workflows_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_workflows_published_by" FOREIGN KEY ("published_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_workflows_status" CHECK ("status" IN ('DRAFT','ACTIVE','ARCHIVED')),
        CONSTRAINT "chk_workflows_versions" CHECK (
          "current_version" >= 1
          AND ("published_version" IS NULL OR "published_version" BETWEEN 1 AND "current_version")
        ),
        -- Active means a version is published.
        CONSTRAINT "chk_workflows_active_published"
          CHECK ("status" <> 'ACTIVE' OR "published_version" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_workflows_org_name"
        ON "workflows" ("organization_id", lower("name")) WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflows_org" ON "workflows" ("organization_id") WHERE "deleted_at" IS NULL
    `);

    // ── workflow_versions (append-only) ────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "workflow_versions" (
        "id"                     uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"             timestamptz  NOT NULL DEFAULT now(),
        "organization_id"        uuid         NOT NULL,
        "workflow_id"            uuid         NOT NULL,
        "version"                integer      NOT NULL,
        "graph"                  jsonb        NOT NULL,
        "settings"               jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "digest"                 varchar(64)  NOT NULL,
        "valid"                  boolean      NOT NULL,
        "validation"             jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "change_note"            varchar(500),
        "restored_from_version"  integer,
        "created_by_id"          uuid,
        CONSTRAINT "pk_workflow_versions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_workflow_versions_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_workflow_versions_workflow" FOREIGN KEY ("workflow_id")
          REFERENCES "workflows"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_workflow_versions_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_workflow_versions_version" CHECK ("version" >= 1),
        CONSTRAINT "chk_workflow_versions_restored"
          CHECK ("restored_from_version" IS NULL OR "restored_from_version" < "version"),
        CONSTRAINT "chk_workflow_versions_json"
          CHECK (jsonb_typeof("graph") = 'object' AND jsonb_typeof("settings") = 'object')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_workflow_versions_workflow_version"
        ON "workflow_versions" ("workflow_id", "version")
    `);
    // A version is evidence of what ran: never edited after the fact.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "daiap_prevent_workflow_version_update"() RETURNS trigger AS $BODY$
      BEGIN
        RAISE EXCEPTION 'workflow_versions is append-only (workflow %, version %)',
          OLD."workflow_id", OLD."version"
          USING ERRCODE = 'restrict_violation';
      END;
      $BODY$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_workflow_versions_no_update"
        BEFORE UPDATE ON "workflow_versions"
        FOR EACH ROW EXECUTE FUNCTION "daiap_prevent_workflow_version_update"()
    `);

    // ── workflow_runs ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "workflow_runs" (
        "id"                       uuid         NOT NULL,
        "created_at"               timestamptz  NOT NULL DEFAULT now(),
        "updated_at"               timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"               timestamptz,
        "organization_id"          uuid         NOT NULL,
        "workflow_id"              uuid         NOT NULL,
        "workflow_version"         integer      NOT NULL,
        "status"                   varchar(20)  NOT NULL,
        "trigger"                  varchar(16)  NOT NULL,
        "initiator_user_id"        uuid,
        "initiator_api_key_id"     uuid,
        "initiator_membership_id"  uuid,
        "idempotency_key"          varchar(128),
        "wrapped_data_key"         text,
        "input_ciphertext"         text,
        "input_bytes"              integer      NOT NULL DEFAULT 0,
        "output_ciphertext"        text,
        "output_bytes"             integer      NOT NULL DEFAULT 0,
        "classification"           varchar(16)  NOT NULL DEFAULT 'PUBLIC',
        "knowledge_base_ids"       jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "document_ids"             jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "integrity"                varchar(16)  NOT NULL DEFAULT 'TRUSTED',
        "max_steps"                integer      NOT NULL,
        "steps_scheduled"          integer      NOT NULL DEFAULT 0,
        "max_tokens"               integer      NOT NULL,
        "tokens_used"              bigint       NOT NULL DEFAULT 0,
        "tool_calls"               integer      NOT NULL DEFAULT 0,
        "error_code"               varchar(64),
        "error_step_id"            uuid,
        "started_at"               timestamptz,
        "completed_at"             timestamptz,
        "deadline_at"              timestamptz  NOT NULL,
        "cancel_requested_at"      timestamptz,
        "cancelled_by_id"          uuid,
        "request_id"               varchar(128),
        CONSTRAINT "pk_workflow_runs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_workflow_runs_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_workflow_runs_workflow" FOREIGN KEY ("workflow_id")
          REFERENCES "workflows"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_workflow_runs_status" CHECK ("status" IN
          ('QUEUED','RUNNING','WAITING_APPROVAL','COMPLETED','FAILED','CANCELLED','TIMED_OUT')),
        CONSTRAINT "chk_workflow_runs_trigger" CHECK ("trigger" IN ('MANUAL','API')),
        -- Exactly one initiator: a person or a machine credential.
        CONSTRAINT "chk_workflow_runs_one_initiator"
          CHECK (num_nonnulls("initiator_user_id", "initiator_api_key_id") = 1),
        CONSTRAINT "chk_workflow_runs_classification" CHECK ("classification" IN ${classification}),
        CONSTRAINT "chk_workflow_runs_integrity" CHECK ("integrity" IN ${integrity}),
        CONSTRAINT "chk_workflow_runs_limits" CHECK (
          "max_steps" >= 1 AND "steps_scheduled" >= 0 AND "max_tokens" >= 1
          AND "tokens_used" >= 0 AND "tool_calls" >= 0 AND "workflow_version" >= 1
        ),
        -- A live run always has its key; only a deleted one may be shredded.
        CONSTRAINT "chk_workflow_runs_key_present"
          CHECK ("wrapped_data_key" IS NOT NULL OR "deleted_at" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_workflow_runs_idempotency"
        ON "workflow_runs" ("workflow_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_runs_org_created"
        ON "workflow_runs" ("organization_id", "created_at" DESC) WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_runs_org_user"
        ON "workflow_runs" ("organization_id", "initiator_user_id", "created_at" DESC)
        WHERE "deleted_at" IS NULL AND "initiator_user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_runs_org_key"
        ON "workflow_runs" ("organization_id", "initiator_api_key_id", "created_at" DESC)
        WHERE "deleted_at" IS NULL AND "initiator_api_key_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_runs_active"
        ON "workflow_runs" ("organization_id", "deadline_at")
        WHERE "status" IN ('QUEUED','RUNNING','WAITING_APPROVAL')
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_runs_workflow"
        ON "workflow_runs" ("workflow_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_runs_finished"
        ON "workflow_runs" ("completed_at")
        WHERE "deleted_at" IS NULL AND "status" IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT')
    `);

    // ── workflow_steps ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "workflow_steps" (
        "id"                  uuid         NOT NULL,
        "created_at"          timestamptz  NOT NULL DEFAULT now(),
        "updated_at"          timestamptz  NOT NULL DEFAULT now(),
        "organization_id"     uuid         NOT NULL,
        "run_id"              uuid         NOT NULL,
        "node_id"             varchar(64)  NOT NULL,
        "node_type"           varchar(16)  NOT NULL,
        "iteration"           integer      NOT NULL DEFAULT 0,
        "status"              varchar(20)  NOT NULL,
        "handles"             jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "predecessors"        jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "attempt"             integer      NOT NULL DEFAULT 0,
        "max_attempts"        integer      NOT NULL,
        "dispatch"            integer      NOT NULL DEFAULT 0,
        "input_ciphertext"    text,
        "input_bytes"         integer      NOT NULL DEFAULT 0,
        "output_ciphertext"   text,
        "output_bytes"        integer      NOT NULL DEFAULT 0,
        "classification"      varchar(16)  NOT NULL DEFAULT 'PUBLIC',
        "knowledge_base_ids"  jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "document_ids"        jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "integrity"           varchar(16)  NOT NULL DEFAULT 'TRUSTED',
        "agent_id"            uuid,
        "agent_version"       integer,
        "tool_id"             uuid,
        "tool_version"        integer,
        "model"               varchar(200),
        "prompt_tokens"       integer      NOT NULL DEFAULT 0,
        "completion_tokens"   integer      NOT NULL DEFAULT 0,
        "invocation_ids"      jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "tool_calls"          jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "approval"            jsonb,
        "error_code"          varchar(64),
        "failure_class"       varchar(16),
        "enqueued_at"         timestamptz,
        "next_attempt_at"     timestamptz,
        "first_attempt_at"    timestamptz,
        "started_at"          timestamptz,
        "heartbeat_at"        timestamptz,
        "completed_at"        timestamptz,
        "duration_ms"         integer,
        "dead_lettered_at"    timestamptz,
        CONSTRAINT "pk_workflow_steps" PRIMARY KEY ("id"),
        CONSTRAINT "fk_workflow_steps_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_workflow_steps_run" FOREIGN KEY ("run_id")
          REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_workflow_steps_status" CHECK ("status" IN
          ('QUEUED','RUNNING','WAITING_APPROVAL','SUCCEEDED','FAILED','SKIPPED','CANCELLED')),
        CONSTRAINT "chk_workflow_steps_node_type" CHECK ("node_type" IN
          ('trigger','agent','tool','retrieval','condition','supervisor','approval','output')),
        CONSTRAINT "chk_workflow_steps_failure_class" CHECK (
          "failure_class" IS NULL OR "failure_class" IN ('TRANSIENT','PERMANENT','TIMEOUT','POLICY')
        ),
        CONSTRAINT "chk_workflow_steps_classification" CHECK ("classification" IN ${classification}),
        CONSTRAINT "chk_workflow_steps_integrity" CHECK ("integrity" IN ${integrity}),
        CONSTRAINT "chk_workflow_steps_counts" CHECK (
          "iteration" >= 0 AND "attempt" >= 0 AND "max_attempts" >= 1 AND "dispatch" >= 0
          AND "prompt_tokens" >= 0 AND "completion_tokens" >= 0
          AND "input_bytes" >= 0 AND "output_bytes" >= 0
        ),
        CONSTRAINT "chk_workflow_steps_json" CHECK (
          jsonb_typeof("handles") = 'array' AND jsonb_typeof("predecessors") = 'array'
          AND jsonb_typeof("tool_calls") = 'array' AND jsonb_typeof("invocation_ids") = 'array'
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_workflow_steps_run_node_iteration"
        ON "workflow_steps" ("run_id", "node_id", "iteration")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_steps_pending"
        ON "workflow_steps" ("status", "next_attempt_at")
        WHERE "status" IN ('QUEUED','RUNNING','WAITING_APPROVAL')
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_workflow_steps_dead_letters"
        ON "workflow_steps" ("organization_id", "dead_lettered_at" DESC)
        WHERE "dead_lettered_at" IS NOT NULL
    `);

    // ── Earlier tables, extended ───────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "llm_invocations"
        ADD COLUMN "workflow_run_id" uuid,
        ADD COLUMN "workflow_step_id" uuid,
        ADD COLUMN "iteration" smallint
    `);
    await queryRunner.query(
      `ALTER TABLE "llm_invocations" DROP CONSTRAINT "chk_llm_invocations_purpose"`,
    );
    await queryRunner.query(`
      ALTER TABLE "llm_invocations" ADD CONSTRAINT "chk_llm_invocations_purpose"
        CHECK ("purpose" IN ('AGENT_TURN','DIRECT_CHAT','WORKFLOW_STEP','WORKFLOW_ROUTING'))
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_llm_invocations_workflow_run"
        ON "llm_invocations" ("workflow_run_id") WHERE "workflow_run_id" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "conversation_messages"
        ADD COLUMN "integrity" varchar(16) NOT NULL DEFAULT 'INTERNAL',
        ADD COLUMN "tool_calls" jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE "conversation_messages"
        ADD CONSTRAINT "chk_conversation_messages_integrity" CHECK ("integrity" IN ${integrity}),
        ADD CONSTRAINT "chk_conversation_messages_tool_calls" CHECK (jsonb_typeof("tool_calls") = 'array')
    `);

    for (const table of ['tools', 'workflows', 'workflow_runs', 'workflow_steps']) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_touch_updated_at"
          BEFORE UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "daiap_touch_updated_at"()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['workflow_steps', 'workflow_runs', 'workflows', 'tools']) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "trg_${table}_touch_updated_at" ON "${table}"`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE "conversation_messages"
        DROP CONSTRAINT IF EXISTS "chk_conversation_messages_tool_calls",
        DROP CONSTRAINT IF EXISTS "chk_conversation_messages_integrity",
        DROP COLUMN IF EXISTS "tool_calls",
        DROP COLUMN IF EXISTS "integrity"
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_invocations_workflow_run"`);
    // Phase 4 purposes cannot survive the narrower constraint.
    await queryRunner.query(
      `DELETE FROM "llm_invocations" WHERE "purpose" IN ('WORKFLOW_STEP','WORKFLOW_ROUTING')`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_invocations" DROP CONSTRAINT "chk_llm_invocations_purpose"`,
    );
    await queryRunner.query(`
      ALTER TABLE "llm_invocations" ADD CONSTRAINT "chk_llm_invocations_purpose"
        CHECK ("purpose" IN ('AGENT_TURN','DIRECT_CHAT'))
    `);
    await queryRunner.query(`
      ALTER TABLE "llm_invocations"
        DROP COLUMN IF EXISTS "iteration",
        DROP COLUMN IF EXISTS "workflow_step_id",
        DROP COLUMN IF EXISTS "workflow_run_id"
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_steps"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_runs"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_workflow_versions_no_update" ON "workflow_versions"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "daiap_prevent_workflow_version_update"()`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflows"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_executions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tools"`);
  }
}
