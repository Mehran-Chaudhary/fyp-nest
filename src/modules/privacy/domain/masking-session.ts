import { canonicalizeText } from '../../../common/utils/unicode.util';
import {
  CUSTOM_ENTITY_TYPE,
  entityDefinition,
  isCataloguedEntityType,
  nameTokens,
  normalizeEntityValue,
  normalizeText,
} from './entity-catalogue';
import { PiiVault } from './pii-vault';
import {
  canonicalPlaceholder,
  formatPlaceholder,
  neutralizePlaceholders,
  placeholderMatcher,
} from './placeholders';
import { escapeRegExp, runRecognizers, type PatternRecognizer } from './recognizers';
import { mergeOverlapping, overlapsAny, type DetectedSpan, type SpanSource } from './spans';
import { StreamingUnmasker } from './stream-unmasker';

/** What the session applies. Built from the workspace's effective PII policy. */
export interface MaskingPolicy {
  enabledTypes: ReadonlySet<string>;
  scoreThreshold: number;
  /** Values never masked, e.g. the company's own name. */
  allowList: readonly string[];
  /**
   * The in-process recognizers, including the workspace's deny list. The
   * egress check re-runs them over the final prompt.
   */
  recognizers: readonly PatternRecognizer[];
}

export interface SegmentInput {
  id: string;
  /** Prepared with {@link prepareText}: canonical form, placeholders neutralised. */
  text: string;
}

export interface AppliedSpan {
  entityType: string;
  /** Offsets in the segment's prepared input text. */
  start: number;
  end: number;
  placeholder: string;
  source: SpanSource;
  recognizer: string;
  score: number;
}

export interface MaskedSegment {
  id: string;
  /** The masked text: what the model receives. */
  text: string;
  /** The prepared input the spans' offsets refer to. */
  input: string;
  spans: AppliedSpan[];
}

export interface RedactionSummary {
  /** Distinct entities, i.e. placeholders issued. */
  entities: number;
  /** Masked mentions, counting repeats. */
  occurrences: number;
  byType: Record<string, number>;
  bySource: Partial<Record<SpanSource, number>>;
  segments: number;
  charactersMasked: number;
}

export interface UnmaskStatistics {
  /** Placeholders in model output that were restored to a real value. */
  resolved: number;
  /**
   * Placeholder-shaped text naming a real entity type but no entity of this
   * session: the model invented it. A direct measure of placeholder fidelity.
   */
  unresolved: number;
}

export interface LeakFinding {
  entityType: string;
  /** `known-value`: a value this session masked is present. `pattern`: a recognizer fired. */
  reason: 'known-value' | 'pattern';
}

interface EntityRecord {
  placeholder: string;
  entityType: string;
  /** PERSON only: keyed digests of the name tokens, for linking partial mentions. */
  tokens: Set<string> | null;
  /** Token count of the value shown when unmasking; the fullest mention wins. */
  displayWeight: number;
  aliases: number;
  occurrences: number;
}

type PropagationKind = 'text' | 'digits' | 'alphanumeric';

interface PropagationIndex {
  kind: PropagationKind;
  /** Text only: an alternation of every known form. Numbers are looked up by key. */
  pattern: RegExp | null;
  byKey: Map<string, { placeholder: string; entityType: string }>;
  /** The longest key, which bounds how far a number lookup extends. */
  maxKeyLength: number;
}

/** A known value found in text. */
interface KnownOccurrence {
  start: number;
  end: number;
  placeholder: string;
  entityType: string;
}

/**
 * Runs of digits (or letters and digits) joined by single separators: the
 * candidates a known number can occur in, however it is grouped. Compiled once
 * for the process, where a per-request alternation of every known value costs
 * milliseconds to compile.
 */
const DIGIT_RUN = /\d+(?:[\s.,/-]\d+)*/g;
const ALPHANUMERIC_RUN = /[\p{L}\p{N}]+(?:[\s.,/-][\p{L}\p{N}]+)*/gu;
const DIGIT_GROUP = /\d+/g;
const ALPHANUMERIC_GROUP = /[\p{L}\p{N}]+/gu;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** Shortest surface form worth masking everywhere it appears. */
const MIN_PROPAGATION_LENGTH = 3;
/**
 * Shortest digit string worth masking everywhere it appears. Identifiers —
 * cards, phones, national ids — are all longer; below six digits a value
 * collides with years, extensions and reference numbers, and masking those
 * would put a salary where a date was.
 */
