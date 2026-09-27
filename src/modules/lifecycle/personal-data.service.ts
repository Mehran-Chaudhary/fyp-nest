import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../common/exceptions/app.exception';
import { LIFECYCLE_CONFIG_KEY, type LifecycleConfig } from '../../config/lifecycle.config';
import { returnedRows } from '../../database/query.util';
import { PasswordHashingService } from '../../shared/crypto/password-hashing.service';
import { MailService } from '../../shared/mail/mail.service';
import { ConversationsService } from '../agents/conversations.service';
import type { Conversation } from '../agents/entities/conversation.entity';
import type { ConversationMessage } from '../agents/entities/conversation-message.entity';
import { AuditService } from '../audit/audit.service';
import { PLATFORM_CHAIN_ID } from '../audit/entities/audit-log.entity';
import { MfaService, type SecondFactor } from '../auth/mfa/mfa.service';
import { JwtTokenService } from '../auth/services/jwt-token.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../rbac/rbac.service';
import { UsersService } from '../users/users.service';
import { RunAad, RunCryptoService } from '../workflows/run-crypto.service';

export interface PersonalDataExport {
  format: 'daiap-personal-data/v1';
  generatedAt: string;
  notice: string;
  account: Record<string, unknown>;
  memberships: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  workflowRuns: Array<Record<string, unknown>>;
  apiKeys: Array<Record<string, unknown>>;
  usage: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
  truncated: string[];
}

export interface ErasureOutcome {
  erased: true;
  workspacesDeleted: string[];
  conversationsShredded: number;
  workflowRunsShredded: number;
  apiKeysRevoked: number;
  membershipsEnded: number;
}

/**
 * A person's rights over their own data (phase 5): a copy of it (GDPR Art.
 * 15 and 20) and its erasure (Art. 17), both self-service.
 *
 * ## Export
 *
 * Everything the platform holds *about* the person and *from* them, across
 * every workspace they belong to: their profile, memberships and devices, the
 * content of their own conversations and workflow runs (decrypted — it is
 * theirs), the API keys they issued, their usage, and the audit trail of what
 * they did. Not other people's data, and not workspace documents, which belong
 * to the workspace.
 *
 * ## Erasure
 *
 * Refused while the person owns a workspace other people belong to —
 * ownership must be transferred first, or those people would lose their
 * workspace. Otherwise, in one transaction:
 *
 *  - their conversations and workflow runs are **crypto-shredded** (the keys
 *    destroyed, so every copy of the content — backups included — is
 *    unreadable);
 *  - their API keys are revoked, memberships ended, sessions, one-time tokens
 *    and recovery codes deleted, and invitations addressed to them anonymised;
 *  - the account itself is anonymised and closed: no name, no address, no
 *    password, no second factor.
 *
 * Workspaces they alone belonged to are deleted through the normal path (so
 * their knowledge is destroyed after the purge grace period).
 *
 * What remains is pseudonymous: usage and tool ledgers reference an id that
 * no longer resolves to a person. The audit log is kept — it is evidence the
 * platform is obliged to keep (Art. 17(3)(b) and (e)) — and is itself bounded
 * by AUDIT_RETENTION.
 */
