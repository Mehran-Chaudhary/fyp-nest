import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * HMAC request signing for backend → AI service calls.
 *
 * The AI service performs work on behalf of every tenant and must not accept
 * requests from anyone else. A static bearer token would authenticate the
 * caller but protect nothing else: a captured request could be replayed, and
 * its body altered in flight by anything that terminates TLS in between (a
 * misconfigured proxy, a service mesh sidecar). The signature covers the
 * method, the exact path and query, a timestamp, a single-use nonce and a hash
 * of the body, so the AI service can verify all of:
 *
 *  - **who** sent it (only holders of the secret can produce the MAC),
 *  - **what** was sent (any byte changed in the path, query or body breaks it),
 *  - **when** (requests older than the tolerance window are refused), and
 *  - **once** (a nonce seen within the window is refused as a replay).
 *
 * Phase 5 layers mutual TLS underneath; this remains as defence in depth and
 * because it survives TLS termination at a load balancer, which mTLS does not.
 *
 * The scheme is specified in `docs/contracts/ai-service-v1.md`, with a Python
 * reference verifier.
 */

export const SIGNATURE_SCHEME = 'DAIAP-HMAC-SHA256';

export const SIGNING_HEADER = {
  KEY_ID: 'x-daiap-key-id',
  TIMESTAMP: 'x-daiap-timestamp',
  NONCE: 'x-daiap-nonce',
  CONTENT_SHA256: 'x-daiap-content-sha256',
  SIGNATURE: 'x-daiap-signature',
} as const;

/** How far apart the two clocks may drift before a signature is refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SigningInput {
  method: string;
  /** Path plus query string exactly as transmitted, e.g. `/v1/embeddings?x=1`. */
  pathAndQuery: string;
  body: Buffer | null;
  secret: string;
  keyId: string;
  /** Injected for tests; defaults to now. */
  timestamp?: number;
  /** Injected for tests; defaults to a random UUID. */
  nonce?: string;
}

export function sha256Hex(body: Buffer | null): string {
  return createHash('sha256')
    .update(body ?? Buffer.alloc(0))
    .digest('hex');
}

/** The exact byte string that is MACed. Both sides must build it identically. */
export function canonicalRequest(
  method: string,
  pathAndQuery: string,
  timestamp: number,
  nonce: string,
  contentSha256: string,
): string {
  return [
    SIGNATURE_SCHEME,
    method.toUpperCase(),
    pathAndQuery,
    String(timestamp),
    nonce,
    contentSha256,
  ].join('\n');
}

/** Produces the headers to attach to a request. */
export function signRequest(input: SigningInput): Record<string, string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomUUID();
  const contentSha256 = sha256Hex(input.body);

  const signature = createHmac('sha256', input.secret)
    .update(
      canonicalRequest(input.method, input.pathAndQuery, timestamp, nonce, contentSha256),
    )
    .digest('hex');

  return {
    [SIGNING_HEADER.KEY_ID]: input.keyId,
    [SIGNING_HEADER.TIMESTAMP]: String(timestamp),
    [SIGNING_HEADER.NONCE]: nonce,
    [SIGNING_HEADER.CONTENT_SHA256]: contentSha256,
    [SIGNING_HEADER.SIGNATURE]: `v1=${signature}`,
  };
}

/**
 * Verifies a signature. The backend never receives signed requests; this is the
 * reference implementation the contract document mirrors in Python, and what
 * the tests use to prove sign and verify agree.
 */
export function verifySignature(input: {
  method: string;
  pathAndQuery: string;
  body: Buffer | null;
  headers: Record<string, string | undefined>;
  secret: string;
  nowSeconds?: number;
}): { valid: true } | { valid: false; reason: string } {
  const timestamp = Number(input.headers[SIGNING_HEADER.TIMESTAMP]);
  const nonce = input.headers[SIGNING_HEADER.NONCE];
  const presented = input.headers[SIGNING_HEADER.SIGNATURE];
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!Number.isInteger(timestamp) || !nonce || !presented?.startsWith('v1=')) {
    return { valid: false, reason: 'missing or malformed signing headers' };
  }

  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp outside tolerance window' };
  }

  const contentSha256 = sha256Hex(input.body);
  if (input.headers[SIGNING_HEADER.CONTENT_SHA256] !== contentSha256) {
    return { valid: false, reason: 'body hash mismatch' };
  }

  const expected = createHmac('sha256', input.secret)
    .update(
      canonicalRequest(input.method, input.pathAndQuery, timestamp, nonce, contentSha256),
    )
    .digest();
  const actual = Buffer.from(presented.slice(3), 'hex');

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
}
