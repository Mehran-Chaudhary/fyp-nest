import { ConfigService } from '@nestjs/config';
import {
  AI_SERVICE_CONFIG_KEY,
  type AiServiceConfig,
} from '../../config/ai-service.config';
import {
  VECTOR_STORE_CONFIG_KEY,
  type VectorStoreConfig,
} from '../../config/vector-store.config';
import { RequestContextService } from '../context/request-context.service';
import { AiServiceClient } from './ai-service.client';
import { AiServiceError } from './ai-service.types';
import {
  canonicalRequest,
  SIGNING_HEADER,
  signRequest,
  verifySignature,
} from './request-signing';
import {
  extractErrorBody,
  validateEmbeddingResponse,
  validateParseResponse,
  validatePiiAnalyzeResponse,
  validateRerankResponse,
} from './response-validation';

const SECRET = 'test-ai-service-signing-secret-at-least-32-chars';

describe('AI service request signing', () => {
  const body = Buffer.from('{"inputs":["hello"]}');

  it('verifies what it signs', () => {
    const headers = signRequest({
      method: 'POST',
      pathAndQuery: '/v1/embeddings',
      body,
      secret: SECRET,
      keyId: 'v1',
    });
    expect(
      verifySignature({
        method: 'POST',
        pathAndQuery: '/v1/embeddings',
        body,
        headers,
        secret: SECRET,
      }).valid,
    ).toBe(true);
  });

  it('is deterministic given the same timestamp and nonce', () => {
    const input = {
      method: 'POST',
      pathAndQuery: '/v1/embeddings',
      body,
      secret: SECRET,
      keyId: 'v1',
      timestamp: 1_758_700_000,
      nonce: 'nonce-1',
    };
    expect(signRequest(input)).toEqual(signRequest(input));
  });

  it('pins the canonical string format documented in the contract', () => {
    expect(canonicalRequest('post', '/v1/x?a=1', 1700000000, 'n', 'abc')).toBe(
      'DAIAP-HMAC-SHA256\nPOST\n/v1/x?a=1\n1700000000\nn\nabc',
    );
  });

  describe('rejects', () => {
    const now = 1_758_700_000;
    const signed = signRequest({
      method: 'POST',
      pathAndQuery: '/v1/embeddings',
      body,
      secret: SECRET,
      keyId: 'v1',
      timestamp: now,
      nonce: 'n',
    });
    const verify = (overrides: Partial<Parameters<typeof verifySignature>[0]>) =>
      verifySignature({
        method: 'POST',
        pathAndQuery: '/v1/embeddings',
        body,
        headers: signed,
        secret: SECRET,
        nowSeconds: now,
        ...overrides,
      });

    it('an altered body', () => {
      expect(verify({ body: Buffer.from('{"inputs":["tampered"]}') }).valid).toBe(false);
    });

    it('an altered path or query', () => {
      expect(verify({ pathAndQuery: '/v1/embeddings?x=1' }).valid).toBe(false);
    });

    it('an altered method', () => {
      expect(verify({ method: 'GET' }).valid).toBe(false);
    });

    it('the wrong secret', () => {
      expect(
        verify({ secret: 'another-secret-that-is-at-least-32-characters' }).valid,
      ).toBe(false);
    });

    it('a stale timestamp (replay outside the window)', () => {
      expect(verify({ nowSeconds: now + 301 }).valid).toBe(false);
    });

    it('a forged signature header', () => {
      expect(
        verify({
          headers: { ...signed, [SIGNING_HEADER.SIGNATURE]: `v1=${'0'.repeat(64)}` },
        }).valid,
      ).toBe(false);
    });
  });
});

