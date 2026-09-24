import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { ConflictError, ValidationError } from '../../common/exceptions/app.exception';
import { PII_CONFIG_KEY, type PiiConfig } from '../../config/pii.config';
import { EncryptionService } from '../../shared/crypto/encryption.service';
import { AuditService } from '../audit/audit.service';
import { ENTITY_TYPE_PATTERN, needsNer } from './domain/entity-catalogue';
import { normalizeEntityTypes, nerTypesOf, type EffectivePiiPolicy } from './domain/policy';
import { NER_DETECTOR, type NerDetector } from './detection/ner-detector';
import type { PiiPolicyDto, UpdatePiiPolicyDto } from './dto/privacy.dto';
import { PiiPolicy } from './entities/pii-policy.entity';

const MAX_ENTITY_TYPES = 60;

/**
 * The per-workspace redaction policy (`pii:policy:read`, `pii:policy:update`).
 *
 * Read on every request that reaches the model and deliberately not cached:
 * one primary-key lookup is cheap, and a cache would let a just-tightened
 * policy go unenforced for its TTL on other instances.
 */
@Injectable()
export class PiiPolicyService {
  private readonly config: PiiConfig;

  constructor(
    @InjectRepository(PiiPolicy)
    private readonly repository: Repository<PiiPolicy>,
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly auditService: AuditService,
    @Inject(NER_DETECTOR) private readonly ner: NerDetector,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<PiiConfig>(PII_CONFIG_KEY);
  }

  async getEffective(organizationId: string): Promise<EffectivePiiPolicy> {
    const row = await this.repository.findOne({ where: { organizationId } });
    return row ? this.fromRow(row) : this.defaults(organizationId);
  }

  defaults(organizationId: string): EffectivePiiPolicy {
    const { defaults } = this.config;
    return {
      organizationId,
      enabled: true,
      entityTypes: normalizeEntityTypes(defaults.entityTypes, []),
      scoreThreshold: defaults.scoreThreshold,
      onDetectorFailure: defaults.onDetectorFailure,
      language: defaults.language,
      allowList: [],
      denyList: [],
      source: 'default',
      version: 0,
      updatedAt: null,
    };
  }

  /**
   * The policy as shown to a reader. Deny-list terms are shown only to those
   * who may change them: the list is usually a set of confidential names, and
   * `pii:policy:read` is held by every ordinary member.
   */
  async describe(organizationId: string, canManage: boolean): Promise<PiiPolicyDto> {
    return this.toDto(await this.getEffective(organizationId), canManage);
  }

  async update(
    organizationId: string,
    actorUserId: string | undefined,
    input: UpdatePiiPolicyDto,
  ): Promise<PiiPolicyDto> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(PiiPolicy);
      // Row lock: concurrent edits serialise, and `expectedVersion` below is
      // checked against the committed state.
      const existing = await repository
        .createQueryBuilder('policy')
        .setLock('pessimistic_write')
        .where('policy.organization_id = :organizationId', { organizationId })
        .getOne();

      const before = existing ? this.fromRow(existing) : this.defaults(organizationId);

