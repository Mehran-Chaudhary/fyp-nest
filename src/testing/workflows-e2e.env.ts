/**
 * Environment for the phase 4 end-to-end suite, applied before anything reads
 * configuration (imported first; see `database/seeds/seed-env.ts` for why).
 *
 * Unlike the phase 3 suite, the queue workers are ON: steps travel through
 * real BullMQ queues on a real Redis and are claimed by real workers in this
 * process. Only the model is a stand-in — a scripted Ollama installed as the
 * gateway's HTTP transport — and a local mock partner API stands in for the
 * internet, which is why private networks and plain HTTP are allowed here
 * (both are refused outside development).
 */
export const MOCK_API_PORT = 47_931;

process.env.QUEUE_WORKERS_ENABLED = 'true';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_BASE_URL = 'http://fake-ollama.e2e';
process.env.LLM_DEFAULT_MODEL = 'e2e-model';
// Not '': dotenv-expand treats an empty value as unset, so a developer's
// `.env` allowlist (e.g. Groq models) would win and refuse the stand-in model.
process.env.LLM_ALLOWED_MODELS = 'e2e-model';
process.env.LLM_MAX_CLASSIFICATION = 'RESTRICTED';
process.env.PII_NER_PROVIDER = 'ai-service';
// Deterministic: every call asks the stand-in NER model afresh.
process.env.PII_DETECTION_CACHE_TTL = '0';
// The engine's retries are under test, not the gateway's; and the scripted
// outage must not open the gateway's circuit for the scenarios after it.
process.env.LLM_MAX_RETRIES = '0';
process.env.LLM_CIRCUIT_THRESHOLD = '100';

// Engine timings shortened so retries, stalls and recovery happen in seconds.
process.env.WORKFLOW_STEP_BACKOFF = '300ms';
process.env.WORKFLOW_STEP_BACKOFF_MAX = '1s';
process.env.WORKFLOW_HEARTBEAT_INTERVAL = '500ms';
process.env.WORKFLOW_STALL_THRESHOLD = '2s';
// The suite runs the sweep itself, at the moments it wants.
process.env.WORKFLOW_SWEEP_INTERVAL = '1h';
process.env.WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG = '50';

process.env.TOOL_HTTP_ALLOWED_HOSTS = `127.0.0.1:${MOCK_API_PORT}`;
process.env.TOOL_HTTP_ALLOW_PRIVATE_NETWORKS = 'true';
process.env.TOOL_HTTP_ALLOW_INSECURE = 'true';

process.env.REALTIME_ENABLED = 'true';
process.env.REALTIME_REVALIDATE_INTERVAL = '1h';
process.env.MAIL_TRANSPORT = 'log';
process.env.THROTTLE_ENABLED = 'false';
