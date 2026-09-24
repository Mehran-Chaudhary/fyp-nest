/**
 * The AI service contract, version 1, as seen from this side.
 *
 * The authoritative specification — endpoints, JSON shapes, status codes and
 * the signing scheme — is `docs/contracts/ai-service-v1.md`. The wire format is
 * snake_case, idiomatic for the Python service that produces it; these types
 * are the camelCase shapes the client returns after validating a response.
 */

export const AI_CONTRACT_VERSION = 1;

export type AiFileType = 'pdf' | 'docx' | 'txt' | 'md';

/** `document` and `query` inputs are embedded differently by asymmetric models. */
export type EmbeddingInputType = 'document' | 'query';

export interface ParseDocumentInput {
  organizationId: string;
  documentId: string;
  fileType: AiFileType;
  filename: string;
  content: Buffer;
  chunkSize: number;
  chunkOverlap: number;
  maxChunks: number;
  signal?: AbortSignal;
}

export interface ParsedChunk {
  index: number;
  text: string;
  tokenCount: number;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface ParsedDocument {
  pageCount: number | null;
  language: string | null;
  chunks: ParsedChunk[];
  parser: string;
}

export interface EmbedInput {
  inputs: string[];
  inputType: EmbeddingInputType;
  organizationId?: string;
  signal?: AbortSignal;
}

export interface EmbeddingBatch {
  model: string;
  dimensions: number;
  embeddings: number[][];
  tokens: number | null;
}

export interface RerankInput {
  query: string;
  documents: string[];
  topN: number;
  organizationId?: string;
  signal?: AbortSignal;
}

export interface RerankResult {
  model: string;
  /** Sorted best first. `index` refers to the position in the input array. */
  results: Array<{ index: number; score: number }>;
}

export interface PiiAnalyzeInput {
  /** Canonicalised texts, analysed independently. */
  texts: string[];
  /** Entity types to look for. Only types the NER model can find are sent. */
  entities: string[];
  language: string;
  scoreThreshold: number;
  organizationId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PiiAnalyzeSpan {
  entityType: string;
  /** UTF-16 offsets, already converted from the service's code-point offsets. */
  start: number;
  end: number;
  score: number;
}

export interface PiiAnalyzeResult {
  /** One list per input text, in input order. */
  results: PiiAnalyzeSpan[][];
  /** e.g. `presidio@2.2.358/en_core_web_lg`. */
  detector: string;
}

export interface AiServiceHealth {
  status: string;
  contractVersion: number;
  embedding: { model: string; dimensions: number } | null;
  rerankAvailable: boolean;
  /** Whether the service implements `/v1/pii/analyze` (added in phase 3). */
  pii: { available: boolean; detector: string | null };
}

/**
 * A failure from the AI service.
 *
 * `retryable` is the decision the ingestion worker cares about: a timeout or a
 * 503 will likely pass on the next attempt; a 422 because the PDF is
 * password-protected never will, and retrying it only delays telling the user.
 */
export class AiServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiServiceError';
  }
}
