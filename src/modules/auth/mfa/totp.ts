import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) over HOTP (RFC 4226), the codes
 * every authenticator app (Google Authenticator, Microsoft Authenticator,
 * 1Password, Authy) produces. Implemented here rather than taken from a
 * dependency: it is forty lines over `node:crypto`, and a second-factor
 * implementation is exactly where supply-chain surface should be smallest.
 *
 * Parameters are the ones every app supports without configuration: SHA-1,
 * six digits, a 30-second step. (SHA-1's collision weakness is irrelevant to
 * HMAC; RFC 6238 still specifies it as the interoperable default.)
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now, for clock drift between phone and server. */
export const TOTP_WINDOW = 1;
/** 160 bits: the secret length RFC 4226 recommends. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded — the encoding authenticator apps expect. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Decodes base32, tolerating lower case, spaces, hyphens and padding. */
export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('Invalid base32 character.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A fresh secret, base32-encoded for the authenticator app. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** HOTP (RFC 4226 §5.3): dynamic truncation of HMAC(secret, counter). */
export function hotp(
  secret: Buffer,
  counter: bigint,
  digits = TOTP_DIGITS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac(algorithm, secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP time step containing `timeMs`. */
export function totpStep(timeMs: number, stepSeconds = TOTP_STEP_SECONDS): bigint {
  return BigInt(Math.floor(timeMs / 1000 / stepSeconds));
}

/** The code for a given moment (for tests and for showing a sample code). */
export function totpAt(secretBase32: string, timeMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), totpStep(timeMs), digits);
}

/**
 * The step `code` matches within the drift window, or null.
 *
 * Every candidate is compared, in constant time, whatever matched first: the
 * response time must not reveal which step (if any) a guess hit. The caller
 * then refuses a step at or before the last one accepted, which is what makes
 * a code single-use.
 */
export function matchTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  window = TOTP_WINDOW,
): bigint | null {
  const candidate = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(candidate)) return null;

  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  const presented = Buffer.from(candidate);
  let matched: bigint | null = null;

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + BigInt(offset);
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, presented) && matched === null) matched = step;
  }
  return matched;
}

/**
 * The `otpauth://` URI authenticator apps import (usually from a QR code the
 * frontend renders). The issuer appears twice — as the label prefix and as a
 * parameter — as the de facto Key URI format asks.
 */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const parameters = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/**
 * A recovery code: ten characters from an alphabet without look-alikes,
 * shown as `xxxxx-xxxxx`. About 50 bits each — ample for a single-use code
 * that is also subject to the account lockout.
 */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateRecoveryCode(): string {
  let code = '';
  // randomInt is unbiased (rejection sampling), unlike `byte % alphabet.length`.
  for (let index = 0; index < 10; index += 1) {
    code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Canonical form for hashing: case and separators do not matter to a person typing it. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}
