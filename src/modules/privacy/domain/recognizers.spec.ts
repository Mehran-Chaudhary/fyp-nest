import {
  canonicalizeText,
  codePointOffsetMapper,
} from '../../../common/utils/unicode.util';
import {
  cardIssuer,
  ibanCheckDigits,
  ibanValid,
  luhnValid,
  withLuhnCheckDigit,
} from './checksums';
import {
  BUILT_IN_RECOGNIZERS,
  CustomTermsRecognizer,
  runRecognizers,
  type TaggedMatch,
} from './recognizers';
import { normalizeEntityValue, nameTokens } from './entity-catalogue';
import { mergeOverlapping } from './spans';

/**
 * The pattern layer of the PII engine.
 *
 * Each recognizer is held to two properties: it finds the real thing in the
 * forms people actually write it, and it does *not* fire on the look-alikes
 * that surround it in ordinary documents — order numbers, dates, years,
 * version strings, prices. Precision matters as much as recall here: this
 * layer runs alone when the NER service is down, and it is what the gateway
 * re-runs as its final egress check.
 */

const ALL_TYPES = new Set([
  'EMAIL_ADDRESS',
  'PHONE_NUMBER',
  'CREDIT_CARD',
  'IBAN_CODE',
  'US_SSN',
  'PK_CNIC',
  'IP_ADDRESS',
  'SALARY',
  'FINANCIAL_AMOUNT',
  'CREDENTIAL',
]);

function detect(text: string, types: ReadonlySet<string> = ALL_TYPES): TaggedMatch[] {
  return runRecognizers(BUILT_IN_RECOGNIZERS, text, types);
}

/**
 * What would be masked for `type`: overlapping detections merged, as the
 * masking session does (a number can be found by two phone rules at once).
 */
function found(text: string, type: string): string[] {
  const spans = detect(text)
    .filter((match) => match.entityType === type)
    .map((match) => ({ ...match, source: 'pattern' as const }));
  return mergeOverlapping(spans).map((span) => text.slice(span.start, span.end));
}

describe('checksums', () => {
  it('validates Luhn and rejects a single altered digit', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('')).toBe(false);
    expect(luhnValid('41a1')).toBe(false);
  });

  it('generates Luhn check digits that validate', () => {
    for (const partial of ['411111111111111', '555555555555444', '37828224631000']) {
      expect(luhnValid(withLuhnCheckDigit(partial))).toBe(true);
    }
  });

  it('identifies card issuers by prefix and length', () => {
    expect(cardIssuer('4111111111111111')).toBe('visa');
    expect(cardIssuer('5555555555554444')).toBe('mastercard');
    expect(cardIssuer('2221000000000009')).toBe('mastercard');
    expect(cardIssuer('2721000000000004')).toBeNull();
    expect(cardIssuer('378282246310005')).toBe('amex');
    expect(cardIssuer('6011111111111117')).toBe('discover');
    expect(cardIssuer('3530111333300000')).toBe('jcb');
    expect(cardIssuer('30569309025904')).toBe('diners');
    expect(cardIssuer('9999999999999995')).toBeNull();
  });

  it('validates IBANs by country length and mod-97', () => {
    expect(ibanValid('GB82WEST12345698765432')).toBe(true);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('PK36SCBL0000001123456702')).toBe(true);
    expect(ibanValid('GB82WEST12345698765433')).toBe(false); // check fails
    expect(ibanValid('GB82WEST1234569876543')).toBe(false); // wrong length
    expect(ibanValid('ZZ82WEST12345698765432')).toBe(false); // unknown country
  });

  it('computes IBAN check digits that validate', () => {
    const bban = 'MEZN0001230102345678';
    expect(ibanValid(`PK${ibanCheckDigits('PK', bban)}${bban}`)).toBe(true);
  });
});

