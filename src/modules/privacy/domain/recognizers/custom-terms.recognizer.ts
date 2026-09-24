import { canonicalizeText } from '../../../../common/utils/unicode.util';
import { CUSTOM_ENTITY_TYPE } from '../entity-catalogue';
import { matchesOf, type PatternRecognizer, type RecognizerMatch } from './recognizer';

/** Upper bound on deny-list size, enforced by the policy DTO as well. */
export const MAX_CUSTOM_TERMS = 200;
export const MAX_CUSTOM_TERM_LENGTH = 100;

/**
 * A workspace's deny list: terms that are always masked, as `CUSTOM`.
 *
 * For the things no model can know are sensitive — a project code name, a
 * client under NDA, an unannounced product. Matching is case-insensitive and
 * on whole words, so "Falcon" masks "falcon" and "FALCON" but not
 * "Falconer".
 */
export class CustomTermsRecognizer implements PatternRecognizer {
  readonly name = 'deny-list';
  readonly entityTypes = [CUSTOM_ENTITY_TYPE] as const;
  private readonly pattern: RegExp | null;

  constructor(terms: readonly string[]) {
    const cleaned = [
      ...new Set(
        terms
          .map((term) => canonicalizeText(term).trim())
          .filter((term) => term.length >= 2 && term.length <= MAX_CUSTOM_TERM_LENGTH),
      ),
    ]
      // Longest first, so "Project Falcon" wins over "Falcon".
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_CUSTOM_TERMS);

    this.pattern =
      cleaned.length === 0
        ? null
        : new RegExp(
            `(?<![\\p{L}\\p{N}_])(?:${cleaned.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
            'giu',
          );
  }

  get isEmpty(): boolean {
    return this.pattern === null;
  }

  recognize(text: string): RecognizerMatch[] {
    if (!this.pattern) return [];
    const found: RecognizerMatch[] = [];
    for (const match of matchesOf(this.pattern, text)) {
      found.push({
        entityType: CUSTOM_ENTITY_TYPE,
        start: match.index,
        end: match.index + match[0].length,
        score: 1,
      });
    }
    return found;
  }
}

/**
 * Escapes regular-expression syntax characters. Safe inside a `u`-flag
 * pattern, where escaping anything else (such as `-`) is itself an error.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
