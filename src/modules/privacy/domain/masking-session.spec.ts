import { inspect } from 'node:util';
import { MaskingSession, prepareText, type MaskingPolicy } from './masking-session';
import { PiiVault } from './pii-vault';
import { BUILT_IN_RECOGNIZERS, CustomTermsRecognizer, runRecognizers } from './recognizers';
import type { DetectedSpan } from './spans';
import { StreamingUnmasker } from './stream-unmasker';

/**
 * The mask and unmask stages of the PII engine.
 *
 * Names come from a scripted "NER" (a fixed list, the way a model would tag
 * them), everything else from the real pattern recognizers — the same split
 * as production.
 */

const ENABLED = new Set([
  'PERSON',
  'LOCATION',
  'ORGANIZATION',
  'EMAIL_ADDRESS',
  'PHONE_NUMBER',
  'CREDIT_CARD',
  'IBAN_CODE',
  'PK_CNIC',
  'SALARY',
  'CREDENTIAL',
  'CUSTOM',
]);

function policy(overrides: Partial<MaskingPolicy> = {}): MaskingPolicy {
  return {
    enabledTypes: ENABLED,
    scoreThreshold: 0.5,
    allowList: [],
    recognizers: BUILT_IN_RECOGNIZERS,
    ...overrides,
  };
}

/** A stand-in NER model: tags every occurrence of the names it "knows" in `found`. */
function ner(text: string, names: string[], type = 'PERSON'): DetectedSpan[] {
  const spans: DetectedSpan[] = [];
  for (const name of names) {
    let from = 0;
    for (let at = text.indexOf(name, from); at !== -1; at = text.indexOf(name, from)) {
      spans.push({
        entityType: type,
        start: at,
        end: at + name.length,
        score: 0.85,
        source: 'ner',
        recognizer: 'test-ner',
      });
      from = at + name.length;
    }
  }
  return spans;
}

function patterns(text: string, session: MaskingPolicy = policy()): DetectedSpan[] {
  return runRecognizers(session.recognizers, text, session.enabledTypes).map((match) => ({
    ...match,
    source: 'pattern',
  }));
}

function detectAll(
  texts: string[],
  names: string[][] = [],
  p = policy(),
): DetectedSpan[][] {
  return texts.map((text, index) => [
    ...patterns(text, p),
    ...ner(text, names[index] ?? []),
  ]);
}

const HR_RECORD =
  'Employee: Ayesha Raza. Email ayesha.raza@acme.test, mobile 0300-1234567. ' +
  'CNIC 35202-1234567-1. Salary PKR 950,000 per year, paid to PK36SCBL0000001123456702. ' +
  'Corporate card 4111 1111 1111 1111.';

const SENSITIVE_VALUES = [
  'Ayesha Raza',
  'ayesha.raza@acme.test',
  '0300-1234567',
  '35202-1234567-1',
  '950,000',
  'PK36SCBL0000001123456702',
  '4111 1111 1111 1111',
];

