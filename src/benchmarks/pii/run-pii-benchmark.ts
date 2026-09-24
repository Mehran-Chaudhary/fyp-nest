/**
 * PII Redaction Engine benchmark.
 *
 *   npm run benchmark:pii                         # patterns only, 2,000 documents
 *   npm run benchmark:pii -- --documents 5000 --seed 7
 *   npm run benchmark:pii -- --ner ai-service     # names too, via the AI service
 *   npm run benchmark:pii -- --ner presidio       # names too, via a Presidio analyzer
 *
 * Measures, on a deterministic synthetic corpus (see corpus.ts), exactly the
 * code path production runs — canonicalisation, pattern and NER detection,
 * masking with linking and propagation, the gateway's egress check, and
 * unmasking — and writes `docs/benchmarks/pii-redaction.{md,json}`.
 *
 * NER modes read the same environment variables as the application
 * (AI_SERVICE_URL and AI_SERVICE_SIGNING_SECRET, or PRESIDIO_ANALYZER_URL).
 */
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import aiServiceConfigFactory, {
  AI_SERVICE_CONFIG_KEY,
} from '../../config/ai-service.config';
import { validateEnvironment } from '../../config/env.validation';
import piiConfigFactory, { PII_CONFIG_KEY, type PiiConfig } from '../../config/pii.config';
import { SECURITY_CONFIG_KEY } from '../../config/security.config';
import vectorStoreConfigFactory, {
  VECTOR_STORE_CONFIG_KEY,
} from '../../config/vector-store.config';
import { AiServiceNerDetector } from '../../modules/privacy/detection/ai-service-ner.detector';
import {
  DisabledNerDetector,
  type NerDetector,
} from '../../modules/privacy/detection/ner-detector';
import { PiiDetectionService } from '../../modules/privacy/detection/pii-detection.service';
import { PresidioNerDetector } from '../../modules/privacy/detection/presidio-ner.detector';
import {
  entityDefinition,
  nameTokens,
  normalizeEntityValue,
} from '../../modules/privacy/domain/entity-catalogue';
import {
  MaskingSession,
  prepareText,
  type AppliedSpan,
} from '../../modules/privacy/domain/masking-session';
import {
  maskingPolicyFor,
  type EffectivePiiPolicy,
} from '../../modules/privacy/domain/policy';
import { AiServiceClient } from '../../shared/ai-service/ai-service.client';
import { RequestContextService } from '../../shared/context/request-context.service';
import type { RedisService } from '../../shared/redis/redis.service';
import { DENY_LIST, generateCorpus, Rng, type AnnotatedDocument } from './corpus';
import { renderReport, type BenchmarkResult } from './report';
import { distribution, prf, ScoreAccumulator, scoreDocument } from './scoring';

type NerMode = 'none' | 'ai-service' | 'presidio';

interface Options {
  documents: number;
  seed: number;
  ner: NerMode;
  out: string | null;
}

const PATTERN_TYPES = [
  'EMAIL_ADDRESS',
  'PHONE_NUMBER',
  'CREDIT_CARD',
  'IBAN_CODE',
  'US_SSN',
  'PK_CNIC',
  'IP_ADDRESS',
  'SALARY',
  'CREDENTIAL',
  'CUSTOM',
];

function parseOptions(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const ner = (value('--ner') ?? 'none') as NerMode;
  if (!['none', 'ai-service', 'presidio'].includes(ner)) {
    throw new Error(`--ner must be none, ai-service or presidio (got ${ner}).`);
  }
  return {
    documents: Number(value('--documents') ?? 2_000),
    seed: Number(value('--seed') ?? 20_260_924),
    ner,
    out: argv.includes('--no-write') ? null : (value('--out') ?? 'docs/benchmarks'),
  };
}

/** A ConfigService over plain values, for running the services outside Nest. */
function configOf(values: Record<string, unknown>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values))
        throw new Error(`Configuration "${key}" is not available to the benchmark.`);
      return values[key];
    },
  } as unknown as ConfigService;
}

/** Fills in schema defaults exactly as the application's ConfigModule does. */
function loadEnvironment(): void {
  const validated = validateEnvironment({ ...process.env });
  for (const [key, entry] of Object.entries(validated)) {
    const primitive =
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean';
    if (process.env[key] === undefined && primitive) process.env[key] = String(entry);
  }
}

