import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PII_CONFIG_KEY, type PiiConfig } from '../../../config/pii.config';
import { SECURITY_CONFIG_KEY } from '../../../config/security.config';
import type { RedisService } from '../../../shared/redis/redis.service';
import type { EffectivePiiPolicy } from '../domain/policy';
import {
  NerUnavailableError,
  type NerDetector,
  type NerRequest,
  type NerResponse,
} from './ner-detector';
import {
  PATTERN_LAYER_VERSION,
  PiiDetectionService,
  PiiDetectionUnavailableError,
} from './pii-detection.service';
import { PresidioNerDetector } from './presidio-ner.detector';

/**
 * Detection, stage one of the PII pipeline: patterns in process, NER for the
 * types only a model can find, a cache that never holds text, and a failure
 * policy that is the workspace's to choose.
 */

const PII_CONFIG: PiiConfig = {
  nerProvider: 'ai-service',
  presidio: { url: '', concurrency: 2 },
  timeoutMs: 1_000,
  defaults: {
    entityTypes: ['PERSON', 'CREDIT_CARD'],
    onDetectorFailure: 'REFUSE',
    scoreThreshold: 0.5,
    language: 'en',
  },
  cacheTtlSeconds: 3_600,
  circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
  maxAnalyzeLength: 20_000,
};

function configFor(pii: PiiConfig): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key === PII_CONFIG_KEY) return pii;
      if (key === SECURITY_CONFIG_KEY) return { encryptionKey: 'k'.repeat(48) };
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService;
}

class MemoryCache {
  readonly store = new Map<string, string>();
  getJson<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return Promise.resolve(raw === undefined ? null : (JSON.parse(raw) as T));
  }
  setJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
    return Promise.resolve();
  }
}

/** Tags each known name wherever it occurs, like a NER model would. */
class ScriptedNer implements NerDetector {
  readonly kind = 'ai-service' as const;
  readonly isConfigured = true;
  readonly missingConfiguration: string[] = [];
  readonly calls: NerRequest[] = [];
  failure: NerUnavailableError | null = null;

  constructor(private readonly names: string[]) {}

