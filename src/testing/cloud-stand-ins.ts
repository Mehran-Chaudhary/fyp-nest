import type { Job } from 'bullmq';
import { AiServiceClient } from '../shared/ai-service/ai-service.client';
import {
  AiServiceError,
  type EmbedInput,
  type EmbeddingBatch,
  type ParseDocumentInput,
  type ParsedDocument,
  type PiiAnalyzeInput,
  type PiiAnalyzeResult,
} from '../shared/ai-service/ai-service.types';
import { ObjectStorageService } from '../shared/storage/object-storage.service';
import { matchesFilter, type VectorPayload } from '../shared/vector-store/vector-filter';
import {
  VectorStoreService,
  type VectorHit,
  type VectorPoint,
  type VectorSearchRequest,
} from '../shared/vector-store/vector-store.service';
import type { IngestionJobData } from '../modules/knowledge/ingestion/knowledge-jobs';

/**
 * In-memory stand-ins for the cloud services, honouring the same contracts.
 * Used by the end-to-end suites, which run the real application module graph
 * against a real, disposable PostgreSQL and replace only these endpoints.
 *
 * Excluded from the production build (`tsconfig.build.json`).
 */

export const E2E_DIMENSIONS = 64;
export const E2E_EMBEDDING_MODEL = 'e2e-model';

export class MemoryObjectStorage extends ObjectStorageService {
  readonly objects = new Map<string, Buffer>();
  override get isConfigured(): boolean {
    return true;
  }
  override put(key: string, body: Buffer): Promise<{ etag?: string }> {
    this.objects.set(key, Buffer.from(body));
    return Promise.resolve({ etag: 'memory' });
  }
  override get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new Error(`no object ${key}`));
    return Promise.resolve(Buffer.from(object));
  }
  override delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  override deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  override ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export class MemoryVectorStore extends VectorStoreService {
  readonly points = new Map<string, { dense: number[]; payload: VectorPayload }>();
  override get isConfigured(): boolean {
    return true;
  }
  override get embeddingModel(): string {
    return E2E_EMBEDDING_MODEL;
  }
  override get embeddingDimensions(): number {
    return E2E_DIMENSIONS;
  }
  override ensureCollection(): Promise<void> {
    return Promise.resolve();
  }
  override upsert(_organizationId: string, points: VectorPoint[]): Promise<void> {
    for (const point of points) {
      this.points.set(point.id, { dense: point.dense, payload: { ...point.payload } });
    }
    return Promise.resolve();
  }
  override activateVersion(
    organizationId: string,
    documentId: string,
    version: number,
  ): Promise<void> {
    for (const [id, point] of this.points) {
      if (
        point.payload.organization_id !== organizationId ||
        point.payload.document_id !== documentId
      ) {
        continue;
      }
      if (point.payload.index_version === version) point.payload.active = true;
      else this.points.delete(id);
    }
    return Promise.resolve();
  }
  override deleteDocument(
    organizationId: string,
    documentId: string,
    version?: number,
  ): Promise<void> {
    for (const [id, point] of this.points) {
      if (
        point.payload.organization_id === organizationId &&
        point.payload.document_id === documentId &&
        (version === undefined || point.payload.index_version === version)
      ) {
        this.points.delete(id);
      }
    }
    return Promise.resolve();
  }
  override deleteKnowledgeBase(
    organizationId: string,
    knowledgeBaseId: string,
  ): Promise<void> {
    for (const [id, point] of this.points) {
      if (
        point.payload.organization_id === organizationId &&
        point.payload.knowledge_base_id === knowledgeBaseId
      ) {
        this.points.delete(id);
      }
    }
    return Promise.resolve();
  }
  override setDocumentClassification(
    organizationId: string,
    documentId: string,
    classification: string,
  ): Promise<void> {
    for (const point of this.points.values()) {
      if (
        point.payload.organization_id === organizationId &&
        point.payload.document_id === documentId
      ) {
        point.payload.classification = classification;
      }
    }
    return Promise.resolve();
  }
  override search(
    _organizationId: string,
    request: VectorSearchRequest,
  ): Promise<VectorHit[]> {
    const hits = [...this.points.entries()]
      .filter(([, point]) =>
        matchesFilter(point.payload as unknown as Record<string, unknown>, request.filter),
      )
      .map(([id, point]) => ({
        id,
        score: cosine(request.dense, point.dense),
        payload: point.payload,
      }))
      .filter(
        (hit) =>
          request.scoreThreshold === undefined || hit.score >= request.scoreThreshold,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, request.limit);
    return Promise.resolve(hits);
  }
  countFor(documentId: string): number {
    return [...this.points.values()].filter(
      (point) => point.payload.document_id === documentId,
    ).length;
  }
}