describe('AI service response validation', () => {
  describe('parse', () => {
    it('maps snake_case, re-indexes densely and drops blank chunks', () => {
      const parsed = validateParseResponse(
        {
          document: { page_count: 3, language: 'en' },
          chunks: [
            { index: 7, text: 'First', token_count: 1, page_start: 1, page_end: 1 },
            { index: 8, text: '   ' },
            { index: 9, text: 'Second', token_count: 1 },
          ],
          parser: { name: 'docling', version: '2.1' },
        },
        { maxChunks: 10 },
      );

      expect(parsed.chunks.map((chunk) => [chunk.index, chunk.text])).toEqual([
        [0, 'First'],
        [1, 'Second'],
      ]);
      expect(parsed.pageCount).toBe(3);
      expect(parsed.parser).toBe('docling@2.1');
    });

    it('refuses more chunks than the configured ceiling', () => {
      const chunks = Array.from({ length: 5 }, () => ({ text: 'x' }));
      expect(() => validateParseResponse({ chunks }, { maxChunks: 4 })).toThrow(
        /TOO_MANY|above/,
      );
    });

    it('refuses malformed shapes with a named field', () => {
      expect(() =>
        validateParseResponse({ chunks: [{ text: 42 }] }, { maxChunks: 10 }),
      ).toThrow(/chunks\[0\]\.text/);
      expect(() =>
        validateParseResponse(
          { chunks: [{ text: 'x', page_start: 3, page_end: 1 }] },
          { maxChunks: 10 },
        ),
      ).toThrow(/page_end/);
    });
  });

  describe('embeddings', () => {
    const expected = { count: 2, dimensions: 3, model: 'm' };

    it('accepts a well-formed batch', () => {
      const batch = validateEmbeddingResponse(
        {
          model: 'm',
          embeddings: [
            [1, 0, 0],
            [0, 1, 0],
          ],
          usage: { tokens: 4 },
        },
        expected,
      );
      expect(batch.embeddings).toHaveLength(2);
      expect(batch.tokens).toBe(4);
    });

    it('refuses a different model — the index’s embedding space is fixed', () => {
      expect(() =>
        validateEmbeddingResponse(
          {
            model: 'other',
            embeddings: [
              [1, 0, 0],
              [0, 1, 0],
            ],
          },
          expected,
        ),
      ).toThrow(/model/);
    });

    it('refuses the wrong count, the wrong dimensions, non-finite and zero vectors', () => {
      expect(() =>
        validateEmbeddingResponse({ model: 'm', embeddings: [[1, 0, 0]] }, expected),
      ).toThrow();
      expect(() =>
        validateEmbeddingResponse(
          {
            model: 'm',
            embeddings: [
              [1, 0],
              [0, 1],
            ],
          },
          expected,
        ),
      ).toThrow(/dimensions/);
      expect(() =>
        validateEmbeddingResponse(
          {
            model: 'm',
            embeddings: [
              [1, 0, NaN],
              [0, 1, 0],
            ],
          },
          expected,
        ),
      ).toThrow(/non-finite/);
      expect(() =>
        validateEmbeddingResponse(
          {
            model: 'm',
            embeddings: [
              [0, 0, 0],
              [0, 1, 0],
            ],
          },
          expected,
        ),
      ).toThrow(/zero vector/);
    });
  });

  describe('rerank', () => {
    it('sorts best first', () => {
      const result = validateRerankResponse(
        {
          results: [
            { index: 0, score: 0.1 },
            { index: 1, score: 0.9 },
          ],
        },
        { documentCount: 2 },
      );
      expect(result.results.map((entry) => entry.index)).toEqual([1, 0]);
    });

    it('refuses out-of-range or repeated indices', () => {
      expect(() =>
        validateRerankResponse({ results: [{ index: 5, score: 1 }] }, { documentCount: 2 }),
      ).toThrow();
      expect(() =>
        validateRerankResponse(
          {
            results: [
              { index: 0, score: 1 },
              { index: 0, score: 0.5 },
            ],
          },
          { documentCount: 2 },
        ),
      ).toThrow();
    });
  });

  it('sanitises relayed error messages', () => {
    expect(
      extractErrorBody({
        error: { code: 'ENCRYPTED_DOCUMENT', message: 'PDF is\u0000 locked\n' },
      }),
    ).toEqual({ code: 'ENCRYPTED_DOCUMENT', message: 'PDF is locked' });
    expect(extractErrorBody({ error: { code: 'bad code!' } }).code).toBeUndefined();
  });
});

