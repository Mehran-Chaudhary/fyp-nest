import { canonicalizeText } from '../../common/utils/unicode.util';
import {
  ibanCheckDigits,
  luhnValid,
  withLuhnCheckDigit,
} from '../../modules/privacy/domain/checksums';

/**
 * A synthetic, annotated corpus for measuring the PII Redaction Engine.
 *
 * Synthetic by necessity — a real corpus of payroll records and support
 * tickets is exactly the data the engine exists to protect — and generated
 * deterministically from a seed, so every figure in the report can be
 * reproduced exactly.
 *
 * Each document is written the way the data arrives in practice: HR records,
 * support tickets, IT incident notes, informal chat, finance correspondence.
 * Around one entity in ten is **obfuscated** the way copy-pasted or
 * deliberately evasive text is — full-width digits, zero-width spaces, no-break
 * spaces — which the engine must see through. Every document also carries
 * **decoys**: order numbers, dates, ISBNs, Luhn-invalid "tracking numbers",
 * version strings, prices. They look like personal data and are not; masking
 * them is a false positive that makes answers worse.
 *
 * Gold annotations are character offsets into the *canonical* text (what
 * `prepareText` produces), which is what the engine detects on and what the
 * model finally reads.
 */

export interface GoldEntity {
  type: string;
  start: number;
  end: number;
  /** Canonical surface form. */
  value: string;
  /** How it was written: `compact`, `spaced`, `fullwidth`, … */
  variant: string;
}

export interface Decoy {
  kind: string;
  start: number;
  end: number;
  value: string;
}

export interface AnnotatedDocument {
  id: string;
  category: DocumentCategory;
  /** As submitted, obfuscations included. */
  text: string;
  /** Canonical form; gold offsets refer to it. */
  canonical: string;
  entities: GoldEntity[];
  decoys: Decoy[];
}

export type DocumentCategory =
  'hr-record' | 'support-ticket' | 'it-incident' | 'chat' | 'finance' | 'clean';

/** Terms on the benchmark workspace's deny list (entity type CUSTOM). */
export const DENY_LIST = ['Project Falcon', 'Operation Blue Heron', 'Codename Nimbus'];

// ── Deterministic randomness ────────────────────────────────────────────────