const MIN_PROPAGATION_DIGITS = 6;
/** Bounds the alternation built for propagation and the egress check. */
const MAX_PROPAGATION_FORMS = 2_000;

/**
 * Canonicalises text and defuses placeholder-shaped text already in it. Every
 * segment goes through this before detection, so detection offsets, masking
 * and what the model finally reads all refer to the same characters.
 */
export function prepareText(text: string): string {
  return neutralizePlaceholders(canonicalizeText(text), isCataloguedEntityType);
}

/**
 * One request's worth of masking: the "Mask" and "Unmask" stages of the
 * three-stage pipeline (detection is `PiiDetectionService`).
 *
 * ## Consistency across the whole prompt
 *
 * A prompt is assembled from several sources — agent instructions, retrieved
 * passages, earlier turns, the new question. They are masked in *one* session,
 * so "Ayesha Raza" is `[PERSON_1]` in the payroll passage, in the history and
 * in the question alike, and the model can connect them.
 *
 * ## Three ways a mention gets masked
 *
 *  1. **Detection** — a recognizer or the NER model found it.
 *  2. **Linking** — "Raza" or "A. Raza" is linked to an already-known
 *     "Ayesha Raza" when exactly one known person contains those name tokens
 *     (ambiguity creates a new placeholder instead of guessing).
 *  3. **Propagation** — once a value is known to be sensitive, every other
 *     occurrence of it in the prompt is masked too, including ones the
 *     detector missed. NER is context-sensitive: it tags a name in one
 *     sentence and misses it in the next. Propagation turns one detection into
 *     full coverage.
 *
 * ## The invariant
 *
 * After masking, no value of three or more characters that the session knows
 * to be sensitive appears anywhere in the masked text, and no enabled
 * recognizer fires on it. {@link findLeaks} re-checks exactly that on the final
 * payload at the gateway, so a bug in any stage above fails closed.
 *
 * Placeholders are scoped to the session: `[PERSON_1]` means one person in one
 * request and possibly another in the next. Nothing about the mapping outlives
 * {@link destroy}.
 */
export class MaskingSession {
  private readonly vault = new PiiVault();
  private readonly entities = new Map<string, EntityRecord>();
  /** fingerprint(type:normalised value) → placeholder */
  private readonly byValue = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly allowText: ReadonlySet<string>;
  private readonly allowDigits: ReadonlySet<string>;
  private propagation: PropagationIndex[] | null = null;

  private readonly summaryState = {
    occurrences: 0,
    byType: {} as Record<string, number>,
    bySource: {} as Partial<Record<SpanSource, number>>,
    segments: 0,
    charactersMasked: 0,
  };
  private readonly unmaskState: UnmaskStatistics = { resolved: 0, unresolved: 0 };

  constructor(private readonly policy: MaskingPolicy) {
    this.allowText = new Set(
      policy.allowList
        .map((value) => normalizeText(value))
        .filter((value) => value.length > 0),
    );
    this.allowDigits = new Set(
      policy.allowList
        .map((value) => value.replace(/\D/g, ''))
        .filter((digits) => digits.length >= 6),
    );
  }

  get entityCount(): number {
    return this.entities.size;
  }

  get isDestroyed(): boolean {
    return this.vault.isDestroyed;
  }

  // ── Mask ──────────────────────────────────────────────────────────────────

