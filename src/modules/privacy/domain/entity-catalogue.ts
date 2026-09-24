/**
 * The vocabulary of personal-data entity types.
 *
 * Names follow Microsoft Presidio's (`PERSON`, `EMAIL_ADDRESS`, `CREDIT_CARD`,
 * `IBAN_CODE`, …) so a workspace policy can name any Presidio entity and have
 * it passed straight through to the NER detector. The platform adds a few of
 * its own where Presidio has a gap that matters for this project:
 *
 *  - `SALARY` / `FINANCIAL_AMOUNT` — the proposal names salaries explicitly,
 *    and Presidio has no recognizer for money at all.
 *  - `PK_CNIC` — the Pakistani national identity number, the most common
 *    national id in the data this platform is built for.
 *  - `CREDENTIAL` — API keys, tokens and private keys pasted into a chat.
 *  - `CUSTOM` — a workspace's own deny-list terms (project code names, client
 *    names).
 *
 * Built-in types are detected in-process by validated pattern recognizers;
 * `ner` types need the statistical model in the AI service.
 */

export type EntityDetector = 'pattern' | 'ner' | 'custom';

/**
 * How two mentions are compared to decide whether they are the same entity,
 * and therefore get the same placeholder.
 */
export type EntityNormalization = 'digits' | 'alphanumeric' | 'lowercase' | 'text';

export interface EntityTypeDefinition {
  type: string;
  label: string;
  description: string;
  detector: EntityDetector;
  normalization: EntityNormalization;
  /** A made-up value, for the policy editor. */
  example: string;
}

export const CUSTOM_ENTITY_TYPE = 'CUSTOM';

const BUILT_IN: readonly EntityTypeDefinition[] = [
  {
    type: 'EMAIL_ADDRESS',
    label: 'Email address',
    description: 'An email address.',
    detector: 'pattern',
    normalization: 'lowercase',
    example: 'ayesha.raza@acme.test',
  },
  {
    type: 'PHONE_NUMBER',
    label: 'Phone number',
    description:
      'International (+92 …), Pakistani mobile (03xx), North American, or any number ' +
      'introduced by a word such as "phone" or "mobile".',
    detector: 'pattern',
    normalization: 'digits',
    example: '+92 300 1234567',
  },
  {
    type: 'CREDIT_CARD',
    label: 'Payment card number',
    description:
      'A 13–19 digit card number passing the Luhn checksum and a known issuer prefix.',
    detector: 'pattern',
    normalization: 'digits',
    example: '4111 1111 1111 1111',
  },
  {
    type: 'IBAN_CODE',
    label: 'IBAN',
    description:
      'An International Bank Account Number with the right length for its country and a ' +
      'valid mod-97 check.',
    detector: 'pattern',
    normalization: 'alphanumeric',
    example: 'PK36SCBL0000001123456702',
  },
  {
    type: 'US_SSN',
    label: 'US Social Security number',
    description: 'A US SSN in the AAA-GG-SSSS form, excluding ranges never issued.',
    detector: 'pattern',
    normalization: 'digits',
    example: '123-45-6789',
  },
  {
    type: 'PK_CNIC',
    label: 'Pakistani CNIC',
    description: 'A Computerised National Identity Card number, 12345-1234567-1.',
    detector: 'pattern',
    normalization: 'digits',
    example: '35202-1234567-1',
  },
  {
    type: 'IP_ADDRESS',
    label: 'IP address',
    description: 'An IPv4 or IPv6 address.',
    detector: 'pattern',
    normalization: 'lowercase',
    example: '203.0.113.42',
  },
  {
    type: 'SALARY',
    label: 'Salary or compensation',
    description:
      'A monetary amount in a compensation context: salary, pay, bonus, earns, per annum.',
    detector: 'pattern',
    normalization: 'digits',
    example: 'PKR 950,000 per year',
  },
  {
    type: 'FINANCIAL_AMOUNT',
    label: 'Monetary amount',
    description:
      'Any amount with a currency. Off by default: it masks prices and limits too.',
    detector: 'pattern',
    normalization: 'digits',
    example: '$1,250.00',
  },
  {
    type: 'CREDENTIAL',
    label: 'Credential or secret',
    description:
      'Access keys, tokens and private keys: AWS, GitHub, Slack, Stripe, Google, JWTs, PEM ' +
      'blocks, this platform’s own API keys, and "password: …" assignments.',
    detector: 'pattern',
    normalization: 'text',
    example: 'AKIAIOSFODNN7EXAMPLE',
  },
  {
    type: CUSTOM_ENTITY_TYPE,
    label: 'Custom term',
    description: 'Terms from the workspace’s own deny list, such as project code names.',
    detector: 'custom',
    normalization: 'text',
    example: 'Project Falcon',
  },
];