  detect(request: NerRequest): Promise<NerResponse> {
    this.calls.push(request);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({
      detector: 'scripted-ner@1',
      spans: request.texts.map((text) =>
        this.names.flatMap((name) => {
          const at = text.indexOf(name);
          return at === -1
            ? []
            : [
                {
                  entityType: 'PERSON',
                  start: at,
                  end: at + name.length,
                  score: 0.9,
                  source: 'ner' as const,
                  recognizer: 'scripted',
                },
              ];
        }),
      ),
    });
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function policy(overrides: Partial<EffectivePiiPolicy> = {}): EffectivePiiPolicy {
  return {
    organizationId: 'org-a',
    enabled: true,
    entityTypes: ['CREDIT_CARD', 'EMAIL_ADDRESS', 'PERSON'],
    scoreThreshold: 0.5,
    onDetectorFailure: 'REFUSE',
    language: 'en',
    allowList: [],
    denyList: [],
    source: 'workspace',
    version: 1,
    updatedAt: null,
    ...overrides,
  };
}

function setup(names = ['Ayesha Raza'], pii: PiiConfig = PII_CONFIG) {
  const ner = new ScriptedNer(names);
  const cache = new MemoryCache();
  const service = new PiiDetectionService(
    ner,
    cache as unknown as RedisService,
    configFor(pii),
  );
  return { ner, cache, service };
}

const TEXT = 'Ayesha Raza, card 4111 1111 1111 1111, ayesha@acme.test';

describe('PII detection service', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('combines pattern and NER detections and records both detectors', async () => {
    const { service } = setup();
    const outcome = await service.detect({
      organizationId: 'org-a',
      policy: policy(),
      texts: [TEXT],
    });
    const types = outcome.spans[0]
      .map((span) => `${span.entityType}:${span.source}`)
      .sort();
    expect(types).toEqual(['CREDIT_CARD:pattern', 'EMAIL_ADDRESS:pattern', 'PERSON:ner']);
    expect(outcome.nerUsed).toBe(true);
    expect(outcome.detectors).toEqual([PATTERN_LAYER_VERSION, 'scripted-ner@1']);
  });

  it('does not call the NER model when the policy needs no NER type', async () => {
    const { ner, service } = setup();
    const outcome = await service.detect({
      organizationId: 'org-a',
      policy: policy({ entityTypes: ['CREDIT_CARD'] }),
      texts: [TEXT],
    });
    expect(ner.calls).toHaveLength(0);
    expect(outcome.spans[0].map((span) => span.entityType)).toEqual(['CREDIT_CARD']);
  });

  it('asks the model only for the types patterns cannot find', async () => {
    const { ner, service } = setup();
    await service.detect({ organizationId: 'org-a', policy: policy(), texts: [TEXT] });
    expect(ner.calls[0].entityTypes).toEqual(['PERSON']);
  });

  it('caches offsets and types only, never text', async () => {
    const { ner, cache, service } = setup();
    await service.detect({ organizationId: 'org-a', policy: policy(), texts: [TEXT] });
    const again = await service.detect({
      organizationId: 'org-a',
      policy: policy(),
      texts: [TEXT],
    });

    expect(ner.calls).toHaveLength(1);
    expect(again.cacheHits).toBe(1);
    expect(again.spans[0].some((span) => span.entityType === 'PERSON')).toBe(true);
    const stored = [...cache.store.entries()].flat().join(' ');
    expect(stored).not.toContain('Ayesha');
    expect(stored).not.toContain(TEXT);
  });

  it('never lets one workspace’s or policy’s cache answer another', async () => {
    const { ner, service } = setup();
    await service.detect({ organizationId: 'org-a', policy: policy(), texts: [TEXT] });
    await service.detect({
      organizationId: 'org-b',
      policy: policy({ organizationId: 'org-b' }),
      texts: [TEXT],
    });
    await service.detect({
      organizationId: 'org-a',
      policy: policy({ entityTypes: ['LOCATION', 'PERSON'] }),
      texts: [TEXT],
    });
    expect(ner.calls).toHaveLength(3);
  });

  it('treats a malformed cache entry as a miss', async () => {
    const { ner, cache, service } = setup();
    await service.detect({ organizationId: 'org-a', policy: policy(), texts: [TEXT] });
    for (const key of cache.store.keys())
      cache.store.set(key, JSON.stringify([['PERSON', 0, 9_999, 0.9]]));
    const outcome = await service.detect({
      organizationId: 'org-a',
      policy: policy(),
      texts: [TEXT],
    });
    expect(ner.calls).toHaveLength(2);
    expect(outcome.cacheHits).toBe(0);
  });

  it('refuses when NER is unavailable and the policy says REFUSE', async () => {
    const { ner, service } = setup();
    ner.failure = new NerUnavailableError('NOT_CONFIGURED', 'no AI service', [
      'AI_SERVICE_URL',
    ]);
    await expect(
      service.detect({ organizationId: 'org-a', policy: policy(), texts: [TEXT] }),
    ).rejects.toMatchObject({
      name: 'PiiDetectionUnavailableError',
      reason: 'NOT_CONFIGURED',
      missingConfiguration: ['AI_SERVICE_URL'],
      entityTypes: ['PERSON'],
    });
  });

  it('degrades to patterns only when the policy allows it, and says so', async () => {
    const { ner, service } = setup();
    ner.failure = new NerUnavailableError('TIMEOUT', 'slow');
    const outcome = await service.detect({
      organizationId: 'org-a',
      policy: policy({ onDetectorFailure: 'DEGRADE_TO_PATTERNS' }),
      texts: [TEXT],
    });
    expect(outcome.degraded).toBe(true);
    expect(outcome.degradedReason).toBe('TIMEOUT');
    expect(outcome.spans[0].map((span) => span.entityType).sort()).toEqual([
      'CREDIT_CARD',
      'EMAIL_ADDRESS',
    ]);
  });

  it('reports a caller that left as a cancellation, not an outage', async () => {
    const { ner, service } = setup();
    const controller = new AbortController();
    const reason = new Error('client left');
    controller.abort(reason);
    ner.failure = new NerUnavailableError('UNAVAILABLE', 'aborted');
    const attempt = service.detect({
      organizationId: 'org-a',
      policy: policy(),
      texts: [TEXT],
      signal: controller.signal,
    });
    await expect(attempt).rejects.toBe(reason);
    await expect(attempt).rejects.not.toBeInstanceOf(PiiDetectionUnavailableError);
  });

  it('marks deny-list matches as custom detections', async () => {
    const { service } = setup([]);
    const outcome = await service.detect({
      organizationId: 'org-a',
      policy: policy({ entityTypes: ['CUSTOM', 'PERSON'], denyList: ['Project Falcon'] }),
      texts: ['Status of Project Falcon?'],
    });
    expect(outcome.spans[0]).toEqual([
      expect.objectContaining({ entityType: 'CUSTOM', source: 'custom' }),
    ]);
  });

  it('skips NER for empty texts', async () => {
    const { ner, service } = setup();
    await service.detect({ organizationId: 'org-a', policy: policy(), texts: ['', ''] });
    expect(ner.calls).toHaveLength(0);
  });
});

describe('Presidio NER detector', () => {
  const config: PiiConfig = {
    ...PII_CONFIG,
    nerProvider: 'presidio',
    presidio: { url: 'https://presidio.internal', apiKey: 'proxy-token', concurrency: 2 },
  };
  const request = (texts: string[]): NerRequest => ({
    organizationId: 'org-a',
    texts,
    entityTypes: ['PERSON'],
    language: 'en',
    scoreThreshold: 0.5,
  });

  function scripted(responses: Array<() => Response>) {
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl = (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >,
        headers: init.headers as Record<string, string>,
      });
      const next = responses.shift();
      return next ? Promise.resolve(next()) : Promise.reject(new TypeError('fetch failed'));
    };
    return { calls, fetchImpl };
  }

