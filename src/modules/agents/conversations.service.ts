import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  AppException,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
} from '../../common/exceptions/app.exception';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { hasPermission } from '../../common/utils/permission.util';
import { AGENTS_CONFIG_KEY, type AgentsConfig } from '../../config/agents.config';
import { returnedRows } from '../../database/query.util';
import { ContentEncryptionService } from '../../shared/crypto/content-encryption.service';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { Classification } from '../knowledge/domain/classification';
import { KnowledgeBaseAccessService } from '../knowledge/knowledge-bases/knowledge-base-access.service';
import { RedactionService } from '../privacy/redaction.service';
import { AgentsService } from './agents.service';
import { withholdReason, type InformationLabel, type LabelReader } from './domain/labels';
import type {
  CitationDto,
  ConversationDto,
  CreateConversationDto,
  ListConversationsQueryDto,
  ListMessagesQueryDto,
  MessageDto,
  MessagePageDto,
  UpdateConversationDto,
} from './dto/conversation.dto';
import { Agent } from './entities/agent.entity';
import {
  ConversationMessage,
  MessageRole,
  MessageStatus,
} from './entities/conversation-message.entity';
import { Conversation, ConversationStatus } from './entities/conversation.entity';

export const READ_ALL_PERMISSION = 'conversation:read_all';
const REVEAL_PERMISSION = 'pii:reveal';

/** A message about to be stored; the id is assigned by the caller. */
export interface NewMessage {
  id: string;
  role: MessageRole;
  status: MessageStatus;
  content: string | null;
  tokenCount: number;
  label: InformationLabel;
  citations?: ConversationMessage['citations'];
  agentVersion?: number | null;
  promptTemplateVersion?: number | null;
  model?: string | null;
  invocationId?: string | null;
  retrievalId?: string | null;
  redaction?: ConversationMessage['redaction'];
  errorCode?: string | null;
  clientMessageId?: string | null;
}

/** Associated data for a conversation's key, title and messages. */
const keyBinding = (conversationId: string) => `conversation:${conversationId}`;
const titleAad = (conversationId: string) => `conversation:${conversationId}:title`;
const messageAad = (messageId: string) => `message:${messageId}`;