describe('MaskingSession', () => {
  it('masks every sensitive value in a synthetic HR record', () => {
    const session = new MaskingSession(policy());
    const text = prepareText(HR_RECORD);
    const [masked] = session.mask(
      [{ id: 'doc', text }],
      detectAll([text], [['Ayesha Raza']]),
    );

    for (const value of SENSITIVE_VALUES) expect(masked.text).not.toContain(value);
    expect(masked.text).toContain('[PERSON_1]');
    expect(masked.text).toContain('[CREDIT_CARD_1]');
    expect(masked.text).toContain('[SALARY_1]');
    expect(session.findLeaks(masked.text)).toEqual([]);
  });

  it('restores the original text exactly when unmasking', () => {
    const session = new MaskingSession(policy());
    const text = prepareText(HR_RECORD);
    const [masked] = session.mask(
      [{ id: 'doc', text }],
      detectAll([text], [['Ayesha Raza']]),
    );

    expect(session.unmask(masked.text)).toBe(text);
    expect(session.unmaskStatistics().unresolved).toBe(0);
  });

  it('gives one value the same placeholder across every segment of a prompt', () => {
    const session = new MaskingSession(policy());
    const texts = [
      'Payroll: Ayesha Raza earns a salary of PKR 950,000.',
      'Previously discussed: Ayesha Raza joined in 2019.',
      'What does Ayesha Raza earn?',
    ].map(prepareText);
    const masked = session.mask(
      texts.map((text, index) => ({ id: String(index), text })),
      detectAll(texts, [['Ayesha Raza'], ['Ayesha Raza'], ['Ayesha Raza']]),
    );

    expect(masked.map((segment) => segment.text.includes('[PERSON_1]'))).toEqual([
      true,
      true,
      true,
    ]);
    expect(session.entityCount).toBe(2); // one person, one salary
  });

  it('keeps two different people apart', () => {
    const session = new MaskingSession(policy());
    const text = prepareText('Ayesha Raza reports to Imran Khan.');
    const [masked] = session.mask(
      [{ id: 'a', text }],
      [ner(text, ['Ayesha Raza', 'Imran Khan'])],
    );
    expect(masked.text).toBe('[PERSON_1] reports to [PERSON_2].');
  });

  it('links a partial mention to the one known person it belongs to', () => {
    const session = new MaskingSession(policy());
    const text = prepareText('Ayesha Raza was promoted. Raza now leads finance.');
    const [masked] = session.mask(
      [{ id: 'a', text }],
      [ner(text, ['Ayesha Raza', 'Raza'])],
    );
    expect(masked.text).toBe('[PERSON_1] was promoted. [PERSON_1] now leads finance.');
    expect(session.unmask('[PERSON_1]')).toBe('Ayesha Raza');
  });

  it('does not link an ambiguous partial mention', () => {
    const session = new MaskingSession(policy());
    const text = prepareText('Ayesha Raza and Imran Raza met. Raza spoke first.');
    const detections = ner(text, ['Ayesha Raza', 'Imran Raza']);
    const lone = text.lastIndexOf('Raza');
    detections.push({
      entityType: 'PERSON',
      start: lone,
      end: lone + 4,
      score: 0.85,
      source: 'ner',
      recognizer: 'test-ner',
    });

    const [masked] = session.mask([{ id: 'a', text }], [detections]);
    expect(masked.text).toBe('[PERSON_1] and [PERSON_2] met. [PERSON_3] spoke first.');
  });

  it('upgrades the unmasked value when a fuller name arrives later', () => {
    const session = new MaskingSession(policy());
    const text = prepareText('Raza signed. Later, Ayesha Raza confirmed.');
    const [masked] = session.mask(
      [{ id: 'a', text }],
      [ner(text, ['Ayesha Raza', 'Raza'])],
    );
    // The NER list tags "Raza" inside "Ayesha Raza" too; the merge keeps the full name.
    expect(masked.text).toBe('[PERSON_1] signed. Later, [PERSON_1] confirmed.');
    expect(session.unmask('[PERSON_1]')).toBe('Ayesha Raza');
  });

  it('propagates a name to mentions the detector missed, in any segment', () => {
    const session = new MaskingSession(policy());
    const texts = ['Ayesha Raza approved it.', 'Nobody told AYESHA RAZA about it.'].map(
      prepareText,
    );
    // The "model" only caught the first mention.
    const masked = session.mask(
      texts.map((text, index) => ({ id: String(index), text })),
      [ner(texts[0], ['Ayesha Raza']), []],
    );
    expect(masked[1].text).toBe('Nobody told [PERSON_1] about it.');
    expect(masked[1].spans[0].source).toBe('propagation');
  });

  it('propagates a salary to a bare mention with no salary context', () => {
    const session = new MaskingSession(policy());
    const texts = [
      'Her salary is PKR 950,000.',
      'The figure 950000 appears in the ledger.',
    ].map(prepareText);
    const masked = session.mask(
      texts.map((text, index) => ({ id: String(index), text })),
      detectAll(texts),
    );
    expect(masked[1].text).toBe('The figure [SALARY_1] appears in the ledger.');
  });

  it('does not propagate very short values', () => {
    const session = new MaskingSession(policy());
    const text = prepareText('Al met Alan. Al left.');
    const detections: DetectedSpan[] = [
      {
        entityType: 'PERSON',
        start: 0,
        end: 2,
        score: 0.85,
        source: 'ner',
        recognizer: 't',
      },
    ];
    const [masked] = session.mask([{ id: 'a', text }], [detections]);
    expect(masked.text).toBe('[PERSON_1] met Alan. Al left.');
  });

  it('respects the allow list', () => {
    const session = new MaskingSession(policy({ allowList: ['Acme Corporation'] }));
    const text = prepareText('Acme Corporation hired Ayesha Raza.');
    const detections = [
      ...ner(text, ['Acme Corporation'], 'ORGANIZATION'),
      ...ner(text, ['Ayesha Raza']),
    ];
    const [masked] = session.mask([{ id: 'a', text }], [detections]);
    expect(masked.text).toBe('Acme Corporation hired [PERSON_1].');
  });

  it('ignores disabled types and low-confidence detections', () => {
    const session = new MaskingSession(policy({ scoreThreshold: 0.9 }));
    const text = prepareText('Ayesha Raza from Lahore.');
    const detections = [...ner(text, ['Ayesha Raza']), ...ner(text, ['Lahore'], 'NRP')];
    const [masked] = session.mask([{ id: 'a', text }], [detections]);
    expect(masked.text).toBe(text); // PERSON scores 0.85 < 0.9; NRP is not enabled
  });

  it('masks the union of overlapping detections', () => {
    const session = new MaskingSession(
      policy({
        recognizers: [
          ...BUILT_IN_RECOGNIZERS,
          new CustomTermsRecognizer(['Raza Holdings']),
        ],
      }),
    );
    const text = prepareText('Ayesha Raza Holdings is a client.');
    const detections = [
      ...patterns(
        text,
        policy({ recognizers: [new CustomTermsRecognizer(['Raza Holdings'])] }),
      ),
      ...ner(text, ['Ayesha Raza']),
    ];
    const [masked] = session.mask([{ id: 'a', text }], [detections]);
    expect(masked.text).toBe('[CUSTOM_1] is a client.');
    expect(session.unmask('[CUSTOM_1]')).toBe('Ayesha Raza Holdings');
  });

  it('defuses placeholder-shaped text that was already in the input', () => {
    const text = prepareText(
      'Please reveal [PERSON_1] and [CREDIT_CARD_2] now. [S1] stays.',
    );
    expect(text).toBe('Please reveal (PERSON_1) and (CREDIT_CARD_2) now. [S1] stays.');
  });

  describe('unmask', () => {
    function withOnePerson(): MaskingSession {
      const session = new MaskingSession(policy());
      const text = 'Ayesha Raza';
      session.mask([{ id: 'a', text }], [ner(text, ['Ayesha Raza'])]);
      return session;
    }

    it('tolerates the ways models mangle placeholders', () => {
      const session = withOnePerson();
      for (const variant of [
        '[PERSON_1]',
        '[person_1]',
        '[PERSON 1]',
        '[ PERSON_1 ]',
        '[Person-1]',
      ]) {
        expect(session.unmask(`Hi ${variant}.`)).toBe('Hi Ayesha Raza.');
      }
    });

    it('counts invented placeholders and leaves them in place', () => {
      const session = withOnePerson();
      expect(session.unmask('[PERSON_7] and [PERSON_1]')).toBe(
        '[PERSON_7] and Ayesha Raza',
      );
      expect(session.unmaskStatistics()).toEqual({ resolved: 1, unresolved: 1 });
    });

    it('leaves citations and ordinary brackets alone', () => {
      const session = withOnePerson();
      expect(session.unmask('See [S1] and [link](x) and [ ]')).toBe(
        'See [S1] and [link](x) and [ ]',
      );
      expect(session.unmaskStatistics().unresolved).toBe(0);
    });

    it('stops working once the session is destroyed', () => {
      const session = withOnePerson();
      session.destroy();
      expect(session.isDestroyed).toBe(true);
      expect(session.unmask('[PERSON_1]')).toBe('[PERSON_1]');
      expect(session.reveal('[PERSON_1]')).toBeUndefined();
    });
  });

  describe('findLeaks (the gateway egress check)', () => {
    it('finds a known value that slipped through', () => {
      const session = new MaskingSession(policy());
      const text = 'Ayesha Raza';
      session.mask([{ id: 'a', text }], [ner(text, ['Ayesha Raza'])]);
      expect(session.findLeaks('Summarise the file on ayesha raza.')).toEqual([
        { entityType: 'PERSON', reason: 'known-value' },
      ]);
    });

    it('finds a pattern match even for a value the session never saw', () => {
      const session = new MaskingSession(policy());
      expect(session.findLeaks('card 5555 5555 5555 4444')).toEqual([
        { entityType: 'CREDIT_CARD', reason: 'pattern' },
      ]);
    });

    it('ignores what sits inside placeholders', () => {
      const session = new MaskingSession(policy());
      expect(session.findLeaks('[CREDIT_CARD_1] and [PERSON_2]')).toEqual([]);
    });

    it('respects the allow list and the threshold', () => {
      const session = new MaskingSession(policy({ allowList: ['0300-1234567'] }));
      expect(session.findLeaks('call 03001234567')).toEqual([]);
    });
  });

  it('summarises what was masked without revealing any value', () => {
    const session = new MaskingSession(policy());
    const text = prepareText(HR_RECORD);
    session.mask([{ id: 'doc', text }], detectAll([text], [['Ayesha Raza']]));
    const summary = session.summary();
    expect(summary.byType.CREDIT_CARD).toBe(1);
    expect(summary.byType.PERSON).toBe(1);
    expect(summary.entities).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(summary)).not.toContain('Ayesha');
  });

  it('never serialises its mapping', () => {
    const session = new MaskingSession(policy());
    const text = 'Ayesha Raza';
    session.mask([{ id: 'a', text }], [ner(text, ['Ayesha Raza'])]);
    expect(JSON.stringify({ session })).not.toContain('Ayesha');
  });
});

