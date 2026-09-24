import { CreditCardRecognizer } from './credit-card.recognizer';
import { CredentialRecognizer } from './credential.recognizer';
import {
  EmailRecognizer,
  IpAddressRecognizer,
  NationalIdRecognizer,
  PhoneRecognizer,
} from './contact.recognizers';
import { IbanRecognizer } from './iban.recognizer';
import { MoneyRecognizer } from './money.recognizer';
import type { PatternRecognizer, RecognizerMatch } from './recognizer';

export * from './recognizer';
export { CustomTermsRecognizer, escapeRegExp } from './custom-terms.recognizer';

/** Every built-in recognizer. Stateless, so one set serves the whole process. */
export const BUILT_IN_RECOGNIZERS: readonly PatternRecognizer[] = [
  new EmailRecognizer(),
  new CreditCardRecognizer(),
  new IbanRecognizer(),
  new NationalIdRecognizer(),
  new PhoneRecognizer(),
  new IpAddressRecognizer(),
  new MoneyRecognizer(),
  new CredentialRecognizer(),
];

export interface TaggedMatch extends RecognizerMatch {
  recognizer: string;
}

/**
 * Runs the recognizers relevant to `enabledTypes` over `text`.
 *
 * A recognizer that emits none of the enabled types is skipped entirely; one
 * that emits several (money → SALARY and FINANCIAL_AMOUNT) runs, and its
 * disabled types are dropped afterwards.
 */
export function runRecognizers(
  recognizers: readonly PatternRecognizer[],
  text: string,
  enabledTypes: ReadonlySet<string>,
): TaggedMatch[] {
  const matches: TaggedMatch[] = [];

  for (const recognizer of recognizers) {
    if (!recognizer.entityTypes.some((type) => enabledTypes.has(type))) continue;
    for (const match of recognizer.recognize(text)) {
      if (enabledTypes.has(match.entityType)) {
        matches.push({ ...match, recognizer: recognizer.name });
      }
    }
  }

  return matches;
}
