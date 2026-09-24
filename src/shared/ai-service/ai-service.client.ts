import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HEADER } from '../../common/constants/app.constants';
import { CircuitBreaker, CircuitOpenError } from '../../common/utils/circuit-breaker';
import { withRetry } from '../../common/utils/retry.util';
import {
  AI_SERVICE_CONFIG_KEY,
  type AiServiceConfig,
} from '../../config/ai-service.config';
import {
  VECTOR_STORE_CONFIG_KEY,
  type VectorStoreConfig,
} from '../../config/vector-store.config';
import { RequestContextService } from '../context/request-context.service';
import {
  AI_CONTRACT_VERSION,
  AiServiceError,
  type AiServiceHealth,
  type EmbedInput,
  type EmbeddingBatch,
  type ParseDocumentInput,
  type ParsedDocument,
  type PiiAnalyzeInput,
  type PiiAnalyzeResult,
  type RerankInput,
  type RerankResult,
} from './ai-service.types';
import { signRequest } from './request-signing';
import {
  extractErrorBody,
  validateEmbeddingResponse,
  validateHealthResponse,
  validateParseResponse,
  validatePiiAnalyzeResponse,
  validateRerankResponse,
} from './response-validation';

interface RequestSpec<T> {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number>;
  body?: Buffer;
  contentType?: string;
  timeoutMs: number;
  organizationId?: string;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  parse: (json: unknown) => T;
}

/**
 * Typed client for the Python AI service (contract v1).
 *
 * The division of labour, which is the point of this class: the AI service
 * does pure computation — turn bytes into chunks, text into vectors — and holds
 * no tenant data and no access policy. This backend decides what may be
 * processed, stores the results, and enforces who may retrieve them. The AI
 * service in particular never talks to the vector store, so the retrieval
 * filter cannot be bypassed by going through it.
 *
 * ## Resilience
 *
 * Every call is signed (see `request-signing.ts`), bounded by a timeout, retried
 * with jittered backoff when the failure is transient, and routed through a
 * circuit breaker so that a dead AI service costs callers microseconds, not
 * thirty-second timeouts. All three operations are pure functions of their
 * input, which is what makes retrying them safe.
 */
