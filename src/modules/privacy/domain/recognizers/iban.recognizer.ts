import { IBAN_LENGTHS, ibanValid } from '../checksums';
import type { PatternRecognizer, RecognizerMatch } from './recognizer';

/**
 * Country code, two check digits, then alphanumerics optionally grouped by
 * single spaces. The candidate may run on into the following word; the
 * country's fixed length decides where the IBAN really ends.
 */
const CANDIDATE = /(?<![\p{L}\p{N}])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){10,32}/gu;

/**
 * International Bank Account Numbers.
 *
 * Accepted only with a known country code, that country's exact length, and a
 * valid ISO 7064 mod-97 check — so a match is effectively certain (score 1.0).
 */
export class IbanRecognizer implements PatternRecognizer {
  readonly name = 'iban';
  readonly entityTypes = ['IBAN_CODE'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];
    const regex = new RegExp(CANDIDATE.source, CANDIDATE.flags);

    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      const result = this.extract(text, match.index, match[0]);
      if (result) {
        found.push(result);
        // Resume right after the IBAN: the candidate may have swallowed the
        // start of a second one.
        regex.lastIndex = result.end;
      } else {
        regex.lastIndex = match.index + 1;
      }
    }

    return found;
  }

  private extract(text: string, offset: number, candidate: string): RecognizerMatch | null {
    const required = IBAN_LENGTHS[candidate.slice(0, 2).toUpperCase()];
    if (!required) return null;

    let compact = '';
    let end = offset;
    for (let index = 0; index < candidate.length && compact.length < required; index += 1) {
      const character = candidate[index];
      if (character === ' ') continue;
      compact += character.toUpperCase();
      end = offset + index + 1;
    }

    if (compact.length !== required) return null;
    // The account number must end here, not run on into more characters.
    if (end < text.length && /[\p{L}\p{N}]/u.test(text[end])) return null;
    if (!ibanValid(compact)) return null;

    return { entityType: 'IBAN_CODE', start: offset, end, score: 1 };
  }
}