@Injectable()
export class PersonalDataService {
  private readonly logger = new Logger(PersonalDataService.name);
  private readonly config: LifecycleConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly mfa: MfaService,
    private readonly conversations: ConversationsService,
    private readonly runCrypto: RunCryptoService,
    private readonly organizations: OrganizationsService,
    private readonly rbac: RbacService,
    private readonly jwtTokens: JwtTokenService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<LifecycleConfig>(LIFECYCLE_CONFIG_KEY);
  }

  // ── Export ────────────────────────────────────────────────────────────────

  async export(userId: string): Promise<PersonalDataExport> {
    const limit = this.config.exportMaxItems;
    const truncated: string[] = [];
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);

    const memberships: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT o.id AS "organizationId", o.name AS "organization", o.slug, m.status,
              m.display_name AS "displayName", m.title, m.joined_at AS "joinedAt",
              m.last_active_at AS "lastActiveAt",
              COALESCE((SELECT json_agg(r.name ORDER BY r.priority DESC)
                          FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                         WHERE mr.member_id = m.id), '[]'::json) AS roles,
              (o.owner_id = m.user_id) AS "isOwner"
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1
        ORDER BY m.created_at`,
      [userId],
    );

    const devices: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT DISTINCT ON (family_id) family_id AS "deviceId", device_label AS "device",
              ip_address AS "ipAddress", user_agent AS "userAgent", created_at AS "signedInAt",
              last_used_at AS "lastUsedAt", expires_at AS "expiresAt",
              revoked_at AS "revokedAt", (mfa_verified_at IS NOT NULL) AS "secondFactor"
         FROM sessions WHERE user_id = $1
        ORDER BY family_id, created_at DESC
        LIMIT 200`,
      [userId],
    );

    const conversations = await this.exportConversations(userId, limit, truncated);
    const workflowRuns = await this.exportRuns(userId, limit, truncated);

    const apiKeys: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT k.id, k.name, k.prefix, k.scopes, o.name AS "organization", k.created_at AS "createdAt",
              k.expires_at AS "expiresAt", k.revoked_at AS "revokedAt", k.last_used_at AS "lastUsedAt"
         FROM api_keys k JOIN organizations o ON o.id = k.organization_id
        WHERE k.created_by_id = $1 ORDER BY k.created_at`,
      [userId],
    );

    const usage: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT o.name AS "organization", date_trunc('month', i.created_at, 'UTC') AS month,
              count(*)::int AS "modelCalls",
              COALESCE(sum(i.prompt_tokens + i.completion_tokens), 0)::bigint AS tokens
         FROM llm_invocations i JOIN organizations o ON o.id = i.organization_id
        WHERE i.user_id = $1
        GROUP BY o.name, 2 ORDER BY 2 DESC`,
      [userId],
    );

    const activity: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT created_at AS at, action, status, resource_type AS "resourceType",
              resource_id AS "resourceId", ip_address AS "ipAddress", user_agent AS "userAgent"
         FROM audit_logs WHERE actor_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    if (activity.length >= limit) truncated.push('activity');

    const mfa = await this.mfa.status(userId);
    await this.auditService.recordSafe({
      action: AuditAction.USER_DATA_EXPORTED,
      organizationId: PLATFORM_CHAIN_ID,
      resourceType: 'user',
      resourceId: userId,
      metadata: {
        conversations: conversations.length,
        workflowRuns: workflowRuns.length,
        truncated,
      },
    });

    return {
      format: 'daiap-personal-data/v1',
      generatedAt: new Date().toISOString(),
      notice:
        'Everything this platform holds about you and from you. Workspace documents belong ' +
        'to their workspace and are not included; personal data other people entered is not ' +
        'included either.',
      account: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        displayName: user.displayName,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        lastLoginIp: user.lastLoginIp,
        preferences: user.preferences,
        twoStepVerification: { enabled: mfa.enabled, enrolledAt: mfa.enrolledAt },
      },
      memberships,
      devices,
      conversations,
      workflowRuns,
      apiKeys,
      usage,
      activity,
      truncated,
    };
  }

  private async exportConversations(
    userId: string,
    limit: number,
    truncated: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const rows: Array<{
      id: string;
      organization: string;
      agent: string | null;
      created_at: Date;
      wrapped_data_key: string | null;
      title_ciphertext: string | null;
    }> = await this.dataSource.query(
      `SELECT c.id, o.name AS organization, a.name AS agent, c.created_at,
              c.wrapped_data_key, c.title_ciphertext
         FROM conversations c
         JOIN organizations o ON o.id = c.organization_id
         LEFT JOIN agents a ON a.id = c.agent_id
        WHERE c.user_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at`,
      [userId],
    );

    let budget = limit;
    const result: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (!row.wrapped_data_key) continue;
      const conversation = {
        id: row.id,
        wrappedDataKey: row.wrapped_data_key,
        titleCiphertext: row.title_ciphertext,
      } as Conversation;
      const key = this.conversations.unwrapKey(conversation);
      try {
        const messages: Array<{
          id: string;
          role: string;
          status: string;
          created_at: Date;
          content_ciphertext: string | null;
        }> =
          budget > 0
            ? await this.dataSource.query(
                `SELECT id, role, status, created_at, content_ciphertext
                   FROM conversation_messages WHERE conversation_id = $1
                  ORDER BY sequence LIMIT $2`,
                [row.id, budget],
              )
            : [];
        budget -= messages.length;
        result.push({
          id: row.id,
          organization: row.organization,
          agent: row.agent,
          createdAt: row.created_at,
          title: this.conversations.decryptTitle(key, conversation),
          messages: messages.map((message) => ({
            role: message.role,
            status: message.status,
            at: message.created_at,
            content: this.conversations.decrypt(key, {
              id: message.id,
              contentCiphertext: message.content_ciphertext,
            } as ConversationMessage),
          })),
        });
      } finally {
        this.conversations.destroyKey(key);
      }
    }
    if (budget <= 0) truncated.push('conversations');
    return result;
  }

  private async exportRuns(
    userId: string,
    limit: number,
    truncated: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const runs: Array<{
      id: string;
      organization: string;
      workflow: string | null;
      status: string;
      created_at: Date;
      completed_at: Date | null;
      wrapped_data_key: string | null;
      input_ciphertext: string | null;
      output_ciphertext: string | null;
    }> = await this.dataSource.query(
      `SELECT r.id, o.name AS organization, w.name AS workflow, r.status, r.created_at,
              r.completed_at, r.wrapped_data_key, r.input_ciphertext, r.output_ciphertext
         FROM workflow_runs r
         JOIN organizations o ON o.id = r.organization_id
         LEFT JOIN workflows w ON w.id = r.workflow_id
        WHERE r.initiator_user_id = $1 AND r.deleted_at IS NULL
        ORDER BY r.created_at DESC LIMIT $2`,
      [userId, limit],
    );
    if (runs.length >= limit) truncated.push('workflowRuns');

    return runs.map((run) => {
      let input: unknown = null;
      let output: unknown = null;
      if (run.wrapped_data_key) {
        const key = this.runCrypto.unwrap(run.id, run.wrapped_data_key);
        try {
          input = run.input_ciphertext
            ? this.runCrypto.open(key, run.input_ciphertext, RunAad.runInput(run.id))
            : null;
          output = run.output_ciphertext
            ? this.runCrypto.open(key, run.output_ciphertext, RunAad.runOutput(run.id))
            : null;
        } finally {
          this.runCrypto.destroy(key);
        }
      }
      return {
        id: run.id,
        organization: run.organization,
        workflow: run.workflow,
        status: run.status,
        startedAt: run.created_at,
        completedAt: run.completed_at,
        input,
        output,
      };
    });
  }

  // ── Erasure ───────────────────────────────────────────────────────────────

  async erase(
    userId: string,
    password: string,
    factor: SecondFactor,
  ): Promise<ErasureOutcome> {
    if (!this.config.erasureEnabled) {
      throw new ForbiddenError(ErrorCode.ACCOUNT_ERASURE_DISABLED);
    }
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user) throw new NotFoundError(ErrorCode.ACCOUNT_NOT_FOUND);
    if (!(await this.usersService.verifyPassword(user, password))) {
      throw new UnauthorizedError(ErrorCode.AUTH_PASSWORD_MISMATCH);
    }
    if (user.mfaEnabled) await this.mfa.verifySecondFactor(userId, factor);

    // Ownership blocks erasure only where it would strand other people.
    const owned: Array<{ id: string; name: string; others: number }> =
      await this.dataSource.query(
        `SELECT o.id, o.name,
                (SELECT count(*)::int FROM organization_members m
                  WHERE m.organization_id = o.id AND m.user_id <> $1
                    AND m.deleted_at IS NULL AND m.status <> 'REMOVED') AS others
           FROM organizations o WHERE o.owner_id = $1 AND o.deleted_at IS NULL`,
        [userId],
      );
    const shared = owned.filter((workspace) => workspace.others > 0);
    if (shared.length > 0) {
      throw new ConflictError(ErrorCode.ACCOUNT_ERASURE_BLOCKED, {
        details: {
          workspaces: shared.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            otherMembers: workspace.others,
          })),
        },
      });
    }

    // Workspaces only they belong to go through the ordinary deletion.
    for (const workspace of owned) {
      await this.organizations.softDelete(workspace.id, userId);
    }

    // The farewell goes to the address before it is erased.
    const originalEmail = user.email;
    const originalName = user.preferredName;

    const outcome = await this.dataSource.transaction(async (manager) => {
      const memberships: Array<{ organization_id: string }> = await manager.query(
        `SELECT organization_id FROM organization_members
          WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );

      const conversationsShredded = returnedRows(
        await manager.query(
          `UPDATE conversations
              SET wrapped_data_key = NULL, title_ciphertext = NULL, deleted_at = now()
            WHERE user_id = $1 AND deleted_at IS NULL
            RETURNING id`,
          [userId],
        ),
      ).length;

      await manager.query(
        `UPDATE workflow_runs SET status = 'CANCELLED', completed_at = now(),
                                  cancel_requested_at = now(), error_code = 'WORKFLOW_PRINCIPAL_REVOKED'
          WHERE initiator_user_id = $1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL')`,
        [userId],
      );
      const runs = returnedRows<{ id: string }>(
        await manager.query(
          `UPDATE workflow_runs
              SET wrapped_data_key = NULL, input_ciphertext = NULL, output_ciphertext = NULL,
                  deleted_at = now()
            WHERE initiator_user_id = $1 AND deleted_at IS NULL
            RETURNING id`,
          [userId],
        ),
      );
      if (runs.length > 0) {
        await manager.query(`DELETE FROM workflow_steps WHERE run_id = ANY($1::uuid[])`, [
          runs.map((run) => run.id),
        ]);
      }

      const apiKeysRevoked = returnedRows(
        await manager.query(
          `UPDATE api_keys SET revoked_at = now(), revocation_reason = 'account erased'
            WHERE created_by_id = $1 AND revoked_at IS NULL
            RETURNING id`,
          [userId],
        ),
      ).length;

      await manager.query(
        `UPDATE organization_members
            SET status = 'REMOVED', deleted_at = now(), display_name = NULL, title = NULL
          WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      for (const { organization_id } of memberships) {
        await manager.query(
          `UPDATE organizations SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1`,
          [organization_id],
        );
        await this.auditService.record(
          {
            action: AuditAction.MEMBER_LEFT,
            organizationId: organization_id,
            resourceType: 'user',
            resourceId: userId,
            actor: { type: ActorType.SYSTEM, label: 'account erasure' },
            metadata: { reason: 'account_erased' },
          },
          manager,
        );
      }

      await manager.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
      await manager.query(`DELETE FROM user_tokens WHERE user_id = $1`, [userId]);
      await manager.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
      await manager.query(
        `UPDATE invitations
            SET email = 'erased@erased.invalid',
                email_normalized = 'erased+' || id || '@erased.invalid',
                status = CASE WHEN status = 'PENDING' THEN 'REVOKED' ELSE status END,
                message = NULL
          WHERE email_normalized = $1`,
        [user.emailNormalized],
      );

      // The account: no name, no address, no usable password, no second factor.
      const unusable = await this.passwordHashing.hash(randomBytes(32).toString('base64url'));
      await manager.query(
        `UPDATE users
            SET email = $2, email_normalized = $2, first_name = 'Erased', last_name = 'User',
                display_name = NULL, avatar_url = NULL, password_hash = $3,
                mfa_enabled = false, mfa_secret = NULL, mfa_enrolled_at = NULL,
                mfa_last_used_step = NULL, last_login_ip = NULL, preferences = '{}'::jsonb,
                status = 'DEACTIVATED', tokens_valid_from = now(), erased_at = now(),
                deleted_at = now()
          WHERE id = $1`,
        [userId, `erased+${userId}@erased.invalid`, unusable],
      );

      await this.auditService.record(
        {
          action: AuditAction.USER_ERASED,
          organizationId: PLATFORM_CHAIN_ID,
          resourceType: 'user',
          resourceId: userId,
          actor: { type: ActorType.USER, id: userId, label: 'erased user' },
          metadata: {
            workspacesDeleted: owned.length,
            memberships: memberships.length,
            conversationsShredded,
            workflowRunsShredded: runs.length,
            apiKeysRevoked,
          },
        },
        manager,
      );

      return {
        conversationsShredded,
        workflowRunsShredded: runs.length,
        apiKeysRevoked,
        membershipsEnded: memberships.length,
        memberships,
      };
    });

    // Outside the transaction: caches and the token overlay.
    await this.jwtTokens.revokeAllUserTokens(userId);
    await this.usersService.invalidateCache(userId);
    for (const { organization_id } of outcome.memberships) {
      await this.rbac.invalidateMemberCache(organization_id, userId).catch(() => undefined);
    }

    await this.mailService
      .sendSecurityAlert(
        originalEmail,
        originalName,
        'Your account has been erased',
        'Your account and the personal data it held have been erased, as you asked. This is ' +
          'the last message you will receive from us.',
      )
      .catch((error: Error) =>
        this.logger.warn(`Could not send the erasure confirmation: ${error.message}`),
      );

    return {
      erased: true,
      workspacesDeleted: owned.map((workspace) => workspace.id),
      conversationsShredded: outcome.conversationsShredded,
      workflowRunsShredded: outcome.workflowRunsShredded,
      apiKeysRevoked: outcome.apiKeysRevoked,
      membershipsEnded: outcome.membershipsEnded,
    };
  }
}
