import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException, ConflictError } from '../../common/exceptions/app.exception';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import { AuditService } from '../audit/audit.service';
import type { LlmModelDto, LlmPolicyDto, UpdateLlmPolicyDto } from './dto/llm.dto';
import { LlmPolicy } from './entities/llm-policy.entity';
import { ModelCatalogueService } from './model-catalogue.service';

export interface EffectiveLlmPolicy {
  organizationId: string;
  /** Empty: every model the platform allows. */
  allowedModels: string[];
  defaultModel: string | null;
  maxOutputTokens: number | null;
  maxContextTokens: number | null;
  source: 'default' | 'workspace';
  version: number;
}

/** A model choice, checked and sized for one request. */
export interface ResolvedModel {
  name: string;
  /** Context window to request: the tightest of model, platform, workspace and agent. */
  contextWindow: number;
  /** Output ceiling: the tighter of platform and workspace. */
  maxOutputTokens: number;
  policy: EffectiveLlmPolicy;
}

/**
 * Which models a workspace may use (proposal module 6.7, "model allowlisting
 * per workspace"), and the sizing of every request.
 *
 * Three allowlists apply, narrowing in turn: what the endpoint serves, what
 * the platform allows (`LLM_ALLOWED_MODELS`), what the workspace allows. A
 * model outside any of them is refused with `LLM_MODEL_NOT_ALLOWED` naming the
 * ones that are available.
 */
@Injectable()
export class LlmPolicyService {
  private readonly config: LlmConfig;

  constructor(
    @InjectRepository(LlmPolicy)
    private readonly repository: Repository<LlmPolicy>,
    private readonly dataSource: DataSource,
    private readonly catalogue: ModelCatalogueService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
  }

  async getEffective(organizationId: string): Promise<EffectiveLlmPolicy> {
    const row = await this.repository.findOne({ where: { organizationId } });
    if (!row) {
      return {
        organizationId,
        allowedModels: [],
        defaultModel: null,
        maxOutputTokens: null,
        maxContextTokens: null,
        source: 'default',
        version: 0,
      };
    }
    return {
      organizationId,
      allowedModels: row.allowedModels.map((name) => this.catalogue.normalize(name)),
      defaultModel: row.defaultModel ? this.catalogue.normalize(row.defaultModel) : null,
      maxOutputTokens: row.maxOutputTokens,
      maxContextTokens: row.maxContextTokens,
      source: 'workspace',
      version: row.version,
    };
  }

  /** The workspace's default model: its own choice, else the platform's. */
  defaultModelOf(policy: EffectiveLlmPolicy): string {
    return policy.defaultModel ?? this.catalogue.defaultModel;
  }

  isAllowed(policy: EffectiveLlmPolicy, name: string): boolean {
    const model = this.catalogue.normalize(name);
    return (
      this.catalogue.isPlatformAllowed(model) &&
      (policy.allowedModels.length === 0 || policy.allowedModels.includes(model))
    );
  }

  /**
   * Chooses the model for a request — the first of `candidates` that is set,
   * else the workspace default — checks every allowlist, and sizes the context
   * window and output ceiling.
   */
  async resolve(
    organizationId: string,
    candidates: Array<string | null | undefined>,
    agentContextWindow?: number | null,
  ): Promise<ResolvedModel> {
    const policy = await this.getEffective(organizationId);
    const requested = candidates.find((candidate): candidate is string => !!candidate);
    const name = this.catalogue.normalize(requested ?? this.defaultModelOf(policy));

    if (!this.isAllowed(policy, name)) {
      const { models } = await this.catalogue.platformModels();
      throw new AppException(
        ErrorCode.LLM_MODEL_NOT_ALLOWED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          details: {
            model: name,
            allowedModels: models
              .map((model) => model.name)
              .filter((model) => this.isAllowed(policy, model)),
          },
        },
      );
    }