@Injectable()
export class AiServiceClient implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiServiceClient.name);
  private readonly config: AiServiceConfig;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number;
  private readonly breaker: CircuitBreaker;

  constructor(
    configService: ConfigService,
    private readonly requestContext: RequestContextService,
  ) {
    this.config = configService.getOrThrow<AiServiceConfig>(AI_SERVICE_CONFIG_KEY);
    const vector = configService.getOrThrow<VectorStoreConfig>(VECTOR_STORE_CONFIG_KEY);
    this.embeddingModel = vector.embedding.model;
    this.embeddingDimensions = vector.embedding.dimensions;
    this.breaker = new CircuitBreaker('ai-service', this.config.circuitBreaker);
  }

  get isConfigured(): boolean {
    return this.config.configured;
  }

  get circuit(): ReturnType<CircuitBreaker['describe']> {
    return this.breaker.describe();
  }

  /**
   * Checks at boot that the AI service embeds with the model this deployment
   * expects. A mismatch is logged loudly rather than thrown, and the check is
   * not awaited: the API should start and serve everything else while someone
   * fixes configuration, not wait on a dependency it may not need yet.
   */
  onApplicationBootstrap(): void {
    if (!this.isConfigured) return;
    void this.checkCompatibility();
  }

  private async checkCompatibility(): Promise<void> {
    try {
      const health = await this.health();
      if (health.contractVersion !== AI_CONTRACT_VERSION) {
        this.logger.warn(
          `AI service reports contract version ${health.contractVersion}; this backend speaks ${AI_CONTRACT_VERSION}.`,
        );
      }
      if (
        health.embedding &&
        (health.embedding.model !== this.embeddingModel ||
          health.embedding.dimensions !== this.embeddingDimensions)
      ) {
        this.logger.error(
          `AI service embeds with ${health.embedding.model} (${health.embedding.dimensions}d) but ` +
            `EMBEDDING_MODEL/EMBEDDING_DIMENSIONS say ${this.embeddingModel} (${this.embeddingDimensions}d). ` +
            'Ingestion and retrieval will fail until they agree.',
        );
      } else {
        this.logger.log(`AI service reachable (status: ${health.status}).`);
      }
    } catch (error) {
      this.logger.warn(
        `AI service not reachable at startup: ${(error as Error).message}. ` +
          'Ingestion jobs will retry until it is.',
      );
    }
  }

  // ── Operations ────────────────────────────────────────────────────────────

  async parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
    return this.call({
      method: 'POST',
      path: '/v1/documents/parse',
      query: {
        chunk_overlap: input.chunkOverlap,
        chunk_size: input.chunkSize,
        file_type: input.fileType,
        filename: input.filename,
        max_chunks: input.maxChunks,
      },
      body: input.content,
      contentType: 'application/octet-stream',
      timeoutMs: this.config.parseTimeoutMs,
      organizationId: input.organizationId,
      extraHeaders: { 'x-document-id': input.documentId },
      signal: input.signal,
      parse: (json) => validateParseResponse(json, { maxChunks: input.maxChunks }),
    });
  }

  async embed(input: EmbedInput): Promise<EmbeddingBatch> {
    if (input.inputs.length === 0) {
      return {
        model: this.embeddingModel,
        dimensions: this.embeddingDimensions,
        embeddings: [],
        tokens: 0,
      };
    }

    return this.call({
      method: 'POST',
      path: '/v1/embeddings',
      body: Buffer.from(
        JSON.stringify({
          model: this.embeddingModel,
          input_type: input.inputType,
          inputs: input.inputs,
        }),
      ),
      contentType: 'application/json',
      timeoutMs: this.config.timeoutMs,
      organizationId: input.organizationId,
      signal: input.signal,
      parse: (json) =>
        validateEmbeddingResponse(json, {
          count: input.inputs.length,
          dimensions: this.embeddingDimensions,
          model: this.embeddingModel,
        }),
    });
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    return this.call({
      method: 'POST',
      path: '/v1/rerank',
      body: Buffer.from(
        JSON.stringify({
          query: input.query,
          documents: input.documents,
          top_n: input.topN,
        }),
      ),
      contentType: 'application/json',
      timeoutMs: this.config.timeoutMs,
      organizationId: input.organizationId,
      signal: input.signal,
      parse: (json) =>
        validateRerankResponse(json, { documentCount: input.documents.length }),
    });
  }

  /**
   * Named-entity detection for the PII engine (added in phase 3; additive, so
   * the contract stays v1).
   *
   * The texts are the ones about to be sent to the language model. The AI
   * service is inside the platform's trust boundary — it already sees every
   * document in plaintext to parse and embed it — which is why detection runs
   * here and never at the model provider.
   */
  async analyzePii(input: PiiAnalyzeInput): Promise<PiiAnalyzeResult> {
    if (input.texts.length === 0) return { results: [], detector: 'none' };

    return this.call({
      method: 'POST',
      path: '/v1/pii/analyze',
      body: Buffer.from(
        JSON.stringify({
          texts: input.texts,
          entities: input.entities,
          language: input.language,
          score_threshold: input.scoreThreshold,
        }),
      ),
      contentType: 'application/json',
      timeoutMs: input.timeoutMs ?? this.config.timeoutMs,
      organizationId: input.organizationId,
      signal: input.signal,
      parse: (json) => validatePiiAnalyzeResponse(json, { texts: input.texts }),
    });
  }

  /**
   * One unretried probe, deliberately outside the circuit breaker: a health
   * check should report what is true right now, and should never itself be the
   * thing that trips the breaker for real traffic.
   */
  async health(): Promise<AiServiceHealth> {
    this.assertConfigured();
    return this.send({
      method: 'GET',
      path: '/v1/health',
      timeoutMs: Math.min(this.config.timeoutMs, 5_000),
      parse: validateHealthResponse,
    });
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new AiServiceError(
        'AI_SERVICE_NOT_CONFIGURED',
        'The AI service is not configured. Set AI_SERVICE_URL and AI_SERVICE_SIGNING_SECRET.',
        false,
      );
    }
  }

  private async call<T>(spec: RequestSpec<T>): Promise<T> {
    this.assertConfigured();

    try {
      return await this.breaker.execute(
        () =>
          withRetry(() => this.send(spec), {
            retries: this.config.maxRetries,
            baseDelayMs: 250,
            maxDelayMs: 5_000,
            signal: spec.signal,
            shouldRetry: (error) => error instanceof AiServiceError && error.retryable,
            retryAfterMs: (error) =>
              error instanceof AiServiceError ? error.retryAfterMs : undefined,
          }),
        // Only the service's own failures count against its health. A 422 for
        // one unreadable PDF says nothing about whether it is up.
        (error) => error instanceof AiServiceError && error.retryable,
      );
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new AiServiceError(
          'AI_SERVICE_CIRCUIT_OPEN',
          'The AI service is failing; requests are paused briefly to let it recover.',
          true,
          undefined,
          error.retryAfterMs,
        );
      }
      throw error;
    }
  }

  private async send<T>(spec: RequestSpec<T>): Promise<T> {
    const query = spec.query
      ? new URLSearchParams(
          // Sorted, so the signed string is independent of how this object was
          // built.
          Object.entries(spec.query)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]): [string, string] => [key, String(value)]),
        ).toString()
      : '';
    const pathAndQuery = query ? `${spec.path}?${query}` : spec.path;
    const body = spec.body ?? null;

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-daiap-contract': String(AI_CONTRACT_VERSION),
      ...signRequest({
        method: spec.method,
        pathAndQuery,
        body,
        secret: this.config.signingSecret,
        keyId: this.config.keyId,
      }),
      ...(spec.contentType ? { 'content-type': spec.contentType } : {}),
      ...(spec.extraHeaders ?? {}),
    };

    // Correlation: the same id links the user's request, this call, and the AI
    // service's own logs.
    const requestId = this.requestContext.requestId;
    if (requestId) headers[HEADER.REQUEST_ID] = requestId;
    if (spec.organizationId) headers[HEADER.ORGANIZATION_ID] = spec.organizationId;

    const timeout = AbortSignal.timeout(spec.timeoutMs);
    const signal = spec.signal ? AbortSignal.any([timeout, spec.signal]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${this.config.url}${pathAndQuery}`, {
        method: spec.method,
        headers,
        body: body ?? undefined,
        signal,
      });
    } catch (error) {
      if (spec.signal?.aborted) throw error;

      const timedOut = timeout.aborted;
      throw new AiServiceError(
        timedOut ? 'AI_SERVICE_TIMEOUT' : 'AI_SERVICE_UNREACHABLE',
        timedOut
          ? `The AI service did not respond within ${spec.timeoutMs}ms.`
          : `The AI service could not be reached: ${(error as Error).message}.`,
        true,
        undefined,
        undefined,
        { cause: error },
      );
    }

    const json = await this.readJson(response);

    if (response.ok) return spec.parse(json);

    const { code, message } = extractErrorBody(json);
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    if (status === 401 || status === 403) {
      // A signing problem is a deployment problem — mismatched secrets or a
      // skewed clock — and fixing it should let queued work resume, so it is
      // retryable rather than permanently failing documents.
      this.logger.error(
        `AI service rejected our signature (HTTP ${status}${code ? `, ${code}` : ''}). ` +
          'Check AI_SERVICE_SIGNING_SECRET matches on both sides and both clocks are in sync.',
      );
      throw new AiServiceError(
        'AI_SERVICE_AUTH_FAILED',
        'The AI service rejected this backend’s credentials.',
        true,
        status,
      );
    }

    const retryable = status === 408 || status === 429 || status >= 500;

    throw new AiServiceError(
      code ?? (retryable ? 'AI_SERVICE_ERROR' : 'AI_SERVICE_REJECTED'),
      message ?? `The AI service returned HTTP ${status}.`,
      retryable,
      status,
      retryAfterMs,
    );
  }

  /**
   * Reads a JSON body with a hard size ceiling.
   *
   * `response.json()` would buffer whatever arrives. A misbehaving service
   * returning a gigabyte would take the process down with it.
   */
  private async readJson(response: Response): Promise<unknown> {
    const limit = this.config.maxResponseBytes;
    const declared = Number(response.headers.get('content-length') ?? 0);

    if (declared > limit) {
      await response.body?.cancel();
      throw new AiServiceError(
        'AI_RESPONSE_TOO_LARGE',
        `The AI service response (${declared} bytes) exceeds the ${limit} byte limit.`,
        false,
        response.status,
      );
    }

    if (!response.body) return null;

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        throw new AiServiceError(
          'AI_RESPONSE_TOO_LARGE',
          `The AI service response exceeded the ${limit} byte limit.`,
          false,
          response.status,
        );
      }
      parts.push(value);
    }

    const text = Buffer.concat(parts).toString('utf8');
    if (text.length === 0) return null;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) return null;
      throw new AiServiceError(
        'AI_CONTRACT_VIOLATION',
        'The AI service returned a body that is not valid JSON.',
        false,
        response.status,
      );
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(date - Date.now(), 0);
}
