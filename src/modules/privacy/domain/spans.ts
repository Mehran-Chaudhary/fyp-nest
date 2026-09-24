/**
 * Detected spans and how conflicting detections are reconciled.
 */

/** Where a detection came from. */
export type SpanSource = 'pattern' | 'ner' | 'custom' | 'propagation';

export interface DetectedSpan {
  entityType: string;
  /** UTF-16 offsets into the canonicalised text. */
  start: number;
  end: number;
  score: number;
  source: SpanSource;
  /** The recognizer or detector that produced it, e.g. `credit-card`, `presidio`. */
  recognizer: string;
}

/**
 * Validated patterns and explicit deny-list terms are the most trustworthy
 * detections; the statistical model comes next; propagated mentions last.
 */
const SOURCE_RANK: Readonly<Record<SpanSource, number>> = {
  pattern: 3,
  custom: 3,
  ner: 2,
  propagation: 1,
};

/** The more authoritative of two detections: higher score, then longer, then source. */
function dominant(a: DetectedSpan, b: DetectedSpan): DetectedSpan {
  if (a.score !== b.score) return a.score > b.score ? a : b;
  const lengthA = a.end - a.start;
  const lengthB = b.end - b.start;
  if (lengthA !== lengthB) return lengthA > lengthB ? a : b;
  return SOURCE_RANK[a.source] >= SOURCE_RANK[b.source] ? a : b;
}

/**
 * Resolves overlapping detections into disjoint spans, masking their **union**.
 *
 * The union rather than a winner, because choosing one of two overlapping
 * spans leaves the rest of the other in clear text. If the NER model tags
 * "Ayesha Raza" and the deny list tags "Raza Holdings", keeping only one
 * would leak "Ayesha" or "Holdings"; the union masks all of it. Masking a
 * little more than necessary is the safe direction to be wrong in.
 *
 * The merged span takes its type from the most authoritative member.
 * Adjacent spans (one ends where the next begins) are not merged: they are two
 * entities.
 */
export function mergeOverlapping(spans: readonly DetectedSpan[]): DetectedSpan[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: DetectedSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      const representative = dominant(last, span);
      merged[merged.length - 1] = {
        ...representative,
        start: last.start,
        end: Math.max(last.end, span.end),
      };
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** True when `[start, end)` intersects any of the (sorted, disjoint) spans. */
export function overlapsAny(
  spans: readonly Pick<DetectedSpan, 'start' | 'end'>[],
  start: number,
  end: number,
): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle];
    if (span.end <= start) low = middle + 1;
    else if (span.start >= end) high = middle - 1;
    else return true;
  }
  return false;
}
