import { isIPv4, isIPv6 } from 'node:net';
import {
  digitCount,
  hasContext,
  matchesOf,
  type PatternRecognizer,
  type RecognizerMatch,
} from './recognizer';

// ── Email ───────────────────────────────────────────────────────────────────

/** The start of a URL's userinfo, `scheme://user:`, right before a match. */
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:$/i;

const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\p{L}\p{N}])/gu;

export class EmailRecognizer implements PatternRecognizer {
  readonly name = 'email';
  readonly entityTypes = ['EMAIL_ADDRESS'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];
    for (const match of matchesOf(EMAIL, text)) {
      const local = match[0].slice(0, match[0].indexOf('@'));
      // RFC 5321: the local part cannot start or end with a dot, or hold two in a row.
      if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) continue;
      // `postgres://app:secret@db.internal` is a URL with a password, not an
      // address; the credential recognizer masks the password.
      if (URL_USERINFO.test(text.slice(Math.max(0, match.index - 128), match.index)))
        continue;
      found.push({
        entityType: 'EMAIL_ADDRESS',
        start: match.index,
        end: match.index + match[0].length,
        score: 1,
      });
    }
    return found;
  }
}

// ── Phone numbers ───────────────────────────────────────────────────────────

const PHONE_CONTEXT =
  /\b(phone|tel|telephone|mobile|mob|cell|cellphone|call|contact|whats\s?app|fax|landline|ph)\b/i;

/** `+` and a country code, then two to six groups. */
const INTERNATIONAL =
  /(?<![\p{L}\p{N}+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}(?![\p{L}\p{N}])/gu;

/**
 * The same with the "00" international prefix (0092 300 1234567). A separator
 * must follow the country code: an unbroken run starting 00 is more often a
 * padded reference number than a phone.
 */
const INTERNATIONAL_00 =
  /(?<![\p{L}\p{N}+]|\p{N}[ .-])00[1-9]\d{0,2}[ .-]\(?\d{1,4}\)?(?:[ .-]?\(?\d{1,4}\)?){1,5}(?![\p{L}\p{N}])/gu;

/** Pakistani mobile: 03xx followed by seven digits. */
const PK_MOBILE = /(?<![\p{N}+])03\d{2}(?:[ -]?\d{7}|[ -]\d{3}[ -]\d{4})(?![\p{N}])/gu;

/** North American: (555) 123-4567, 555-123-4567, 555.123.4567. */
const NANP = /(?<![\p{N}+])(?:\(\d{3}\) ?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\p{N}])/gu;

/** Anything phone-shaped, accepted only when a word like "phone" introduces it. */
const GENERIC = /(?<![\p{N}+])\(?\d{2,5}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\p{N}])/gu;

/** Dates are the classic phone false positive. */
const DATE_LIKE = /^\d{4}[ .-]\d{2}[ .-]\d{2}$|^\d{2}[ .-]\d{2}[ .-]\d{4}$/;

/**
 * The span of `match` without a bracket it took from the surrounding sentence.
 * Each group may carry its own optional brackets, so "(+92 300 1234567)" would
 * otherwise end with the sentence's ")", and masking it would delete that ")".
 */
function withoutStrayBrackets(match: RegExpExecArray): { start: number; end: number } {
  const value = match[0];
  let from = 0;
  let to = value.length;
  const count = (bracket: string) =>
    [...value.slice(from, to)].filter((character) => character === bracket).length;

  while (to > from && value[to - 1] === ')' && count(')') > count('(')) to -= 1;
  while (from < to && value[from] === '(' && count('(') > count(')')) from += 1;

  return { start: match.index + from, end: match.index + to };
}

export class PhoneRecognizer implements PatternRecognizer {
  readonly name = 'phone';
  readonly entityTypes = ['PHONE_NUMBER'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];
    const add = (start: number, end: number, score: number, contextFreeScore?: number) =>
      found.push({ entityType: 'PHONE_NUMBER', start, end, score, contextFreeScore });

    for (const match of matchesOf(INTERNATIONAL, text)) {
      const digits = digitCount(match[0]);
      if (digits < 8 || digits > 15) continue;
      const { start, end } = withoutStrayBrackets(match);
      add(start, end, 0.85);
    }

    for (const match of matchesOf(INTERNATIONAL_00, text)) {
      const digits = digitCount(match[0]) - 2;
      if (digits < 8 || digits > 15) continue;
      const { start, end } = withoutStrayBrackets(match);
      add(start, end, 0.85);
    }

    for (const match of matchesOf(PK_MOBILE, text)) {
      add(match.index, match.index + match[0].length, 0.85);
    }

