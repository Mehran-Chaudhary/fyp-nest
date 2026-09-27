/**
 * What may leave the platform in a trace (phase 5).
 *
 * Traces go to a third-party backend (Grafana Cloud, Honeycomb, Datadog…),
 * outside the platform's access control, so every span is sanitized on its
 * way out — whatever instrumentation created it:
 *
 *  - **URLs lose their query strings.** A query can carry a document's file
 *    name (the AI service's parse call), a member search term, a retrieval
 *    filter. Paths stay: they are routes and ids.
 *  - **Exception messages are scrubbed.** A database error can quote the
 *    value that violated a constraint (`Key (email)=(…) already exists`).
 *  - **Free-text attributes are bounded.** Nothing long enough to be a prompt.
 *
 * Pure functions, applied by the exporter wrapper in `tracing.ts`, and unit
 * tested on their own.
 */

const URL_ATTRIBUTES = new Set([
  'url.full',
  'http.url',
  'http.target',
  'url.query',
  'http.route.query',
]);

const SCRUBBED_TEXT_ATTRIBUTES = new Set([
  'exception.message',
  'exception.stacktrace',
  'db.statement',
  'db.query.text',
  'error.message',
]);

const MAX_ATTRIBUTE_LENGTH = 512;

/** Removes a URL's query and fragment. Accepts absolute URLs and bare paths. */
export function stripQuery(value: string): string {
  const end = value.search(/[?#]/);
  return end === -1 ? value : value.slice(0, end);
}

/**
 * Replaces values that look personal: email addresses, long digit runs (card,
 * phone and national ID numbers), and quoted SQL literals.
 */
export function scrubText(value: string): string {
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\(([^()]{1,200})\)=\(([^()]{0,500})\)/g, '($1)=([value])')
    .replace(/'(?:[^']|'')*'/g, "'[literal]'")
    .replace(/\d[\d\s-]{5,}\d/g, '[number]')
    .slice(0, MAX_ATTRIBUTE_LENGTH);
}

export type AttributeValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean | null | undefined>
  | undefined;

/** A sanitized copy of a span's (or event's) attributes. */
export function sanitizeAttributes(
  attributes: Readonly<Record<string, AttributeValue>>,
): Record<string, AttributeValue> {
  const clean: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'url.query') continue;
    if (typeof value === 'string') {
      if (URL_ATTRIBUTES.has(key)) clean[key] = stripQuery(value);
      else if (SCRUBBED_TEXT_ATTRIBUTES.has(key)) clean[key] = scrubText(value);
      else clean[key] = value.slice(0, MAX_ATTRIBUTE_LENGTH);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}
