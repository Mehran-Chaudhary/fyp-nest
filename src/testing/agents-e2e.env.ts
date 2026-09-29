/**
 * Environment for the phase 3 end-to-end suite, applied before anything reads
 * configuration (imported first; see `database/seeds/seed-env.ts` for why).
 *
 * Points the LLM gateway at a scripted Ollama that the suite installs as the
 * gateway's HTTP transport, so every request that "leaves" the platform is
 * captured for inspection.
 */
process.env.QUEUE_WORKERS_ENABLED = 'false';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_BASE_URL = 'http://fake-ollama.e2e';
process.env.LLM_DEFAULT_MODEL = 'e2e-model';
// Not '': dotenv-expand treats an empty value as unset, so a developer's
// `.env` allowlist (e.g. Groq models) would win and refuse the stand-in model.
process.env.LLM_ALLOWED_MODELS = 'e2e-model';
process.env.LLM_MAX_CLASSIFICATION = 'RESTRICTED';
process.env.PII_NER_PROVIDER = 'ai-service';
// Deterministic: every turn asks the stand-in NER model afresh.
process.env.PII_DETECTION_CACHE_TTL = '0';