  /**
   * Masks `segments` given their detections (same order, same offsets).
   *
   * May be called more than once; entities persist across calls, so later
   * segments reuse earlier placeholders.
   */
  mask(
    segments: readonly SegmentInput[],
    detections: readonly DetectedSpan[][],
  ): MaskedSegment[] {
    if (detections.length !== segments.length) {
      throw new Error('mask(): one detection list is required per segment.');
    }

    // 1. Policy filter and overlap resolution, per segment.
    const accepted = segments.map((segment, index) =>
      this.accept(segment.text, detections[index]),
    );

    // 2. Placeholder assignment, in prompt order.
    const applied: AppliedSpan[][] = segments.map((segment, index) =>
      accepted[index].map((span) => ({
        entityType: span.entityType,
        start: span.start,
        end: span.end,
        placeholder: this.register(
          span.entityType,
          segment.text.slice(span.start, span.end),
        ),
        source: span.source,
        recognizer: span.recognizer,
        score: span.score,
      })),
    );

    // 3. Propagation of every known value to the mentions detection missed.
    this.propagation = null;
    const indexes = this.propagationIndexes();
    segments.forEach((segment, index) => {
      const extra = this.findKnownValues(segment.text, applied[index], indexes);
      if (extra.length > 0) {
        applied[index] = [...applied[index], ...extra].sort((a, b) => a.start - b.start);
      }
    });

    // 4. Rewrite.
    return segments.map((segment, index) => {
      const spans = applied[index];
      this.summaryState.segments += 1;
      for (const span of spans) {
        this.summaryState.occurrences += 1;
        this.summaryState.charactersMasked += span.end - span.start;
        this.summaryState.byType[span.entityType] =
          (this.summaryState.byType[span.entityType] ?? 0) + 1;
        this.summaryState.bySource[span.source] =
          (this.summaryState.bySource[span.source] ?? 0) + 1;
      }
      return {
        id: segment.id,
        text: rewrite(segment.text, spans),
        input: segment.text,
        spans,
      };
    });
  }

  /** Applies the policy to raw detections and resolves overlaps. */
  private accept(text: string, spans: readonly DetectedSpan[]): DetectedSpan[] {
    const kept: DetectedSpan[] = [];

    for (const span of spans) {
      if (!this.policy.enabledTypes.has(span.entityType)) continue;
      if (span.score < this.policy.scoreThreshold) continue;

      const trimmed = trimSpan(text, span);
      if (!trimmed) continue;
      if (this.isAllowed(text.slice(trimmed.start, trimmed.end))) continue;
      kept.push(trimmed);
    }

    return mergeOverlapping(kept);
  }

  private isAllowed(value: string): boolean {
    if (this.allowText.has(normalizeText(value))) return true;
    const digits = value.replace(/\D/g, '');
    return digits.length >= 6 && this.allowDigits.has(digits);
  }

  /** The placeholder for a value, reusing, linking or issuing one. */
  private register(entityType: string, rawValue: string): string {
    const value = rawValue.trim();
    const normalized = normalizeEntityValue(entityType, value);
    const key = this.vault.fingerprint(`${entityType}:${normalized}`);

    const known = this.byValue.get(key);
    if (known) {
      (this.entities.get(known) as EntityRecord).occurrences += 1;
      return known;
    }

    if (entityType === 'PERSON') {
      const linked = this.linkPerson(value);
      if (linked) {
        this.byValue.set(key, linked.placeholder);
        this.addAlias(linked, value);
        linked.occurrences += 1;
        return linked.placeholder;
      }
    }

    const ordinal = (this.counters.get(entityType) ?? 0) + 1;
    this.counters.set(entityType, ordinal);
    const placeholder = formatPlaceholder(entityType, ordinal);

    const record: EntityRecord = {
      placeholder,
      entityType,
      tokens: entityType === 'PERSON' ? this.tokenSet(value) : null,
      displayWeight: nameTokens(value).length,
      aliases: 0,
      occurrences: 1,
    };
    this.vault.seal(placeholder, value);
    this.addAlias(record, value);
    this.entities.set(placeholder, record);
    this.byValue.set(key, placeholder);
    this.propagation = null;

    return placeholder;
  }

  /**
   * Links a partial name to exactly one known person whose name tokens contain
   * it, or that it contains. Two candidates means ambiguity — "Raza" when both
   * "Ayesha Raza" and "Imran Raza" are known — and no link is made.
   */
  private linkPerson(value: string): EntityRecord | null {
    const tokens = this.tokenSet(value);
    if (tokens.size === 0) return null;

    const candidates = [...this.entities.values()].filter((record) => {
      if (record.entityType !== 'PERSON' || !record.tokens || record.tokens.size === 0) {
        return false;
      }
      return isSubset(tokens, record.tokens) || isSubset(record.tokens, tokens);
    });
    if (candidates.length !== 1) return null;

    const [record] = candidates;
    const weight = nameTokens(value).length;
    if (weight > record.displayWeight) {
      // The fuller name becomes what the placeholder unmasks to.
      this.vault.seal(record.placeholder, value);
      record.displayWeight = weight;
      record.tokens = new Set([...(record.tokens as Set<string>), ...tokens]);
    }
    return record;
  }

