/**
 * Checksum validation for structured identifiers.
 *
 * A regular expression alone cannot tell a card number from any other run of
 * sixteen digits — an order number, a tracking code. Validation is what makes
 * the pattern layer precise enough to run with no NER model behind it: roughly
 * one random digit string in ten passes Luhn, and far fewer also carry a real
 * issuer prefix; a random string passes the IBAN mod-97 check about once in
 * ninety-seven, and must also have its country's exact length.
 */

/** The Luhn (mod-10) check used by every payment card. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

interface IssuerRule {
  issuer: string;
  lengths: readonly number[];
  ranges: ReadonlyArray<readonly [number, number]>;
  prefixLength: number;
}

const LENGTHS_16_19 = [16, 17, 18, 19] as const;

/** Issuer identification number ranges of the major card schemes. */
const ISSUERS: readonly IssuerRule[] = [
  { issuer: 'visa', lengths: [13, 16, 19], ranges: [[4, 4]], prefixLength: 1 },
  {
    issuer: 'mastercard',
    lengths: [16],
    ranges: [
      [51, 55],
      [22, 27],
    ],
    prefixLength: 2,
  },
  {
    issuer: 'amex',
    lengths: [15],
    ranges: [
      [34, 34],
      [37, 37],
    ],
    prefixLength: 2,
  },
  { issuer: 'discover', lengths: LENGTHS_16_19, ranges: [[6011, 6011]], prefixLength: 4 },
  { issuer: 'discover', lengths: LENGTHS_16_19, ranges: [[644, 649]], prefixLength: 3 },
  { issuer: 'discover', lengths: LENGTHS_16_19, ranges: [[65, 65]], prefixLength: 2 },
  { issuer: 'jcb', lengths: LENGTHS_16_19, ranges: [[3528, 3589]], prefixLength: 4 },
  {
    issuer: 'diners',
    lengths: [14, 15, 16, 17, 18, 19],
    ranges: [
      [300, 305],
      [309, 309],
    ],
    prefixLength: 3,
  },
  {
    issuer: 'diners',
    lengths: [14, 15, 16, 17, 18, 19],
    ranges: [
      [36, 36],
      [38, 39],
    ],
    prefixLength: 2,
  },
  { issuer: 'unionpay', lengths: LENGTHS_16_19, ranges: [[62, 62]], prefixLength: 2 },
  { issuer: 'mir', lengths: LENGTHS_16_19, ranges: [[2200, 2204]], prefixLength: 4 },
  {
    issuer: 'maestro',
    lengths: [12, 13, 14, 15, 16, 17, 18, 19],
    ranges: [
      [5018, 5018],
      [5020, 5020],
      [5038, 5038],
      [5893, 5893],
      [6304, 6304],
      [6759, 6763],
    ],
    prefixLength: 4,
  },
  {
    issuer: 'rupay',
    lengths: [16],
    ranges: [
      [60, 60],
      [81, 82],
    ],
    prefixLength: 2,
  },
];

/**
 * The card scheme a number belongs to, judged by prefix and length, or `null`.
 * Mastercard's 2-series is checked at four digits (2221–2720).
 */
export function cardIssuer(digits: string): string | null {
  for (const rule of ISSUERS) {
    if (!rule.lengths.includes(digits.length)) continue;
    const prefix = Number(digits.slice(0, rule.prefixLength));

    for (const [low, high] of rule.ranges) {
      if (prefix < low || prefix > high) continue;
      if (rule.issuer === 'mastercard' && rule.prefixLength === 2 && low === 22) {
        const four = Number(digits.slice(0, 4));
        if (four < 2221 || four > 2720) continue;
      }
      return rule.issuer;
    }
  }
  return null;
}

/**
 * IBAN length by country (ISO 13616 registry). A candidate must match its
 * country's length exactly, which is a strong filter on its own.
 */
// prettier-ignore
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21,
  LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/**
 * Validates a compact (no spaces), upper-case IBAN: known country, exact
 * length, and the ISO 7064 mod-97-10 check.
 */
export function ibanValid(compact: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  if (IBAN_LENGTHS[compact.slice(0, 2)] !== compact.length) return false;
  return mod97(compact.slice(4) + compact.slice(0, 4)) === 1;
}

/** Remainder mod 97 of an alphanumeric string read with A=10 … Z=35. */
export function mod97(value: string): number {
  let remainder = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const numeric = code >= 65 && code <= 90 ? String(code - 55) : character;
    for (const digit of numeric) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

/** Computes the two check digits for a country code and BBAN. Used by tests and the benchmark corpus. */
export function ibanCheckDigits(country: string, bban: string): string {
  const remainder = mod97(`${bban}${country}00`);
  return String(98 - remainder).padStart(2, '0');
}

/** Appends a Luhn check digit to `partial`. Used by tests and the benchmark corpus. */
export function withLuhnCheckDigit(partial: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    if (luhnValid(`${partial}${digit}`)) return `${partial}${digit}`;
  }
  throw new Error('unreachable: one check digit always satisfies Luhn');
}
