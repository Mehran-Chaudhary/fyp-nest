import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Role } from '../../rbac/entities/role.entity';
import { User } from '../../users/entities/user.entity';
import { AgentAccessMode, AgentVisibility } from '../domain/agent-config';

/**
 * An agent: a "digital employee" with a persona, instructions, a model and the
 * knowledge bases it consults (proposal module 6.8).
 *
 * This row is the agent's identity and its access settings. Its behaviour —
 * persona, instructions, model, parameters, retrieval and memory settings —
 * lives in immutable `agent_versions` rows; `currentVersion` points at the one
 * in force. Changing an agent never edits history: it appends a version, and
 * rolling back appends a copy of an older one.
 */
@Entity('agents')
// (organization_id, lower(name)) uniqueness is a partial expression index in the migration.
@Index('idx_agents_org', ['organizationId'])
export class Agent extends SoftDeletableEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'varchar', length: 80, name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'visibility',
    default: AgentVisibility.PRIVATE,
  })
  visibility: AgentVisibility;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'access_mode',
    default: AgentAccessMode.WORKSPACE,
  })
  accessMode: AgentAccessMode;

  /** Roles allowed to use the agent when `accessMode` is RESTRICTED. */
  @ManyToMany(() => Role, { cascade: false })
  @JoinTable({
    name: 'agent_allowed_roles',
    joinColumn: { name: 'agent_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  allowedRoles?: Role[];

  @Column({ type: 'integer', name: 'current_version', default: 1 })
  currentVersion: number;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_id' })
  createdBy?: User | null;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'uuid', name: 'published_by_id', nullable: true })
  publishedById: string | null;

  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt: Date | null;
}
