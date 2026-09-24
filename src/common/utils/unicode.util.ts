/**
 * Unicode handling for text that is scanned for personal data.
 *
 * Two problems, both of which silently defeat a PII detector if ignored.
 *
 * **Evasion.** A card number written with full-width digits
 * (`４１１１ １１１１…`), or with zero-width spaces between its digits, reads
 * perfectly well to a language model and matches no ASCII-digit pattern. So
 * does a name with a soft hyphen in it. {@link canonicalizeText} folds these
 * variants to one canonical form *before* detection, and the canonical form is
 * what is sent to the model — so what the detector checked and what the model
 * reads are the same characters.
 *
 * **Offsets.** Presidio is Python, and Python indexes strings by code point.
 * JavaScript indexes them by UTF-16 code unit. On any text containing a
 * character outside the Basic Multilingual Plane — most emoji — the two
 * disagree, and a span reported as `[10, 20)` masks the wrong characters.
 * {@link codePointOffsetMapper} converts between them.
 */

/**
 * Invisible formatting characters: zero-width spaces and joiners, bidi
 * controls, soft hyphens, the BOM, and the rest of Unicode category Cf.
 * Removing the bidi controls also closes the "Trojan Source" class of tricks,
 * where text displays differently from how it is stored.
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. */
const UNICODE_LINE_BREAKS = /[\u2028\u2029]/g;

/**
 * NFKC-normalises, strips invisible formatting characters and normalises line
 * breaks.
 *
 * NFKC folds compatibility variants: full-width letters and digits, ligatures,
 * superscripts, the non-breaking space. The result means the same thing to a
 * reader — and to a model — while giving pattern recognizers one form to match.
 */
export function canonicalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(FORMAT_CHARACTERS, '')
    .replace(/\r\n?/g, '\n')
    .replace(UNICODE_LINE_BREAKS, '\n');
}

/** True when `text` contains a surrogate pair, i.e. a non-BMP character. */
function hasSurrogates(text: string): boolean {
  return /[\uD800-\uDBFF]/.test(text);
}

/**
 * Returns a function mapping a code-point offset in `text` to the equivalent
 * UTF-16 offset. Offsets past the end clamp to `text.length`.
 *
 * The common case — no characters outside the BMP — is the identity and
 * allocates nothing.
 */
export function codePointOffsetMapper(text: string): (codePointOffset: number) => number {
  if (!hasSurrogates(text)) {
    return (offset) => Math.max(0, Math.min(offset, text.length));
  }

  const utf16ByCodePoint: number[] = [];
  let utf16 = 0;
  for (const character of text) {
    utf16ByCodePoint.push(utf16);
    utf16 += character.length;
  }
  utf16ByCodePoint.push(utf16);

  return (offset) => {
    if (offset <= 0) return 0;
    if (offset >= utf16ByCodePoint.length) return text.length;
    return utf16ByCodePoint[offset];
  };
}

/** Number of code points in `text`, which is what a Python peer calls its length. */
export function codePointLength(text: string): number {
  return hasSurrogates(text) ? Array.from(text).length : text.length;
}
