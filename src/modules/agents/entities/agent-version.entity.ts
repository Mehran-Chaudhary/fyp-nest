import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AgentConfig } from '../domain/agent-config';
import { Agent } from './agent.entity';

/**
 * One immutable version of an agent's behaviour.
 *
 * Append-only, enforced by a trigger that rejects UPDATE: a version is
 * evidence of what an agent was told to do at a point in time, and every
 * answer records the version that produced it. "Which prompt produced this
 * answer?" therefore always has an exact answer, even after the agent has been
 * edited ten times since.
 *
 * The instructions are encrypted: a system prompt routinely describes internal
 * policy ("never disclose the bonus pool before March"), and it would
 * otherwise sit in clear text in every database backup.
 */
@Entity('agent_versions')
@Index('uq_agent_versions_agent_version', ['agentId', 'version'], { unique: true })
export class AgentVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'uuid', name: 'agent_id' })
  agentId: string;

  @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_id' })
  agent?: Agent;

  @Column({ type: 'integer', name: 'version' })
  version: number;

  @Column({ type: 'jsonb', name: 'config' })
  config: AgentConfig;

  @Column({ type: 'text', name: 'instructions_ciphertext' })
  instructionsCiphertext: string;

  /** SHA-256 of config and instructions; identical behaviour has an identical digest. */
  @Column({ type: 'varchar', length: 64, name: 'config_digest' })
  configDigest: string;

  @Column({ type: 'varchar', length: 500, name: 'change_note', nullable: true })
  changeNote: string | null;

  @Column({ type: 'integer', name: 'restored_from_version', nullable: true })
  restoredFromVersion: number | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;
}