describe('credit card recognizer', () => {
  it('finds numbers in the usual groupings', () => {
    expect(found('Card: 4111 1111 1111 1111.', 'CREDIT_CARD')).toEqual([
      '4111 1111 1111 1111',
    ]);
    expect(found('pay with 5555-5555-5555-4444 today', 'CREDIT_CARD')).toEqual([
      '5555-5555-5555-4444',
    ]);
    expect(found('amex 3782 822463 10005', 'CREDIT_CARD')).toEqual(['3782 822463 10005']);
    expect(found('6011111111111117', 'CREDIT_CARD')).toEqual(['6011111111111117']);
  });

  it('picks the card out of a longer run of digit groups', () => {
    expect(found('4111 1111 1111 1111 2026', 'CREDIT_CARD')).toEqual([
      '4111 1111 1111 1111',
    ]);
    expect(found('Ref 12 4111 1111 1111 1111', 'CREDIT_CARD')).toEqual([
      '4111 1111 1111 1111',
    ]);
  });

  it('rejects Luhn failures, unknown issuers without context, and long identifiers', () => {
    expect(found('4111 1111 1111 1112', 'CREDIT_CARD')).toEqual([]);
    expect(found('Order 9999999999999995 shipped', 'CREDIT_CARD')).toEqual([]);
    expect(found('Tracking 41111111111111111111111 ok', 'CREDIT_CARD')).toEqual([]);
    expect(found('1111 1111 1111 1111', 'CREDIT_CARD')).toEqual([]);
  });

  it('accepts an unknown-issuer Luhn number only with card vocabulary nearby', () => {
    expect(found('card number 9999999999999995', 'CREDIT_CARD')).toEqual([
      '9999999999999995',
    ]);
  });

  it('scores validated numbers at 1.0', () => {
    const [match] = detect('4111111111111111');
    expect(match.score).toBe(1);
  });
});

describe('IBAN recognizer', () => {
  it('finds compact and grouped IBANs', () => {
    expect(found('IBAN PK36SCBL0000001123456702', 'IBAN_CODE')).toEqual([
      'PK36SCBL0000001123456702',
    ]);
    expect(found('Pay to GB82 WEST 1234 5698 7654 32 please', 'IBAN_CODE')).toEqual([
      'GB82 WEST 1234 5698 7654 32',
    ]);
  });

  it('stops at the country length even when words follow', () => {
    expect(found('DE89 3704 0044 0532 0130 00 IBAN', 'IBAN_CODE')).toEqual([
      'DE89 3704 0044 0532 0130 00',
    ]);
  });

  it('finds two IBANs in a row', () => {
    expect(
      found('GB82WEST12345698765432 DE89370400440532013000', 'IBAN_CODE'),
    ).toHaveLength(2);
  });

  it('rejects invalid check digits and wrong lengths', () => {
    expect(found('GB82WEST12345698765433', 'IBAN_CODE')).toEqual([]);
    expect(found('PK36SCBL00000011234567021', 'IBAN_CODE')).toEqual([]);
  });
});