function detectorFor(mode: NerMode): { ner: NerDetector; pii: PiiConfig } {
  loadEnvironment();
  const pii = { ...piiConfigFactory(), cacheTtlSeconds: 0 };
  switch (mode) {
    case 'none':
      return { ner: new DisabledNerDetector(), pii };
    case 'presidio': {
      const detector = new PresidioNerDetector(pii);
      if (!detector.isConfigured)
        throw new Error('--ner presidio needs PRESIDIO_ANALYZER_URL.');
      return { ner: detector, pii };
    }
    case 'ai-service': {
      const client = new AiServiceClient(
        configOf({
          [AI_SERVICE_CONFIG_KEY]: aiServiceConfigFactory(),
          [VECTOR_STORE_CONFIG_KEY]: vectorStoreConfigFactory(),
        }),
        new RequestContextService(),
      );
      if (!client.isConfigured)
        throw new Error(
          '--ner ai-service needs AI_SERVICE_URL and AI_SERVICE_SIGNING_SECRET.',
        );
      return { ner: new AiServiceNerDetector(client, pii.timeoutMs), pii };
    }
  }
}

function policyFor(mode: NerMode): EffectivePiiPolicy {
  const entityTypes = mode === 'none' ? PATTERN_TYPES : [...PATTERN_TYPES, 'PERSON'];
  return {
    organizationId: 'benchmark',
    enabled: true,
    entityTypes: [...entityTypes].sort(),
    scoreThreshold: 0.5,
    onDetectorFailure: 'REFUSE',
    language: 'en',
    allowList: [],
    denyList: DENY_LIST,
    source: 'workspace',
    version: 1,
    updatedAt: null,
  };
}

/**
 * Whether unmasking restored the same entity at every masked span. One entity
 * written two ways ("Rs. 280,000", "PKR 280,000") shares one placeholder and is
 * restored in one form; a partial name ("Raza") is restored as the full name it
 * was linked to. Anything else — a year restored as a salary — is an error.
 */
function restoresSameEntities(
  prepared: string,
  restored: string,
  spans: readonly AppliedSpan[],
  display: (placeholder: string) => string,
): boolean {
  let expected = '';
  let cursor = 0;
  for (const span of spans) {
    const original = prepared.slice(span.start, span.end);
    const shown = display(span.placeholder);
    const same =
      span.entityType === 'PERSON'
        ? nameTokens(original).every((token) => nameTokens(shown).includes(token))
        : normalizeEntityValue(span.entityType, original) ===
          normalizeEntityValue(span.entityType, shown);
    if (!same) return false;
    expected += prepared.slice(cursor, span.start) + shown;
    cursor = span.end;
  }
  return restored === expected + prepared.slice(cursor);
}

const NO_CACHE = {
  getJson: () => Promise.resolve(null),
  setJson: () => Promise.resolve(),
} as unknown as RedisService;

interface Timing {
  prepare: number;
  patterns: number;
  ner: number;
  mask: number;
  egress: number;
  unmask: number;
  total: number;
  characters: number;
}