      if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
        throw new ConflictError(ErrorCode.RESOURCE_CONFLICT, {
          message:
            'The redaction policy was changed by someone else. Reload it and try again.',
          details: {
            expectedVersion: input.expectedVersion,
            currentVersion: before.version,
          },
        });
      }

      const allowList = input.allowList ?? before.allowList;
      const denyList = input.denyList ?? before.denyList;
      const entityTypes = normalizeEntityTypes(
        input.entityTypes ?? before.entityTypes,
        denyList,
      );
      this.validateTypes(entityTypes);

      const row = existing ?? repository.create({ organizationId });
      row.enabled = input.enabled ?? before.enabled;
      row.entityTypes = entityTypes;
      row.scoreThreshold = input.scoreThreshold ?? before.scoreThreshold;
      row.onDetectorFailure = input.onDetectorFailure ?? before.onDetectorFailure;
      row.language = input.language ?? before.language;
      row.allowListCiphertext = this.seal(organizationId, 'allow', allowList);
      row.denyListCiphertext = this.seal(organizationId, 'deny', denyList);
      row.updatedById = actorUserId ?? null;

      const stored = await repository.save(row);
      const after = this.fromRow(stored);

      await this.auditService.record(
        {
          action: AuditAction.PII_POLICY_UPDATED,
          organizationId,
          resourceType: 'pii_policy',
          resourceId: organizationId,
          metadata: diff(before, after),
        },
        manager,
      );

      return after;
    });

    return this.toDto(saved, true);
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private fromRow(row: PiiPolicy): EffectivePiiPolicy {
    const allowList = this.open(row.organizationId, 'allow', row.allowListCiphertext);
    const denyList = this.open(row.organizationId, 'deny', row.denyListCiphertext);
    return {
      organizationId: row.organizationId,
      enabled: row.enabled,
      entityTypes: normalizeEntityTypes(row.entityTypes, denyList),
      scoreThreshold: Number(row.scoreThreshold),
      onDetectorFailure: row.onDetectorFailure,
      language: row.language,
      allowList,
      denyList,
      source: 'workspace',
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }

  toDto(policy: EffectivePiiPolicy, canManage: boolean): PiiPolicyDto {
    const nerTypes = nerTypesOf(policy);
    const warnings: string[] = [];

    if (!policy.enabled) {
      warnings.push('Redaction is disabled: prompts reach the model without masking.');
    }
    if (policy.enabled && nerTypes.length > 0 && !this.ner.isConfigured) {
      warnings.push(
        `${nerTypes.join(', ')} need the NER detector, which this deployment has not configured ` +
          `(${this.ner.missingConfiguration.join(', ')}). ` +
          (policy.onDetectorFailure === 'REFUSE'
            ? 'Requests to the model will be refused until it is.'
            : 'They will go undetected; only pattern-based types are masked.'),
      );
    }

    return {
      source: policy.source,
      version: policy.version,
      enabled: policy.enabled,
      entityTypes: policy.entityTypes,
      nerEntityTypes: nerTypes,
      scoreThreshold: policy.scoreThreshold,
      onDetectorFailure: policy.onDetectorFailure,
      language: policy.language,
      allowList: policy.allowList,
      denyList: canManage ? policy.denyList : null,
      denyListCount: policy.denyList.length,
      nerDetector: {
        kind: this.ner.kind,
        configured: this.ner.isConfigured,
        missingConfiguration: this.ner.missingConfiguration,
      },
      warnings,
      updatedAt: policy.updatedAt,
    };
  }

  private validateTypes(types: readonly string[]): void {
    const invalid = types.filter((type) => !ENTITY_TYPE_PATTERN.test(type));
    if (invalid.length > 0 || types.length > MAX_ENTITY_TYPES) {
      throw new ValidationError({
        message:
          invalid.length > 0
            ? 'Entity types must be upper-case names such as PERSON or CREDIT_CARD.'
            : `A policy may name at most ${MAX_ENTITY_TYPES} entity types.`,
        details: { invalidEntityTypes: invalid },
      });
    }
  }

  private seal(
    organizationId: string,
    list: 'allow' | 'deny',
    values: readonly string[],
  ): string | null {
    return values.length === 0
      ? null
      : this.encryption.encrypt(
          JSON.stringify(values),
          `pii-policy:${organizationId}:${list}`,
        );
  }

  private open(
    organizationId: string,
    list: 'allow' | 'deny',
    sealed: string | null,
  ): string[] {
    if (!sealed) return [];
    const parsed: unknown = JSON.parse(
      this.encryption.decrypt(sealed, `pii-policy:${organizationId}:${list}`),
    );
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  }
}

/**
 * What changed, for the audit record. Term lists are summarised by count:
 * the audit log must not become a second copy of the deny list.
 */
function diff(
  before: EffectivePiiPolicy,
  after: EffectivePiiPolicy,
): Record<string, unknown> {
  const added = after.entityTypes.filter((type) => !before.entityTypes.includes(type));
  const removed = before.entityTypes.filter((type) => !after.entityTypes.includes(type));
  const weakened =
    (before.enabled && !after.enabled) ||
    removed.length > 0 ||
    after.scoreThreshold > before.scoreThreshold ||
    (before.onDetectorFailure === 'REFUSE' && after.onDetectorFailure !== 'REFUSE') ||
    after.allowList.length > before.allowList.length;

  return {
    version: after.version,
    enabled:
      before.enabled === after.enabled
        ? undefined
        : { from: before.enabled, to: after.enabled },
    entityTypesAdded: added.length > 0 ? added : undefined,
    entityTypesRemoved: removed.length > 0 ? removed : undefined,
    scoreThreshold:
      before.scoreThreshold === after.scoreThreshold
        ? undefined
        : { from: before.scoreThreshold, to: after.scoreThreshold },
    onDetectorFailure:
      before.onDetectorFailure === after.onDetectorFailure
        ? undefined
        : { from: before.onDetectorFailure, to: after.onDetectorFailure },
    language:
      before.language === after.language
        ? undefined
        : { from: before.language, to: after.language },
    allowListSize: { from: before.allowList.length, to: after.allowList.length },
    denyListSize: { from: before.denyList.length, to: after.denyList.length },
    nerDependentTypes: after.entityTypes.filter(needsNer),
    // Flags the changes a reviewer should look at first.
    weakened,
  };
}