/**
 * The Python AI service: paragraph chunking, deterministic bag-of-words
 * embeddings, and — for the PII engine — a named-entity "model" that tags the
 * names it has been told about, at code-point offsets converted exactly as the
 * real client does.
 */
export class FakeAiService extends AiServiceClient {
  /** When set, the Nth embed call (1-based) fails transiently — a crash mid-embedding. */
  failOnEmbedCall: number | null = null;
  embedCalls = 0;
  /** Names the stand-in NER model recognises as PERSON. */
  knownNames: string[] = [];
  /** Simulates the NER endpoint being down. */
  nerDown = false;
  nerCalls = 0;

  override get isConfigured(): boolean {
    return true;
  }
  override onApplicationBootstrap(): void {}

  override parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
    const text = input.content.toString('utf8');
    const chunks = text
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, index) => ({
        index,
        text: part,
        tokenCount: part.split(/\s+/).length,
        pageStart: 1,
        pageEnd: 1,
      }));
    return Promise.resolve({ pageCount: 1, language: 'en', chunks, parser: 'e2e-fake@1' });
  }

  override embed(input: EmbedInput): Promise<EmbeddingBatch> {
    this.embedCalls += 1;
    if (this.failOnEmbedCall !== null && this.embedCalls === this.failOnEmbedCall) {
      return Promise.reject(
        new AiServiceError('AI_SERVICE_TIMEOUT', 'simulated crash', true),
      );
    }
    return Promise.resolve({
      model: E2E_EMBEDDING_MODEL,
      dimensions: E2E_DIMENSIONS,
      embeddings: input.inputs.map(embedText),
      tokens: input.inputs.length,
    });
  }

  override analyzePii(input: PiiAnalyzeInput): Promise<PiiAnalyzeResult> {
    this.nerCalls += 1;
    if (this.nerDown) {
      return Promise.reject(
        new AiServiceError('AI_SERVICE_UNREACHABLE', 'simulated NER outage', true),
      );
    }
    const results = input.texts.map((text) => {
      const spans: PiiAnalyzeResult['results'][number] = [];
      if (!input.entities.includes('PERSON')) return spans;
      for (const name of this.knownNames) {
        let from = 0;
        for (let at = text.indexOf(name, from); at !== -1; at = text.indexOf(name, from)) {
          spans.push({
            entityType: 'PERSON',
            start: at,
            end: at + name.length,
            score: 0.85,
          });
          from = at + name.length;
        }
      }
      return spans;
    });
    return Promise.resolve({ results, detector: 'e2e-ner@1' });
  }
}

/** Records enqueues instead of touching Redis; a test drives the pipeline itself. */
export class RecordingJobs {
  readonly ingestion: Array<{ id: string; indexVersion: number }> = [];
  readonly maintenance: Array<{ name: string; subjectId: string }> = [];
  enqueueIngestion(document: { id: string; indexVersion: number }): Promise<boolean> {
    this.ingestion.push({ id: document.id, indexVersion: document.indexVersion });
    return Promise.resolve(true);
  }
  enqueueMaintenance(name: string, _data: unknown, subjectId: string): Promise<boolean> {
    this.maintenance.push({ name, subjectId });
    return Promise.resolve(true);
  }
  deadLetter(): Promise<void> {
    return Promise.resolve();
  }
}

/** One chat request as the scripted model sees it. */
export interface FakeChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  /** Stop sequences the caller asked for (`options.stop`). */
  stop: string[];
  /** The system prompt: which agent is being asked. */
  system: string;
  /** The latest user message: the task, or a tool result. */
  lastUser: string;
}

/**
 * What the scripted model does with a request: answer with this text (cut at
 * the first stop sequence, as Ollama does), answer slowly, fail with an HTTP
 * status, or — `undefined` — fall back to the default answer.
 */
export type FakeReply =
  | string
  | { text: string; delayMs?: number }
  | { status: number; body?: string }
  | undefined;

/**
 * A scripted Ollama. Speaks the real `/api/*` wire format — NDJSON streaming
 * included — behind the real provider, and records every request it receives:
 * exactly what left the gateway.
 *
 * Its default "model" answers with the placeholders it was shown, split into
 * three-character chunks so that placeholders straddle chunk boundaries and
 * the streaming unmasker is exercised for real. A suite can install a
 * `script` to play specific agents: tool calls, JSON answers, outages, and
 * slow answers that honour cancellation.
 */
