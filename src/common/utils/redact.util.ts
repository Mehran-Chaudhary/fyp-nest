/**
 * Structural redaction helpers.
 *
 * Every log line, audit record and error payload the platform emits passes
 * through this module. The platform's value proposition is that sensitive
 * enterprise data never leaks, and observability pipelines are one of the most
 * common accidental exfiltration paths, so redaction is applied by default and
 * opted out of explicitly rather than the other way around.
 *
 * Note that this is *structural* redaction (key-name based). The semantic,
 * NLP-driven PII Redaction Engine described in the proposal operates on
 * free-form text and arrives in a later phase; the two are complementary.
 */

export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'password',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'passwordhash',
  'pwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'api_key',
  'apisecret',
  'clientsecret',
  'privatekey',
  'authorization',
  'cookie',
  'set-cookie',
  'setcookie',
  'sessionid',
  'otp',
  'mfasecret',
  'totpsecret',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
  'encryptionkey',
  'pepper',
];

export const REDACTED_PLACEHOLDER = '[REDACTED]';

const MAX_DEPTH = 8;

/**
 * Returns a structurally identical copy of `value` with any property whose name
 * matches a sensitive key replaced by a placeholder.
 *
 * The traversal is depth limited and cycle safe so that a hostile or merely
 * unusual payload cannot turn logging into a denial of service.
 */
export function deepRedact<T>(
  value: T,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): T {
  const keySet = new Set(sensitiveKeys.map((key) => key.toLowerCase()));
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;
    if (depth > MAX_DEPTH) return '[TRUNCATED]';

    if (Array.isArray(input)) {
      if (seen.has(input)) return '[CIRCULAR]';
      seen.add(input);
      return input.map((item) => walk(item, depth + 1));
    }

    if (input instanceof Date) return input;
    if (input instanceof Error) {
      return { name: input.name, message: input.message };
    }
    if (Buffer.isBuffer(input)) return `[Buffer ${input.length} bytes]`;

    if (typeof input === 'object') {
      if (seen.has(input)) return '[CIRCULAR]';
      seen.add(input);

      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(input as Record<string, unknown>)) {
        output[key] = keySet.has(key.toLowerCase())
          ? REDACTED_PLACEHOLDER
          : walk(nested, depth + 1);
      }
      return output;
    }

    return input;
  };

  return walk(value, 0) as T;
}

/**
 * Masks the middle of a string, preserving a short prefix and suffix so a human
 * can still correlate the value (matching an API key to its dashboard entry, for
 * example) without the value itself being recoverable from the log.
 */
export function maskSecret(value: string, visiblePrefix = 4, visibleSuffix = 2): string {
  if (!value) return '';
  if (value.length <= visiblePrefix + visibleSuffix) return REDACTED_PLACEHOLDER;
  return `${value.slice(0, visiblePrefix)}${'*'.repeat(8)}${value.slice(-visibleSuffix)}`;
}

/** Masks an email as `jo****@example.com`, keeping the domain for support triage. */
export function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0) return REDACTED_PLACEHOLDER;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));

  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 2))}${domain}`;
}