describe('AiServiceClient transport', () => {
  const ai: AiServiceConfig = {
    configured: true,
    url: 'https://ai.test',
    signingSecret: SECRET,
    keyId: 'v1',
    timeoutMs: 2_000,
    parseTimeoutMs: 2_000,
    maxRetries: 2,
    maxResponseBytes: 1024,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
  };
  const vector = {
    embedding: { model: 'm', dimensions: 2, batchSize: 8 },
  } as unknown as VectorStoreConfig;

  const config = {
    getOrThrow: (key: string) => {
      if (key === AI_SERVICE_CONFIG_KEY) return ai;
      if (key === VECTOR_STORE_CONFIG_KEY) return vector;
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService;

  const originalFetch = globalThis.fetch;
  let calls: Array<{ url: string; init: RequestInit }>;
  let responses: Array<() => Response>;

  beforeEach(() => {
    calls = [];
    responses = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(next());
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const json =
    (status: number, body: unknown, headers: Record<string, string> = {}) =>
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
  const okEmbedding = json(200, { model: 'm', embeddings: [[0.6, 0.8]] });

  const client = () => new AiServiceClient(config, new RequestContextService());

  it('signs every request', async () => {
    responses.push(okEmbedding);
    await client().embed({ inputs: ['hi'], inputType: 'query' });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers[SIGNING_HEADER.SIGNATURE]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(headers[SIGNING_HEADER.KEY_ID]).toBe('v1');
    expect(calls[0].url).toBe('https://ai.test/v1/embeddings');
  });

  it('retries a transient failure and then succeeds', async () => {
    responses.push(
      json(503, { error: { code: 'MODEL_LOADING' } }, { 'retry-after': '0' }),
      okEmbedding,
    );
    const batch = await client().embed({ inputs: ['hi'], inputType: 'query' });
    expect(batch.embeddings).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a permanent rejection', async () => {
    responses.push(json(422, { error: { code: 'ENCRYPTED_DOCUMENT', message: 'locked' } }));
    await expect(
      client().embed({ inputs: ['hi'], inputType: 'query' }),
    ).rejects.toMatchObject({
      code: 'ENCRYPTED_DOCUMENT',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('opens the circuit after repeated failures and then fails fast', async () => {
    const instance = client();
    // Three calls × three attempts each, all failing at the network level.
    for (let call = 0; call < 3; call += 1) {
      await expect(
        instance.embed({ inputs: ['x'], inputType: 'query' }),
      ).rejects.toBeInstanceOf(AiServiceError);
    }
    const before = calls.length;
    await expect(
      instance.embed({ inputs: ['x'], inputType: 'query' }),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_CIRCUIT_OPEN',
    });
    expect(calls.length).toBe(before);
  });

  it('refuses a response above the size ceiling', async () => {
    responses.push(
      json(200, { model: 'm', embeddings: [[0.6, 0.8]], padding: 'x'.repeat(4096) }),
    );
    await expect(
      client().embed({ inputs: ['hi'], inputType: 'query' }),
    ).rejects.toMatchObject({
      code: 'AI_RESPONSE_TOO_LARGE',
    });
  });

  it('short-circuits an empty batch without a network call', async () => {
    const batch = await client().embed({ inputs: [], inputType: 'document' });
    expect(batch.embeddings).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The PII detection contract (`POST /v1/pii/analyze`). Offsets come from
 * Python, which counts code points; a span that is not converted masks the
 * wrong characters on any text with an emoji before it.
 */
describe('AI service PII analysis contract', () => {
  const span = (entity_type: string, start: number, end: number, score = 0.85) => ({
    entity_type,
    start,
    end,
    score,
  });

  it('converts code-point offsets to string offsets', () => {
    const text = 'Thanks 🙏 from Ayesha Raza';
    const result = validatePiiAnalyzeResponse(
      {
        results: [[span('PERSON', 14, 25)]],
        detector: { name: 'presidio', version: '2.2', model: 'en_core_web_lg' },
      },
      { texts: [text] },
    );
    const [found] = result.results[0];
    expect(text.slice(found.start, found.end)).toBe('Ayesha Raza');
    expect(result.detector).toBe('presidio@2.2/en_core_web_lg');
  });

  it('requires one result list per text, in order', () => {
    expect(() =>
      validatePiiAnalyzeResponse({ results: [[]] }, { texts: ['a', 'b'] }),
    ).toThrow(/one entry per text/);
    expect(
      validatePiiAnalyzeResponse({ results: [[], []] }, { texts: ['a', 'b'] }).detector,
    ).toBe('unknown');
  });

  it('refuses offsets outside the text, empty spans and bad scores', () => {
    const check = (item: unknown) => () =>
      validatePiiAnalyzeResponse({ results: [[item]] }, { texts: ['short 😀'] });
    expect(check(span('PERSON', 0, 8))).toThrow(/offsets/); // 7 code points
    expect(check(span('PERSON', 3, 3))).toThrow(/offsets/);
    expect(check(span('PERSON', -1, 2))).toThrow(/offsets/);
    expect(check(span('PERSON', 0.5, 2))).toThrow(/offsets/);
    expect(check(span('PERSON', 0, 2, 1.5))).toThrow(/score/);
    expect(check(span('person', 0, 2))).toThrow(/entity_type/);
    expect(check(span('PERSON', 0, 7))).not.toThrow();
  });

  it('fails as a contract violation, which is not retried', () => {
    try {
      validatePiiAnalyzeResponse({ results: 'nope' }, { texts: ['x'] });
      throw new Error('expected a violation');
    } catch (error) {
      expect(error).toBeInstanceOf(AiServiceError);
      expect((error as AiServiceError).retryable).toBe(false);
    }
  });
});