async function main(): Promise<void> {
  Logger.overrideLogger(['error']);
  const options = parseOptions(process.argv.slice(2));
  const { ner, pii } = detectorFor(options.ner);
  const detection = new PiiDetectionService(
    ner,
    NO_CACHE,
    configOf({
      [PII_CONFIG_KEY]: pii,
      [SECURITY_CONFIG_KEY]: { encryptionKey: 'benchmark-only-key-material-0123456789' },
    }),
  );
  const policy = policyFor(options.ner);
  const measured = new Set(policy.entityTypes);
  const masking = maskingPolicyFor(policy);

  const generationStarted = performance.now();
  const corpus = generateCorpus({ documents: options.documents, seed: options.seed });
  const generationMs = performance.now() - generationStarted;

  for (const document of corpus) {
    if (prepareText(document.text) !== document.canonical) {
      throw new Error(
        `Corpus error: ${document.id} does not canonicalise to its annotated form.`,
      );
    }
  }

  const run = async (document: AnnotatedDocument, rng: Rng) => {
    const started = performance.now();
    const prepared = prepareText(document.text);
    const prepareMs = performance.now() - started;

    const detected = await detection.detect({
      organizationId: 'benchmark',
      policy,
      texts: [prepared],
    });

    const session = new MaskingSession(masking);
    const maskStarted = performance.now();
    const [masked] = session.mask([{ id: document.id, text: prepared }], detected.spans);
    const maskMs = performance.now() - maskStarted;

    const egressStarted = performance.now();
    const leaks = session.findLeaks(masked.text);
    const egressMs = performance.now() - egressStarted;

    const unmaskStarted = performance.now();
    const restored = session.unmask(masked.text);
    const unmaskMs = performance.now() - unmaskStarted;
    const totalMs = performance.now() - started;

    // Streaming: the same text, cut at random points, must unmask identically.
    const streamer = session.createStreamUnmasker();
    let streamed = '';
    for (let at = 0; at < masked.text.length;) {
      const size = rng.int(1, 8);
      streamed += streamer.push(masked.text.slice(at, at + size));
      at += size;
    }
    streamed += streamer.flush();

    const equivalent = restoresSameEntities(
      prepared,
      restored,
      masked.spans,
      (placeholder) => session.reveal(placeholder) ?? placeholder,
    );
    const entities = session.entityCount;
    session.destroy();
    return {
      masked,
      leaks,
      degraded: detected.degraded,
      roundTrip: restored === prepared,
      equivalent,
      streaming: streamed === restored,
      entities,
      timing: {
        prepare: prepareMs,
        patterns: detected.timings.patternMs,
        ner: detected.timings.nerMs,
        mask: maskMs,
        egress: egressMs,
        unmask: unmaskMs,
        total: totalMs,
        characters: prepared.length,
      } satisfies Timing,
    };
  };

  // Warm-up: compile every regular expression and let the JIT settle.
  const warmupRng = new Rng(1);
  for (const document of corpus.slice(0, Math.min(100, corpus.length)))
    await run(document, warmupRng);

  const scores = new ScoreAccumulator();
  const timings: Timing[] = [];
  const rng = new Rng(options.seed ^ 0x5eed);
  let egressFindings = 0;
  let roundTripFailures = 0;
  let equivalenceFailures = 0;
  let streamingFailures = 0;
  let degraded = 0;
  let placeholders = 0;
  const started = performance.now();

  for (const document of corpus) {
    const result = await run(document, rng);
    scores.add(scoreDocument(document, result.masked.spans, measured));
    timings.push(result.timing);
    if (result.leaks.length > 0) egressFindings += 1;
    if (!result.roundTrip) roundTripFailures += 1;
    if (!result.equivalent) equivalenceFailures += 1;
    if (!result.streaming) streamingFailures += 1;
    if (result.degraded) degraded += 1;
    placeholders += result.entities;
  }
  const wallMs = performance.now() - started;

  // ── Aggregate ──────────────────────────────────────────────────────────
  const byType = [...scores.byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, counts]) => ({
      type,
      label: entityDefinition(type).label,
      ...counts,
      ...prf(counts.correct, counts.predicted, counts.detected, counts.gold),
      leakRate: counts.gold === 0 ? 0 : counts.leaked / counts.gold,
    }));
  const totals = byType.reduce(
    (sum, row) => ({
      gold: sum.gold + row.gold,
      detected: sum.detected + row.detected,
      predicted: sum.predicted + row.predicted,
      correct: sum.correct + row.correct,
      leaked: sum.leaked + row.leaked,
    }),
    { gold: 0, detected: 0, predicted: 0, correct: 0, leaked: 0 },
  );
  const scored = byType.filter((row) => row.gold > 0);
  const macro = {
    precision:
      scored.reduce((sum, row) => sum + row.precision, 0) / Math.max(1, scored.length),
    recall: scored.reduce((sum, row) => sum + row.recall, 0) / Math.max(1, scored.length),
    f1: scored.reduce((sum, row) => sum + row.f1, 0) / Math.max(1, scored.length),
  };

  const bucket = (timing: Timing) =>
    timing.characters < 500
      ? 'short (< 500 chars)'
      : timing.characters < 3_000
        ? 'medium (500–3,000)'
        : 'long (≥ 3,000)';
  const buckets = new Map<string, Timing[]>();
  for (const timing of timings) {
    const key = bucket(timing);
    buckets.set(key, [...(buckets.get(key) ?? []), timing]);
  }

  const personGold = corpus.reduce(
    (sum, document) =>
      sum + document.entities.filter((entity) => entity.type === 'PERSON').length,
    0,
  );
  const characters = corpus.reduce((sum, document) => sum + document.canonical.length, 0);

  const result: BenchmarkResult = {
    generatedAt: new Date().toISOString(),
    command: `npm run benchmark:pii -- --documents ${options.documents} --seed ${options.seed} --ner ${options.ner}`,
    environment: {
      node: process.version,
      platform: `${platform()} ${release()} (${arch()})`,
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
    },
    corpus: {
      seed: options.seed,
      documents: corpus.length,
      characters,
      entities: corpus.reduce((sum, document) => sum + document.entities.length, 0),
      decoys: corpus.reduce((sum, document) => sum + document.decoys.length, 0),
      obfuscatedEntities: corpus.reduce(
        (sum, document) =>
          sum + document.entities.filter((entity) => entity.variant.includes('+')).length,
        0,
      ),
      byCategory: Object.fromEntries(
        [...new Set(corpus.map((document) => document.category))]
          .sort()
          .map((category) => [
            category,
            corpus.filter((document) => document.category === category).length,
          ]),
      ),
      generationMs,
    },
    configuration: {
      ner: options.ner,
      nerDetector: ner.kind,
      entityTypes: policy.entityTypes,
      scoreThreshold: policy.scoreThreshold,
      denyList: DENY_LIST,
      personEntitiesNotMeasured: options.ner === 'none' ? personGold : 0,
    },
    detection: {
      byType,
      micro: prf(totals.correct, totals.predicted, totals.detected, totals.gold),
      macro,
      typeConfusions: Object.fromEntries(scores.typeConfusions),
    },
    protection: {
      entities: totals.gold,
      leaked: totals.leaked,
      leakRate: totals.gold === 0 ? 0 : totals.leaked / totals.gold,
      byVariant: [...scores.byVariant.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([variant, counts]) => ({
          variant,
          ...counts,
          rate: counts.protected / counts.gold,
        })),
      documentsWithEgressFindings: egressFindings,
      degradedDocuments: degraded,
      placeholdersIssued: placeholders,
    },
    decoys: [...scores.decoys.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, counts]) => ({
        kind,
        ...counts,
        falsePositiveRate: counts.masked / counts.total,
      })),
    falsePositiveExamples: scores.falsePositives.slice(0, 25),
    falsePositiveCount: scores.falsePositives.length,
    roundTrip: {
      documents: corpus.length,
      exact: corpus.length - roundTripFailures,
      equivalent: corpus.length - equivalenceFailures,
      streaming: corpus.length - streamingFailures,
    },
    latency: {
      stages: {
        prepare: distribution(timings.map((timing) => timing.prepare)),
        patterns: distribution(timings.map((timing) => timing.patterns)),
        ner: distribution(timings.map((timing) => timing.ner)),
        mask: distribution(timings.map((timing) => timing.mask)),
        egress: distribution(timings.map((timing) => timing.egress)),
        unmask: distribution(timings.map((timing) => timing.unmask)),
        total: distribution(timings.map((timing) => timing.total)),
      },
      bySize: [...buckets.entries()].map(([size, entries]) => ({
        size,
        documents: entries.length,
        meanCharacters: Math.round(
          entries.reduce((sum, entry) => sum + entry.characters, 0) / entries.length,
        ),
        total: distribution(entries.map((entry) => entry.total)),
      })),
      throughputCharactersPerMs:
        characters / timings.reduce((sum, timing) => sum + timing.total, 0),
      wallMs,
    },
  };

  const markdown = renderReport(result);
  if (options.out) {
    const directory = resolve(options.out);
    mkdirSync(directory, { recursive: true });
    const suffix = options.ner === 'none' ? '' : `-${options.ner}`;
    writeFileSync(
      join(directory, `pii-redaction${suffix}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    writeFileSync(join(directory, `pii-redaction${suffix}.md`), markdown);
    console.log(`Wrote ${join(options.out, `pii-redaction${suffix}.md`)} and .json`);
  }

  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  console.log(
    [
      `PII benchmark — ${corpus.length} documents, ${characters.toLocaleString('en-US')} characters, ${totals.gold} entities (NER: ${options.ner})`,
      `  micro precision ${pct(result.detection.micro.precision)}, recall ${pct(result.detection.micro.recall)}, F1 ${pct(result.detection.micro.f1)}`,
      `  leak rate ${pct(result.protection.leakRate)} (${totals.leaked} of ${totals.gold}); egress findings in ${egressFindings} documents`,
      `  round trip: same entities restored ${result.roundTrip.equivalent}/${corpus.length} (character-exact ${result.roundTrip.exact}), streaming ${result.roundTrip.streaming}/${corpus.length}`,
      `  overhead per document: p50 ${result.latency.stages.total.p50.toFixed(3)} ms, p95 ${result.latency.stages.total.p95.toFixed(3)} ms, p99 ${result.latency.stages.total.p99.toFixed(3)} ms`,
    ].join('\n'),
  );

  if (equivalenceFailures > 0 || streamingFailures > 0 || egressFindings > 0)
    process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
