import { Column, Entity, Index } from 'typeorm';
import { SoftDeletableEntity } from '../../../database/base/base.entity';
import type { ToolDataPolicy } from '../domain/information-flow';
import type { JsonSchema } from '../domain/json-schema';
import type { HttpToolConfig, ToolKind } from '../domain/tool-definition';

/**
 * A workspace-defined tool (built-in tools are code, not rows).
 *
 * The credential an HTTP tool authenticates with is stored only as
 * ciphertext, bound by associated data to this tool's id, and is write-only
 * through the API: it can be replaced, never read back. `version` increases
 * with every change to behaviour, and every execution records the version and
 * digest it ran, so "what exactly did this tool do on Tuesday?" has an answer
 * after the definition has moved on.
 */
@Entity('tools')
@Index('idx_tools_org', ['organizationId'])
export class Tool extends SoftDeletableEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'varchar', length: 48, name: 'name' })
  name: string;

  @Column({ type: 'varchar', length: 80, name: 'display_name' })
  displayName: string;

  @Column({ type: 'text', name: 'description' })
  description: string;

  @Column({ type: 'varchar', length: 16, name: 'kind' })
  kind: ToolKind;

  @Column({ type: 'jsonb', name: 'parameters' })
  parameters: JsonSchema;

  @Column({ type: 'jsonb', name: 'config' })
  config: HttpToolConfig;

  @Column({ type: 'jsonb', name: 'data_policy' })
  dataPolicy: ToolDataPolicy;

  @Column({ type: 'boolean', name: 'requires_approval', default: false })
  requiresApproval: boolean;

  @Column({ type: 'integer', name: 'timeout_ms' })
  timeoutMs: number;

  @Column({ type: 'boolean', name: 'enabled', default: true })
  enabled: boolean;

  @Column({ type: 'integer', name: 'version', default: 1 })
  version: number;

  @Column({ type: 'varchar', length: 64, name: 'definition_digest' })
  definitionDigest: string;

  /** Never selected by default: only the executor reads it, to authenticate. */
  @Column({ type: 'text', name: 'secret_ciphertext', nullable: true, select: false })
  secretCiphertext: string | null;

  @Column({ type: 'boolean', name: 'has_secret', default: false })
  hasSecret: boolean;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @Column({ type: 'uuid', name: 'updated_by_id', nullable: true })
  updatedById: string | null;
}
