import { stripControlCharacters } from '../../common/utils/text.util';
import { codePointLength, codePointOffsetMapper } from '../../common/utils/unicode.util';
import {
  AiServiceError,
  type AiServiceHealth,
  type EmbeddingBatch,
  type ParsedChunk,
  type ParsedDocument,
  type PiiAnalyzeResult,
  type PiiAnalyzeSpan,
  type RerankResult,
} from './ai-service.types';

/**
 * Validation of AI service responses.
 *
 * The AI service is internal, but it is a separately deployed program written
 * by someone else, in another language, on its own release cadence. Its output
 * flows straight into the database and the vector store, so it is treated as a
 * trust boundary: every field is checked for type and range before use. A
 * malformed response becomes one clear `AI_CONTRACT_VIOLATION` naming the
 * field, instead of a `NaN` embedding silently written into the index or a
 * `TypeError` three calls later.
 */

/** Per-chunk text ceiling. A chunk is a few hundred tokens; this is generous. */
const MAX_CHUNK_TEXT_LENGTH = 100_000;

function violation(message: string): AiServiceError {
  return new AiServiceError(
    'AI_CONTRACT_VIOLATION',
    `AI service contract violation: ${message}`,
    false,
  );
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw violation(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalInt(value: unknown, label: string, min = 0): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw violation(`${label} must be an integer ≥ ${min} when present.`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw violation(`${label} must be a string when present.`);
  return value.slice(0, maxLength);
}

export function validateParseResponse(
  json: unknown,
  limits: { maxChunks: number },
): ParsedDocument {
  const root = asRecord(json, 'response');
  const documentInfo =
    root.document === undefined ? {} : asRecord(root.document, 'document');
  const parserInfo = root.parser === undefined ? {} : asRecord(root.parser, 'parser');

  if (!Array.isArray(root.chunks)) throw violation('chunks must be an array.');

  if (root.chunks.length > limits.maxChunks) {
    throw new AiServiceError(
      'TOO_MANY_CHUNKS',
      `The document produced ${root.chunks.length} chunks, above the ${limits.maxChunks} limit.`,
      false,
    );
  }

  const chunks: ParsedChunk[] = [];

  root.chunks.forEach((raw, position) => {
    const chunk = asRecord(raw, `chunks[${position}]`);

    if (typeof chunk.text !== 'string')
      throw violation(`chunks[${position}].text must be a string.`);
    if (chunk.text.length > MAX_CHUNK_TEXT_LENGTH) {
      throw violation(
        `chunks[${position}].text exceeds ${MAX_CHUNK_TEXT_LENGTH} characters.`,
      );
    }

    // Whitespace-only chunks carry nothing worth embedding.
    if (chunk.text.trim().length === 0) return;

    const pageStart = optionalInt(chunk.page_start, `chunks[${position}].page_start`, 1);
    const pageEnd = optionalInt(chunk.page_end, `chunks[${position}].page_end`, 1);
    if (pageStart !== null && pageEnd !== null && pageEnd < pageStart) {
      throw violation(`chunks[${position}] has page_end before page_start.`);
    }

    chunks.push({
      // Re-indexed densely here: positions are derived, never trusted, because
      // they feed the deterministic chunk ids.
      index: chunks.length,
      text: chunk.text,
      tokenCount: optionalInt(chunk.token_count, `chunks[${position}].token_count`) ?? 0,
      pageStart,
      pageEnd,
    });
  });

  const parserName = optionalString(parserInfo.name, 'parser.name', 40) ?? 'unknown';
  const parserVersion = optionalString(parserInfo.version, 'parser.version', 20);

  return {
    pageCount: optionalInt(documentInfo.page_count, 'document.page_count'),
    language: optionalString(documentInfo.language, 'document.language', 16),
    chunks,
    parser: parserVersion ? `${parserName}@${parserVersion}` : parserName,
  };
}

export function validateEmbeddingResponse(
  json: unknown,
  expected: { count: number; dimensions: number; model: string },
): EmbeddingBatch {
  const root = asRecord(json, 'response');

  if (typeof root.model !== 'string' || root.model !== expected.model) {
    // The embedding space is part of the index's identity; vectors from another
    // model would be silently wrong forever.
    throw violation(`model is "${String(root.model)}", expected "${expected.model}".`);
  }

  if (!Array.isArray(root.embeddings) || root.embeddings.length !== expected.count) {
    throw violation(
      `expected ${expected.count} embeddings, received ${Array.isArray(root.embeddings) ? root.embeddings.length : 'none'}.`,
    );
  }

  const embeddings = root.embeddings.map((vector, position) => {
    if (!Array.isArray(vector) || vector.length !== expected.dimensions) {
      throw violation(
        `embeddings[${position}] must have ${expected.dimensions} dimensions, has ${Array.isArray(vector) ? vector.length : 'none'}.`,
      );
    }

    let magnitude = 0;
    for (const component of vector) {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw violation(`embeddings[${position}] contains a non-finite value.`);
      }
      magnitude += component * component;
    }

    // A zero vector has no direction, so cosine similarity against it is
    // undefined; indexing one would poison every query that touched it.
    if (magnitude === 0) throw violation(`embeddings[${position}] is a zero vector.`);

    return vector as number[];
  });

  const usage = root.usage === undefined ? {} : asRecord(root.usage, 'usage');

  return {
    model: root.model,
    dimensions: expected.dimensions,
    embeddings,
    tokens: optionalInt(usage.tokens, 'usage.tokens'),
  };
}

export function validateRerankResponse(
  json: unknown,
  expected: { documentCount: number },
): RerankResult {
  const root = asRecord(json, 'response');
  if (!Array.isArray(root.results)) throw violation('results must be an array.');

  const seen = new Set<number>();
  const results = root.results.map((raw, position) => {
    const entry = asRecord(raw, `results[${position}]`);
    const index = entry.index;
    const score = entry.score;

    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected.documentCount ||
      seen.has(index)
    ) {
      throw violation(`results[${position}].index is out of range or repeated.`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw violation(`results[${position}].score must be a finite number.`);
    }

    seen.add(index);
    return { index, score };
  });

  results.sort((a, b) => b.score - a.score);

  return {
    model: optionalString(root.model, 'model', 128) ?? 'unknown',
    results,
  };
}

export function validateHealthResponse(json: unknown): AiServiceHealth {
  const root = asRecord(json, 'response');
  const embedding =
    root.embedding === undefined || root.embedding === null
      ? null
      : asRecord(root.embedding, 'embedding');
  const rerank =
    root.rerank === undefined || root.rerank === null
      ? null
      : asRecord(root.rerank, 'rerank');
  const pii =
    root.pii === undefined || root.pii === null ? null : asRecord(root.pii, 'pii');

  return {
    status: optionalString(root.status, 'status', 32) ?? 'unknown',
    contractVersion: optionalInt(root.contract_version, 'contract_version') ?? 0,
    embedding:
      embedding && typeof embedding.model === 'string'
        ? {
            model: embedding.model,
            dimensions: optionalInt(embedding.dimensions, 'embedding.dimensions') ?? 0,
          }
        : null,
    rerankAvailable: rerank?.available === true,
    pii: {
      available: pii?.available === true,
      detector: pii ? optionalString(pii.detector, 'pii.detector', 128) : null,
    },
  };
}

const ENTITY_TYPE = /^[A-Z][A-Z0-9_]{1,40}$/;

/**
 * Validates `/v1/pii/analyze` and converts its offsets.
 *
 * The service is Python, which indexes strings by code point; JavaScript
 * indexes by UTF-16 code unit. On text containing an emoji the two differ, and
 * an unconverted span would mask the wrong characters — leaving the name it
 * was meant to hide in clear text. Offsets are checked against each text's
 * code-point length, then converted.
 */
export function validatePiiAnalyzeResponse(
  json: unknown,
  expected: { texts: readonly string[] },
): PiiAnalyzeResult {
  const root = asRecord(json, 'response');
  if (!Array.isArray(root.results) || root.results.length !== expected.texts.length) {
    throw violation(
      `results must be an array with one entry per text (${expected.texts.length}).`,
    );
  }

  const results = root.results.map((rawList: unknown, textIndex): PiiAnalyzeSpan[] => {
    if (!Array.isArray(rawList)) throw violation(`results[${textIndex}] must be an array.`);

    const text = expected.texts[textIndex];
    const length = codePointLength(text);
    const toUtf16 = codePointOffsetMapper(text);

    return rawList.map((raw: unknown, spanIndex): PiiAnalyzeSpan => {
      const label = `results[${textIndex}][${spanIndex}]`;
      const span = asRecord(raw, label);
      const { entity_type: type, start, end, score } = span;

      if (typeof type !== 'string' || !ENTITY_TYPE.test(type)) {
        throw violation(`${label}.entity_type must be an upper-case entity name.`);
      }
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > length
      ) {
        throw violation(`${label} has offsets outside its text.`);
      }
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
        throw violation(`${label}.score must be a number between 0 and 1.`);
      }

      return { entityType: type, start: toUtf16(start), end: toUtf16(end), score };
    });
  });

  const detector = root.detector === undefined ? {} : asRecord(root.detector, 'detector');
  const name = optionalString(detector.name, 'detector.name', 40) ?? 'unknown';
  const version = optionalString(detector.version, 'detector.version', 24);
  const model = optionalString(detector.model, 'detector.model', 64);

  return {
    results,
    detector: name + (version ? `@${version}` : '') + (model ? `/${model}` : ''),
  };
}

/**
 * Extracts `{ error: { code, message } }` from an error response, sanitised.
 *
 * The message is shown to users on a failed document ("This PDF is password
 * protected"), so it is truncated and stripped of control characters: it
 * originates outside this process.
 */
export function extractErrorBody(json: unknown): { code?: string; message?: string } {
  if (typeof json !== 'object' || json === null) return {};

  const error = (json as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return {};

  const { code, message } = error as { code?: unknown; message?: unknown };

  return {
    code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined,
    message:
      typeof message === 'string'
        ? stripControlCharacters(message).slice(0, 300)
        : undefined,
  };
}
