import { registerAs } from '@nestjs/config';

export type RetrievalMode = 'hybrid' | 'dense';

export interface RagConfig {
  defaultTopK: number;
  maxTopK: number;
  searchMode: RetrievalMode;
  candidateMultiplier: number;
  rerankEnabled: boolean;
  maxQueryLength: number;
  auditWithheld: boolean;
  withheldScoreThreshold: number;
}

export const RAG_CONFIG_KEY = 'rag';

export default registerAs(RAG_CONFIG_KEY, (): RagConfig => {
  const maxTopK = Number(process.env.RAG_MAX_TOP_K);

  return {
    defaultTopK: Math.min(Number(process.env.RAG_DEFAULT_TOP_K), maxTopK),
    maxTopK,
    searchMode: (process.env.RAG_SEARCH_MODE ?? 'hybrid') as RetrievalMode,
    candidateMultiplier: Number(process.env.RAG_CANDIDATE_MULTIPLIER),
    rerankEnabled: process.env.RAG_RERANK_ENABLED === 'true',
    maxQueryLength: Number(process.env.RAG_MAX_QUERY_LENGTH),
    auditWithheld: process.env.RAG_AUDIT_WITHHELD !== 'false',
    withheldScoreThreshold: Number(process.env.RAG_WITHHELD_SCORE_THRESHOLD),
  };
});