    // A model the endpoint does not have is a mistake in the request, reported
    // before any work is done on it — not a failure half-way through a stream.
    if ((await this.catalogue.isServed(name)) === false) {
      const { models } = await this.catalogue.platformModels();
      throw new AppException(
        ErrorCode.LLM_MODEL_NOT_FOUND,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          details: {
            model: name,
            availableModels: models
              .map((model) => model.name)
              .filter((model) => this.isAllowed(policy, model)),
          },
        },
      );
    }

    const modelContext = await this.catalogue.contextLength(name);
    const contextWindow = Math.min(
      modelContext ?? this.config.defaultContextWindow,
      this.config.maxContextWindow,
      policy.maxContextTokens ?? Number.POSITIVE_INFINITY,
      agentContextWindow ?? Number.POSITIVE_INFINITY,
    );
    const maxOutputTokens = Math.min(
      this.config.maxOutputTokens,
      policy.maxOutputTokens ?? Number.POSITIVE_INFINITY,
      // Never let the answer claim more than half the window.
      Math.floor(contextWindow / 2),
    );

    return { name, contextWindow, maxOutputTokens, policy };
  }

  /** Models for the workspace's picker, each marked allowed or not. */
  async listModels(
    organizationId: string,
  ): Promise<{ models: LlmModelDto[]; verified: boolean }> {
    const policy = await this.getEffective(organizationId);
    const { models, verified } = await this.catalogue.platformModels();
    const defaultModel = this.defaultModelOf(policy);

    return {
      verified,
      models: models.map((model) => ({
        name: model.name,
        family: model.family,
        parameterSize: model.parameterSize,
        quantization: model.quantization,
        contextLength: model.contextLength,
        sizeBytes: model.sizeBytes,
        allowed: this.isAllowed(policy, model.name),
        isDefault: model.name === defaultModel,
      })),
    };
  }

  async describe(organizationId: string): Promise<LlmPolicyDto> {
    return this.toDto(await this.getEffective(organizationId));
  }

  async update(
    organizationId: string,
    actorUserId: string | undefined,
    input: UpdateLlmPolicyDto,
  ): Promise<LlmPolicyDto> {
    const normalizedAllowed = input.allowedModels?.map((name) =>
      this.catalogue.normalize(name),
    );
    const normalizedDefault =
      input.defaultModel === undefined
        ? undefined
        : input.defaultModel === null
          ? null
          : this.catalogue.normalize(input.defaultModel);

    const notPlatformAllowed = [
      ...(normalizedAllowed ?? []),
      ...(normalizedDefault ? [normalizedDefault] : []),
    ].filter((name) => !this.catalogue.isPlatformAllowed(name));
    if (notPlatformAllowed.length > 0) {
      throw new AppException(
        ErrorCode.LLM_MODEL_NOT_ALLOWED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          message: 'A workspace can only choose among the models the platform allows.',
          details: { models: notPlatformAllowed },
        },
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(LlmPolicy);
      const existing = await repository
        .createQueryBuilder('policy')
        .setLock('pessimistic_write')
        .where('policy.organization_id = :organizationId', { organizationId })
        .getOne();

      const currentVersion = existing?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new ConflictError(ErrorCode.RESOURCE_CONFLICT, {
          message: 'The model policy was changed by someone else. Reload it and try again.',
          details: { expectedVersion: input.expectedVersion, currentVersion },
        });
      }

      const row = existing ?? repository.create({ organizationId, allowedModels: [] });
      const before = {
        allowedModels: [...row.allowedModels],
        defaultModel: row.defaultModel ?? null,
        maxOutputTokens: row.maxOutputTokens ?? null,
        maxContextTokens: row.maxContextTokens ?? null,
      };

      if (normalizedAllowed !== undefined)
        row.allowedModels = [...new Set(normalizedAllowed)].sort();
      if (normalizedDefault !== undefined) row.defaultModel = normalizedDefault;
      if (input.maxOutputTokens !== undefined) row.maxOutputTokens = input.maxOutputTokens;
      if (input.maxContextTokens !== undefined)
        row.maxContextTokens = input.maxContextTokens;
      row.updatedById = actorUserId ?? null;

      // The default must itself be allowed, or every agent without a model breaks.
      if (
        row.defaultModel &&
        row.allowedModels.length > 0 &&
        !row.allowedModels.includes(row.defaultModel)
      ) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            message: 'The default model must be one of the allowed models.',
          },
        );
      }

      const stored = await repository.save(row);

      await this.auditService.record(
        {
          action: AuditAction.LLM_POLICY_UPDATED,
          organizationId,
          resourceType: 'llm_policy',
          resourceId: organizationId,
          metadata: {
            before,
            after: {
              allowedModels: stored.allowedModels,
              defaultModel: stored.defaultModel,
              maxOutputTokens: stored.maxOutputTokens,
              maxContextTokens: stored.maxContextTokens,
            },
            version: stored.version,
          },
        },
        manager,
      );

      return stored;
    });

    return this.toDto(await this.getEffective(saved.organizationId));
  }

  private toDto(policy: EffectiveLlmPolicy): LlmPolicyDto {
    return {
      source: policy.source,
      version: policy.version,
      allowedModels: policy.allowedModels,
      defaultModel: policy.defaultModel,
      maxOutputTokens: policy.maxOutputTokens,
      maxContextTokens: policy.maxContextTokens,
      effective: {
        defaultModel: this.defaultModelOf(policy),
        maxOutputTokens: Math.min(
          this.config.maxOutputTokens,
          policy.maxOutputTokens ?? Number.POSITIVE_INFINITY,
        ),
        maxContextTokens: Math.min(
          this.config.maxContextWindow,
          policy.maxContextTokens ?? Number.POSITIVE_INFINITY,
        ),
        platformAllowlist: this.config.allowedModels,
        maxClassification: this.config.maxClassification,
      },
    };
  }
}