describe('email, phone, national id and IP recognizers', () => {
  it('finds email addresses and rejects malformed ones', () => {
    expect(found('Mail ayesha.raza@acme.test now', 'EMAIL_ADDRESS')).toEqual([
      'ayesha.raza@acme.test',
    ]);
    expect(found('bad .dot@acme.test and a..b@acme.test', 'EMAIL_ADDRESS')).toEqual([]);
  });

  it('finds international, Pakistani and North American phone numbers', () => {
    expect(found('Call +92 300 1234567', 'PHONE_NUMBER')).toEqual(['+92 300 1234567']);
    expect(found('mobile 0300-1234567', 'PHONE_NUMBER')).toEqual(['0300-1234567']);
    expect(found('(555) 123-4567', 'PHONE_NUMBER')).toEqual(['(555) 123-4567']);
  });

  it('accepts a generic number only when a phone word introduces it', () => {
    expect(found('Tel: 051 1234567', 'PHONE_NUMBER')).toEqual(['051 1234567']);
    expect(found('Invoice 051 1234567', 'PHONE_NUMBER')).toEqual([]);
  });

  it('does not take dates for phone numbers', () => {
    expect(found('Phone review on 2026-09-24', 'PHONE_NUMBER')).toEqual([]);
  });

  it('finds SSNs, excluding ranges never issued', () => {
    expect(found('SSN 123-45-6789', 'US_SSN')).toEqual(['123-45-6789']);
    expect(found('000-12-3456 666-12-3456 900-12-3456', 'US_SSN')).toEqual([]);
    expect(found('social security 123456789', 'US_SSN')).toEqual(['123456789']);
    expect(found('reference 123456789', 'US_SSN')).toEqual([]);
  });

  it('finds CNICs by format and bare CNICs by context', () => {
    expect(found('CNIC 35202-1234567-1', 'PK_CNIC')).toEqual(['35202-1234567-1']);
    expect(found('his cnic is 3520212345671', 'PK_CNIC')).toEqual(['3520212345671']);
    expect(found('95202-1234567-1', 'PK_CNIC')).toEqual([]); // province code 9 does not exist
  });

  it('finds IPv4 and IPv6 addresses but not version numbers', () => {
    expect(found('login from 203.0.113.42.', 'IP_ADDRESS')).toEqual(['203.0.113.42']);
    expect(found('host 2001:db8::8a2e:370:7334', 'IP_ADDRESS')).toEqual([
      '2001:db8::8a2e:370:7334',
    ]);
    expect(found('upgrade to version 1.2.3.4', 'IP_ADDRESS')).toEqual([]);
    expect(found('999.1.1.1', 'IP_ADDRESS')).toEqual([]);
    expect(found('meeting 10:30:45', 'IP_ADDRESS')).toEqual([]);
  });
});

describe('money recognizer', () => {
  it('labels compensation amounts SALARY', () => {
    expect(found('Her salary is PKR 950,000 per year.', 'SALARY')).toContain('PKR 950,000');
    expect(found('Bonus of $12,500 paid in March', 'SALARY')).toContain('$12,500');
    expect(found('He earns 1.2 million rupees annually', 'SALARY')).toContain(
      '1.2 million rupees',
    );
  });

  it('accepts a bare number only in a compensation context', () => {
    expect(found('Monthly salary: 185000', 'SALARY')).toEqual(['185000']);
    expect(found('Invoice total 185000', 'SALARY')).toEqual([]);
  });

  it('never takes a year for a salary', () => {
    expect(found('The 2024 salary review happened', 'SALARY')).toEqual([]);
  });

  it('labels other currency amounts FINANCIAL_AMOUNT', () => {
    expect(found('The laptop costs $1,200.', 'FINANCIAL_AMOUNT')).toEqual(['$1,200']);
    expect(found('The laptop costs $1,200.', 'SALARY')).toEqual([]);
  });
});