    for (const match of matchesOf(NANP, text)) {
      const end = match.index + match[0].length;
      add(
        match.index,
        end,
        hasContext(text, match.index, end, PHONE_CONTEXT) ? 0.85 : 0.6,
        0.6,
      );
    }

    for (const match of matchesOf(GENERIC, text)) {
      const end = match.index + match[0].length;
      const digits = digitCount(match[0]);
      if (digits < 7 || digits > 15 || DATE_LIKE.test(match[0])) continue;
      if (hasContext(text, match.index, end, PHONE_CONTEXT, 32, 0)) {
        add(match.index, end, 0.7, 0);
      }
    }

    return found;
  }
}

// ── National identifiers ────────────────────────────────────────────────────

/**
 * US SSN, AAA-GG-SSSS. Area 000, 666 and 900–999, group 00 and serial 0000
 * were never issued, so they are excluded outright.
 */
const SSN_SEPARATED =
  /(?<![\p{N}-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\p{N}-])/gu;
const SSN_BARE =
  /(?<![\p{N}#-])(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}(?![\p{N}-])/gu;
const SSN_CONTEXT = /\b(ssn|social security|soc\.? sec)\b/i;

/**
 * Pakistani CNIC, 12345-1234567-1. The first digit is the province code, 1–7.
 */
const CNIC_SEPARATED = /(?<![\p{N}-])[1-7]\d{4}-\d{7}-\d(?![\p{N}-])/gu;
const CNIC_BARE = /(?<![\p{N}-])[1-7]\d{12}(?![\p{N}-])/gu;
const CNIC_CONTEXT =
  /\b(cnic|nic|nicop|national identity|identity card|id card|shanakhti)\b/i;

export class NationalIdRecognizer implements PatternRecognizer {
  readonly name = 'national-id';
  readonly entityTypes = ['US_SSN', 'PK_CNIC'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];

    for (const match of matchesOf(SSN_SEPARATED, text)) {
      const end = match.index + match[0].length;
      found.push({
        entityType: 'US_SSN',
        start: match.index,
        end,
        score: hasContext(text, match.index, end, SSN_CONTEXT) ? 0.95 : 0.85,
        contextFreeScore: 0.85,
      });
    }
    for (const match of matchesOf(SSN_BARE, text)) {
      const end = match.index + match[0].length;
      if (hasContext(text, match.index, end, SSN_CONTEXT)) {
        found.push({
          entityType: 'US_SSN',
          start: match.index,
          end,
          score: 0.75,
          contextFreeScore: 0,
        });
      }
    }

    for (const match of matchesOf(CNIC_SEPARATED, text)) {
      found.push({
        entityType: 'PK_CNIC',
        start: match.index,
        end: match.index + match[0].length,
        score: 0.95,
      });
    }
    for (const match of matchesOf(CNIC_BARE, text)) {
      const end = match.index + match[0].length;
      if (hasContext(text, match.index, end, CNIC_CONTEXT)) {
        found.push({
          entityType: 'PK_CNIC',
          start: match.index,
          end,
          score: 0.8,
          contextFreeScore: 0,
        });
      }
    }

    return found;
  }
}

// ── IP addresses ────────────────────────────────────────────────────────────

const IPV4 = /(?<!\d)(?<!\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
const IPV6 =
  /(?<![\p{L}\p{N}:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\p{L}\p{N}:])/gu;
const IP_CONTEXT =
  /\b(ip|ipv4|ipv6|address|host|server|client|login|logged in|from|source|remote|vpn)\b/i;
const VERSION_CONTEXT = /\b(version|ver|v|release|build|firmware)\b\.?\s*$/i;

export class IpAddressRecognizer implements PatternRecognizer {
  readonly name = 'ip-address';
  readonly entityTypes = ['IP_ADDRESS'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];

    for (const match of matchesOf(IPV4, text)) {
      if (!isIPv4(match[0])) continue;
      const end = match.index + match[0].length;
      // "version 1.2.3.4" is a version number, not a host.
      if (VERSION_CONTEXT.test(text.slice(Math.max(0, match.index - 12), match.index))) {
        continue;
      }
      found.push({
        entityType: 'IP_ADDRESS',
        start: match.index,
        end,
        score: hasContext(text, match.index, end, IP_CONTEXT) ? 0.9 : 0.6,
        contextFreeScore: 0.6,
      });
    }

    for (const match of matchesOf(IPV6, text)) {
      const candidate = match[0];
      // Needs at least three hex groups to be worth checking; `isIPv6` decides.
      if ((candidate.match(/[0-9A-Fa-f]+/g) ?? []).length < 3 || !isIPv6(candidate))
        continue;
      found.push({
        entityType: 'IP_ADDRESS',
        start: match.index,
        end: match.index + candidate.length,
        score: 0.9,
      });
    }

    return found;
  }
}