/** mulberry32: small, fast and good enough for test data. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  digits(count: number): string {
    let out = '';
    for (let index = 0; index < count; index += 1) out += String(this.int(0, 9));
    return out;
  }

  alphanumeric(
    count: number,
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ): string {
    let out = '';
    for (let index = 0; index < count; index += 1)
      out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
}

// ── Obfuscation ─────────────────────────────────────────────────────────────

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);

function fullWidthDigits(text: string): string {
  return text.replace(/[0-9]/g, (digit) => String.fromCodePoint(0xff10 + Number(digit)));
}

type Obfuscation = 'fullwidth' | 'zero-width' | 'no-break-space';

function obfuscate(text: string, how: Obfuscation): string {
  switch (how) {
    case 'fullwidth':
      return fullWidthDigits(text);
    case 'zero-width':
      // Between every character of the value's middle third.
      return [...text]
        .map((character, index) =>
          index > 0 && index % 3 === 0 ? ZERO_WIDTH_SPACE + character : character,
        )
        .join('');
    case 'no-break-space':
      return text.replace(/ /g, NO_BREAK_SPACE);
  }
}

// ── A document under construction ───────────────────────────────────────────

class DocumentBuilder {
  private raw = '';
  private canonical = '';
  readonly entities: GoldEntity[] = [];
  readonly decoys: Decoy[] = [];

  constructor(private readonly rng: Rng) {}

  text(value: string): this {
    this.raw += value;
    this.canonical += canonicalizeText(value);
    return this;
  }

  entity(
    type: string,
    value: { text: string; variant: string },
    obfuscations: readonly Obfuscation[] = [],
  ): this {
    let raw = value.text;
    let variant = value.variant;
    if (obfuscations.length > 0 && this.rng.chance(0.12)) {
      const how = this.rng.pick(obfuscations);
      raw = obfuscate(raw, how);
      variant = `${variant}+${how}`;
    }
    const canonical = canonicalizeText(raw);
    const start = this.canonical.length;
    this.raw += raw;
    this.canonical += canonical;
    this.entities.push({
      type,
      start,
      end: start + canonical.length,
      value: canonical,
      variant,
    });
    return this;
  }

  decoy(kind: string, value: string): this {
    const start = this.canonical.length;
    this.raw += value;
    this.canonical += canonicalizeText(value);
    this.decoys.push({
      kind,
      start,
      end: this.canonical.length,
      value: canonicalizeText(value),
    });
    return this;
  }

  build(id: string, category: DocumentCategory): AnnotatedDocument {
    return {
      id,
      category,
      text: this.raw,
      canonical: this.canonical,
      entities: this.entities,
      decoys: this.decoys,
    };
  }
}

// ── Values ──────────────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'Ayesha',
  'Imran',
  'Fatima',
  'Bilal',
  'Sana',
  'Usman',
  'Hira',
  'Ahmed',
  'Zainab',
  'Hamza',
  'Maryam',
  'Ali',
  'Omar',
  'Sarah',
  'John',
  'Emily',
  'David',
  'Priya',
  'Wei',
  'Maria',
  'Mehwish',
  'Kamran',
  'Nadia',
  'Farhan',
  'Rabia',
  'Tariq',
  'Sofia',
  'James',
  'Aisha',
  'Daniel',
];
const LAST_NAMES = [
  'Raza',
  'Khan',
  'Ahmed',
  'Malik',
  'Qureshi',
  'Siddiqui',
  'Chaudhry',
  'Butt',
  'Sheikh',
  'Hussain',
  'Smith',
  'Johnson',
  'Williams',
  'Garcia',
  'Patel',
  'Wang',
  'Iqbal',
  'Mirza',
  'Abbasi',
  'Rehman',
];
const DOMAINS = [
  'acme.test',
  'mail.example.com',
  'corp.example.org',
  'example.net',
  'hr.acme.test',
];

function person(rng: Rng): { first: string; last: string; full: string } {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return { first, last, full: `${first} ${last}` };
}

function email(
  rng: Rng,
  name: { first: string; last: string },
): { text: string; variant: string } {
  const local = rng
    .pick([
      `${name.first}.${name.last}`,
      `${name.first[0]}${name.last}`,
      `${name.first}${rng.int(1, 99)}`,
      `${name.first}_${name.last}`,
    ])
    .toLowerCase();
  const tagged = rng.chance(0.1)
    ? `${local}+${rng.pick(['payroll', 'hr', 'billing'])}`
    : local;
  const address = `${tagged}@${rng.pick(DOMAINS)}`;
  return rng.chance(0.1)
    ? { text: address.toUpperCase(), variant: 'uppercase' }
    : { text: address, variant: 'plain' };
}

function phone(rng: Rng): { text: string; variant: string } {
  const network = rng.pick(['300', '301', '321', '333', '345', '312']);
  const rest = rng.digits(7);
  return rng.pick([
    { text: `0${network}-${rest}`, variant: 'pk-dashed' },
    { text: `0${network}${rest}`, variant: 'pk-compact' },
    { text: `0${network} ${rest.slice(0, 3)} ${rest.slice(3)}`, variant: 'pk-spaced' },
    { text: `+92 ${network} ${rest}`, variant: 'intl-spaced' },
    { text: `+92-${network}-${rest}`, variant: 'intl-dashed' },
    { text: `+92 (${network}) ${rest}`, variant: 'intl-parenthesised' },
    { text: `0092 ${network} ${rest}`, variant: 'intl-00-prefix' },
    { text: `+44 20 ${rng.digits(4)} ${rng.digits(4)}`, variant: 'uk' },
    {
      text: `(${rng.int(201, 989)}) ${rng.int(200, 999)}-${rng.digits(4)}`,
      variant: 'nanp',
    },
  ]);
}

function card(rng: Rng): { text: string; variant: string } {
  const scheme = rng.pick([
    'visa',
    'mastercard',
    'mastercard-2',
    'amex',
    'discover',
    'unionpay',
  ] as const);
  let digits: string;
  switch (scheme) {
    case 'visa':
      digits = withLuhnCheckDigit(`4${rng.digits(14)}`);
      break;
    case 'mastercard':
      digits = withLuhnCheckDigit(`5${rng.int(1, 5)}${rng.digits(13)}`);
      break;
    case 'mastercard-2':
      digits = withLuhnCheckDigit(`${rng.int(2221, 2720)}${rng.digits(11)}`);
      break;
    case 'amex':
      digits = withLuhnCheckDigit(`3${rng.pick(['4', '7'])}${rng.digits(12)}`);
      break;
    case 'discover':
      digits = withLuhnCheckDigit(`6011${rng.digits(11)}`);
      break;
    case 'unionpay':
      digits = withLuhnCheckDigit(`62${rng.digits(13)}`);
      break;
  }
  const groups =
    digits.length === 15
      ? [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10)]
      : (digits.match(/.{1,4}/g) ?? [digits]);
  const format = rng.pick(['spaced', 'dashed', 'compact'] as const);
  const text = format === 'compact' ? digits : groups.join(format === 'spaced' ? ' ' : '-');
  return { text, variant: `${scheme}-${format}` };
}

function iban(rng: Rng): { text: string; variant: string } {
  const country = rng.pick(['PK', 'GB', 'DE', 'AE', 'SA'] as const);
  const bban = {
    PK: () => `${rng.alphanumeric(4, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')}${rng.digits(16)}`,
    GB: () => `${rng.alphanumeric(4, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')}${rng.digits(14)}`,
    DE: () => rng.digits(18),
    AE: () => rng.digits(19),
    SA: () =>
      `${rng.digits(2)}${rng.alphanumeric(18, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')}`,
  }[country]();
  const compact = `${country}${ibanCheckDigits(country, bban)}${bban}`;
  const grouped = compact.match(/.{1,4}/g)?.join(' ') ?? compact;
  const roll = rng.next();
  if (roll < 0.45) return { text: compact, variant: `${country}-compact` };
  if (roll < 0.9) return { text: grouped, variant: `${country}-grouped` };
  return { text: grouped.toLowerCase(), variant: `${country}-grouped-lowercase` };
}

function cnic(rng: Rng): { text: string; variant: string } {
  return {
    text: `${rng.int(1, 7)}${rng.digits(4)}-${rng.digits(7)}-${rng.int(1, 9)}`,
    variant: 'dashed',
  };
}

function ssn(rng: Rng): { text: string; variant: string } {
  const area = String(rng.int(1, 665)).padStart(3, '0');
  const group = String(rng.int(1, 99)).padStart(2, '0');
  const serial = String(rng.int(1, 9999)).padStart(4, '0');
  return { text: `${area}-${group}-${serial}`, variant: 'dashed' };
}

function ip(rng: Rng): { text: string; variant: string } {
  return rng.chance(0.8)
    ? {
        text: `${rng.pick(['203.0.113', '198.51.100', '192.0.2', '185.12.64'])}.${rng.int(1, 254)}`,
        variant: 'v4',
      }
    : {
        text: `2001:db8:${rng.int(1, 0xffff).toString(16)}::${rng.int(1, 0xffff).toString(16)}`,
        variant: 'v6',
      };
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const TEENS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

/** 1–999 in words. */
function hundredsInWords(value: number): string {
  const words: string[] = [];
  if (value >= 100) words.push(ONES[Math.floor(value / 100)], 'hundred');
  const rest = value % 100;
  if (rest >= 20)
    words.push(TENS[Math.floor(rest / 10)], ...(rest % 10 ? [ONES[rest % 10]] : []));
  else if (rest >= 10) words.push(TEENS[rest - 10]);
  else if (rest > 0) words.push(ONES[rest]);
  return words.join(' ');
}

