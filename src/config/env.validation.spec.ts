import {
  findInsecureDefaults,
  INSECURE_AI_SIGNING_DEFAULT,
  validateEnvironment,
} from './env.validation';

const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: 'c'.repeat(40),
  AUDIT_HASH_SECRET: 'd'.repeat(40),
};

/**
 * Phase 2 configuration contract. Every knowledge-layer dependency is optional
 * at boot — the platform must start before they are provisioned — but once one
 * is configured, its security-relevant settings are not.
 */
describe('environment validation (phase 2)', () => {
  it('boots with no knowledge-layer configuration at all', () => {
    const env = validateEnvironment({ NODE_ENV: 'development' });
    expect(env.STORAGE_S3_BUCKET).toBe('');
    expect(env.QDRANT_URL).toBe('');
    expect(env.AI_SERVICE_URL).toBe('');
  });

  it('requires a signing secret once the AI service is configured in production', () => {
    expect(() =>
      validateEnvironment({ ...PRODUCTION_BASE, AI_SERVICE_URL: 'https://ai.example.com' }),
    ).toThrow(/AI_SERVICE_SIGNING_SECRET/);
  });

  it('refuses a short signing secret', () => {
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_BASE,
        AI_SERVICE_URL: 'https://ai.example.com',
        AI_SERVICE_SIGNING_SECRET: 'too-short',
      }),
    ).toThrow(/at least 32/);
  });

  it('falls back to a flagged development secret outside production', () => {
    const env = validateEnvironment({
      NODE_ENV: 'development',
      AI_SERVICE_URL: 'http://localhost:8000',
    });
    expect(env.AI_SERVICE_SIGNING_SECRET).toBe(INSECURE_AI_SIGNING_DEFAULT);
    expect(findInsecureDefaults(env)).toContain('AI_SERVICE_SIGNING_SECRET');
  });

  it('validates sizes and enumerations', () => {
    expect(() => validateEnvironment({ UPLOAD_MAX_FILE_SIZE: 'huge' })).toThrow(/size/);
    expect(() => validateEnvironment({ UPLOAD_ALLOWED_TYPES: 'pdf,exe' })).toThrow();
    expect(() => validateEnvironment({ QDRANT_TENANCY: 'schema' })).toThrow();
    expect(() => validateEnvironment({ RAG_SEARCH_MODE: 'keyword' })).toThrow();
  });

  it('bounds the queue polling intervals', () => {
    const env = validateEnvironment({});
    expect(env.QUEUE_DRAIN_DELAY).toBe('5s');
    expect(env.QUEUE_STALLED_INTERVAL).toBe('30s');
    expect(() =>
      validateEnvironment({ QUEUE_DRAIN_DELAY: '60s', QUEUE_STALLED_INTERVAL: '120s' }),
    ).not.toThrow();
    expect(() => validateEnvironment({ QUEUE_DRAIN_DELAY: '500ms' })).toThrow(
      /QUEUE_DRAIN_DELAY/,
    );
    expect(() => validateEnvironment({ QUEUE_DRAIN_DELAY: '10m' })).toThrow(
      /QUEUE_DRAIN_DELAY/,
    );
    expect(() => validateEnvironment({ QUEUE_STALLED_INTERVAL: '1s' })).toThrow(
      /QUEUE_STALLED_INTERVAL/,
    );
  });

  it('accepts a realistic cloud configuration', () => {
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_BASE,
        STORAGE_S3_BUCKET: 'daiap-documents',
        STORAGE_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
        STORAGE_S3_ACCESS_KEY_ID: 'key',
        STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
        QDRANT_URL: 'https://xyz.eu-central.aws.cloud.qdrant.io:6333',
        QDRANT_API_KEY: 'qdrant-key',
        AI_SERVICE_URL: 'https://ai.example.com',
        AI_SERVICE_SIGNING_SECRET: 'e'.repeat(43),
        UPLOAD_ALLOWED_TYPES: 'pdf, docx',
      }),
    ).not.toThrow();
  });
});

/**
 * Phase 3 configuration contract: the model endpoint and the NER detector are
 * optional at boot, and the timeouts around a generation must nest — a
 * request budget shorter than the generation it wraps would cut off answers
 * that were still being written.
 */
describe('environment validation (phase 3)', () => {
  it('boots with no model endpoint and safe privacy defaults', () => {
    const env = validateEnvironment({ NODE_ENV: 'development' });
    expect(env.LLM_BASE_URL).toBe('');
    expect(env.LLM_PROVIDER).toBe('ollama');
    expect(env.LLM_MAX_CLASSIFICATION).toBe('RESTRICTED');
    expect(env.PII_DEFAULT_ON_FAILURE).toBe('REFUSE');
    expect(env.PII_NER_PROVIDER).toBe('ai-service');
    expect(String(env.PII_DEFAULT_ENTITIES)).toContain('CREDIT_CARD');
  });

  it('accepts a hosted OpenAI-compatible endpoint and a Presidio analyzer', () => {
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_BASE,
        LLM_PROVIDER: 'openai',
        LLM_BASE_URL: 'https://api.together.xyz/v1',
        LLM_API_KEY: 'key',
        LLM_ALLOWED_MODELS: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        LLM_MAX_CLASSIFICATION: 'INTERNAL',
        PII_NER_PROVIDER: 'presidio',
        PRESIDIO_ANALYZER_URL: 'https://presidio.internal.example.com',
      }),
    ).not.toThrow();
  });

  it('rejects unknown providers, classifications and failure modes', () => {
    expect(() => validateEnvironment({ LLM_PROVIDER: 'anthropic' })).toThrow(
      /LLM_PROVIDER/,
    );
    expect(() => validateEnvironment({ LLM_MAX_CLASSIFICATION: 'SECRET' })).toThrow();
    expect(() =>
      validateEnvironment({ PII_DEFAULT_ON_FAILURE: 'SEND_UNMASKED' }),
    ).toThrow();
    expect(() => validateEnvironment({ PII_DEFAULT_ENTITIES: 'person;email' })).toThrow();
    expect(() => validateEnvironment({ LLM_KEEP_ALIVE: 'forever' })).toThrow();
  });

  it('requires the request budget to outlast the longest generation', () => {
    expect(() =>
      validateEnvironment({ LLM_MAX_DURATION: '300s', LLM_REQUEST_TIMEOUT: '300s' }),
    ).toThrow(/LLM_REQUEST_TIMEOUT/);
    expect(() =>
      validateEnvironment({ LLM_MAX_DURATION: '120s', LLM_REQUEST_TIMEOUT: '130s' }),
    ).not.toThrow();
  });

  it('requires the first-token deadline to fit inside the total duration', () => {
    expect(() =>
      validateEnvironment({ LLM_FIRST_TOKEN_TIMEOUT: '300s', LLM_MAX_DURATION: '240s' }),
    ).toThrow(/LLM_FIRST_TOKEN_TIMEOUT/);
  });

  it('requires an analyzer URL when Presidio is chosen', () => {
    expect(() => validateEnvironment({ PII_NER_PROVIDER: 'presidio' })).toThrow(
      /PRESIDIO_ANALYZER_URL/,
    );
    expect(() => validateEnvironment({ PII_NER_PROVIDER: 'none' })).not.toThrow();
  });
});
