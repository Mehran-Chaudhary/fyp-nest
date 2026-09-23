import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 schema: identity, multi-tenancy, RBAC and the tamper-evident audit log.
 *
 * Written by hand rather than generated. A generated migration reflects whatever
 * the entity decorators happen to produce, and several things this schema needs
 * cannot be expressed in decorators at all:
 *
 *  - **Partial unique indexes.** Uniqueness on soft-deletable columns must be
 *    scoped `WHERE deleted_at IS NULL`, otherwise a deleted account permanently
 *    reserves its email address.
 *  - **Append-only enforcement.** The audit log's immutability is a database
 *    trigger, not an application convention.
 *  - **CHECK constraints.** Status columns are constrained at the storage layer
 *    so a bug or a manual `psql` session cannot introduce a value the
 *    application cannot interpret.
 *  - **Expression and covering indexes** tuned for the specific access paths the
 *    authorization hot path uses.
 */
export class InitialSchema1758500000000 implements MigrationInterface {
  name = 'InitialSchema1758500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Extensions ──────────────────────────────────────────────────────────
    // pgcrypto supplies gen_random_uuid() on PostgreSQL < 13; on 13+ the
    // function is built in and the extension is harmless.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    // Trigram index support, used for member and audit search.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // ── users ───────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"                     uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"             timestamptz  NOT NULL DEFAULT now(),
        "updated_at"             timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"             timestamptz,
        "email"                  varchar(320) NOT NULL,
        "email_normalized"       varchar(320) NOT NULL,
        "password_hash"          varchar(255) NOT NULL,
        "first_name"             varchar(100) NOT NULL,
        "last_name"              varchar(100) NOT NULL,
        "display_name"           varchar(255),
        "avatar_url"             text,
        "status"                 varchar(32)  NOT NULL DEFAULT 'PENDING',
        "email_verified_at"      timestamptz,
        "last_login_at"          timestamptz,
        "last_login_ip"          varchar(45),
        "failed_login_attempts"  integer      NOT NULL DEFAULT 0,
        "locked_until"           timestamptz,
        "tokens_valid_from"      timestamptz,
        "is_platform_admin"      boolean      NOT NULL DEFAULT false,
        "mfa_enabled"            boolean      NOT NULL DEFAULT false,
        "mfa_secret"             text,
        "preferences"            jsonb        NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "pk_users" PRIMARY KEY ("id"),
        CONSTRAINT "chk_users_status" CHECK ("status" IN ('PENDING','ACTIVE','SUSPENDED','DEACTIVATED')),
        CONSTRAINT "chk_users_failed_attempts" CHECK ("failed_login_attempts" >= 0)
      )
    `);

    // Partial unique index: a soft-deleted account must not hold its address forever.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_users_email_normalized"
        ON "users" ("email_normalized") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_users_status" ON "users" ("status") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_created_at" ON "users" ("created_at")`,
    );
    // Only a handful of rows qualify, so a partial index keeps the platform-admin
    // lookup effectively free.
    await queryRunner.query(
      `CREATE INDEX "idx_users_platform_admin" ON "users" ("is_platform_admin") WHERE "is_platform_admin" = true`,
    );

    // ── permissions (global catalogue) ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id"           uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"   timestamptz  NOT NULL DEFAULT now(),
        "updated_at"   timestamptz  NOT NULL DEFAULT now(),
        "key"          varchar(100) NOT NULL,
        "resource"     varchar(50)  NOT NULL,
        "action"       varchar(50)  NOT NULL,
        "category"     varchar(50)  NOT NULL,
        "description"  text         NOT NULL,
        "is_dangerous" boolean      NOT NULL DEFAULT false,
        "phase"        smallint     NOT NULL DEFAULT 1,
        CONSTRAINT "pk_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_permissions_key" UNIQUE ("key"),
        CONSTRAINT "chk_permissions_phase" CHECK ("phase" BETWEEN 1 AND 5)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_permissions_category" ON "permissions" ("category")`,
    );

    // ── organizations ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id"                   uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"           timestamptz  NOT NULL DEFAULT now(),
        "updated_at"           timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"           timestamptz,
        "name"                 varchar(120) NOT NULL,
        "slug"                 varchar(60)  NOT NULL,
        "description"          text,
        "logo_url"             text,
        "status"               varchar(32)  NOT NULL DEFAULT 'ACTIVE',
        "plan"                 varchar(32)  NOT NULL DEFAULT 'FREE',
        "owner_id"             uuid         NOT NULL,
        "settings"             jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "ip_allowlist_enabled" boolean      NOT NULL DEFAULT false,
        "member_count"         integer      NOT NULL DEFAULT 0,
        "suspended_at"         timestamptz,
        "suspension_reason"    varchar(255),
        CONSTRAINT "pk_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "fk_organizations_owner" FOREIGN KEY ("owner_id")
          REFERENCES "users"("id") ON DELETE RESTRICT,
        CONSTRAINT "chk_organizations_status" CHECK ("status" IN ('ACTIVE','SUSPENDED','ARCHIVED')),
        CONSTRAINT "chk_organizations_plan" CHECK ("plan" IN ('FREE','PRO','ENTERPRISE')),
        CONSTRAINT "chk_organizations_member_count" CHECK ("member_count" >= 0),
        CONSTRAINT "chk_organizations_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_organizations_slug"
        ON "organizations" ("slug") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_organizations_owner" ON "organizations" ("owner_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_organizations_status" ON "organizations" ("status") WHERE "deleted_at" IS NULL`,
    );

    // ── roles ───────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "deleted_at"      timestamptz,
        "version"         integer     NOT NULL DEFAULT 1,
        "organization_id" uuid        NOT NULL,
        "name"            varchar(60) NOT NULL,
        "slug"            varchar(60) NOT NULL,
        "description"     text,
        "is_system"       boolean     NOT NULL DEFAULT false,
        "is_default"      boolean     NOT NULL DEFAULT false,
        "priority"        integer     NOT NULL DEFAULT 0,
        "color"           varchar(16),
        "permission_keys" jsonb       NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "pk_roles" PRIMARY KEY ("id"),
        CONSTRAINT "fk_roles_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_roles_priority" CHECK ("priority" >= 0 AND "priority" <= 1000)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_roles_organization_slug"
        ON "roles" ("organization_id", "slug") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_roles_organization" ON "roles" ("organization_id") WHERE "deleted_at" IS NULL`,
    );
    // At most one default role per workspace: the invitation flow must be able to
    // resolve "the" default unambiguously.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_roles_one_default_per_org"
        ON "roles" ("organization_id")
        WHERE "is_default" = true AND "deleted_at" IS NULL
    `);

    // ── role_permissions ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "role_permissions" (
        "role_id"       uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        CONSTRAINT "pk_role_permissions" PRIMARY KEY ("role_id", "permission_id"),
        CONSTRAINT "fk_role_permissions_role" FOREIGN KEY ("role_id")
          REFERENCES "roles"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_role_permissions_permission" FOREIGN KEY ("permission_id")
          REFERENCES "permissions"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_role_permissions_permission" ON "role_permissions" ("permission_id")`,
    );

    // ── organization_members ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "organization_members" (
        "id"                     uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"             timestamptz  NOT NULL DEFAULT now(),
        "updated_at"             timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"             timestamptz,
        "organization_id"        uuid         NOT NULL,
        "user_id"                uuid         NOT NULL,
        "status"                 varchar(32)  NOT NULL DEFAULT 'ACTIVE',
        "display_name"           varchar(120),
        "title"                  varchar(120),
        "joined_at"              timestamptz,
        "invited_by_id"          uuid,
        "last_active_at"         timestamptz,
        "suspended_at"           timestamptz,
        "suspension_reason"      varchar(255),
        "effective_permissions"  jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "highest_role_priority"  integer      NOT NULL DEFAULT 0,
        CONSTRAINT "pk_organization_members" PRIMARY KEY ("id"),
        CONSTRAINT "fk_org_members_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_org_members_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_org_members_invited_by" FOREIGN KEY ("invited_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_org_members_status" CHECK ("status" IN ('ACTIVE','SUSPENDED','REMOVED'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_org_members_organization_user"
        ON "organization_members" ("organization_id", "user_id") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_org_members_user" ON "organization_members" ("user_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_org_members_org_status" ON "organization_members" ("organization_id", "status") WHERE "deleted_at" IS NULL`,
    );

    // ── member_roles ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "member_roles" (
        "member_id" uuid NOT NULL,
        "role_id"   uuid NOT NULL,
        CONSTRAINT "pk_member_roles" PRIMARY KEY ("member_id", "role_id"),
        CONSTRAINT "fk_member_roles_member" FOREIGN KEY ("member_id")
          REFERENCES "organization_members"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_member_roles_role" FOREIGN KEY ("role_id")
          REFERENCES "roles"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_member_roles_role" ON "member_roles" ("role_id")`,
    );

    // ── organization_ip_rules ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "organization_ip_rules" (
        "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "organization_id" uuid        NOT NULL,
        "cidr"            varchar(64) NOT NULL,
        "label"           varchar(120),
        "created_by_id"   uuid,
        "is_active"       boolean     NOT NULL DEFAULT true,
        "last_matched_at" timestamptz,
        CONSTRAINT "pk_organization_ip_rules" PRIMARY KEY ("id"),
        CONSTRAINT "fk_org_ip_rules_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_org_ip_rules_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "uq_org_ip_rules_cidr" UNIQUE ("organization_id", "cidr")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_org_ip_rules_organization" ON "organization_ip_rules" ("organization_id") WHERE "is_active" = true`,
    );

    // ── invitations ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "invitations" (
        "id"               uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       timestamptz  NOT NULL DEFAULT now(),
        "updated_at"       timestamptz  NOT NULL DEFAULT now(),
        "organization_id"  uuid         NOT NULL,
        "email"            varchar(320) NOT NULL,
        "email_normalized" varchar(320) NOT NULL,
        "token_hash"       varchar(128) NOT NULL,
        "status"           varchar(32)  NOT NULL DEFAULT 'PENDING',
        "role_id"          uuid         NOT NULL,
        "expires_at"       timestamptz  NOT NULL,
        "invited_by_id"    uuid         NOT NULL,
        "accepted_at"      timestamptz,
        "accepted_by_id"   uuid,
        "revoked_at"       timestamptz,
        "revoked_by_id"    uuid,
        "message"          text,
        "send_count"       integer      NOT NULL DEFAULT 1,
        "last_sent_at"     timestamptz,
        CONSTRAINT "pk_invitations" PRIMARY KEY ("id"),
        CONSTRAINT "uq_invitations_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "fk_invitations_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_invitations_role" FOREIGN KEY ("role_id")
          REFERENCES "roles"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_invitations_invited_by" FOREIGN KEY ("invited_by_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_invitations_accepted_by" FOREIGN KEY ("accepted_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_invitations_revoked_by" FOREIGN KEY ("revoked_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_invitations_status" CHECK ("status" IN ('PENDING','ACCEPTED','REVOKED','EXPIRED'))
      )
    `);
    // One live invitation per address per workspace, enforced in the database so
    // two concurrent invites cannot both succeed.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_invitations_pending_email"
        ON "invitations" ("organization_id", "email_normalized")
        WHERE "status" = 'PENDING'
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_invitations_organization_status" ON "invitations" ("organization_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_invitations_email" ON "invitations" ("email_normalized")`,
    );

    // ── api_keys ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "api_keys" (
        "id"                uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"        timestamptz  NOT NULL DEFAULT now(),
        "updated_at"        timestamptz  NOT NULL DEFAULT now(),
        "organization_id"   uuid         NOT NULL,
        "name"              varchar(120) NOT NULL,
        "description"       text,
        "prefix"            varchar(64)  NOT NULL,
        "key_hash"          varchar(128) NOT NULL,
        "scopes"            jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "created_by_id"     uuid         NOT NULL,
        "expires_at"        timestamptz,
        "revoked_at"        timestamptz,
        "revoked_by_id"     uuid,
        "revocation_reason" varchar(255),
        "last_used_at"      timestamptz,
        "last_used_ip"      varchar(45),
        "usage_count"       bigint       NOT NULL DEFAULT 0,
        "allowed_ips"       jsonb        NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "pk_api_keys" PRIMARY KEY ("id"),
        CONSTRAINT "uq_api_keys_prefix" UNIQUE ("prefix"),
        CONSTRAINT "uq_api_keys_hash" UNIQUE ("key_hash"),
        CONSTRAINT "fk_api_keys_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_api_keys_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_api_keys_revoked_by" FOREIGN KEY ("revoked_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_api_keys_usage_count" CHECK ("usage_count" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_api_keys_organization" ON "api_keys" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_api_keys_active" ON "api_keys" ("organization_id") WHERE "revoked_at" IS NULL`,
    );

    // ── sessions (refresh token rotation chains) ────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id"                      uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"              timestamptz  NOT NULL DEFAULT now(),
        "updated_at"              timestamptz  NOT NULL DEFAULT now(),
        "user_id"                 uuid         NOT NULL,
        "family_id"               uuid         NOT NULL,
        "token_hash"              varchar(128) NOT NULL,
        "expires_at"              timestamptz  NOT NULL,
        "revoked_at"              timestamptz,
        "revoked_reason"          varchar(32),
        "replaced_by_session_id"  uuid,
        "last_used_at"            timestamptz,
        "ip_address"              varchar(45),
        "user_agent"              varchar(512),
        "device_label"            varchar(128),
        "organization_id"         uuid,
        CONSTRAINT "pk_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_sessions_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "fk_sessions_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sessions_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_sessions_revoked_reason" CHECK (
          "revoked_reason" IS NULL OR "revoked_reason" IN (
            'ROTATED','LOGOUT','LOGOUT_ALL','PASSWORD_CHANGED',
            'REUSE_DETECTED','ADMIN_REVOKED','ACCOUNT_SUSPENDED','EXPIRED'
          )
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_sessions_user" ON "sessions" ("user_id")`);
    await queryRunner.query(
      `CREATE INDEX "idx_sessions_family" ON "sessions" ("family_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_sessions_expires_at" ON "sessions" ("expires_at") WHERE "revoked_at" IS NULL`,
    );

    // ── user_tokens (verification, password reset, email change) ────────────
    await queryRunner.query(`
      CREATE TABLE "user_tokens" (
        "id"           uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"   timestamptz  NOT NULL DEFAULT now(),
        "updated_at"   timestamptz  NOT NULL DEFAULT now(),
        "user_id"      uuid         NOT NULL,
        "type"         varchar(32)  NOT NULL,
        "token_hash"   varchar(128) NOT NULL,
        "expires_at"   timestamptz  NOT NULL,
        "consumed_at"  timestamptz,
        "consumed_ip"  varchar(45),
        "requested_ip" varchar(45),
        "metadata"     jsonb        NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "pk_user_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "uq_user_tokens_hash" UNIQUE ("token_hash"),
        CONSTRAINT "fk_user_tokens_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_user_tokens_type" CHECK ("type" IN ('EMAIL_VERIFICATION','PASSWORD_RESET','EMAIL_CHANGE'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_user_tokens_user_type" ON "user_tokens" ("user_id", "type")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_user_tokens_expires_at" ON "user_tokens" ("expires_at") WHERE "consumed_at" IS NULL`,
    );

    // ── audit_logs ──────────────────────────────────────────────────────────
    // Deliberately carries no foreign key to organizations: an audit record must
    // outlive the workspace it describes.
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
        "sequence"        bigint       NOT NULL,
        "organization_id" uuid         NOT NULL,
        "action"          varchar(64)  NOT NULL,
        "status"          varchar(16)  NOT NULL,
        "severity"        varchar(16)  NOT NULL,
        "actor_type"      varchar(16)  NOT NULL,
        "actor_id"        uuid,
        "actor_label"     varchar(255),
        "resource_type"   varchar(64),
        "resource_id"     varchar(128),
        "resource_label"  varchar(255),
        "ip_address"      varchar(45),
        "user_agent"      varchar(512),
        "request_id"      varchar(128),
        "http_method"     varchar(8),
        "http_path"       varchar(512),
        "http_status"     smallint,
        "duration_ms"     integer,
        "error_code"      varchar(64),
        "error_message"   text,
        "metadata"        jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "previous_hash"   varchar(64)  NOT NULL,
        "hash"            varchar(64)  NOT NULL,
        "created_at"      timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "chk_audit_logs_sequence" CHECK ("sequence" > 0),
        CONSTRAINT "chk_audit_logs_status" CHECK ("status" IN ('SUCCESS','FAILURE','DENIED')),
        CONSTRAINT "chk_audit_logs_severity" CHECK ("severity" IN ('INFO','NOTICE','WARNING','CRITICAL')),
        CONSTRAINT "chk_audit_logs_actor_type" CHECK ("actor_type" IN ('USER','API_KEY','SYSTEM','AGENT'))
      )
    `);

    // The chain must not fork: one record per position per workspace.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_audit_logs_org_sequence"
        ON "audit_logs" ("organization_id", "sequence")
    `);
    // Primary read path for the compliance dashboard: newest first, per workspace.
    await queryRunner.query(`
      CREATE INDEX "idx_audit_logs_org_created"
        ON "audit_logs" ("organization_id", "created_at" DESC)
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_org_action" ON "audit_logs" ("organization_id", "action")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_actor" ON "audit_logs" ("actor_id") WHERE "actor_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" ("resource_type", "resource_id")`,
    );
    // Security triage: "show me everything that needs attention", which is a
    // vanishingly small fraction of rows, so a partial index stays tiny.
    await queryRunner.query(`
      CREATE INDEX "idx_audit_logs_attention"
        ON "audit_logs" ("organization_id", "created_at" DESC)
        WHERE "severity" IN ('WARNING','CRITICAL')
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_request" ON "audit_logs" ("request_id") WHERE "request_id" IS NOT NULL`,
    );

    // ── Append-only enforcement ─────────────────────────────────────────────
    // Application discipline alone is not evidence of immutability. This trigger
    // makes tampering fail at the storage layer, including from a manual psql
    // session or an ORM bug.
    //
    // DELETE has a deliberate escape hatch for the retention job scheduled in
    // phase 5: it must be opened explicitly, inside a transaction, which leaves
    // the intent visible in the PostgreSQL log.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "daiap_prevent_audit_mutation"() RETURNS trigger AS $BODY$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('daiap.allow_audit_deletion', true) = 'on' THEN
          RETURN OLD;
        END IF;

        RAISE EXCEPTION
          'audit_logs is append-only; % is not permitted (sequence %)',
          TG_OP,
          COALESCE(OLD."sequence", NEW."sequence")
          USING ERRCODE = 'restrict_violation';
      END;
      $BODY$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_logs_no_update"
        BEFORE UPDATE ON "audit_logs"
        FOR EACH ROW EXECUTE FUNCTION "daiap_prevent_audit_mutation"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_logs_no_delete"
        BEFORE DELETE ON "audit_logs"
        FOR EACH ROW EXECUTE FUNCTION "daiap_prevent_audit_mutation"()
    `);

    // ── updated_at maintenance ──────────────────────────────────────────────
    // TypeORM sets updated_at on save, but a direct SQL UPDATE (a migration, a
    // maintenance script) would leave it stale. The trigger makes the column
    // trustworthy regardless of who writes.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "daiap_touch_updated_at"() RETURNS trigger AS $BODY$
      BEGIN
        NEW."updated_at" = now();
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql
    `);

    const touchTables = [
      'users',
      'permissions',
      'organizations',
      'roles',
      'organization_members',
      'organization_ip_rules',
      'invitations',
      'api_keys',
      'sessions',
      'user_tokens',
    ];

    for (const table of touchTables) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_touch_updated_at"
          BEFORE UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "daiap_touch_updated_at"()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const touchTables = [
      'user_tokens',
      'sessions',
      'api_keys',
      'invitations',
      'organization_ip_rules',
      'organization_members',
      'roles',
      'organizations',
      'permissions',
      'users',
    ];

    for (const table of touchTables) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "trg_${table}_touch_updated_at" ON "${table}"`,
      );
    }

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_audit_logs_no_delete" ON "audit_logs"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_audit_logs_no_update" ON "audit_logs"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "daiap_touch_updated_at"()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "daiap_prevent_audit_mutation"()`);

    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invitations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organization_ip_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "member_roles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organization_members"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "role_permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "roles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organizations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
