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