describe('PiiVault', () => {
  it('round-trips values and rejects swapped entries', () => {
    const vault = new PiiVault();
    vault.seal('[PERSON_1]', 'Ayesha Raza');
    expect(vault.open('[PERSON_1]')).toBe('Ayesha Raza');
    expect(vault.open('[PERSON_2]')).toBeUndefined();
  });

  it('serialises and inspects to an opaque marker', () => {
    const vault = new PiiVault();
    vault.seal('[PERSON_1]', 'Ayesha Raza');
    expect(JSON.stringify(vault)).toBe('"[PiiVault: sealed]"');
    expect(inspect(vault)).toBe('PiiVault <1 sealed>');
  });

  it('is unusable after destroy', () => {
    const vault = new PiiVault();
    vault.seal('[PERSON_1]', 'Ayesha Raza');
    vault.destroy();
    expect(vault.isDestroyed).toBe(true);
    expect(vault.size).toBe(0);
    expect(() => vault.seal('[X_1]', 'y')).toThrow(/destroyed/);
  });

  it('produces fingerprints that differ between vaults', () => {
    expect(new PiiVault().fingerprint('same')).not.toBe(new PiiVault().fingerprint('same'));
  });
});

describe('StreamingUnmasker', () => {
  /** Deterministic PRNG (mulberry32), so a failure is reproducible. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sessionWith(values: Record<string, string>): MaskingSession {
    const session = new MaskingSession(policy());
    const text = Object.values(values).join(' | ');
    const spans: DetectedSpan[] = [];
    let offset = 0;
    for (const [placeholder, value] of Object.entries(values)) {
      const type = placeholder.slice(1, placeholder.lastIndexOf('_'));
      spans.push({
        entityType: type,
        start: offset,
        end: offset + value.length,
        score: 1,
        source: 'ner',
        recognizer: 't',
      });
      offset += value.length + 3;
    }
    session.mask([{ id: 'seed', text }], [spans]);
    return session;
  }

  const session = sessionWith({
    '[PERSON_1]': 'Ayesha Raza',
    '[PERSON_2]': 'Imran Khan',
    '[EMAIL_ADDRESS_1]': 'ayesha.raza@acme.test',
  });

  const outputs = [
    '[PERSON_1] earns more than [PERSON_2]. Contact [EMAIL_ADDRESS_1].',
    'Markdown [link](http://x) and a list: [ ] todo, [x] done, [PERSON 2]!',
    '[[PERSON_1]] [PERSON_9] [S1] [S2] trailing [',
    "[person_1]'s manager is [ PERSON_2 ]; unmatched [PERSON_",
    'no placeholders at all',
    '',
  ];

  it('matches whole-text unmasking for every chunking', () => {
    const next = random(20260924);
    for (const output of outputs) {
      const expected = session.unmask(output);
      for (let trial = 0; trial < 300; trial += 1) {
        const unmasker = session.createStreamUnmasker();
        let streamed = '';
        let cursor = 0;
        while (cursor < output.length) {
          const size = 1 + Math.floor(next() * 7);
          streamed += unmasker.push(output.slice(cursor, cursor + size));
          cursor += size;
        }
        streamed += unmasker.flush();
        expect(streamed).toBe(expected);
      }
    }
  });

  it('never releases part of a placeholder', () => {
    const unmasker = session.createStreamUnmasker();
    const released = ['Hi ', '[PER', 'SON', '_1', ']', '!'].map((chunk) =>
      unmasker.push(chunk),
    );
    expect(released).toEqual(['Hi ', '', '', '', 'Ayesha Raza', '!']);
  });

  it('releases a bracket as soon as it cannot become a placeholder', () => {
    const unmasker = new StreamingUnmasker((text) => text);
    expect(unmasker.push('see [link')).toBe('see ');
    expect(unmasker.push('](url)')).toBe('[link](url)');
    expect(unmasker.push('[1.5')).toBe('[1.5');
    expect(unmasker.buffered).toBe(0);
  });
});

/**
 * Propagation and the egress check, as pinned down by the redaction benchmark
 * (docs/benchmarks/pii-redaction.md).
 */
describe('propagation and egress, benchmark regressions', () => {
  const salaryPolicy = () =>
    policy({ enabledTypes: new Set(['SALARY', 'CREDIT_CARD', 'PERSON', 'CUSTOM']) });
  const span = (text: string, value: string, entityType: string): DetectedSpan => {
    const start = text.indexOf(value);
    return {
      entityType,
      start,
      end: start + value.length,
      score: 0.9,
      source: 'pattern',
      recognizer: 'test',
    };
  };

  it('masks a known number however it is grouped', () => {
    const session = new MaskingSession(salaryPolicy());
    const text = prepareText(
      'Approved: PKR 950,000. Payroll shows 950000 and 9,50,000; ref 1950000 unchanged.',
    );
    const [masked] = session.mask(
      [{ id: 'a', text }],
      [[span(text, 'PKR 950,000', 'SALARY')]],
    );
    expect(masked.text).toBe(
      'Approved: [SALARY_1]. Payroll shows [SALARY_1] and [SALARY_1]; ref 1950000 unchanged.',
    );
    expect(session.findLeaks(masked.text)).toEqual([]);
  });

  it('does not spread a short number into years and references', () => {
    const session = new MaskingSession(salaryPolicy());
    const text = prepareText('The fee of USD 2,024 was agreed in 2024 under INV-2024-7.');
    const [masked] = session.mask(
      [{ id: 'a', text }],
      [[span(text, 'USD 2,024', 'SALARY')]],
    );
    expect(masked.text).toBe('The fee of [SALARY_1] was agreed in 2024 under INV-2024-7.');
    expect(session.unmask(masked.text)).toBe(text);
  });

  it('does not block a prompt because masking moved a context word closer', () => {
    const session = new MaskingSession(salaryPolicy());
    // In the original, "raise" is too far from the extension to make it a salary.
    const text = prepareText(
      `After the raise, see ${'x'.repeat(40)} Project Falcon notes. Ref: extension 8627.`,
    );
    const [masked] = session.mask(
      [{ id: 'a', text }],
      [[span(text, 'Project Falcon', 'CUSTOM')]],
    );
    expect(masked.text).toContain('extension 8627');
    expect(session.findLeaks(masked.text)).toEqual([]);
    // A structural leak still blocks.
    expect(session.findLeaks(`${masked.text} Card 4111 1111 1111 1111.`)).toEqual([
      { entityType: 'CREDIT_CARD', reason: 'pattern' },
    ]);
  });

  it('respects word boundaries beyond ASCII when propagating a name', () => {
    const session = new MaskingSession(salaryPolicy());
    const text = prepareText('Imran called. Imranë is a different word; so is Imran_bot.');
    const [masked] = session.mask(
      [{ id: 'a', text }],
      [[{ ...span(text, 'Imran', 'PERSON'), source: 'ner' }]],
    );
    expect(masked.text).toBe(
      '[PERSON_1] called. Imranë is a different word; so is Imran_bot.',
    );
  });
});
