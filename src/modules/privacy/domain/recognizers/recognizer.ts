/**
 * The in-process pattern recognizers: the first detection layer of the PII
 * engine.
 *
 * Each recognizer finds candidates with a regular expression and then
 * *validates* them — a checksum, a known issuer prefix, a length table, or a
 * context word nearby. Validation is what keeps precision high enough to run
 * with no NER model at all, which matters twice over: it is the fallback when
 * the NER service is down and the policy allows degrading, and it is what the
 * gateway re-runs over every outgoing prompt as its last check.
 *
 * Offsets are UTF-16 code units, JavaScript's native string index.
 */

export interface RecognizerMatch {
  entityType: string;
  start: number;
  end: number;
  /** 0–1. Validated matches score 1; context-dependent ones lower. */
  score: number;
  /**
   * The score this match would have with no context words around it; absent
   * when context played no part. A salary is only a salary because "salary"
   * is nearby — and masking changes what is nearby. The gateway's re-scan of
   * the masked prompt therefore judges by this score: it re-checks what is
   * sensitive in itself, not what a shifted context window now suggests.
   */
  contextFreeScore?: number;
}

export interface PatternRecognizer {
  readonly name: string;
  readonly entityTypes: readonly string[];
  recognize(text: string): RecognizerMatch[];
}

/** Iterates every match of a global regular expression without sharing `lastIndex`. */
export function* matchesOf(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    yield match;
    // A zero-length match would otherwise loop forever.
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

/**
 * True when `words` occurs near `[start, end)`: up to `before` characters
 * earlier or `after` characters later, not crossing a paragraph break.
 *
 * Context turns an ambiguous candidate — nine digits, an amount of money —
 * into a confident one: "SSN: 123 45 6789", "salary of 950,000".
 */
export function hasContext(
  text: string,
  start: number,
  end: number,
  words: RegExp,
  before = 48,
  after = 32,
): boolean {
  let left = text.slice(Math.max(0, start - before), start);
  let right = text.slice(end, end + after);

  const leftBreak = left.lastIndexOf('\n\n');
  if (leftBreak !== -1) left = left.slice(leftBreak + 2);
  const rightBreak = right.indexOf('\n\n');
  if (rightBreak !== -1) right = right.slice(0, rightBreak);

  const flags = words.flags.replace('g', '');
  return new RegExp(words.source, flags).test(`${left} ${right}`);
}

/** Number of ASCII digits in `value`. */
export function digitCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 48 && code <= 57) count += 1;
  }
  return count;
}
