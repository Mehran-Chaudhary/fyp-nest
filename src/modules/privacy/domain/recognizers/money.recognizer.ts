import {
  hasContext,
  matchesOf,
  type PatternRecognizer,
  type RecognizerMatch,
} from './recognizer';

/**
 * Money — the entity the proposal names ("salaries") and Presidio does not
 * recognise at all.
 *
 * Every amount is not sensitive: "reimbursement up to $50" in a policy is not
 * personal data, and masking it would only make answers worse. What is
 * sensitive is *compensation*. So an amount is a `SALARY` when compensation
 * vocabulary surrounds it, and otherwise a `FINANCIAL_AMOUNT` — a separate
 * type, off in the default policy, for workspaces that want every figure
 * hidden.
 *
 * Bare numbers ("salary is 950000") count only in a compensation context,
 * and never when they look like a year.
 */

const CURRENCY_SYMBOL = String.raw`(?:(?:US|CA|AU|NZ|HK|SG)?\$|€|£|¥|₹|₨|Rs\.?|PKR|USD|EUR|GBP|INR|AED|SAR|CAD|AUD|JPY|CNY)`;
const CURRENCY_WORD = String.raw`(?:PKR|USD|EUR|GBP|INR|AED|SAR|CAD|AUD|JPY|CNY|rupees?|dollars?|euros?|pounds?|dirhams?|riyals?)`;
const AMOUNT = String.raw`(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d{1,2})?`;
const MAGNITUDE = String.raw`(?: ?(?:k|K|m|M|mn|bn|million|thousand|lakhs?|lacs?|crores?|billion)\b)?`;

const PREFIXED = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${CURRENCY_SYMBOL} ?${AMOUNT}${MAGNITUDE}(?![\p{N}])`,
  'gu',
);
const SUFFIXED = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])${AMOUNT}${MAGNITUDE} ?${CURRENCY_WORD}(?![\p{L}])`,
  'giu',
);
/**
 * A number with no currency, accepted only beside a compensation word. Not an
 * amount: a group inside a longer digit sequence (a phone number, a tracking
 * number), anything with a leading zero, an identifier after "#" or a
 * letter-and-hyphen prefix ("EMP-00421", "INV-2024-48017").
 */
const BARE =
  /(?<![\p{L}\p{N}.,$€£¥₹₨#]|\p{N}[ -]|\p{L}-)(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{3,8})(?:\.\d{1,2})?(?![\p{L}\p{N}%]|[.,]\d|[ -]\p{N})/gu;

/**
 * Words that make an amount someone's pay. Periods alone ("annual", "per
 * month") are not among them: an annual subscription is not a salary.
 */
const COMPENSATION =
  /\b(salary|salaries|wage|wages|pay|paid|payroll|payslip|pay slip|compensation|remuneration|bonus|bonuses|earns?|earned|earning|income|stipend|ctc|package|gross|net pay|take[- ]home|per annum|p\.a\.|allowance|increment|raise|overtime|commission)\b/i;

const YEAR = /^(19|20)\d{2}$/;

const NUMBER_WORD = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?|lacs?|crores?|million|billion)`;
const NUMBER_WORDS = String.raw`${NUMBER_WORD}(?:(?:[\s-]+|\s+and\s+)${NUMBER_WORD}){1,14}`;
const WORD_CURRENCY = String.raw`(?:rupees?|dollars?|euros?|pounds?|dirhams?|riyals?|PKR|USD|EUR|GBP|INR|AED|SAR)`;

/**
 * An amount in words, as contracts and cheques write it: "Rupees Nine Hundred
 * Fifty Thousand Only", "nine hundred and fifty thousand rupees". At least two
 * number words and an explicit currency, so "one or two dollars" is not one.
 */
const IN_WORDS = new RegExp(
  String.raw`(?<![\p{L}])(?:${WORD_CURRENCY}\s+${NUMBER_WORDS}(?:\s+only)?|${NUMBER_WORDS}\s+${WORD_CURRENCY}(?:\s+only)?)(?![\p{L}])`,
  'giu',
);

export class MoneyRecognizer implements PatternRecognizer {
  readonly name = 'money';
  readonly entityTypes = ['SALARY', 'FINANCIAL_AMOUNT'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];

    const withCurrency = (start: number, end: number) => {
      const salary = hasContext(text, start, end, COMPENSATION, 64, 40);
      found.push({
        entityType: salary ? 'SALARY' : 'FINANCIAL_AMOUNT',
        start,
        end,
        score: salary ? 0.9 : 0.6,
        // Without the context word it is an amount of money, not a salary.
        ...(salary ? { contextFreeScore: 0 } : {}),
      });
    };

    for (const match of matchesOf(PREFIXED, text)) {
      withCurrency(match.index, match.index + match[0].length);
    }
    for (const match of matchesOf(SUFFIXED, text)) {
      withCurrency(match.index, match.index + match[0].length);
    }
    for (const match of matchesOf(IN_WORDS, text)) {
      withCurrency(match.index, match.index + match[0].length);
    }

    for (const match of matchesOf(BARE, text)) {
      if (YEAR.test(match[0])) continue;
      const end = match.index + match[0].length;
      if (hasContext(text, match.index, end, COMPENSATION, 64, 40)) {
        found.push({
          entityType: 'SALARY',
          start: match.index,
          end,
          score: 0.7,
          contextFreeScore: 0,
        });
      }
    }

    return found;
  }
}
