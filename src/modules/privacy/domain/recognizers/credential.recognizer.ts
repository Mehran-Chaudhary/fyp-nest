import { matchesOf, type PatternRecognizer, type RecognizerMatch } from './recognizer';

interface CredentialPattern {
  label: string;
  pattern: RegExp;
  score: number;
  /** Mask only this capture group, e.g. the value after "password:". */
  group?: number;
}

/**
 * Secrets pasted into a chat or buried in a document: access keys, tokens,
 * private keys.
 *
 * Not personal data in the GDPR sense, but exactly the kind of thing that must
 * never reach a model's logs. Every pattern is a vendor's documented key
 * format, so precision is high; the generic "password: …" rule masks only the
 * value, leaving the sentence readable.
 */
const PATTERNS: readonly CredentialPattern[] = [
  {
    label: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g,
    score: 0.95,
  },
  { label: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, score: 0.95 },
  {
    label: 'github-fine-grained',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g,
    score: 0.95,
  },
  { label: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, score: 0.9 },
  {
    label: 'stripe-key',
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    score: 0.95,
  },
  { label: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, score: 0.9 },
  {
    label: 'openai-style-key',
    pattern: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/g,
    score: 0.85,
  },
  {
    label: 'platform-api-key',
    pattern: /\b[a-z]{2,16}_sk_[A-Za-z0-9_-]{20,}\b/g,
    score: 0.95,
  },
  {
    label: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    score: 0.9,
  },
  {
    label: 'private-key',
    pattern:
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]{16,16384}?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
    score: 1,
  },
  {
    label: 'connection-string',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/]+:([^\s@/]{3,})@/gi,
    score: 0.95,
    group: 1,
  },
  {
    label: 'assignment',
    pattern:
      /\b(?:password|passwd|pwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?([^\s"',;]{6,200})/gi,
    score: 0.8,
    group: 1,
  },
];

export class CredentialRecognizer implements PatternRecognizer {
  readonly name = 'credential';
  readonly entityTypes = ['CREDENTIAL'] as const;

  recognize(text: string): RecognizerMatch[] {
    const found: RecognizerMatch[] = [];

    for (const { pattern, score, group } of PATTERNS) {
      for (const match of matchesOf(pattern, text)) {
        if (group === undefined) {
          found.push({
            entityType: 'CREDENTIAL',
            start: match.index,
            end: match.index + match[0].length,
            score,
          });
          continue;
        }

        const value = match[group];
        if (!value) continue;
        const start = match.index + match[0].lastIndexOf(value);
        found.push({ entityType: 'CREDENTIAL', start, end: start + value.length, score });
      }
    }

    return found;
  }
}