describe('credential recognizer', () => {
  it('finds vendor key formats', () => {
    expect(found('key AKIAIOSFODNN7EXAMPLE here', 'CREDENTIAL')).toEqual([
      'AKIAIOSFODNN7EXAMPLE',
    ]);
    expect(found('token ghp_' + 'a'.repeat(36), 'CREDENTIAL')).toEqual([
      'ghp_' + 'a'.repeat(36),
    ]);
    expect(found('use daiap_sk_abcdefghijklmnopqrstuvwxyz', 'CREDENTIAL')).toEqual([
      'daiap_sk_abcdefghijklmnopqrstuvwxyz',
    ]);
  });

  it('masks only the value of a password assignment', () => {
    expect(found('password: Hunter2Secret!', 'CREDENTIAL')).toEqual(['Hunter2Secret!']);
  });

  it('masks the password in a connection string', () => {
    expect(found('postgres://app:s3cretPass@db.example.com/prod', 'CREDENTIAL')).toEqual([
      's3cretPass',
    ]);
  });

  it('finds private key blocks', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`;
    expect(found(`key:\n${pem}\n`, 'CREDENTIAL')).toEqual([pem]);
  });
});

describe('custom terms (deny list)', () => {
  it('matches whole words case-insensitively, longest first', () => {
    const recognizer = new CustomTermsRecognizer(['Falcon', 'Project Falcon']);
    const text = 'Project Falcon and FALCON, not Falconer.';
    const matches = recognizer.recognize(text).map((m) => text.slice(m.start, m.end));
    expect(matches).toEqual(['Project Falcon', 'FALCON']);
  });

  it('escapes regular-expression syntax in terms', () => {
    const recognizer = new CustomTermsRecognizer(['C++ (beta)', 'a.b']);
    expect(recognizer.recognize('We use C++ (beta) and axb').length).toBe(1);
  });

  it('is empty without terms', () => {
    expect(new CustomTermsRecognizer([]).isEmpty).toBe(true);
  });
});

describe('recognizer selection', () => {
  it('runs only recognizers for enabled types', () => {
    const text = 'ayesha@acme.test 4111111111111111';
    const matches = runRecognizers(BUILT_IN_RECOGNIZERS, text, new Set(['EMAIL_ADDRESS']));
    expect(matches.map((m) => m.entityType)).toEqual(['EMAIL_ADDRESS']);
  });

  it('drops disabled types from multi-type recognizers', () => {
    const matches = runRecognizers(
      BUILT_IN_RECOGNIZERS,
      'salary PKR 950,000 and a $5 coffee',
      new Set(['SALARY']),
    );
    expect(matches.every((m) => m.entityType === 'SALARY')).toBe(true);
  });
});

describe('Unicode hardening', () => {
  it('folds full-width digits so a disguised card is still found', () => {
    const disguised = '４１１１ １１１１ １１１１ １１１１';
    expect(found(canonicalizeText(disguised), 'CREDIT_CARD')).toHaveLength(1);
  });

  it('removes zero-width characters hidden inside a number', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const hidden = ['4111', '1111', '1111', '1111'].join(zeroWidth);
    expect(found(hidden, 'CREDIT_CARD')).toEqual([]);
    expect(found(canonicalizeText(hidden), 'CREDIT_CARD')).toEqual(['4111111111111111']);
  });

  it('removes bidi controls', () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(canonicalizeText(`abc${rlo}def`)).toBe('abcdef');
  });

  it('maps Python code-point offsets to UTF-16 offsets around emoji', () => {
    const text = '😀 Ayesha';
    const toUtf16 = codePointOffsetMapper(text);
    // Python: "😀 Ayesha"[2:8] == "Ayesha"
    expect(text.slice(toUtf16(2), toUtf16(8))).toBe('Ayesha');
  });

  it('is the identity without astral characters', () => {
    const toUtf16 = codePointOffsetMapper('plain');
    expect(toUtf16(3)).toBe(3);
    expect(toUtf16(99)).toBe(5);
  });
});

describe('entity normalisation', () => {
  it('treats separator variants of a number as one value', () => {
    expect(normalizeEntityValue('CREDIT_CARD', '4111-1111-1111-1111')).toBe(
      normalizeEntityValue('CREDIT_CARD', '4111 1111 1111 1111'),
    );
  });

  it('treats case, spacing and possessives of a name as one value', () => {
    expect(normalizeEntityValue('PERSON', "Ayesha  RAZA's")).toBe('ayesha raza');
  });

  it('drops initials from name tokens', () => {
    expect(nameTokens('A. Raza')).toEqual(['raza']);
  });
});

/**
 * Look-alikes and formats surfaced by the redaction benchmark
 * (docs/benchmarks/pii-redaction.md). Each was a false positive, a leak or a
 * false egress block before the fix it pins down.
 */
describe('benchmark regressions', () => {
  it('does not take a group inside a longer digit sequence for a salary', () => {
    expect(
      found('Her salary was reviewed. Tracking number 2406 9260 3418 4683.', 'SALARY'),
    ).toEqual([]);
    expect(found('Salary queries: call 0300-1234567.', 'SALARY')).toEqual([]);
  });

  it('does not take identifiers for salaries', () => {
    expect(
      found('Payroll ref EMP-00421, invoice INV-2024-48017, order #293706785.', 'SALARY'),
    ).toEqual([]);
  });

  it('does not treat a period word as pay', () => {
    const text = 'The annual subscription is USD 1,200.';
    expect(found(text, 'SALARY')).toEqual([]);
    expect(found(text, 'FINANCIAL_AMOUNT')).toEqual(['USD 1,200']);
  });

  it('finds amounts written in words, as contracts write them', () => {
    expect(found('Salary: Rupees Nine Hundred Fifty Thousand Only.', 'SALARY')).toEqual([
      'Rupees Nine Hundred Fifty Thousand Only',
    ]);
    expect(found('a bonus of nine hundred and fifty thousand rupees', 'SALARY')).toEqual([
      'nine hundred and fifty thousand rupees',
    ]);
    expect(found('it costs one or two dollars', 'FINANCIAL_AMOUNT')).toEqual([]);
  });

  it('finds phone numbers with the 00 international prefix and spaced mobiles', () => {
    expect(found('mobile 0092 300 1234567', 'PHONE_NUMBER')).toEqual(['0092 300 1234567']);
    expect(found('call 0300 123 4567', 'PHONE_NUMBER')).toEqual(['0300 123 4567']);
    expect(found('reference 00123456789', 'PHONE_NUMBER')).toEqual([]);
  });

  it('never takes a number starting with 0 for a card', () => {
    const digits = withLuhnCheckDigit('009230012345678');
    const grouped = digits.match(/.{4}/g)?.join(' ') ?? digits;
    expect(found(`card on file ${grouped}`, 'CREDIT_CARD')).toEqual([]);
  });

  it('does not take a CNIC for a card, even a Luhn-valid one', () => {
    const digits = withLuhnCheckDigit('435201234567');
    const cnic = `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
    expect(luhnValid(digits)).toBe(true);
    expect(found(`card holder CNIC ${cnic}`, 'CREDIT_CARD')).toEqual([]);
    expect(found(`card holder CNIC ${cnic}`, 'PK_CNIC')).toEqual([cnic]);
  });

  it('does not read a URL password as an email address', () => {
    const url = 'postgres://app:s3cretpass@db.internal:5432/app';
    expect(found(url, 'EMAIL_ADDRESS')).toEqual([]);
    expect(found(url, 'CREDENTIAL')).toEqual(['s3cretpass']);
    expect(found('Email:john@acme.test', 'EMAIL_ADDRESS')).toEqual(['john@acme.test']);
  });

  it('leaves a bracket that belongs to the sentence outside the number', () => {
    expect(found('Ayesha (+92 300 1234567) called', 'PHONE_NUMBER')).toEqual([
      '+92 300 1234567',
    ]);
    expect(found('reach her (0092 300 1234567) today', 'PHONE_NUMBER')).toEqual([
      '0092 300 1234567',
    ]);
    expect(found('Call +92 (21) 3456 7890', 'PHONE_NUMBER')).toEqual(['+92 (21) 3456 7890']);
  });

  it('does not start a phone number in the middle of a longer number', () => {
    expect(found('tracking number 8150 0063 5858 5691', 'PHONE_NUMBER')).toEqual([]);
  });

  it('does not take an ISBN beside card words for a card', () => {
    expect(found('Paid by card for ISBN 978-0-330-81147-0', 'CREDIT_CARD')).toEqual([]);
  });

  it('does not take an order number for an SSN', () => {
    expect(found('SSN check for order #123456789', 'US_SSN')).toEqual([]);
  });

  it('says which matches rest on context', () => {
    const salary = detect('Her salary is 185000').find(
      (match) => match.entityType === 'SALARY',
    );
    expect(salary?.contextFreeScore).toBe(0);
    const card = detect('4111 1111 1111 1111').find(
      (match) => match.entityType === 'CREDIT_CARD',
    );
    expect(card?.contextFreeScore).toBeUndefined();
  });
});