export class FakeOllama {
  readonly captured: Array<{
    model: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  model = 'e2e-model:latest';
  contextLength = 8192;
  script: ((request: FakeChatRequest) => FakeReply | Promise<FakeReply>) | null = null;
  /** Requests abandoned by the caller (a cancelled step) while being answered. */
  aborted = 0;

  readonly fetch = (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    switch (url.pathname) {
      case '/api/version':
        return json({ version: 'e2e' });
      case '/api/tags':
        return json({
          models: [
            {
              name: this.model,
              size: 1,
              details: {
                family: 'llama',
                parameter_size: '8B',
                quantization_level: 'Q4_K_M',
              },
            },
          ],
        });
      case '/api/show':
        return json({ model_info: { 'llama.context_length': this.contextLength } });
      case '/api/chat': {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
          model: string;
          messages: Array<{ role: string; content: string }>;
          options?: { stop?: string[] };
        };
        this.captured.push({ model: body.model, messages: body.messages });
        return this.chat(body, init.signal ?? undefined);
      }
      default:
        return Promise.resolve(new Response('not found', { status: 404 }));
    }
  };

  private async chat(
    body: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      options?: { stop?: string[] };
    },
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const stop = body.options?.stop ?? [];
    const reply = this.script
      ? await this.script({
          model: body.model,
          messages: body.messages,
          stop,
          system: body.messages.find((message) => message.role === 'system')?.content ?? '',
          lastUser:
            [...body.messages].reverse().find((message) => message.role === 'user')
              ?.content ?? '',
        })
      : undefined;

    if (reply !== undefined && typeof reply === 'object' && 'status' in reply) {
      return new Response(reply.body ?? 'scripted failure', { status: reply.status });
    }
    const text =
      typeof reply === 'string' ? reply : (reply?.text ?? this.answer(body.messages));
    const delayMs = typeof reply === 'object' ? (reply.delayMs ?? 0) : 0;
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            this.aborted += 1;
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          },
          { once: true },
        );
      });
    }
    return this.stream(cutAtStop(text, stop), body.messages);
  }

  /** Everything the model has been sent, as one string. */
  get everythingSent(): string {
    return this.captured
      .flatMap((request) => request.messages.map((message) => message.content))
      .join('\n');
  }

  lastPrompt(): string {
    const last = this.captured[this.captured.length - 1];
    return last ? last.messages.map((message) => message.content).join('\n') : '';
  }

  private answer(messages: Array<{ role: string; content: string }>): string {
    const prompt = messages.map((message) => message.content).join('\n');
    const first = (type: string) => prompt.match(new RegExp(`\\[${type}_\\d+\\]`))?.[0];
    const person = first('PERSON');
    const salary = first('SALARY');
    const card = first('CREDIT_CARD');
    const source = prompt.includes('<source tag="S1"') ? ' [S1]' : '';

    if (!person && !salary) return `I do not know based on the available sources.${source}`;
    const parts = [
      `${person ?? 'The employee'} earns ${salary ?? 'an undisclosed amount'}.`,
    ];
    // A mangled placeholder, the way small models write them.
    if (person) parts.push(`${person.toLowerCase().replace('_', ' ')} is on the payroll.`);
    if (card) parts.push(`Card on file: ${card}.`);
    return `${parts.join(' ')}${source}`;
  }

  private stream(answer: string, messages: Array<{ content: string }>): Response {
    const encoder = new TextEncoder();
    const promptTokens = messages.reduce(
      (total, message) => total + Math.ceil(message.content.length / 4),
      0,
    );
    const pieces: string[] = [];
    for (let index = 0; index < answer.length; index += 3)
      pieces.push(answer.slice(index, index + 3));

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ message: { role: 'assistant', content: piece }, done: false })}\n`,
            ),
          );
        }
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              done: true,
              done_reason: 'stop',
              prompt_eval_count: promptTokens,
              eval_count: pieces.length,
            })}\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  }
}

/** What Ollama returns when a stop sequence is hit: the text before it. */
function cutAtStop(text: string, stop: readonly string[]): string {
  let end = text.length;
  for (const sequence of stop) {
    const at = sequence ? text.indexOf(sequence) : -1;
    if (at !== -1 && at < end) end = at;
  }
  return text.slice(0, end);
}

export function embedText(text: string): number[] {
  const vector = new Array<number>(E2E_DIMENSIONS).fill(0.001);
  for (const word of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % E2E_DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

export function ingestionJob(
  data: Omit<IngestionJobData, 'enqueuedAt'>,
  attemptsMade = 0,
): Job<IngestionJobData> {
  return {
    id: `e2e-${data.documentId}-${data.indexVersion}-${attemptsMade}`,
    name: 'ingest',
    data: { ...data, enqueuedAt: Date.now() },
    attemptsMade,
    opts: { attempts: 5 },
  } as unknown as Job<IngestionJobData>;
}
