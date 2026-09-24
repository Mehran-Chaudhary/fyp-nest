import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { VersionedEntity } from '../../../database/base/base.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { User } from '../../users/entities/user.entity';
import { Classification } from '../domain/classification';
import { KnowledgeBaseAccessMode } from '../domain/access';

/**
 * A knowledge base: a named collection of documents and an access compartment
 * (proposal modules 6.4–6.6).
 *
 * The embedding model is fixed at creation and recorded here. Vectors from two
 * models live in unrelated spaces, so a base's documents must all be embedded
 * by the same one; recording it is what lets a future model change be detected
 * and handled as a re-index rather than silently producing nonsense scores.
 */
@Entity('knowledge_bases')
// (organization_id, lower(name)) uniqueness is a partial expression index in the migration.
@Index('idx_knowledge_bases_org', ['organizationId'])
export class KnowledgeBase extends VersionedEntity {
  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'varchar', length: 120, name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'access_mode',
    default: KnowledgeBaseAccessMode.WORKSPACE,
  })
  accessMode: KnowledgeBaseAccessMode;

  /** Applied to uploads that do not specify a classification. */
  @Column({
    type: 'varchar',
    length: 16,
    name: 'default_classification',
    default: Classification.INTERNAL,
  })
  defaultClassification: Classification;

  @Column({ type: 'varchar', length: 128, name: 'embedding_model' })
  embeddingModel: string;

  @Column({ type: 'integer', name: 'embedding_dimensions' })
  embeddingDimensions: number;

  /** Overrides the workspace default when set. */
  @Column({ type: 'integer', name: 'chunk_size', nullable: true })
  chunkSize: number | null;

  @Column({ type: 'integer', name: 'chunk_overlap', nullable: true })
  chunkOverlap: number | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_id' })
  createdBy?: User | null;

  /** Set once a deleted base's content has been destroyed everywhere. */
  @Column({ type: 'timestamptz', name: 'purged_at', nullable: true })
  purgedAt: Date | null;
}
