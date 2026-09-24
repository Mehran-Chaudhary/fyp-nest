import { cardIssuer, luhnValid } from '../checksums';
import {
  hasContext,
  matchesOf,
  type PatternRecognizer,
  type RecognizerMatch,
} from './recognizer';

/**
 * A run of digit groups: 13+ digits, optionally separated by single spaces or
 * hyphens. Deliberately wider than a card (up to 23 digits) so that a card
 * number sitting next to another number is still found — the windowing below
 * picks the card out of the run.
 */
const DIGIT_RUN = /(?<![\p{N}])\d(?:[ -]?\d){12,22}(?![\p{N}])/gu;

const CNIC_SHAPE = /^\d{5}-\d{7}-\d$/;

const CARD_CONTEXT =
  /\b(card|credit|debit|visa|master\s?card|amex|american express|discover|unionpay|cc|cvv|expiry|payment|paid with)\b/i;

interface Group {
  digits: string;
  start: number;
  end: number;
}

/**
 * Payment card numbers.
 *
 * A candidate must pass the Luhn checksum *and* carry a real issuer prefix at
 * a length that issuer uses (score 1.0). A Luhn-valid number with an unknown
 * prefix is accepted only with card vocabulary nearby (score 0.8): Luhn alone
 * passes one random digit string in ten.
 */
export class CreditCardRecognizer implements PatternRecognizer {
  readonly name = 'credit-card';
  readonly entityTypes = ['CREDIT_CARD'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];

    for (const match of matchesOf(DIGIT_RUN, text)) {
      // 12345-1234567-1 is a Pakistani CNIC; no card is ever grouped 5-7-1.
      if (CNIC_SHAPE.test(match[0])) continue;
      const groups = splitGroups(match[0], match.index);
      found.push(...this.bestWindows(text, groups));
    }

    return found;
  }

  /**
   * Chooses card numbers within one run of digit groups.
   *
   * Windows start and end on group boundaries — "4111 1111 1111 1111 2026" is a
   * card followed by a year, not a 20-digit number — and the longest valid,
   * non-overlapping windows win.
   */
  private bestWindows(text: string, groups: Group[]): RecognizerMatch[] {
    const candidates: RecognizerMatch[] = [];

    for (let first = 0; first < groups.length; first += 1) {
      let digits = '';
      for (let last = first; last < groups.length; last += 1) {
        digits += groups[last].digits;
        if (digits.length > 19) break;
        if (digits.length < 13) continue;

        const sizes = groups.slice(first, last + 1).map((group) => group.digits.length);
        const score = this.score(
          text,
          digits,
          sizes,
          groups[first].start,
          groups[last].end,
        );
        if (score > 0) {
          candidates.push({
            entityType: 'CREDIT_CARD',
            start: groups[first].start,
            end: groups[last].end,
            score,
            // An unknown issuer counts only beside a word like "card".
            ...(cardIssuer(digits) ? {} : { contextFreeScore: 0 }),
          });
        }
      }
    }

    // Longest first, then earliest; keep those that do not overlap.
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const chosen: RecognizerMatch[] = [];
    for (const candidate of candidates) {
      if (
        chosen.every((kept) => candidate.end <= kept.start || candidate.start >= kept.end)
      ) {
        chosen.push(candidate);
      }
    }
    return chosen;
  }

  private score(
    text: string,
    digits: string,
    sizes: number[],
    start: number,
    end: number,
  ): number {
    // ISO/IEC 7812: no payment card starts with 0 — but trunk-prefixed phone
    // numbers (0092…, 0300…) do.
    if (digits.startsWith('0')) return 0;
    if (!luhnValid(digits)) return 0;
    // All one digit repeated passes Luhn for some lengths and is never a card.
    if (/^(\d)\1+$/.test(digits)) return 0;
    if (cardIssuer(digits)) return 1;
    // An unknown issuer needs a card's layout as well as card words nearby:
    // "978-0-330-81147-0" beside "card" is a book.
    if (!isCardLayout(sizes)) return 0;
    return hasContext(text, start, end, CARD_CONTEXT) ? 0.8 : 0;
  }
}

/** How cards are printed: one block, fours (the last may be short), or 4-6-5 / 4-6-4. */
function isCardLayout(sizes: readonly number[]): boolean {
  if (sizes.length === 1) return true;
  const last = sizes[sizes.length - 1];
  if (sizes.slice(0, -1).every((size) => size === 4) && last >= 1 && last <= 4) return true;
  return (
    sizes.length === 3 &&
    sizes[0] === 4 &&
    sizes[1] === 6 &&
    (sizes[2] === 5 || sizes[2] === 4)
  );
}

/** Splits a matched run into its digit groups, with absolute offsets. */
function splitGroups(run: string, offset: number): Group[] {
  const groups: Group[] = [];
  for (const group of matchesOf(/\d+/g, run)) {
    groups.push({
      digits: group[0],
      start: offset + group.index,
      end: offset + group.index + group[0].length,
    });
  }
  // An unseparated run longer than 19 digits stays one group and so matches
  // nothing: searching inside long identifiers for Luhn-valid substrings would
  // find "cards" in every transaction reference.
  return groups;
}
