/**
 * Placeholder syntax: `[TYPE_N]`, e.g. `[PERSON_1]`, `[EMAIL_ADDRESS_2]`.
 *
 * Numbered rather than generic (`[PERSON]`) so that two different people stay
 * two different people to the model: "[PERSON_1] reports to [PERSON_2]" can be
 * reasoned about; "[PERSON] reports to [PERSON]" cannot.
 *
 * Models do not always copy a placeholder exactly. Small models in particular
 * write `[Person_1]`, `[PERSON 1]` or `[ PERSON_1 ]`. Parsing is therefore
 * tolerant of case, spacing and the separator; the canonical form is what the
 * vault is keyed by.
 */

/** Longest text a placeholder can plausibly occupy, used to bound stream buffering. */
export const MAX_PLACEHOLDER_LENGTH = 64;

const PLACEHOLDER_SOURCE = String.raw`\[\s*([A-Za-z][A-Za-z_\s-]*?)[\s_-]*(\d{1,4})\s*\]`;

/** A fresh global matcher for placeholders (never shared: `lastIndex` is state). */
export function placeholderMatcher(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, 'g');
}

/**
 * Every prefix of a placeholder, and nothing that could not become one. Used
 * by the streaming unmasker to decide how much of a chunk it must hold back.
 */
export const PLACEHOLDER_PREFIX = /^\[\s*(?:[A-Za-z][A-Za-z_\s-]*)?(?:\d{1,4})?\s*$/;

export function formatPlaceholder(entityType: string, ordinal: number): string {
  return `[${entityType}_${ordinal}]`;
}

/** The canonical form of a (possibly mangled) placeholder's parts. */
export function canonicalPlaceholder(
  rawType: string,
  rawOrdinal: string,
): {
  entityType: string;
  placeholder: string;
} {
  const entityType = rawType
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return {
    entityType,
    placeholder: formatPlaceholder(entityType, Number.parseInt(rawOrdinal, 10)),
  };
}

/**
 * Defuses placeholder-shaped text that was already in an input.
 *
 * A document that happens to contain "[PERSON_1]" — or one written to contain
 * it — would otherwise collide with a placeholder the engine assigns, and the
 * model's output would be unmasked to the wrong value. Such text has its
 * brackets turned into parentheses before masking, so every bracketed
 * placeholder the model sees was put there by the engine.
 */
export function neutralizePlaceholders(
  text: string,
  isEntityType: (type: string) => boolean,
): string {
  return text.replace(
    placeholderMatcher(),
    (match: string, rawType: string, rawOrdinal: string) =>
      isEntityType(canonicalPlaceholder(rawType, rawOrdinal).entityType)
        ? `(${match.slice(1, -1)})`
        : match,
  );
}