/**
 * Conversations and their messages (proposal module 6.10).
 *
 * ## Who reads what
 *
 * A conversation belongs to the person (or API key) that started it. Holders
 * of `conversation:read_all` may read everyone's — supervision — under three
 * restrictions that apply to every read, the owner's included:
 *
 *  1. **Labels.** A message drawn from material the reader cannot currently
 *     read — above their clearance, from a compartment they are not in, or
 *     from a document since deleted — is withheld. The owner always sees the
 *     messages they typed themselves.
 *  2. **Masking.** A supervisor sees personal data replaced by placeholders:
 *     oversight without exposure. `reveal=true` shows it unmasked, requires
 *     `pii:reveal`, and is audited as `pii.unmasked` (CRITICAL).
 *  3. **Audit.** Every supervised read is recorded as
 *     `agent.conversation.supervised`.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);
  private readonly config: AgentsConfig;

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(ConversationMessage)
    private readonly messageRepository: Repository<ConversationMessage>,
    private readonly dataSource: DataSource,
    private readonly contentEncryption: ContentEncryptionService,
    private readonly knowledgeAccess: KnowledgeBaseAccessService,
    private readonly redaction: RedactionService,
    private readonly agents: AgentsService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AgentsConfig>(AGENTS_CONFIG_KEY);
  }

  // ── Ownership ─────────────────────────────────────────────────────────────

  isOwner(principal: AccessPrincipal, conversation: Conversation): boolean {
    return principal.kind === 'api_key'
      ? !!principal.apiKeyId && conversation.apiKeyId === principal.apiKeyId
      : !!principal.userId && conversation.userId === principal.userId;
  }

  /**
   * Loads a conversation the principal may use. `owner` requires ownership
   * (sending, renaming); `read` also admits supervisors. Anything else is 404:
   * whether another member has a conversation is not disclosed.
   */
  async load(
    principal: AccessPrincipal,
    conversationId: string,
    mode: 'owner' | 'read',
    options: { withKey?: boolean; withTitle?: boolean; manager?: EntityManager } = {},
  ): Promise<Conversation> {
    const repository = options.manager
      ? options.manager.getRepository(Conversation)
      : this.conversationRepository;
    const builder = repository
      .createQueryBuilder('conversation')
      .where('conversation.id = :conversationId', { conversationId })
      .andWhere('conversation.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });
    if (options.withKey) builder.addSelect('conversation.wrappedDataKey');
    if (options.withTitle) builder.addSelect('conversation.titleCiphertext');

    const conversation = await builder.getOne();
    const allowed =
      !!conversation &&
      (this.isOwner(principal, conversation) ||
        (mode === 'read' && hasPermission(principal.permissions, READ_ALL_PERMISSION)));
    if (!conversation || !allowed)
      throw new NotFoundError(ErrorCode.CONVERSATION_NOT_FOUND);
    return conversation;
  }

  // ── Keys and content ──────────────────────────────────────────────────────

  /** The conversation's data key. The caller must `destroyKey()` it when done. */
  unwrapKey(conversation: Conversation): Buffer {
    if (!conversation.wrappedDataKey) {
      throw new NotFoundError(ErrorCode.CONVERSATION_NOT_FOUND);
    }
    return this.contentEncryption.unwrapDataKey(
      conversation.wrappedDataKey,
      keyBinding(conversation.id),
    );
  }

  destroyKey(key: Buffer): void {
    this.contentEncryption.destroy(key);
  }

  decrypt(key: Buffer, message: ConversationMessage): string | null {
    return message.contentCiphertext
      ? this.contentEncryption.decryptText(
          key,
          message.contentCiphertext,
          messageAad(message.id),
        )
      : null;
  }

  decryptTitle(key: Buffer, conversation: Conversation): string | null {
    return conversation.titleCiphertext
      ? this.contentEncryption.decryptText(
          key,
          conversation.titleCiphertext,
          titleAad(conversation.id),
        )
      : null;
  }

  /** The most recent `limit` messages, oldest first. */
  async recentMessages(
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessage[]> {
    if (limit <= 0) return [];
    const rows = await this.messageRepository.find({
      where: { conversationId },
      order: { sequence: 'DESC' },
      take: limit,
    });
    return rows.reverse();
  }

  // ── The turn lease ────────────────────────────────────────────────────────

  /** Takes the conversation's turn lease, or refuses with 409 while another turn runs. */
  async acquireTurn(conversation: Conversation): Promise<string> {
    const lockId = randomUUID();
    const result: unknown = await this.dataSource.query(
      `UPDATE conversations
          SET turn_lock_id = $1,
              turn_lock_expires_at = now() + ($2::int * interval '1 millisecond')
        WHERE id = $3 AND organization_id = $4 AND deleted_at IS NULL
          AND (turn_lock_id IS NULL OR turn_lock_expires_at < now())
        RETURNING id`,
      [lockId, this.config.turnLockTtlMs, conversation.id, conversation.organizationId],
    );
    if (returnedRows(result).length === 0) {
      throw new ConflictError(ErrorCode.CONVERSATION_BUSY);
    }
    return lockId;
  }

  async releaseTurn(conversationId: string, lockId: string): Promise<void> {
    await this.dataSource
      .query(
        `UPDATE conversations SET turn_lock_id = NULL, turn_lock_expires_at = NULL
          WHERE id = $1 AND turn_lock_id = $2`,
        [conversationId, lockId],
      )
      .catch((error: Error) =>
        this.logger.warn(
          `Could not release the turn lease on ${conversationId}: ${error.message}`,
        ),
      );
  }

  async assertNotDuplicate(
    conversationId: string,
    clientMessageId: string | undefined,
  ): Promise<void> {
    if (!clientMessageId) return;
    const existing = await this.messageRepository.findOne({
      where: { conversationId, clientMessageId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(ErrorCode.MESSAGE_DUPLICATE, {
        details: { messageId: existing.id },
      });
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Appends a message inside `manager`'s transaction: allocates the next
   * sequence number, seals the content under the conversation key, and — for a
   * conversation still without one — derives its title from the first message.
   */
  async appendMessage(
    manager: EntityManager,
    conversation: Conversation,
    key: Buffer,
    message: NewMessage,
  ): Promise<ConversationMessage> {
    const [{ message_count: sequence }] = returnedRows<{ message_count: number }>(
      await manager.query(
        `UPDATE conversations
            SET message_count = message_count + 1, last_message_at = now()
          WHERE id = $1
          RETURNING message_count`,
        [conversation.id],
      ),
    );

    if (
      message.role === MessageRole.USER &&
      !conversation.titleCiphertext &&
      message.content
    ) {
      const title = deriveTitle(message.content);
      conversation.titleCiphertext = this.contentEncryption.encryptText(
        key,
        title,
        titleAad(conversation.id),
      );
      await manager.query(`UPDATE conversations SET title_ciphertext = $2 WHERE id = $1`, [
        conversation.id,
        conversation.titleCiphertext,
      ]);
    }

    const entity = manager.getRepository(ConversationMessage).create({
      id: message.id,
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      sequence: Number(sequence),
      role: message.role,
      status: message.status,
      contentCiphertext:
        message.content === null
          ? null
          : this.contentEncryption.encryptText(
              key,
              message.content,
              messageAad(message.id),
            ),
      charCount: message.content?.length ?? 0,
      tokenCount: message.tokenCount,
      classification: message.label.classification,
      knowledgeBaseIds: message.label.knowledgeBaseIds,
      documentIds: message.label.documentIds,
      citations: message.citations ?? [],
      agentVersion: message.agentVersion ?? null,
      promptTemplateVersion: message.promptTemplateVersion ?? null,
      model: message.model ?? null,
      invocationId: message.invocationId ?? null,
      retrievalId: message.retrievalId ?? null,
      redaction: message.redaction ?? {},
      errorCode: message.errorCode ?? null,
      clientMessageId: message.clientMessageId ?? null,
    });
    return manager.getRepository(ConversationMessage).save(entity);
  }

  /** Raises the conversation's high-water mark and adds the turn's token counts. */
  async recordTurn(
    manager: EntityManager,
    conversation: Conversation,
    label: InformationLabel,
    tokens: { prompt: number; completion: number },
  ): Promise<void> {
    await manager.query(
      `UPDATE conversations
          SET classification = $2,
              knowledge_base_ids = $3::jsonb,
              prompt_tokens = prompt_tokens + $4,
              completion_tokens = completion_tokens + $5
        WHERE id = $1`,
      [
        conversation.id,
        label.classification,
        JSON.stringify(label.knowledgeBaseIds),
        tokens.prompt,
        tokens.completion,
      ],
    );
  }

  async create(
    principal: AccessPrincipal,
    input: CreateConversationDto,
  ): Promise<ConversationDto> {
    const { agent } = await this.agents.resolveForExecution(principal, input.agentId);
    const id = randomUUID();
    const dataKey = this.contentEncryption.generateDataKey(keyBinding(id));

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(Conversation).insert({
          id,
          organizationId: principal.organizationId,
          agentId: agent.id,
          userId: principal.kind === 'user' ? (principal.userId ?? null) : null,
          apiKeyId: principal.kind === 'api_key' ? (principal.apiKeyId ?? null) : null,
          wrappedDataKey: dataKey.wrapped,
          titleCiphertext: input.title
            ? this.contentEncryption.encryptText(
                dataKey.plaintext,
                input.title,
                titleAad(id),
              )
            : null,
          status: ConversationStatus.ACTIVE,
          classification: Classification.PUBLIC,
          knowledgeBaseIds: [],
        });

        await this.auditService.record(
          {
            action: AuditAction.AGENT_CONVERSATION_STARTED,
            organizationId: principal.organizationId,
            resourceType: 'conversation',
            resourceId: id,
            metadata: { agentId: agent.id, agentVersion: agent.currentVersion },
          },
          manager,
        );
      });
    } finally {
      this.contentEncryption.destroy(dataKey.plaintext);
    }

    return this.get(principal, id);
  }

  async update(
    principal: AccessPrincipal,
    conversationId: string,
    input: UpdateConversationDto,
  ): Promise<ConversationDto> {
    const conversation = await this.load(principal, conversationId, 'owner', {
      withKey: true,
    });
    const changes: { status?: ConversationStatus; titleCiphertext?: string } = {};

    if (input.status !== undefined) changes.status = input.status;
    if (input.title !== undefined) {
      const key = this.unwrapKey(conversation);
      try {
        changes.titleCiphertext = this.contentEncryption.encryptText(
          key,
          input.title,
          titleAad(conversation.id),
        );
      } finally {
        this.destroyKey(key);
      }
    }

    if (Object.keys(changes).length > 0) {
      await this.conversationRepository.update({ id: conversation.id }, changes);
    }
    return this.get(principal, conversationId);
  }

  /**
   * Crypto-shreds a conversation: the key and title are destroyed and the
   * messages deleted in one transaction. The row remains as a tombstone so
   * audit records and the usage ledger still resolve.
   */
  async remove(principal: AccessPrincipal, conversationId: string): Promise<void> {
    const conversation = await this.load(principal, conversationId, 'read');
    const isOwner = this.isOwner(principal, conversation);

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(ConversationMessage)
        .delete({ conversationId: conversation.id });
      await manager.query(
        `UPDATE conversations
            SET wrapped_data_key = NULL, title_ciphertext = NULL, deleted_at = now(),
                turn_lock_id = NULL, turn_lock_expires_at = NULL
          WHERE id = $1`,
        [conversation.id],
      );
      await this.auditService.record(
        {
          action: AuditAction.AGENT_CONVERSATION_DELETED,
          organizationId: principal.organizationId,
          resourceType: 'conversation',
          resourceId: conversation.id,
          metadata: {
            agentId: conversation.agentId,
            messages: conversation.messageCount,
            deletedByOwner: isOwner,
          },
        },
        manager,
      );
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async get(principal: AccessPrincipal, conversationId: string): Promise<ConversationDto> {
    const conversation = await this.load(principal, conversationId, 'read', {
      withKey: true,
      withTitle: true,
    });
    const [dto] = await this.toDtos(principal, [conversation]);
    return dto;
  }

  async list(
    principal: AccessPrincipal,
    query: ListConversationsQueryDto,
  ): Promise<PaginatedResult<ConversationDto>> {
    const scope = query.scope ?? 'mine';
    if (scope === 'all' && !hasPermission(principal.permissions, READ_ALL_PERMISSION)) {
      await this.auditService.recordAccessDenied(
        'conversation',
        [READ_ALL_PERMISSION],
        principal.organizationId,
      );
      throw new PermissionDeniedError([READ_ALL_PERMISSION]);
    }

    const builder = this.conversationRepository
      .createQueryBuilder('conversation')
      .addSelect('conversation.wrappedDataKey')
      .addSelect('conversation.titleCiphertext')
      .where('conversation.organization_id = :organizationId', {
        organizationId: principal.organizationId,
      });

    if (scope === 'mine') {
      if (principal.kind === 'api_key') {
        builder.andWhere('conversation.api_key_id = :apiKeyId', {
          apiKeyId: principal.apiKeyId,
        });
      } else {
        builder.andWhere('conversation.user_id = :userId', { userId: principal.userId });
      }
    }
    if (query.agentId)
      builder.andWhere('conversation.agent_id = :agentId', { agentId: query.agentId });
    if (query.status)
      builder.andWhere('conversation.status = :status', { status: query.status });

    const [conversations, total] = await builder
      .orderBy('conversation.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('conversation.created_at', 'DESC')
      .skip((query.page - 1) * query.take)
      .take(query.take)
      .getManyAndCount();

    const items = await this.toDtos(principal, conversations);

    const supervised = items.filter((item) => !item.isOwner).length;
    if (supervised > 0) {
      await this.auditService.recordSafe({
        action: AuditAction.AGENT_CONVERSATION_SUPERVISED,
        organizationId: principal.organizationId,
        resourceType: 'conversation',
        metadata: { operation: 'list', conversations: supervised },
      });
    }

    return { items, meta: buildPaginationMeta(total, query.page, query.take) };
  }

  /**
   * A page of messages, newest page first, each checked against the reader's
   * current access and — for someone else's conversation — masked.
   */
  async messages(
    principal: AccessPrincipal,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<MessagePageDto> {
    const conversation = await this.load(principal, conversationId, 'read', {
      withKey: true,
    });
    const isOwner = this.isOwner(principal, conversation);
    const reveal = !isOwner && query.reveal === true;

    if (reveal && !hasPermission(principal.permissions, REVEAL_PERMISSION)) {
      await this.auditService.recordAccessDenied(
        'pii_reveal',
        [REVEAL_PERMISSION],
        principal.organizationId,
      );
      throw new PermissionDeniedError([REVEAL_PERMISSION]);
    }

    const builder = this.messageRepository
      .createQueryBuilder('message')
      .where('message.conversation_id = :conversationId', {
        conversationId: conversation.id,
      });
    if (query.before)
      builder.andWhere('message.sequence < :before', { before: query.before });
    const rows = (
      await builder.orderBy('message.sequence', 'DESC').take(query.limit).getMany()
    ).reverse();

    const reader = await this.readerFor(principal, rows);
    const key = this.unwrapKey(conversation);

    let messages: MessageDto[];
    let masked = false;
    try {
      const decided = rows.map((row) => {
        const own = isOwner && row.role === MessageRole.USER;
        const reason = own ? null : withholdReason(labelOf(row), reader);
        return { row, reason, content: reason ? null : this.decrypt(key, row) };
      });

      const titles = await this.documentTitles(
        principal.organizationId,
        decided
          .filter((entry) => !entry.reason)
          .flatMap((entry) => entry.row.citations.map((c) => c.documentId)),
      );

      messages = decided.map(({ row, reason, content }) =>
        toMessageDto(
          row,
          content,
          reason ? 'WITHHELD' : 'VISIBLE',
          reason ?? undefined,
          titles,
        ),
      );

      if (!isOwner && !reveal) {
        masked = await this.maskForSupervisor(principal.organizationId, messages);
      }
    } finally {
      this.destroyKey(key);
    }

    if (!isOwner) {
      await this.auditService.recordSafe({
        action: AuditAction.AGENT_CONVERSATION_SUPERVISED,
        organizationId: principal.organizationId,
        resourceType: 'conversation',
        resourceId: conversation.id,
        metadata: {
          operation: 'read-messages',
          ownerKind: conversation.userId ? 'user' : 'api_key',
          ownerId: conversation.userId ?? conversation.apiKeyId,
          messages: messages.length,
          withheld: messages.filter((message) => message.contentState === 'WITHHELD')
            .length,
          masked,
          revealed: reveal,
        },
      });
    }
    if (reveal) {
      // Written with the throwing form: a reveal that cannot be recorded does not happen.
      await this.auditService.record({
        action: AuditAction.PII_UNMASKED,
        organizationId: principal.organizationId,
        resourceType: 'conversation',
        resourceId: conversation.id,
        metadata: {
          purpose: 'conversation-supervision',
          messages: messages.filter((message) => message.content !== null).length,
        },
      });
    }

    return {
      messages,
      nextBefore: rows.length === query.limit && rows.length > 0 ? rows[0].sequence : null,
      masked,
      revealed: reveal,
    };
  }

  /** The reader's current access, in the form label checks need. */
  async readerFor(
    principal: AccessPrincipal,
    messages: ReadonlyArray<Pick<ConversationMessage, 'documentIds'>>,
  ): Promise<LabelReader> {
    const scope = await this.knowledgeAccess.resolveScope(principal);
    const documentIds = [...new Set(messages.flatMap((message) => message.documentIds))];
    return {
      clearance: scope.clearance,
      readableKnowledgeBaseIds: new Set(scope.knowledgeBases.keys()),
      deletedDocumentIds: await this.deletedDocuments(
        principal.organizationId,
        documentIds,
      ),
    };
  }

  /** Of `documentIds`, those that no longer exist (deleted or purged). */
  async deletedDocuments(
    organizationId: string,
    documentIds: string[],
  ): Promise<ReadonlySet<string>> {
    if (documentIds.length === 0) return new Set();
    const live: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM documents
        WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [organizationId, documentIds],
    );
    const alive = new Set(live.map((row) => row.id));
    return new Set(documentIds.filter((id) => !alive.has(id)));
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private async toDtos(
    principal: AccessPrincipal,
    conversations: Conversation[],
  ): Promise<ConversationDto[]> {
    if (conversations.length === 0) return [];

    const agentNames = new Map(
      (
        await this.dataSource.getRepository(Agent).find({
          where: { id: In([...new Set(conversations.map((c) => c.agentId))]) },
          withDeleted: true,
          select: { id: true, name: true },
        })
      ).map((agent) => [agent.id, agent.name]),
    );

    const titles = conversations.map((conversation) => {
      if (!conversation.wrappedDataKey || !conversation.titleCiphertext) return null;
      const key = this.unwrapKey(conversation);
      try {
        return this.decryptTitle(key, conversation);
      } finally {
        this.destroyKey(key);
      }
    });

    // Someone else's titles are derived from their messages: mask them.
    const foreign = conversations
      .map((conversation, index) => ({
        index,
        owned: this.isOwner(principal, conversation),
      }))
      .filter((entry) => !entry.owned && titles[entry.index] !== null);
    if (foreign.length > 0) {
      try {
        const outcome = await this.redaction.redact({
          organizationId: principal.organizationId,
          segments: foreign.map((entry) => ({
            id: String(entry.index),
            text: titles[entry.index] as string,
          })),
          purpose: 'supervision',
        });
        outcome.segments.forEach((segment) => (titles[Number(segment.id)] = segment.text));
        outcome.session?.destroy();
      } catch (error) {
        if (!(error instanceof AppException)) throw error;
        for (const entry of foreign) titles[entry.index] = null; // cannot mask: do not show
      }
    }

    return conversations.map((conversation, index) => ({
      id: conversation.id,
      agentId: conversation.agentId,
      agentName: agentNames.get(conversation.agentId) ?? null,
      title: titles[index],
      status: conversation.status,
      messageCount: conversation.messageCount,
      lastMessageAt: conversation.lastMessageAt,
      classification: conversation.classification,
      isOwner: this.isOwner(principal, conversation),
      ownerKind: conversation.userId ? 'user' : 'api_key',
      ownerUserId: conversation.userId,
      createdAt: conversation.createdAt,
    }));
  }

  /**
   * Masks visible content (and cited document titles) for a supervisor. When
   * detection is unavailable and the policy fails closed, the content is
   * withheld rather than shown unmasked.
   */
  private async maskForSupervisor(
    organizationId: string,
    messages: MessageDto[],
  ): Promise<boolean> {
    const visible = messages.filter((message) => message.content !== null);
    if (visible.length === 0) return false;

    const segments = [
      ...visible.map((message) => ({
        id: `m:${message.id}`,
        text: message.content as string,
      })),
      ...visible.flatMap((message) =>
        message.citations
          .filter((citation) => citation.documentTitle)
          .map((citation) => ({
            id: `t:${message.id}:${citation.tag}`,
            text: citation.documentTitle as string,
          })),
      ),
    ];

    try {
      const outcome = await this.redaction.redact({
        organizationId,
        segments,
        purpose: 'supervision',
      });
      try {
        if (!outcome.enabled) return false;
        const byId = new Map(outcome.segments.map((segment) => [segment.id, segment.text]));
        for (const message of visible) {
          message.content = byId.get(`m:${message.id}`) ?? null;
          message.contentState = 'MASKED';
          for (const citation of message.citations) {
            const title = byId.get(`t:${message.id}:${citation.tag}`);
            if (title !== undefined) citation.documentTitle = title;
          }
        }
        return true;
      } finally {
        outcome.session?.destroy();
      }
    } catch (error) {
      if (
        !(error instanceof AppException) ||
        error.code !== ErrorCode.PII_DETECTION_UNAVAILABLE
      ) {
        throw error;
      }
      for (const message of visible) {
        message.content = null;
        message.contentState = 'WITHHELD';
        message.withheldReason = 'REDACTION_UNAVAILABLE';
        for (const citation of message.citations) citation.documentTitle = null;
      }
      return true;
    }
  }

  private async documentTitles(
    organizationId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows: Array<{ id: string; title: string }> = await this.dataSource.query(
      `SELECT id, title FROM documents
        WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [organizationId, unique],
    );
    return new Map(rows.map((row) => [row.id, row.title]));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function labelOf(
  message: Pick<ConversationMessage, 'classification' | 'knowledgeBaseIds' | 'documentIds'>,
): InformationLabel {
  return {
    classification: message.classification,
    knowledgeBaseIds: message.knowledgeBaseIds ?? [],
    documentIds: message.documentIds ?? [],
  };
}

export function toMessageDto(
  message: ConversationMessage,
  content: string | null,
  state: MessageDto['contentState'],
  withheldReason: string | undefined,
  titles: ReadonlyMap<string, string>,
): MessageDto {
  const withheld = state === 'WITHHELD';
  const redaction = message.redaction as Partial<MessageDto['redaction']> & {
    enabled?: boolean;
  };
  const citations: CitationDto[] = withheld
    ? []
    : message.citations.map((citation) => ({
        tag: citation.tag,
        documentId: citation.documentId,
        documentTitle: titles.get(citation.documentId) ?? null,
        knowledgeBaseId: citation.knowledgeBaseId,
        chunkId: citation.chunkId,
        rank: citation.rank,
        score: citation.score,
        cited: citation.cited,
      }));

  return {
    id: message.id,
    sequence: message.sequence,
    role: message.role,
    status: message.status,
    content: withheld ? null : content,
    contentState: state,
    ...(withheldReason ? { withheldReason } : {}),
    classification: message.classification,
    citations,
    agentVersion: message.agentVersion,
    model: message.model,
    redaction:
      redaction && redaction.enabled !== undefined
        ? {
            enabled: redaction.enabled,
            degraded: redaction.degraded ?? false,
            entities: redaction.entities ?? 0,
            byType: redaction.byType ?? {},
          }
        : null,
    errorCode: message.errorCode,
    createdAt: message.createdAt,
  };
}

/** The first line of the first message, trimmed to a title. */
function deriveTitle(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
