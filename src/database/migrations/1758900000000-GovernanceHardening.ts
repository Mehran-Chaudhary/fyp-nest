import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tables carrying an `organization_id` that row-level security isolates.
 *
 * `organizations` is handled apart (its tenant column is `id`), as are the
 * audit tables (see below). Join tables without a tenant column
 * (`member_roles`, `role_permissions`, `agent_allowed_roles`) hold only ids of
 * rows that are themselves isolated.
 */
export const TENANT_TABLES = [
  'roles',
  'organization_members',
  'organization_ip_rules',
  'invitations',
  'api_keys',
  'knowledge_bases',
  'knowledge_base_grants',
  'documents',
  'document_chunks',
  'pii_policies',
  'llm_policies',
  'llm_invocations',
  'agents',
  'agent_versions',
  'conversations',
  'conversation_messages',
  'tools',
  'tool_executions',
  'workflows',
  'workflow_versions',
  'workflow_runs',
  'workflow_steps',
  'usage_quotas',
  'usage_counters',
  'quota_reservations',
  'audit_logs',
  'audit_chain_anchors',
] as const;

/**
 * Phase 5 schema: governance, hardening and operations.
 *
 *  - **Token quotas** (`usage_quotas`, `usage_counters`, `quota_reservations`):
 *    budgets per workspace, member, agent and API key, reserved before each
 *    model call and settled after it.
 *  - **MFA**: enrolment bookkeeping on `users`, a second-factor mark on
 *    `sessions` that survives refresh rotation, and single-use recovery codes.
 *  - **Audit retention**: `audit_chain_anchors`, the signed record that lets a
 *    pruned chain still verify from where it now starts.
 *  - **Row-level security**: every tenant table isolated by a policy on the
 *    workspace bound to the connection — a third layer beneath the guards and
 *    the repository filters (ADR 0005).
 */
export class GovernanceHardening1758900000000 implements MigrationInterface {
  name = 'GovernanceHardening1758900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Usage ledger: a governance refusal is its own outcome ──────────────
    await queryRunner.query(
      `ALTER TABLE "llm_invocations" DROP CONSTRAINT "chk_llm_invocations_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "llm_invocations" ADD CONSTRAINT "chk_llm_invocations_status"
        CHECK ("status" IN ('COMPLETED','CANCELLED','FAILED','REFUSED','BLOCKED','THROTTLED'))
    `);
    // API-key budgets are reconciled from the ledger like the others.
    await queryRunner.query(`
      CREATE INDEX "idx_llm_invocations_org_key"
        ON "llm_invocations" ("organization_id", "api_key_id", "created_at" DESC)
        WHERE "api_key_id" IS NOT NULL
    `);
    // Retention deletes by age across every workspace. The ledgers are
    // append-only and time-ordered, which is exactly what BRIN is for: an index
    // of a few pages instead of a B-tree the size of the table.
    await queryRunner.query(
      `CREATE INDEX "brin_llm_invocations_created" ON "llm_invocations" USING brin ("created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "brin_tool_executions_created" ON "tool_executions" USING brin ("created_at")`,
    );

