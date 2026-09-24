import { encodeDocument, encodeQuery, hashToken, tokenize } from './sparse-encoder';
import { matchAny, matchesFilter, matchValue } from './vector-filter';

describe('BM25 sparse encoder', () => {
  it('normalises case and drops stopwords and punctuation', () => {
    expect(tokenize('The Annual-Leave policy, for ALL staff!')).toEqual([
      'annual',
      'leave',
      'policy',
      'staff',
    ]);
  });

  it('keeps identifiers and numbers, which dense embeddings handle poorly', () => {
    expect(tokenize('Invoice INV-2024-0117 and policy HR 7.3')).toEqual(
      expect.arrayContaining(['invoice', 'inv', '2024', '0117', 'hr']),
    );
  });

  it('tokenises non-Latin scripts', () => {
    expect(tokenize('ملازمین کی چھٹی').length).toBeGreaterThan(0);
  });

  it('folds compatibility forms (NFKC)', () => {
    expect(tokenize('ＦＵＬＬ ｗｉｄｔｈ')).toEqual(tokenize('full width'));
  });

  it('hashes tokens deterministically into 32-bit indices', () => {
    expect(hashToken('salary')).toBe(hashToken('salary'));
    expect(hashToken('salary')).not.toBe(hashToken('salaries'));
    expect(hashToken('salary')).toBeGreaterThanOrEqual(0);
    expect(hashToken('salary')).toBeLessThan(2 ** 32);
  });

  it('produces sorted, unique indices', () => {
    const { indices } = encodeDocument('leave leave policy annual leave');
    expect(new Set(indices).size).toBe(indices.length);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it('saturates term frequency, as BM25 requires', () => {
    const once = encodeDocument('leave');
    const many = encodeDocument(Array(50).fill('leave').join(' '));
    const k1 = 1.2;
    expect(many.values[0]).toBeGreaterThan(once.values[0]);
    // tf·(k1+1)/(tf+k1·…) is bounded above by k1+1.
    expect(many.values[0]).toBeLessThan(k1 + 1);
  });

  it('weights a term lower in a longer document', () => {
    const short = encodeDocument('leave policy');
    const long = encodeDocument(`leave ${Array(500).fill('filler').join(' ')}`);
    const index = hashToken('leave');
    const valueIn = (vector: { indices: number[]; values: number[] }) =>
      vector.values[vector.indices.indexOf(index)];
    expect(valueIn(long)).toBeLessThan(valueIn(short));
  });

  it('gives each distinct query term weight 1, leaving IDF to the vector store', () => {
    const query = encodeQuery('leave leave policy');
    expect(query.values).toEqual([1, 1]);
  });

  it('yields an empty vector for text with no terms', () => {
    expect(encodeDocument('the and of')).toEqual({ indices: [], values: [] });
    expect(encodeQuery('?!')).toEqual({ indices: [], values: [] });
  });
});

describe('vector filter evaluator', () => {
  const payload = { organization_id: 'o', tags: ['a', 'b'], active: true };

  it('requires every must condition', () => {
    expect(
      matchesFilter(payload, {
        must: [matchValue('organization_id', 'o'), matchValue('active', true)],
      }),
    ).toBe(true);
    expect(
      matchesFilter(payload, {
        must: [matchValue('organization_id', 'o'), matchValue('active', false)],
      }),
    ).toBe(false);
  });

  it('rejects on any must_not condition', () => {
    expect(matchesFilter(payload, { must_not: [matchValue('organization_id', 'o')] })).toBe(
      false,
    );
  });

  it('requires at least one should condition when present', () => {
    expect(
      matchesFilter(payload, {
        should: [matchValue('organization_id', 'x'), matchValue('active', true)],
      }),
    ).toBe(true);
    expect(matchesFilter(payload, { should: [matchValue('organization_id', 'x')] })).toBe(
      false,
    );
  });

  it('matches array-valued fields element-wise, like Qdrant', () => {
    expect(matchesFilter(payload, { must: [matchAny('tags', ['b', 'z'])] })).toBe(true);
    expect(matchesFilter(payload, { must: [matchValue('tags', 'z')] })).toBe(false);
  });

  it('evaluates nested filters', () => {
    expect(
      matchesFilter(payload, {
        must_not: [{ must: [matchValue('organization_id', 'o'), matchAny('tags', ['a'])] }],
      }),
    ).toBe(false);
  });

  it('never matches a missing field', () => {
    expect(matchesFilter(payload, { must: [matchValue('knowledge_base_id', 'kb')] })).toBe(
      false,
    );
  });

  it('never matches an empty allowlist', () => {
    expect(matchesFilter(payload, { must: [matchAny('organization_id', [])] })).toBe(false);
  });
});