  private tokenSet(value: string): Set<string> {
    return new Set(
      nameTokens(value).map((token) => this.vault.fingerprint(`token:${token}`)),
    );
  }

  private addAlias(record: EntityRecord, value: string): void {
    this.vault.seal(`${record.placeholder}#${record.aliases}`, value);
    record.aliases += 1;
    this.propagation = null;
  }

  // ── Propagation (and the egress check's known-value scan) ────────────────

  /**
   * Matchers for every known sensitive value, grouped by how values compare:
   * names case-insensitively on word boundaries; numbers digit-by-digit with
   * any separators, so "950,000" also finds "950000" and "950 000".
   */
  private propagationIndexes(): PropagationIndex[] {
    if (this.propagation) return this.propagation;

    const forms: Record<
      PropagationKind,
      Map<string, { placeholder: string; entityType: string; form: string }>
    > = {
      text: new Map(),
      digits: new Map(),
      alphanumeric: new Map(),
    };
    let total = 0;

    for (const record of this.entities.values()) {
      // Deny-list terms are already matched exhaustively by their recognizer.
      if (record.entityType === CUSTOM_ENTITY_TYPE) continue;
      const kind = propagationKind(record.entityType);

      for (
        let alias = 0;
        alias < record.aliases && total < MAX_PROPAGATION_FORMS;
        alias += 1
      ) {
        const form = this.vault.open(`${record.placeholder}#${alias}`);
        if (!form) continue;
        const key = propagationKey(kind, form);
        if (!qualifiesForPropagation(kind, key) || forms[kind].has(key)) continue;
        forms[kind].set(key, {
          placeholder: record.placeholder,
          entityType: record.entityType,
          form,
        });
        total += 1;
      }
    }

    this.propagation = (Object.keys(forms) as PropagationKind[])
      .filter((kind) => forms[kind].size > 0)
      .map((kind) => {
        const byKey = new Map(
          [...forms[kind].entries()].map(([key, entry]) => [
            key,
            { placeholder: entry.placeholder, entityType: entry.entityType },
          ]),
        );
        const maxKeyLength = Math.max(...[...byKey.keys()].map((key) => key.length));
        if (kind !== 'text') return { kind, pattern: null, byKey, maxKeyLength };

        // Longest first, so "Ayesha Raza" wins over "Ayesha" at the same place.
        // Not in Unicode mode, and with ASCII-only boundaries: a Unicode,
        // case-insensitive alternation takes milliseconds to compile, and it
        // is compiled afresh for every request. Letters outside ASCII at the
        // edges are checked in code instead (see `isWholeWord`).
        const alternatives = [...forms[kind].values()]
          .sort((a, b) => b.form.length - a.form.length)
          .map((entry) => formPattern(entry.form));
        return {
          kind,
          pattern: new RegExp(
            `(?<![A-Za-z0-9_])(?:${alternatives.join('|')})(?![A-Za-z0-9_])`,
            'gi',
          ),
          byKey,
          maxKeyLength,
        };
      });

    return this.propagation;
  }

  /** Occurrences of known values in `text` that no existing span covers. */
  private findKnownValues(
    text: string,
    existing: readonly AppliedSpan[],
    indexes: readonly PropagationIndex[],
  ): AppliedSpan[] {
    const found: AppliedSpan[] = [];
    const covered = [...existing].sort((a, b) => a.start - b.start);

    for (const index of indexes) {
      for (const occurrence of knownOccurrences(index, text)) {
        const { start, end } = occurrence;
        if (overlapsAny(covered, start, end) || overlapsAny(found, start, end)) continue;

        found.push({
          entityType: occurrence.entityType,
          start,
          end,
          placeholder: occurrence.placeholder,
          source: 'propagation',
          recognizer: 'known-value',
          score: 1,
        });
        (this.entities.get(occurrence.placeholder) as EntityRecord).occurrences += 1;
        found.sort((a, b) => a.start - b.start);
      }
    }

    return found;
  }

  // ── Egress check ──────────────────────────────────────────────────────────

