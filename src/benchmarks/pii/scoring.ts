import type { AppliedSpan } from '../../modules/privacy/domain/masking-session';
import type { AnnotatedDocument } from './corpus';

/**
 * Scoring for the PII benchmark.
 *
 * Two different questions, answered separately:
 *
 *  - **Detection accuracy** (precision, recall, F1 per entity type): did the
 *    engine find the entity *and name its type correctly*? Matching is by
 *    overlap — a detection that covers "PKR 950,000" when the annotation says
 *    "PKR 950,000 per year" is a hit — because boundaries matter less than
 *    coverage for masking.
 *  - **Protection** (leak rate): whatever the type, did every character of the
 *    sensitive value end up inside a placeholder? This is the number that
 *    matters for privacy. A card number masked as a phone number is a type
 *    error but not a leak.
 */

export interface TypeTally {
  gold: number;
  detected: number;
  predicted: number;
  correct: number;
  leaked: number;
}

export interface DecoyTally {
  total: number;
  masked: number;
}

export interface DocumentScore {
  byType: Map<string, TypeTally>;
  decoys: Map<string, DecoyTally>;
  byVariant: Map<string, { gold: number; protected: number }>;
  falsePositives: Array<{ type: string; text: string; kind: string }>;
  typeConfusions: Array<{ gold: string; predicted: string }>;
}

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

function tally<K, V>(map: Map<K, V>, key: K, empty: () => V): V {
  let value = map.get(key);
  if (!value) {
    value = empty();
    map.set(key, value);
  }
  return value;
}

const emptyType = (): TypeTally => ({
  gold: 0,
  detected: 0,
  predicted: 0,
  correct: 0,
  leaked: 0,
});

/**
 * Scores one document. `spans` are the spans actually masked (after policy,
 * overlap resolution, linking and propagation), with offsets into the
 * canonical text; `measured` limits scoring to the entity types the run could
 * detect at all.
 */
export function scoreDocument(
  document: AnnotatedDocument,
  spans: readonly AppliedSpan[],
  measured: ReadonlySet<string>,
): DocumentScore {
  const score: DocumentScore = {
    byType: new Map(),
    decoys: new Map(),
    byVariant: new Map(),
    falsePositives: [],
    typeConfusions: [],
  };

  const covered = new Uint8Array(document.canonical.length);
  for (const span of spans) covered.fill(1, span.start, span.end);

  for (const gold of document.entities) {
    if (!measured.has(gold.type)) continue;
    const counts = tally(score.byType, gold.type, emptyType);
    counts.gold += 1;

    const sameType = spans.some(
      (span) => span.entityType === gold.type && overlaps(span, gold),
    );
    if (sameType) counts.detected += 1;
    else {
      const other = spans.find((span) => overlaps(span, gold));
      if (other)
        score.typeConfusions.push({ gold: gold.type, predicted: other.entityType });
    }

    let isProtected = true;
    for (let index = gold.start; index < gold.end; index += 1) {
      if (!covered[index] && !/\s/u.test(document.canonical[index])) {
        isProtected = false;
        break;
      }
    }
    if (!isProtected) counts.leaked += 1;

    const variant = tally(score.byVariant, `${gold.type} · ${gold.variant}`, () => ({
      gold: 0,
      protected: 0,
    }));
    variant.gold += 1;
    if (isProtected) variant.protected += 1;
  }

  for (const span of spans) {
    if (!measured.has(span.entityType)) continue;
    const counts = tally(score.byType, span.entityType, emptyType);
    counts.predicted += 1;
    const hit = document.entities.some(
      (gold) => gold.type === span.entityType && overlaps(span, gold),
    );
    if (hit) {
      counts.correct += 1;
      continue;
    }
    const decoy = document.decoys.find((candidate) => overlaps(span, candidate));
    const other = document.entities.find((gold) => overlaps(span, gold));
    score.falsePositives.push({
      type: span.entityType,
      text: document.canonical.slice(span.start, span.end),
      kind: decoy
        ? `decoy:${decoy.kind}`
        : other
          ? `other-entity:${other.type}`
          : 'unannotated',
    });
  }

  for (const decoy of document.decoys) {
    const counts = tally(score.decoys, decoy.kind, () => ({ total: 0, masked: 0 }));
    counts.total += 1;
    if (spans.some((span) => overlaps(span, decoy))) counts.masked += 1;
  }

  return score;
}

/** Merges per-document scores into corpus totals. */
export class ScoreAccumulator {
  readonly byType = new Map<string, TypeTally>();
  readonly decoys = new Map<string, DecoyTally>();
  readonly byVariant = new Map<string, { gold: number; protected: number }>();
  readonly falsePositives: Array<{ type: string; text: string; kind: string }> = [];
  readonly typeConfusions = new Map<string, number>();

  add(score: DocumentScore): void {
    for (const [type, counts] of score.byType) {
      const total = tally(this.byType, type, emptyType);
      total.gold += counts.gold;
      total.detected += counts.detected;
      total.predicted += counts.predicted;
      total.correct += counts.correct;
      total.leaked += counts.leaked;
    }
    for (const [kind, counts] of score.decoys) {
      const total = tally(this.decoys, kind, () => ({ total: 0, masked: 0 }));
      total.total += counts.total;
      total.masked += counts.masked;
    }
    for (const [variant, counts] of score.byVariant) {
      const total = tally(this.byVariant, variant, () => ({ gold: 0, protected: 0 }));
      total.gold += counts.gold;
      total.protected += counts.protected;
    }
    this.falsePositives.push(...score.falsePositives);
    for (const confusion of score.typeConfusions) {
      const key = `${confusion.gold} → ${confusion.predicted}`;
      this.typeConfusions.set(key, (this.typeConfusions.get(key) ?? 0) + 1);
    }
  }
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

export function prf(
  correct: number,
  predicted: number,
  detected: number,
  gold: number,
): Prf {
  const precision = predicted === 0 ? 1 : correct / predicted;
  const recall = gold === 0 ? 1 : detected / gold;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export interface Distribution {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentiles. */
export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}
