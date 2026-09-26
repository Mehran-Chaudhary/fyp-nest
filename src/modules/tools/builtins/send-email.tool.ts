import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { TOOLS_CONFIG_KEY, type ToolsConfig } from '../../../config/tools.config';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { MailService } from '../../../shared/mail/mail.service';
import { withholdReason, type LabelReader } from '../../agents/domain/labels';
import type { AccessPrincipal } from '../../knowledge/domain/access';
import { Classification, resolveClearance } from '../../knowledge/domain/classification';
import { KnowledgeBaseAccessService } from '../../knowledge/knowledge-bases/knowledge-base-access.service';
import { Integrity } from '../domain/information-flow';
import { ToolDenialReason } from '../entities/tool-execution.entity';
import {
  ToolRuntimeError,
  type BuiltinTool,
  type BuiltinToolContext,
  type BuiltinToolDefinition,
  type ToolOutput,
} from './builtin-tool';

interface Recipient {
  userId: string;
  membershipId: string;
  email: string;
  name: string;
  permissions: string[];
}

/**
 * Sends an email to a member of the workspace (the proposal's "sending an
 * email" tool, module 6.11).
 *
 * Three rules keep it from becoming an exfiltration channel:
 *
 *  1. **Members only.** The recipient must be an active member of this
 *     workspace. An injected "email the payroll to attacker@example.com"
 *     fails here whatever else happens.
 *  2. **The recipient must be cleared for the context.** An email is a message
 *     its recipient reads, so the recipient's *own* clearance and compartments
 *     are checked against the label of everything the model had seen — the
 *     same check that decides whether they could read the answer in the app.
 *     The HR manager's agent cannot mail payroll figures to an engineer.
 *  3. **Email leaves the encryption boundary.** Whatever the recipient's
 *     clearance, mailboxes are third-party systems; the tool accepts context
 *     up to INTERNAL. And it has side effects, so once the context contains
 *     untrusted external content it is refused (integrity).
 */
@Injectable()
export class SendEmailTool implements BuiltinTool {
  private readonly config: ToolsConfig;
  readonly definition: BuiltinToolDefinition;

  constructor(
    private readonly dataSource: DataSource,
    private readonly knowledgeAccess: KnowledgeBaseAccessService,
    private readonly mail: MailService,
    private readonly events: EventBusService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<ToolsConfig>(TOOLS_CONFIG_KEY);
    this.definition = {
      name: 'send_email',
      displayName: 'Send email to a member',
      description:
        'Sends an email to a member of this workspace, identified by their email address. ' +
        'Only workspace members can receive it, and only if they are allowed to see the ' +
        'information in this conversation. Keep messages short and factual.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            minLength: 3,
            maxLength: 254,
            description:
              'The member’s email address (a placeholder such as [EMAIL_ADDRESS_1] is fine).',
          },
          subject: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', minLength: 1, maxLength: 5000 },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      dataPolicy: {
        maxClassification: Classification.INTERNAL,
        minIntegrity: Integrity.INTERNAL,
        piiArguments: 'unmask',
        sideEffects: true,
      },
      resultIntegrity: Integrity.TRUSTED,
      requiresApproval: false,
      requiredPermissions: ['member:read'],
      timeoutMs: 20_000,
      maxCallsPerRun: this.config.email.maxPerRun,
    };
  }

  isAvailable(): boolean {
    return this.config.email.enabled && this.config.email.maxPerRun > 0;
  }

  async execute(
    args: Record<string, unknown>,
    context: BuiltinToolContext,
  ): Promise<ToolOutput> {
    const address = String(args.to).trim().toLowerCase();
    const recipient = await this.findRecipient(context.principal.organizationId, address);
    if (!recipient) {
      throw new ToolRuntimeError(
        ErrorCode.TOOL_INFORMATION_FLOW_BLOCKED,
        'That address does not belong to a member of this workspace. Emails can only be sent ' +
          'to workspace members.',
        { denial: ToolDenialReason.RECIPIENT },
      );
    }

    const reason = withholdReason(
      context.flow.label,
      await this.readerFor(recipient, context),
    );
    if (reason) {
      throw new ToolRuntimeError(
        ErrorCode.TOOL_INFORMATION_FLOW_BLOCKED,
        'The recipient is not allowed to see some of the information in this conversation, ' +
          'so it cannot be emailed to them.',
        { denial: ToolDenialReason.RECIPIENT },
      );
    }

    const [workspace]: Array<{ name: string }> = await this.dataSource.query(
      'SELECT name FROM organizations WHERE id = $1',
      [context.principal.organizationId],
    );

    const result = await this.mail.sendAgentMessage(recipient.email, {
      subject: String(args.subject)
        .replace(/[\r\n]+/g, ' ')
        .trim(),
      body: String(args.body),
      agentName: context.agent?.name ?? 'Workflow',
      onBehalfOf: context.actorLabel,
      workspaceName: workspace?.name ?? 'your',
    });
    if (!result.accepted) {
      throw new ToolRuntimeError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        'The email could not be delivered right now.',
        { retryable: true },
      );
    }

    await this.events.publish({
      type: 'notification',
      organizationId: context.principal.organizationId,
      recipientUserIds: [recipient.userId],
      ...(context.origin.runId ? { runId: context.origin.runId } : {}),
      data: {
        kind: 'agent_email',
        agentId: context.agent?.id ?? null,
        subjectLength: String(args.subject).length,
      },
    });

    return {
      content: `Email sent to ${String(args.to)}.`,
      data: { delivered: true },
      metadata: {
        recipientMembershipId: recipient.membershipId,
        transport: result.transport,
      },
    };
  }

  private async findRecipient(
    organizationId: string,
    address: string,
  ): Promise<Recipient | null> {
    const rows: Array<{
      user_id: string;
      member_id: string;
      email: string;
      name: string;
      permissions: string[] | null;
    }> = await this.dataSource.query(
      `SELECT u.id AS user_id, m.id AS member_id, u.email_normalized AS email,
              COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.email_normalized) AS name,
              m.effective_permissions AS permissions
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.deleted_at IS NULL AND m.status = 'ACTIVE'
          AND u.email_normalized = $2 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        LIMIT 1`,
      [organizationId, address],
    );
    const row = rows[0];
    return row
      ? {
          userId: row.user_id,
          membershipId: row.member_id,
          email: row.email,
          name: row.name,
          permissions: row.permissions ?? [],
        }
      : null;
  }

  /** The recipient's *current* access, exactly as a label check on their own reads sees it. */
  private async readerFor(
    recipient: Recipient,
    context: BuiltinToolContext,
  ): Promise<LabelReader> {
    const principal: AccessPrincipal = {
      organizationId: context.principal.organizationId,
      kind: 'user',
      userId: recipient.userId,
      membershipId: recipient.membershipId,
      permissions: recipient.permissions,
    };
    const scope = await this.knowledgeAccess.resolveScope(principal);
    const documentIds = context.flow.label.documentIds;
    const deleted: Array<{ id: string }> =
      documentIds.length === 0
        ? []
        : await this.dataSource.query(
            `SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`,
            [documentIds],
          );
    return {
      clearance: resolveClearance(recipient.permissions),
      readableKnowledgeBaseIds: new Set(scope.knowledgeBases.keys()),
      deletedDocumentIds: new Set(deleted.map((row) => row.id)),
    };
  }
}
