import agentsConfig, { AGENTS_CONFIG_KEY } from './agents.config';
import aiServiceConfig, { AI_SERVICE_CONFIG_KEY } from './ai-service.config';
import appConfig, { APP_CONFIG_KEY } from './app.config';
import databaseConfig, { DATABASE_CONFIG_KEY } from './database.config';
import ingestionConfig, { INGESTION_CONFIG_KEY } from './ingestion.config';
import jwtConfig, { JWT_CONFIG_KEY } from './jwt.config';
import llmConfig, { LLM_CONFIG_KEY } from './llm.config';
import mailConfig, { MAIL_CONFIG_KEY } from './mail.config';
import piiConfig, { PII_CONFIG_KEY } from './pii.config';
import ragConfig, { RAG_CONFIG_KEY } from './rag.config';
import realtimeConfig, { REALTIME_CONFIG_KEY } from './realtime.config';
import redisConfig, { REDIS_CONFIG_KEY } from './redis.config';
import securityConfig, { SECURITY_CONFIG_KEY } from './security.config';
import storageConfig, { STORAGE_CONFIG_KEY } from './storage.config';
import throttleConfig, { THROTTLE_CONFIG_KEY } from './throttle.config';
import toolsConfig, { TOOLS_CONFIG_KEY } from './tools.config';
import vectorStoreConfig, { VECTOR_STORE_CONFIG_KEY } from './vector-store.config';
import workflowsConfig, { WORKFLOWS_CONFIG_KEY } from './workflows.config';

export * from './agents.config';
export * from './ai-service.config';
export * from './app.config';
export * from './database.config';
export * from './ingestion.config';
export * from './jwt.config';
export * from './llm.config';
export * from './mail.config';
export * from './pii.config';
export * from './rag.config';
export * from './realtime.config';
export * from './redis.config';
export * from './security.config';
export * from './storage.config';
export * from './throttle.config';
export * from './tools.config';
export * from './vector-store.config';
export * from './workflows.config';
export * from './env.validation';

/** Every namespaced configuration factory, loaded by the root ConfigModule. */
export const configurations = [
  appConfig,
  databaseConfig,
  jwtConfig,
  mailConfig,
  redisConfig,
  securityConfig,
  throttleConfig,
  storageConfig,
  aiServiceConfig,
  vectorStoreConfig,
  ingestionConfig,
  ragConfig,
  llmConfig,
  piiConfig,
  agentsConfig,
  toolsConfig,
  workflowsConfig,
  realtimeConfig,
];

export const CONFIG_KEYS = {
  APP: APP_CONFIG_KEY,
  DATABASE: DATABASE_CONFIG_KEY,
  JWT: JWT_CONFIG_KEY,
  MAIL: MAIL_CONFIG_KEY,
  REDIS: REDIS_CONFIG_KEY,
  SECURITY: SECURITY_CONFIG_KEY,
  THROTTLE: THROTTLE_CONFIG_KEY,
  STORAGE: STORAGE_CONFIG_KEY,
  AI_SERVICE: AI_SERVICE_CONFIG_KEY,
  VECTOR_STORE: VECTOR_STORE_CONFIG_KEY,
  INGESTION: INGESTION_CONFIG_KEY,
  RAG: RAG_CONFIG_KEY,
  LLM: LLM_CONFIG_KEY,
  PII: PII_CONFIG_KEY,
  AGENTS: AGENTS_CONFIG_KEY,
  TOOLS: TOOLS_CONFIG_KEY,
  WORKFLOWS: WORKFLOWS_CONFIG_KEY,
  REALTIME: REALTIME_CONFIG_KEY,
} as const;