function salaryAmount(rng: Rng): { text: string; variant: string } {
  const thousands = rng.int(45, 999);
  const grouped = (thousands * 1_000).toLocaleString('en-US');
  const lakh = (rng.int(15, 240) / 10).toString();
  return rng.pick([
    { text: `PKR ${grouped}`, variant: 'pkr-prefix' },
    { text: `Rs. ${grouped}`, variant: 'rs-prefix' },
    { text: `$${grouped}`, variant: 'usd-symbol' },
    { text: `${grouped} rupees`, variant: 'rupees-suffix' },
    { text: `USD ${grouped}`, variant: 'usd-prefix' },
    { text: `PKR ${lakh} lakh`, variant: 'lakh' },
    { text: `$${rng.int(45, 250)}k`, variant: 'thousands-k' },
    { text: `Rupees ${hundredsInWords(thousands)} thousand only`, variant: 'in-words' },
  ]);
}

function credential(rng: Rng): { text: string; variant: string; lead: string } {
  return rng.pick([
    {
      lead: 'the AWS key ',
      text: `AKIA${rng.alphanumeric(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`,
      variant: 'aws',
    },
    { lead: 'a GitHub token ', text: `ghp_${rng.alphanumeric(36)}`, variant: 'github' },
    { lead: 'the Stripe key ', text: `sk_live_${rng.alphanumeric(24)}`, variant: 'stripe' },
    {
      lead: 'password: ',
      text: `${rng.alphanumeric(4)}!${rng.digits(3)}${rng.alphanumeric(5)}`,
      variant: 'password-assignment',
    },
    { lead: 'api_key=', text: rng.alphanumeric(32), variant: 'api-key-assignment' },
  ]);
}

