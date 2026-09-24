import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type ProviderModel,
} from './providers/provider.types';

interface CachedList {
  models: ProviderModel[];
  fetchedAt: number;
}

/**
 * The models this deployment may use: what the endpoint serves, intersected
 * with the platform allowlist (`LLM_ALLOWED_MODELS`).
 *
 * The provider's list is cached briefly and served stale when the endpoint is
 * down, so the model picker keeps working through a GPU restart. Context
 * lengths are looked up once per model and remembered.
 */
@Injectable()
export class ModelCatalogueService {
  private readonly logger = new Logger(ModelCatalogueService.name);
  private readonly config: LlmConfig;
  private readonly platformAllowlist: ReadonlySet<string>;
  private cached: CachedList | null = null;
  private inflight: Promise<ProviderModel[]> | null = null;
  private readonly contextLengths = new Map<string, number | null>();

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
    this.platformAllowlist = new Set(
      this.config.allowedModels.map((name) => provider.normalizeModelName(name)),
    );
  }

  normalize(name: string): string {
    return this.provider.normalizeModelName(name);
  }

  get defaultModel(): string {
    return this.normalize(this.config.defaultModel);
  }

  /** Passes the static platform allowlist (or there is none). */
  isPlatformAllowed(name: string): boolean {
    return (
      this.platformAllowlist.size === 0 || this.platformAllowlist.has(this.normalize(name))
    );
  }

  /**
   * Models served by the endpoint and allowed by the platform.
   *
   * When the endpoint cannot be reached and nothing is cached, falls back to
   * the static allowlist (existence unverified) — or, with no allowlist, to
   * the default model alone.
   */
  async platformModels(): Promise<{ models: ProviderModel[]; verified: boolean }> {
    try {
      const listed = await this.fetchList();
      return {
        models: listed.filter((model) => this.isPlatformAllowed(model.name)),
        verified: true,
      };
    } catch (error) {
      this.logger.warn(`Model list unavailable: ${(error as Error).message}`);
      const names =
        this.platformAllowlist.size > 0 ? [...this.platformAllowlist] : [this.defaultModel];
      return {
        models: names.map((name) => ({
          name,
          family: null,
          parameterSize: null,
          quantization: null,
          contextLength: null,
          sizeBytes: null,
        })),
        verified: false,
      };
    }
  }

  /**
   * Whether the endpoint serves `name`: a definite answer where its model list
   * is authoritative and reachable, null otherwise (the endpoint then decides).
   *
   * A miss is re-checked against a freshly fetched list, never a cached or
   * stale one: the model may have been pulled a moment ago, and an old list
   * proves nothing about the present.
   */
  async isServed(name: string): Promise<boolean | null> {
    if (!this.provider.listsEveryServedModel) return null;
    const model = this.normalize(name);
    const listed = (models: ProviderModel[]) =>
      models.some((entry) => entry.name === model);
    try {
      if (listed(await this.fetchList())) return true;
      return listed(await this.fetchList({ force: true, allowStale: false }));
    } catch {
      return null;
    }
  }

  /** The model's own context length, where the endpoint reports one. */
  async contextLength(name: string): Promise<number | null> {
    const model = this.normalize(name);
    if (this.contextLengths.has(model)) return this.contextLengths.get(model) ?? null;

    const listed = this.cached?.models.find((entry) => entry.name === model)?.contextLength;
    if (listed) {
      this.contextLengths.set(model, listed);
      return listed;
    }

    try {
      const { contextLength } = await this.provider.describeModel(
        model,
        AbortSignal.timeout(10_000),
      );
      this.contextLengths.set(model, contextLength);
      return contextLength;
    } catch (error) {
      // Not cached: a transient failure should not pin the default forever.
      this.logger.debug(`Could not describe ${model}: ${(error as Error).message}`);
      return null;
    }
  }

  private async fetchList(
    options: { force?: boolean; allowStale?: boolean } = {},
  ): Promise<ProviderModel[]> {
    const { force = false, allowStale = true } = options;
    if (
      !force &&
      this.cached &&
      Date.now() - this.cached.fetchedAt < this.config.modelCacheTtlMs
    ) {
      return this.cached.models;
    }

    // One refresh at a time; concurrent callers share it.
    this.inflight ??= this.provider
      .listModels(AbortSignal.timeout(10_000))
      .then((models) => {
        this.cached = { models, fetchedAt: Date.now() };
        return models;
      })
      .finally(() => {
        this.inflight = null;
      });

    try {
      return await this.inflight;
    } catch (error) {
      if (allowStale && this.cached) return this.cached.models; // stale beats nothing
      throw error;
    }
  }
}