/** The NER-backed types most workspaces will want. Any other Presidio type is accepted too. */
const NER: readonly EntityTypeDefinition[] = [
  {
    type: 'PERSON',
    label: 'Person name',
    description: 'A person’s name, found by the NER model.',
    detector: 'ner',
    normalization: 'text',
    example: 'Ayesha Raza',
  },
  {
    type: 'LOCATION',
    label: 'Location',
    description: 'Cities, countries, addresses and other places.',
    detector: 'ner',
    normalization: 'text',
    example: 'Gulberg, Lahore',
  },
  {
    type: 'ORGANIZATION',
    label: 'Organisation',
    description: 'Company and institution names. Often too broad to mask by default.',
    detector: 'ner',
    normalization: 'text',
    example: 'Meezan Bank',
  },
  {
    type: 'NRP',
    label: 'Nationality, religion or political group',
    description: 'Special-category data under GDPR Article 9.',
    detector: 'ner',
    normalization: 'text',
    example: 'Pakistani',
  },
  {
    type: 'DATE_TIME',
    label: 'Date or time',
    description: 'Dates and times, including dates of birth. Broad; enable deliberately.',
    detector: 'ner',
    normalization: 'text',
    example: '14 August 1990',
  },
  {
    type: 'MEDICAL_LICENSE',
    label: 'Medical licence number',
    description: 'A medical licence number.',
    detector: 'ner',
    normalization: 'alphanumeric',
    example: 'AB1234567',
  },
  {
    type: 'US_PASSPORT',
    label: 'US passport number',
    description: 'A US passport number.',
    detector: 'ner',
    normalization: 'alphanumeric',
    example: '912803456',
  },
  {
    type: 'US_DRIVER_LICENSE',
    label: 'US driver licence',
    description: 'A US driver licence number.',
    detector: 'ner',
    normalization: 'alphanumeric',
    example: 'D1234567',
  },
  {
    type: 'UK_NHS',
    label: 'UK NHS number',
    description: 'A UK National Health Service number.',
    detector: 'ner',
    normalization: 'digits',
    example: '943 476 5919',
  },
];

const BY_TYPE: ReadonlyMap<string, EntityTypeDefinition> = new Map(
  [...BUILT_IN, ...NER].map((definition) => [definition.type, definition]),
);

/** Types the in-process recognizers can detect (plus `CUSTOM`, from the deny list). */
export const LOCALLY_DETECTED_TYPES: ReadonlySet<string> = new Set(
  BUILT_IN.map((definition) => definition.type),
);

/** Every type described here, for the policy editor. */
export function listEntityTypes(): readonly EntityTypeDefinition[] {
  return [...BUILT_IN, ...NER];
}

/** Well-formed entity type name: what Presidio and this catalogue use. */
export const ENTITY_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,40}$/;

/**
 * The definition for `type`. An unknown but well-formed name is treated as a
 * Presidio NER type, which is what it will be looked up as.
 */
export function entityDefinition(type: string): EntityTypeDefinition {
  return (
    BY_TYPE.get(type) ?? {
      type,
      label: type,
      description: 'Detected by the NER service.',
      detector: 'ner',
      normalization: 'text',
      example: '',
    }
  );
}

/** True for any type this catalogue knows, or any name that looks like one. */
export function isEntityTypeName(value: string): boolean {
  return BY_TYPE.has(value) || ENTITY_TYPE_PATTERN.test(value);
}

/** True only for types this catalogue describes. */
export function isCataloguedEntityType(value: string): boolean {
  return BY_TYPE.has(value);
}

/** True when detecting `type` requires the NER service. */
export function needsNer(type: string): boolean {
  return !LOCALLY_DETECTED_TYPES.has(type);
}

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * The comparison form of a value: two mentions with the same normalised form
 * are the same entity and share a placeholder.
 *
 * `4111-1111-1111-1111` and `4111 1111 1111 1111` are one card; `Ayesha Raza`
 * and `ayesha  raza's` are one person.
 */
export function normalizeEntityValue(type: string, value: string): string {
  switch (entityDefinition(type).normalization) {
    case 'digits': {
      const digits = value.replace(/\D/g, '');
      return digits.length > 0 ? digits : value.trim().toLowerCase();
    }
    case 'alphanumeric':
      return value.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
    case 'lowercase':
      return value.trim().toLowerCase();
    case 'text':
    default:
      return normalizeText(value);
  }
}

/** Case- and spacing-insensitive form, with a trailing possessive removed. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]s$/u, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Name tokens used to link partial mentions ("Raza", "A. Raza") to a full
 * one ("Ayesha Raza"). Initials are dropped: they carry too little to link on.
 */
export function nameTokens(value: string): string[] {
  return normalizeText(value)
    .split(/[\s.-]+/u)
    .filter((token) => token.length >= 2);
}
