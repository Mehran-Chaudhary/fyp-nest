import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import { ModelCatalogueService } from './model-catalogue.service';
import { OllamaProvider } from './providers/ollama.provider';
import type { LlmProvider, ProviderModel } from './providers/provider.types';

/**
 * The model catalogue: which models exist and are allowed. A request for a
 * model the endpoint does not have should fail as a request error before any
 * work is done — but only where the endpoint's list can be trusted.
 */

const CONFIG = {
  defaultModel: 'llama3.1:8b',
  allowedModels: [] as string[],
  modelCacheTtlMs: 60_000,
} as unknown as LlmConfig;

function listed(...names: string[]): ProviderModel[] {
  return names.map((name) => ({
    name,
    family: null,
    parameterSize: null,
    quantization: null,
    contextLength: null,
    sizeBytes: null,
  }));
}

class ListingProvider implements Pick<
  LlmProvider,
  'kind' | 'listsEveryServedModel' | 'normalizeModelName' | 'listModels'
> {
  readonly kind = 'ollama' as const;
  readonly listsEveryServedModel: boolean;
  readonly lists: Array<ProviderModel[] | Error> = [];
  calls = 0;
  private readonly ollama = new OllamaProvider(CONFIG);

  constructor(authoritative = true) {
    this.listsEveryServedModel = authoritative;
  }

  normalizeModelName(name: string): string {
    return this.ollama.normalizeModelName(name);
  }

  listModels(): Promise<ProviderModel[]> {
    this.calls += 1;
    const next = this.lists.shift();
    if (!next) return Promise.reject(new Error('unreachable'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

function catalogue(provider: ListingProvider, overrides: Partial<LlmConfig> = {}) {
  const config = {
    getOrThrow: (key: string) => {
      if (key !== LLM_CONFIG_KEY) throw new Error(key);
      return { ...CONFIG, ...overrides };
    },
  } as unknown as ConfigService;
  return new ModelCatalogueService(provider as unknown as LlmProvider, config);
}

describe('model catalogue', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('finds a served model under its normalised name, from the cache', async () => {
    const provider = new ListingProvider();
    provider.lists.push(listed('llama3.1:latest', 'qwen2.5:7b'));
    const models = catalogue(provider);
    expect(await models.isServed('llama3.1')).toBe(true);
    expect(await models.isServed('qwen2.5:7b')).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('re-checks a miss against a fresh list, so a model pulled a moment ago is found', async () => {
    const provider = new ListingProvider();
    provider.lists.push(
      listed('llama3.1:latest'),
      listed('llama3.1:latest', 'mistral:latest'),
    );
    expect(await catalogue(provider).isServed('mistral')).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it('reports a model missing from a fresh list as not served', async () => {
    const provider = new ListingProvider();
    provider.lists.push(listed('llama3.1:latest'), listed('llama3.1:latest'));
    expect(await catalogue(provider).isServed('no-such-model')).toBe(false);
  });

  it('never concludes "not served" from a stale list', async () => {
    const provider = new ListingProvider();
    provider.lists.push(
      listed('llama3.1:latest'),
      new Error('GPU host restarting'),
      new Error('still restarting'),
    );
    const models = catalogue(provider, { modelCacheTtlMs: 0 });
    expect(await models.isServed('llama3.1')).toBe(true); // a fresh list
    // Now only a stale list is available: absent from it proves nothing.
    expect(await models.isServed('mistral')).toBe(null);
  });

  it('leaves the decision to the endpoint when its list is not authoritative', async () => {
    const provider = new ListingProvider(false);
    expect(await catalogue(provider).isServed('anything')).toBe(null);
    expect(provider.calls).toBe(0);
  });

  it('serves a stale list to the model picker while the endpoint is down', async () => {
    const provider = new ListingProvider();
    provider.lists.push(listed('llama3.1:latest'), new Error('down'));
    const models = catalogue(provider, { modelCacheTtlMs: 0 });
    expect((await models.platformModels()).verified).toBe(true);
    const during = await models.platformModels();
    expect(during.models.map((model) => model.name)).toEqual(['llama3.1:latest']);
  });

  it('falls back to the default model when nothing was ever listed', async () => {
    const provider = new ListingProvider();
    const { models, verified } = await catalogue(provider).platformModels();
    expect(verified).toBe(false);
    expect(models.map((model) => model.name)).toEqual(['llama3.1:8b']);
  });
});