    // ── usage_quotas ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "usage_quotas" (
        "id"               uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        "organization_id"  uuid          NOT NULL,
        "scope"            varchar(16)   NOT NULL,
        "subject_id"       uuid,
        "period"           varchar(8)    NOT NULL,
        "token_limit"      bigint        NOT NULL,
        "enforcement"      varchar(8)    NOT NULL DEFAULT 'HARD',
        "alert_threshold"  smallint      NOT NULL DEFAULT 80,
        "managed_by"       varchar(16)   NOT NULL DEFAULT 'WORKSPACE',
        "label"            varchar(120),
        "created_by_id"    uuid,
        "updated_by_id"    uuid,
        CONSTRAINT "pk_usage_quotas" PRIMARY KEY ("id"),
        CONSTRAINT "fk_usage_quotas_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_usage_quotas_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_usage_quotas_updated_by" FOREIGN KEY ("updated_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_usage_quotas_scope"
          CHECK ("scope" IN ('ORGANIZATION','MEMBER','AGENT','API_KEY')),
        -- A workspace-wide quota names no subject; every other scope names one.
        CONSTRAINT "chk_usage_quotas_subject"
          CHECK (("scope" = 'ORGANIZATION') = ("subject_id" IS NULL)),
        CONSTRAINT "chk_usage_quotas_period" CHECK ("period" IN ('MINUTE','DAY','MONTH')),
        CONSTRAINT "chk_usage_quotas_limit" CHECK ("token_limit" > 0),
        CONSTRAINT "chk_usage_quotas_enforcement" CHECK ("enforcement" IN ('HARD','SOFT')),
        CONSTRAINT "chk_usage_quotas_threshold" CHECK ("alert_threshold" BETWEEN 1 AND 100),
        CONSTRAINT "chk_usage_quotas_managed_by" CHECK ("managed_by" IN ('WORKSPACE','PLATFORM')),
        -- The platform manages exactly two things: the workspace's allowance and rate.
        CONSTRAINT "chk_usage_quotas_platform_scope"
          CHECK ("managed_by" = 'WORKSPACE' OR "scope" = 'ORGANIZATION')
      )
    `);
    // One quota per scope, subject, period and manager: a workspace may keep a
    // stricter budget of its own next to the platform's allowance.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_usage_quotas_scope"
        ON "usage_quotas" ("organization_id", "scope",
          COALESCE("subject_id", '00000000-0000-0000-0000-000000000000'::uuid),
          "period", "managed_by")
    `);

    // ── usage_counters ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "usage_counters" (
        "quota_id"         uuid          NOT NULL,
        "period_start"     timestamptz   NOT NULL,
        "organization_id"  uuid          NOT NULL,
        "tokens_used"      bigint        NOT NULL DEFAULT 0,
        "tokens_reserved"  bigint        NOT NULL DEFAULT 0,
        "requests"         integer       NOT NULL DEFAULT 0,
        "rejected"         integer       NOT NULL DEFAULT 0,
        "alerted_at"       timestamptz,
        "exhausted_at"     timestamptz,
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "pk_usage_counters" PRIMARY KEY ("quota_id", "period_start"),
        CONSTRAINT "fk_usage_counters_quota" FOREIGN KEY ("quota_id")
          REFERENCES "usage_quotas"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_usage_counters_values" CHECK (
          "tokens_used" >= 0 AND "tokens_reserved" >= 0 AND "requests" >= 0 AND "rejected" >= 0
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_usage_counters_org_period"
        ON "usage_counters" ("organization_id", "period_start" DESC)
    `);

    // ── quota_reservations ──────────────────────────────────────────────────
    // A reservation outlives a crashed call by at most QUOTA_RESERVATION_TTL:
    // the sweep releases expired ones, so a process dying mid-generation
    // cannot leak budget for the rest of the month.
    await queryRunner.query(`
      CREATE TABLE "quota_reservations" (
        "id"               uuid          NOT NULL,
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "organization_id"  uuid          NOT NULL,
        "tokens"           bigint        NOT NULL,
        "counters"         jsonb         NOT NULL,
        "expires_at"       timestamptz   NOT NULL,
        CONSTRAINT "pk_quota_reservations" PRIMARY KEY ("id"),
        CONSTRAINT "chk_quota_reservations_tokens" CHECK ("tokens" >= 0),
        CONSTRAINT "chk_quota_reservations_counters" CHECK (jsonb_typeof("counters") = 'array')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_quota_reservations_expires" ON "quota_reservations" ("expires_at")`,
    );

    // ── MFA ─────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "mfa_enrolled_at" timestamptz,
        ADD COLUMN "mfa_last_used_step" bigint,
        ADD COLUMN "erased_at" timestamptz
    `);
    // Set when the session was established with a second factor; rotation
    // carries it forward, so a refreshed token keeps the same assurance.
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "mfa_verified_at" timestamptz`);
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "chk_sessions_revoked_reason"`,
    );
    await queryRunner.query(`
      ALTER TABLE "sessions" ADD CONSTRAINT "chk_sessions_revoked_reason" CHECK (
        "revoked_reason" IS NULL OR "revoked_reason" IN (
          'ROTATED','LOGOUT','LOGOUT_ALL','PASSWORD_CHANGED','REUSE_DETECTED',
          'ADMIN_REVOKED','ACCOUNT_SUSPENDED','EXPIRED','MFA_CHANGED','ACCOUNT_ERASED'
        )
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "user_recovery_codes" (
        "id"          uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"  timestamptz   NOT NULL DEFAULT now(),
        "user_id"     uuid          NOT NULL,
        "code_hash"   varchar(128)  NOT NULL,
        "used_at"     timestamptz,
        CONSTRAINT "pk_user_recovery_codes" PRIMARY KEY ("id"),
        CONSTRAINT "uq_user_recovery_codes_hash" UNIQUE ("code_hash"),
        CONSTRAINT "fk_user_recovery_codes_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_user_recovery_codes_user"
        ON "user_recovery_codes" ("user_id") WHERE "used_at" IS NULL
    `);

    // ── Lifecycle sweeps ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX "idx_sessions_revoked_at"
        ON "sessions" ("revoked_at") WHERE "revoked_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conversations_idle"
        ON "conversations" ("last_message_at") WHERE "deleted_at" IS NULL
    `);

    // ── audit_chain_anchors ─────────────────────────────────────────────────
    // Pruning the oldest records of a hash chain would make it unverifiable
    // (verification starts from the genesis hash). An anchor records where the
    // surviving chain begins — the sequence and hash of the last pruned record
    // — signed with the audit secret, so that someone with database access
    // alone cannot forge an anchor to hide deleted records.
    await queryRunner.query(`
      CREATE TABLE "audit_chain_anchors" (
        "organization_id"  uuid          NOT NULL,
        "sequence"         bigint        NOT NULL,
        "hash"             varchar(64)   NOT NULL,
        "first_sequence"   bigint        NOT NULL,
        "records_pruned"   bigint        NOT NULL,
        "cutoff"           timestamptz   NOT NULL,
        "archive_key"      text,
        "archive_sha256"   varchar(64),
        "mac"              varchar(64)   NOT NULL,
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "pk_audit_chain_anchors" PRIMARY KEY ("organization_id", "sequence"),
        CONSTRAINT "chk_audit_chain_anchors_range" CHECK (
          "sequence" >= "first_sequence" AND "first_sequence" >= 1 AND "records_pruned" > 0
        )
      )
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "daiap_prevent_anchor_mutation"() RETURNS trigger AS $BODY$
      BEGIN
        RAISE EXCEPTION 'audit_chain_anchors is append-only; % is not permitted', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $BODY$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_chain_anchors_immutable"
        BEFORE UPDATE OR DELETE ON "audit_chain_anchors"
        FOR EACH ROW EXECUTE FUNCTION "daiap_prevent_anchor_mutation"()
    `);

    for (const table of ['usage_quotas', 'usage_counters']) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_touch_updated_at"
          BEFORE UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "daiap_touch_updated_at"()
      `);
    }

    // ── Row-level security ──────────────────────────────────────────────────
    // The workspace a connection works for, bound by the application on
    // checkout (`daiap.tenant`). Unbound means a trusted system context —
    // migrations, sign-in, cross-tenant maintenance sweeps — and sees
    // everything; bound, a connection sees and writes only its workspace's
    // rows, whatever its SQL forgets to say. See ADR 0005.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "daiap_current_tenant"() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE AS $BODY$
          SELECT NULLIF(current_setting('daiap.tenant', true), '')::uuid
        $BODY$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "daiap_tenant_allows"(tenant uuid) RETURNS boolean
        LANGUAGE sql STABLE PARALLEL SAFE AS $BODY$
          SELECT "daiap_current_tenant"() IS NULL OR tenant = "daiap_current_tenant"()
        $BODY$
    `);

    for (const table of TENANT_TABLES) {
      await this.isolate(queryRunner, table, 'organization_id');
    }
    await this.isolate(queryRunner, 'organizations', 'id');

    // A role that cannot bypass RLS, for providers whose login role can
    // (a superuser, or Supabase's `postgres`, which holds BYPASSRLS): set
    // DB_RLS_ROLE=daiap_rls and every connection assumes it. Creating roles
    // needs CREATEROLE; where the migration's role lacks it the step is
    // skipped with a notice, and RLS still applies to any role that owns the
    // tables without bypassing (policies are FORCEd).
    await queryRunner.query(`
      DO $BODY$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daiap_rls') THEN
          CREATE ROLE "daiap_rls" NOLOGIN NOBYPASSRLS;
        END IF;
        EXECUTE format('GRANT "daiap_rls" TO %I', current_user);
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO "daiap_rls"', current_schema());
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO "daiap_rls"',
          current_schema());
        EXECUTE format(
          'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO "daiap_rls"', current_schema());
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "daiap_rls"',
          current_schema());
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Role daiap_rls was not created (%). DB_RLS_ROLE is unavailable; RLS still applies to non-bypassing roles.', SQLERRM;
      END
      $BODY$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...TENANT_TABLES, 'organizations'].reverse()) {
      await queryRunner.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${table}"`);
      await queryRunner.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS "daiap_tenant_allows"(uuid)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "daiap_current_tenant"()`);
    // The role is left in place: roles are cluster-wide, and another database
    // on the same server may use it.

    for (const table of ['usage_counters', 'usage_quotas']) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "trg_${table}_touch_updated_at" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_audit_chain_anchors_immutable" ON "audit_chain_anchors"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "daiap_prevent_anchor_mutation"()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_chain_anchors"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_conversations_idle"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_revoked_at"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "user_recovery_codes"`);
    await queryRunner.query(`
      UPDATE "sessions" SET "revoked_reason" = 'LOGOUT_ALL'
       WHERE "revoked_reason" IN ('MFA_CHANGED','ACCOUNT_ERASED')
    `);
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "chk_sessions_revoked_reason"`,
    );
    await queryRunner.query(`
      ALTER TABLE "sessions" ADD CONSTRAINT "chk_sessions_revoked_reason" CHECK (
        "revoked_reason" IS NULL OR "revoked_reason" IN (
          'ROTATED','LOGOUT','LOGOUT_ALL','PASSWORD_CHANGED',
          'REUSE_DETECTED','ADMIN_REVOKED','ACCOUNT_SUSPENDED','EXPIRED'
        )
      )
    `);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN IF EXISTS "mfa_verified_at"`);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "erased_at",
        DROP COLUMN IF EXISTS "mfa_last_used_step",
        DROP COLUMN IF EXISTS "mfa_enrolled_at"
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "quota_reservations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_counters"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_quotas"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "brin_tool_executions_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "brin_llm_invocations_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_invocations_org_key"`);
    // THROTTLED rows cannot survive the narrower constraint.
    await queryRunner.query(`DELETE FROM "llm_invocations" WHERE "status" = 'THROTTLED'`);
    await queryRunner.query(
      `ALTER TABLE "llm_invocations" DROP CONSTRAINT "chk_llm_invocations_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "llm_invocations" ADD CONSTRAINT "chk_llm_invocations_status"
        CHECK ("status" IN ('COMPLETED','CANCELLED','FAILED','REFUSED','BLOCKED'))
    `);
  }

  /**
   * Enables and FORCEs row-level security with one policy for every command.
   * FORCE matters: without it the table owner — which is what most managed
   * providers connect the application as — would bypass every policy.
   */
  private async isolate(
    queryRunner: QueryRunner,
    table: string,
    tenantColumn: string,
  ): Promise<void> {
    await queryRunner.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "${table}"
        USING ("daiap_tenant_allows"("${tenantColumn}"))
        WITH CHECK ("daiap_tenant_allows"("${tenantColumn}"))
    `);
  }
}
