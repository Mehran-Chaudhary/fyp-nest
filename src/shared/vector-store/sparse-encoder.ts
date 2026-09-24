/**
 * BM25 sparse vectors for hybrid retrieval.
 *
 * Dense embeddings are good at meaning and bad at exact tokens. Ask about
 * "invoice INV-2024-0117" or "policy HR-7.3" and a dense retriever finds
 * passages *about invoices* or *about policies*; the one passage containing the
 * literal identifier may rank nowhere. Lexical scoring is the opposite. Hybrid
 * retrieval runs both and fuses the rankings (reciprocal rank fusion, performed
 * by Qdrant), and consistently beats either alone on enterprise documents —
 * which are dense with codes, names and figures.
 *
 * ## How BM25 maps onto sparse vectors
 *
 *     score(q, d) = Σ_{t ∈ q}  IDF(t) · tf(t,d)·(k1+1) / (tf(t,d) + k1·(1 − b + b·|d|/avgdl))
 *
 * The document-side factor depends only on the document, so it is computed here
 * and stored as the sparse vector's values. IDF depends on the whole corpus, so
 * it is computed by Qdrant at query time (`modifier: idf` on the sparse vector
 * field) from its own statistics — which are therefore always current as
 * documents come and go. The query vector is just the set of query terms with
 * weight 1; the dot product then yields exactly the BM25 sum.
 *
 * This is the scheme Qdrant documents for BM25, and runs entirely in this
 * process: lexical retrieval keeps working even when the AI service is down.
 *
 * ## Tokens to indices
 *
 * Terms are mapped to 32-bit indices with FNV-1a rather than a vocabulary. A
 * vocabulary would have to be built, stored, versioned and shared; hashing needs
 * none of that. Collisions merge two rare terms into one dimension, which at
 * 2³² buckets is statistically negligible for a workspace's vocabulary.
 */

export interface SparseVector {
  indices: number[];
  values: number[];
}

export interface Bm25Options {
  /** Term-frequency saturation. 1.2 is the standard default. */
  k1: number;
  /** Length normalisation strength. 0.75 is the standard default. */
  b: number;
  /**
   * Assumed mean document length, in tokens. A constant rather than a corpus
   * statistic, so vectors never need recomputing as the corpus grows; chunks
   * are near-uniform in length by construction, so the approximation is close.
   */
  averageLength: number;
}

export const DEFAULT_BM25: Bm25Options = { k1: 1.2, b: 0.75, averageLength: 256 };

const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_LENGTH = 40;

/** Common English function words. They carry no retrieval signal and dominate term counts. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being ' +
    'below between both but by can could did do does doing down during each few for from further ' +
    'had has have having he her here hers herself him himself his how i if in into is it its ' +
    'itself just me more most my myself no nor not now of off on once only or other our ours ' +
    'ourselves out over own same she should so some such than that the their theirs them ' +
    'themselves then there these they this those through to too under until up very was we were ' +
    'what when where which while who whom why will with would you your yours yourself yourselves'
  ).split(' '),
);

/**
 * Splits text into normalised terms.
 *
 * NFKC folds compatibility forms (full-width digits, ligatures) so that
 * visually identical text tokenises identically. Letters and digits from every
 * script are kept, so non-English documents still get lexical matching even
 * though only English stopwords are removed.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const raw of text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.push(raw);
  }

  return tokens;
}

/** FNV-1a, 32-bit. Stable across processes, platforms and versions. */
export function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(token, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Counts terms per hashed index, sorted by index for a canonical form. */
function termFrequencies(tokens: string[]): Map<number, number> {
  const frequencies = new Map<number, number>();
  for (const token of tokens) {
    const index = hashToken(token);
    frequencies.set(index, (frequencies.get(index) ?? 0) + 1);
  }
  return new Map([...frequencies.entries()].sort(([a], [b]) => a - b));
}

/** Document-side BM25 vector for a chunk of text. */
export function encodeDocument(
  text: string,
  options: Bm25Options = DEFAULT_BM25,
): SparseVector {
  const tokens = tokenize(text);
  const length = tokens.length;
  const indices: number[] = [];
  const values: number[] = [];

  if (length === 0) return { indices, values };

  const normaliser =
    options.k1 * (1 - options.b + (options.b * length) / options.averageLength);

  for (const [index, frequency] of termFrequencies(tokens)) {
    indices.push(index);
    values.push((frequency * (options.k1 + 1)) / (frequency + normaliser));
  }

  return { indices, values };
}

/**
 * Query-side vector: each distinct term once, weight 1. Qdrant supplies IDF, so
 * repeating a word in a query does not make it count more — matching BM25.
 */
export function encodeQuery(text: string): SparseVector {
  const indices = [...termFrequencies(tokenize(text)).keys()];
  return { indices, values: indices.map(() => 1) };
}