  /**
   * The gateway's last check before text leaves for the model.
   *
   * Two independent tests over the exact outgoing payload:
   *
   *  - **Known values.** Every value this session masked (three or more
   *    characters) must be absent outside placeholders.
   *  - **Patterns.** Every enabled recognizer — cards, IBANs, national ids,
   *    credentials, the deny list — must find nothing outside placeholders.
   *
   * Any finding means a stage of the pipeline failed, and the request is
   * refused. The findings carry types only, never values.
   */
  findLeaks(outgoing: string): LeakFinding[] {
    const placeholders: Array<{ start: number; end: number }> = [];
    for (const match of outgoing.matchAll(placeholderMatcher())) {
      const start = match.index ?? 0;
      placeholders.push({ start, end: start + match[0].length });
    }

    const findings = new Map<string, LeakFinding>();
    const note = (entityType: string, reason: LeakFinding['reason']) =>
      findings.set(`${reason}:${entityType}`, { entityType, reason });

    for (const index of this.propagationIndexes()) {
      for (const occurrence of knownOccurrences(index, outgoing)) {
        if (overlapsAny(placeholders, occurrence.start, occurrence.end)) continue;
        note(occurrence.entityType, 'known-value');
      }
    }

    // Judged without context: masking moves words closer together, and the
    // assembled prompt puts segments side by side, so a context window here
    // sees things detection never did. What is sensitive in itself is checked.
    const matches = runRecognizers(
      this.policy.recognizers,
      outgoing,
      this.policy.enabledTypes,
    );
    for (const match of matches) {
      if ((match.contextFreeScore ?? match.score) < this.policy.scoreThreshold) continue;
      if (overlapsAny(placeholders, match.start, match.end)) continue;
      if (this.isAllowed(outgoing.slice(match.start, match.end))) continue;
      note(match.entityType, 'pattern');
    }

    return [...findings.values()];
  }

  // ── Unmask ────────────────────────────────────────────────────────────────

  /**
   * Restores real values in model output. Tolerates the ways models mangle a
   * placeholder (`[Person_1]`, `[PERSON 1]`); leaves anything else untouched.
   */
  unmask(text: string): string {
    return text.replace(
      placeholderMatcher(),
      (match: string, rawType: string, rawOrdinal: string): string => {
        const { entityType, placeholder } = canonicalPlaceholder(rawType, rawOrdinal);
        const value = this.vault.isDestroyed ? undefined : this.vault.open(placeholder);
        if (value !== undefined) {
          this.unmaskState.resolved += 1;
          return value;
        }
        if (
          isCataloguedEntityType(entityType) ||
          this.policy.enabledTypes.has(entityType)
        ) {
          this.unmaskState.unresolved += 1;
        }
        return match;
      },
    );
  }