// ── Decoys ──────────────────────────────────────────────────────────────────

function luhnInvalid16(rng: Rng): string {
  for (;;) {
    const digits = `${rng.int(1, 9)}${rng.digits(15)}`;
    if (!luhnValid(digits)) return digits.match(/.{4}/g)?.join(' ') ?? digits;
  }
}

function decoyValue(rng: Rng): { kind: string; text: string; lead: string } {
  return rng.pick([
    { kind: 'order-number', lead: 'order #', text: rng.digits(9) },
    {
      kind: 'date-iso',
      lead: 'on ',
      text: `20${rng.int(18, 26)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
    },
    {
      kind: 'date-dmy',
      lead: 'dated ',
      text: `${String(rng.int(1, 28)).padStart(2, '0')}/${String(rng.int(1, 12)).padStart(2, '0')}/20${rng.int(18, 26)}`,
    },
    { kind: 'tracking-number', lead: 'tracking number ', text: luhnInvalid16(rng) },
    {
      kind: 'isbn',
      lead: 'ISBN ',
      text: `978-${rng.int(0, 1)}-${rng.digits(3)}-${rng.digits(5)}-${rng.int(0, 9)}`,
    },
    {
      kind: 'invoice',
      lead: 'invoice ',
      text: `INV-20${rng.int(18, 26)}-${rng.digits(5)}`,
    },
    {
      kind: 'version',
      lead: 'firmware version ',
      text: `${rng.int(1, 12)}.${rng.int(0, 20)}.${rng.int(0, 9)}.${rng.int(0, 99)}`,
    },
    {
      kind: 'uuid',
      lead: 'request ',
      text: `${rng.alphanumeric(8, '0123456789abcdef')}-${rng.alphanumeric(4, '0123456789abcdef')}-4${rng.alphanumeric(3, '0123456789abcdef')}-a${rng.alphanumeric(3, '0123456789abcdef')}-${rng.alphanumeric(12, '0123456789abcdef')}`,
    },
    { kind: 'commit', lead: 'commit ', text: rng.alphanumeric(40, '0123456789abcdef') },
    {
      kind: 'price',
      lead: 'a licence costs ',
      text: `USD ${rng.int(10, 999)}.${rng.digits(2)}`,
    },
    { kind: 'employee-id', lead: 'employee ID ', text: `EMP-${rng.digits(5)}` },
    { kind: 'year', lead: 'since ', text: String(rng.int(1995, 2026)) },
    { kind: 'percentage', lead: 'up ', text: `${rng.int(1, 60)}.${rng.int(0, 9)}%` },
    { kind: 'extension', lead: 'extension ', text: rng.digits(4) },
    {
      kind: 'annual-fee',
      lead: 'the annual subscription is ',
      text: `USD ${rng.int(1, 9)},${rng.digits(3)}`,
    },
  ]);
}

function addDecoys(builder: DocumentBuilder, rng: Rng, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const decoy = decoyValue(rng);
    builder.text(` Ref: ${decoy.lead}`).decoy(decoy.kind, decoy.text).text('.');
  }
}

const DIGIT_OBFUSCATIONS: readonly Obfuscation[] = [
  'fullwidth',
  'zero-width',
  'no-break-space',
];

// ── Documents ───────────────────────────────────────────────────────────────

function hrRecord(rng: Rng, builder: DocumentBuilder): void {
  const who = person(rng);
  builder
    .text('Employee record. Name: ')
    .entity('PERSON', { text: who.full, variant: 'full-name' })
    .text('. Email ')
    .entity('EMAIL_ADDRESS', email(rng, who))
    .text(', mobile ')
    .entity('PHONE_NUMBER', phone(rng), DIGIT_OBFUSCATIONS)
    .text('. CNIC ')
    .entity('PK_CNIC', cnic(rng), DIGIT_OBFUSCATIONS)
    .text('. Annual salary ')
    .entity('SALARY', salaryAmount(rng))
    .text(', paid monthly to ')
    .entity('IBAN_CODE', iban(rng), ['no-break-space'])
    .text('. Corporate card ')
    .entity('CREDIT_CARD', card(rng), DIGIT_OBFUSCATIONS)
    .text('.');
  if (rng.chance(0.5)) {
    builder
      .text(' ')
      .entity('PERSON', { text: who.last, variant: 'surname-only' })
      .text(' joined the finance team last year.');
  }
  if (rng.chance(0.3)) {
    builder
      .text(' Assigned to ')
      .entity('CUSTOM', { text: rng.pick(DENY_LIST), variant: 'deny-list' })
      .text('.');
  }
  addDecoys(builder, rng, rng.int(1, 3));
}

function supportTicket(rng: Rng, builder: DocumentBuilder): void {
  const who = person(rng);
  builder
    .text('Ticket: customer ')
    .entity('PERSON', { text: who.full, variant: 'full-name' })
    .text(' (')
    .entity('EMAIL_ADDRESS', email(rng, who))
    .text(') called from ')
    .entity('PHONE_NUMBER', phone(rng), DIGIT_OBFUSCATIONS)
    .text(' about a double charge on card ')
    .entity('CREDIT_CARD', card(rng), DIGIT_OBFUSCATIONS)
    .text('.');
  addDecoys(builder, rng, rng.int(2, 4));
  builder.text(' Please refund and confirm by email.');
}

function itIncident(rng: Rng, builder: DocumentBuilder): void {
  const who = person(rng);
  const secret = credential(rng);
  builder
    .text('Incident: ')
    .entity('PERSON', { text: who.full, variant: 'full-name' })
    .text(' logged in from ')
    .entity('IP_ADDRESS', ip(rng))
    .text(` and pasted ${secret.lead}`)
    .entity('CREDENTIAL', secret)
    .text(' into a public channel. The key was rotated.');
  if (rng.chance(0.4)) {
    builder
      .text(' The app also used postgres://app:')
      .entity('CREDENTIAL', { text: rng.alphanumeric(14), variant: 'connection-string' })
      .text('@db.internal:5432/app.');
  }
  if (rng.chance(0.3)) {
    builder
      .text(' US contractor SSN on file: ')
      .entity('US_SSN', ssn(rng), DIGIT_OBFUSCATIONS)
      .text('.');
  }
  addDecoys(builder, rng, rng.int(2, 4));
}

function chat(rng: Rng, builder: DocumentBuilder): void {
  const who = person(rng);
  builder
    .text('hey its ')
    .entity('PERSON', { text: who.first, variant: 'first-name' })
    .text(', my new number is ')
    .entity('PHONE_NUMBER', phone(rng), DIGIT_OBFUSCATIONS)
    .text(' pls update it. also send my payslip to ')
    .entity('EMAIL_ADDRESS', email(rng, who))
    .text(', my salary is ')
    .entity('SALARY', salaryAmount(rng))
    .text(' now after the raise');
  if (rng.chance(0.4)) {
    builder
      .text(' and dont tell anyone about ')
      .entity('CUSTOM', { text: rng.pick(DENY_LIST), variant: 'deny-list' });
  }
  builder.text(' thx');
  addDecoys(builder, rng, rng.int(0, 2));
}

function finance(rng: Rng, builder: DocumentBuilder): void {
  const who = person(rng);
  builder
    .text('Payment instruction: transfer the bonus of ')
    .entity('SALARY', salaryAmount(rng))
    .text(' to IBAN ')
    .entity('IBAN_CODE', iban(rng), ['no-break-space'])
    .text(', beneficiary ')
    .entity('PERSON', { text: who.full, variant: 'full-name' })
    .text(', CNIC ')
    .entity('PK_CNIC', cnic(rng), DIGIT_OBFUSCATIONS)
    .text('.');
  addDecoys(builder, rng, rng.int(2, 4));
}

function clean(rng: Rng, builder: DocumentBuilder): void {
  builder.text(
    rng.pick([
      'The quarterly town hall moves to the main auditorium.',
      'Remember to submit expense reports before the end of the month.',
      'The cafeteria menu changes next week; vegetarian options are expanding.',
      'Our leave policy grants eighteen days of annual leave after probation.',
    ]),
  );
  addDecoys(builder, rng, rng.int(3, 6));
}

const GENERATORS: ReadonlyArray<
  [DocumentCategory, (rng: Rng, builder: DocumentBuilder) => void, number]
> = [
  ['hr-record', hrRecord, 0.25],
  ['support-ticket', supportTicket, 0.2],
  ['it-incident', itIncident, 0.15],
  ['chat', chat, 0.15],
  ['finance', finance, 0.15],
  ['clean', clean, 0.1],
];

export interface CorpusOptions {
  documents: number;
  seed: number;
  /** Repeat each generated document's body to reach longer documents. */
  longDocumentShare?: number;
}

export function generateCorpus(options: CorpusOptions): AnnotatedDocument[] {
  const rng = new Rng(options.seed);
  const documents: AnnotatedDocument[] = [];
  const longShare = options.longDocumentShare ?? 0.1;

  for (let index = 0; index < options.documents; index += 1) {
    const builder = new DocumentBuilder(rng);
    const roll = rng.next();
    let cumulative = 0;
    let chosen = GENERATORS[GENERATORS.length - 1];
    for (const generator of GENERATORS) {
      cumulative += generator[2];
      if (roll < cumulative) {
        chosen = generator;
        break;
      }
    }

    // A long document is several records of the same kind, one after another:
    // a payroll export, a ticket thread.
    const parts = rng.chance(longShare) ? rng.int(8, 20) : 1;
    for (let part = 0; part < parts; part += 1) {
      if (part > 0) builder.text('\n\n');
      chosen[1](rng, builder);
    }
    documents.push(builder.build(`doc-${String(index + 1).padStart(5, '0')}`, chosen[0]));
  }

  return documents;
}
