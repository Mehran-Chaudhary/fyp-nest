import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import { Classification } from '../../knowledge/domain/classification';
import { Organization } from '../../organizations/entities/organization.entity';
import { Agent } from './agent.entity';

export enum ConversationStatus {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
}

/**
 * A conversation between one principal and one agent (proposal module 6.10).
 *
 * ## Encrypted like a document
 *
 * Every message and the title are sealed under this conversation's own data
 * key, stored only wrapped by the platform master key — the envelope scheme of
 * ADR 0002. Deleting the conversation destroys the key in the same
 * transaction, which makes every copy of its content unreadable at once,
 * backups included.
 *
 * ## High-water mark
 *
 * `classification` and `knowledgeBaseIds` only ever rise: they are the join of
 * every message's label, i.e. the most sensitive material the conversation
 * has drawn on. A new user message inherits them (see `domain/labels.ts`).
 *
 * ## One turn at a time
 *
 * `turnLockId` / `turnLockExpiresAt` form a lease taken for the duration of a
 * turn, so two concurrent sends cannot interleave their questions and answers.
 * A lease rather than a flag: a process that dies mid-turn cannot wedge the
 * conversation for longer than the lease.
 */
@Entity('conversations')
@Index('idx_conversations_org_agent', ['organizationId', 'agentId'])
export class Conversation extends SoftDeletableEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'uuid', name: 'agent_id' })
  agentId: string;

  @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_id' })
  agent?: Agent;

  /** Exactly one of `userId` / `apiKeyId` is set: the conversation's owner. */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId: string | null;

  @Column({ type: 'uuid', name: 'api_key_id', nullable: true })
  apiKeyId: string | null;

  @Column({ type: 'text', name: 'title_ciphertext', nullable: true, select: false })
  titleCiphertext?: string | null;

  /** Null once shredded. */
  @Column({ type: 'text', name: 'wrapped_data_key', nullable: true, select: false })
  wrappedDataKey?: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'status',
    default: ConversationStatus.ACTIVE,
  })
  status: ConversationStatus;

  @Column({ type: 'integer', name: 'message_count', default: 0 })
  messageCount: number;

  @Column({ type: 'timestamptz', name: 'last_message_at', nullable: true })
  lastMessageAt: Date | null;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'classification',
    default: Classification.PUBLIC,
  })
  classification: Classification;

  @Column({ type: 'jsonb', name: 'knowledge_base_ids', default: () => "'[]'::jsonb" })
  knowledgeBaseIds: string[];

  @Column({ type: 'uuid', name: 'turn_lock_id', nullable: true })
  turnLockId: string | null;

  @Column({ type: 'timestamptz', name: 'turn_lock_expires_at', nullable: true })
  turnLockExpiresAt: Date | null;

  @Column({ type: 'bigint', name: 'prompt_tokens', default: 0 })
  promptTokens: string;

  @Column({ type: 'bigint', name: 'completion_tokens', default: 0 })
  completionTokens: string;
}