  /** An unmasker for a token stream, holding back partial placeholders across chunks. */
  createStreamUnmasker(): StreamingUnmasker {
    return new StreamingUnmasker((text) => this.unmask(text));
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  summary(): RedactionSummary {
    return {
      entities: this.entities.size,
      occurrences: this.summaryState.occurrences,
      byType: { ...this.summaryState.byType },
      bySource: { ...this.summaryState.bySource },
      segments: this.summaryState.segments,
      charactersMasked: this.summaryState.charactersMasked,
    };
  }

  unmaskStatistics(): UnmaskStatistics {
    return { ...this.unmaskState };
  }

  /**
   * The real value behind a placeholder, for a caller entitled to see it
   * (`pii:reveal` reports). Undefined for unknown placeholders.
   */
  reveal(placeholder: string): string | undefined {
    return this.vault.isDestroyed ? undefined : this.vault.open(placeholder);
  }

  /** Ends the session: the key is zeroed and every mapping becomes unrecoverable. */
  destroy(): void {
    this.vault.destroy();
    this.entities.clear();
    this.byValue.clear();
    this.propagation = null;
  }

  toJSON(): string {
    return '[MaskingSession]';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isSubset(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  if (small.size > large.size) return false;
  for (const value of small) if (!large.has(value)) return false;
  return true;
}

/** Narrows a span to exclude leading and trailing whitespace. */
function trimSpan(text: string, span: DetectedSpan): DetectedSpan | null {
  let { start, end } = span;
  start = Math.max(0, Math.min(start, text.length));
  end = Math.max(start, Math.min(end, text.length));
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end > start ? { ...span, start, end } : null;
}

/** Replaces each span with its placeholder. Spans must be sorted and disjoint. */
function rewrite(text: string, spans: readonly AppliedSpan[]): string {
  if (spans.length === 0) return text;
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    output += text.slice(cursor, span.start) + span.placeholder;
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

function propagationKind(entityType: string): PropagationKind {
  const normalization = entityDefinition(entityType).normalization;
  if (normalization === 'digits') return 'digits';
  if (normalization === 'alphanumeric') return 'alphanumeric';
  return 'text';
}

function propagationKey(kind: PropagationKind, value: string): string {
  if (kind === 'digits') return value.replace(/\D/g, '');
  if (kind === 'alphanumeric') return value.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  return normalizeText(value);
}

function qualifiesForPropagation(kind: PropagationKind, key: string): boolean {
  if (kind === 'digits') return key.length >= MIN_PROPAGATION_DIGITS;
  if (key.length < MIN_PROPAGATION_LENGTH) return false;
  return /[\p{L}\p{N}]/u.test(key);
}

/** The regular-expression form of a known text value: any whitespace between words. */
function formPattern(form: string): string {
  return normalizeText(form)
    .split(' ')
    .map((word) => escapeRegExp(word))
    .join('\\s+');
}

/** Whether the code point just before `index` is a letter, digit or underscore. */
function wordCharacterBefore(text: string, index: number): boolean {
  if (index <= 0) return false;
  const low = text.charCodeAt(index - 1);
  const from = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  return WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(from) ?? 0));
}

/** Whether the code point at `index` is a letter, digit or underscore. */
function wordCharacterAt(text: string, index: number): boolean {
  if (index >= text.length) return false;
  return WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(index) ?? 0));
}

function isWholeWord(text: string, start: number, end: number): boolean {
  return !wordCharacterBefore(text, start) && !wordCharacterAt(text, end);
}

/**
 * Every occurrence of a known value in `text`, left to right, longest first at
 * each position, never overlapping one another — the semantics of a single
 * alternation with word boundaries.
 *
 * Numbers are found by key rather than by pattern: every run of digit groups
 * is split at its separators, and each span of whole groups is looked up by
 * its digits. "950,000", "950000" and "9,50,000" all have the key "950000";
 * a card has the same key however its sixteen digits are grouped.
 */
function* knownOccurrences(
  index: PropagationIndex,
  text: string,
): Generator<KnownOccurrence> {
  if (index.pattern) {
    const regex = new RegExp(index.pattern.source, index.pattern.flags);
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      const entry = index.byKey.get(propagationKey(index.kind, match[0]));
      if (!entry || !isWholeWord(text, start, end)) {
        regex.lastIndex = start + 1;
        continue;
      }
      yield { start, end, ...entry };
    }
    return;
  }

  const runs = index.kind === 'digits' ? DIGIT_RUN : ALPHANUMERIC_RUN;
  const groupPattern = index.kind === 'digits' ? DIGIT_GROUP : ALPHANUMERIC_GROUP;
  for (const run of text.matchAll(new RegExp(runs.source, runs.flags))) {
    const offset = run.index ?? 0;
    const groups = [
      ...run[0].matchAll(new RegExp(groupPattern.source, groupPattern.flags)),
    ].map((group) => {
      const start = offset + (group.index ?? 0);
      return {
        start,
        end: start + group[0].length,
        key: propagationKey(index.kind, group[0]),
      };
    });

    for (let first = 0; first < groups.length; first += 1) {
      if (wordCharacterBefore(text, groups[first].start)) continue;
      let key = '';
      let hit: { last: number; entry: { placeholder: string; entityType: string } } | null =
        null;
      for (let last = first; last < groups.length; last += 1) {
        key += groups[last].key;
        if (key.length > index.maxKeyLength) break;
        const entry = index.byKey.get(key);
        if (entry && !wordCharacterAt(text, groups[last].end)) hit = { last, entry };
      }
      if (hit) {
        yield { start: groups[first].start, end: groups[hit.last].end, ...hit.entry };
        first = hit.last;
      }
    }
  }
}
