import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base/base.entity';
import { ApiKey } from '../../api-keys/entities/api-key.entity';
import { OrganizationMember } from '../../memberships/entities/organization-member.entity';
import { Role } from '../../rbac/entities/role.entity';
import { AccessLevel } from '../domain/access';
import { KnowledgeBase } from './knowledge-base.entity';

export enum GrantSubjectType {
  ROLE = 'ROLE',
  MEMBER = 'MEMBER',
  API_KEY = 'API_KEY',
}

/**
 * Admits a subject into a RESTRICTED knowledge base at a given level.
 *
 * Exactly one of `roleId`, `memberId` or `apiKeyId` is set — enforced by a
 * CHECK constraint, not just here — and each is a real foreign key with
 * `ON DELETE CASCADE`, so a grant can never outlive what it grants to.
 *
 * Member grants reference the *membership*, not the user. Removing someone from
 * the workspace therefore voids their grants for good: if they are invited back
 * they get a new membership, and none of the old compartments.
 */
@Entity('knowledge_base_grants')
@Index('idx_kb_grants_knowledge_base', ['knowledgeBaseId'])
export class KnowledgeBaseGrant extends BaseEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'uuid', name: 'knowledge_base_id' })
  knowledgeBaseId: string;

  @ManyToOne(() => KnowledgeBase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'knowledge_base_id' })
  knowledgeBase?: KnowledgeBase;

  @Column({ type: 'uuid', name: 'role_id', nullable: true })
  roleId: string | null;

  @ManyToOne(() => Role, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'role_id' })
  role?: Role | null;

  @Column({ type: 'uuid', name: 'member_id', nullable: true })
  memberId: string | null;

  @ManyToOne(() => OrganizationMember, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'member_id' })
  member?: OrganizationMember | null;

  @Column({ type: 'uuid', name: 'api_key_id', nullable: true })
  apiKeyId: string | null;

  @ManyToOne(() => ApiKey, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'api_key_id' })
  apiKey?: ApiKey | null;

  @Column({ type: 'varchar', length: 16, name: 'access_level' })
  accessLevel: AccessLevel;

  @Column({ type: 'uuid', name: 'granted_by_id', nullable: true })
  grantedById: string | null;

  get subjectType(): GrantSubjectType {
    if (this.roleId) return GrantSubjectType.ROLE;
    if (this.memberId) return GrantSubjectType.MEMBER;
    return GrantSubjectType.API_KEY;
  }

  get subjectId(): string {
    return (this.roleId ?? this.memberId ?? this.apiKeyId) as string;
  }
}