  it('reports what to configure when it has no URL', async () => {
    const detector = new PresidioNerDetector(PII_CONFIG);
    await expect(detector.detect(request(['x']))).rejects.toMatchObject({
      reason: 'NOT_CONFIGURED',
      missingConfiguration: ['PRESIDIO_ANALYZER_URL'],
    });
  });

  it('analyses each text, authenticates to the proxy and converts offsets', async () => {
    const text = 'Hi 👋 Ayesha Raza';
    const { calls, fetchImpl } = scripted([
      () => Response.json([{ entity_type: 'PERSON', start: 5, end: 16, score: 0.85 }]),
    ]);
    const detector = new PresidioNerDetector(config, fetchImpl);
    const response = await detector.detect(request([text, '']));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://presidio.internal/analyze');
    expect(calls[0].headers.authorization).toBe('Bearer proxy-token');
    expect(calls[0].body).toEqual({
      text,
      language: 'en',
      entities: ['PERSON'],
      score_threshold: 0.5,
    });
    const [found] = response.spans[0];
    expect(text.slice(found.start, found.end)).toBe('Ayesha Raza');
    expect(response.spans[1]).toEqual([]);
  });

  it('retries a transient failure once', async () => {
    const { calls, fetchImpl } = scripted([
      () => new Response('busy', { status: 503 }),
      () => Response.json([]),
    ]);
    const response = await new PresidioNerDetector(config, fetchImpl).detect(
      request(['text']),
    );
    expect(response.spans).toEqual([[]]);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a rejection, and rejects a response outside the contract', async () => {
    const rejected = scripted([() => new Response('bad', { status: 400 })]);
    await expect(
      new PresidioNerDetector(config, rejected.fetchImpl).detect(request(['text'])),
    ).rejects.toMatchObject({ reason: 'UNAVAILABLE' });
    expect(rejected.calls).toHaveLength(1);

    const invalid = scripted([
      () => Response.json([{ entity_type: 'PERSON', start: 0, end: 99, score: 0.9 }]),
      () => new Response('<html>', { status: 200 }),
    ]);
    const detector = new PresidioNerDetector(config, invalid.fetchImpl);
    await expect(detector.detect(request(['text']))).rejects.toMatchObject({
      reason: 'INVALID_RESPONSE',
    });
    await expect(detector.detect(request(['text']))).rejects.toMatchObject({
      reason: 'INVALID_RESPONSE',
    });
  });

  it('opens its circuit after repeated outages', async () => {
    const detector = new PresidioNerDetector(config, scripted([]).fetchImpl);
    await expect(detector.detect(request(['a']))).rejects.toMatchObject({
      reason: 'UNAVAILABLE',
    });
    await expect(detector.detect(request(['b']))).rejects.toMatchObject({
      reason: 'UNAVAILABLE',
    });
    await expect(detector.detect(request(['c']))).rejects.toMatchObject({
      reason: 'CIRCUIT_OPEN',
    });
    expect(detector.circuitState).toBe('OPEN');
  });
});
