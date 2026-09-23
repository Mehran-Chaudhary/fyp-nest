#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Generates cryptographically strong values for the platform's signing and
 * encryption secrets.
 *
 *   npm run generate:secrets            print to stdout
 *   npm run generate:secrets -- --write append any missing keys to .env
 *
 * This exists because the alternative — asking people to "put a long random
 * string here" — reliably produces secrets that are neither long nor random.
 * Every value below is 32 bytes from the OS CSPRNG.
 *
 * Deliberately plain JavaScript with no imports beyond node:crypto, so it runs
 * before `npm install` has finished and cannot itself become a supply-chain
 * concern.
 */

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEYS = [
  {
    key: 'JWT_ACCESS_SECRET',
    comment: 'Signs short-lived access tokens.',
  },
  {
    key: 'JWT_REFRESH_SECRET',
    comment: 'Signs refresh tokens. MUST differ from the access secret.',
  },
  {
    key: 'ENCRYPTION_KEY',
    comment: 'AES-256-GCM key for encrypted columns. Rotating it orphans existing ciphertext.',
  },
  {
    key: 'AUDIT_HASH_SECRET',
    comment: 'HMAC key for the audit log hash chain. Rotating it invalidates verification.',
  },
  {
    key: 'PASSWORD_PEPPER',
    comment: 'Optional. Mixed into every password hash. Rotating it invalidates all passwords.',
  },
  {
    key: 'COOKIE_SECRET',
    comment: 'Signs cookies. Falls back to JWT_ACCESS_SECRET when unset.',
  },
];

function generate() {
  return randomBytes(32).toString('base64url');
}

function main() {
  const shouldWrite = process.argv.includes('--write');
  const envPath = path.resolve(process.cwd(), '.env');

  const generated = SECRET_KEYS.map((entry) => ({ ...entry, value: generate() }));

  if (!shouldWrite) {
    console.log('');
    console.log('# Generated secrets — copy into your .env file.');
    console.log('# Each value is 32 bytes from the OS CSPRNG (256 bits of entropy).');
    console.log('');
    for (const entry of generated) {
      console.log(`# ${entry.comment}`);
      console.log(`${entry.key}=${entry.value}`);
      console.log('');
    }
    console.log('# Re-run with --write to append the missing ones to .env automatically.');
    console.log('');
    return;
  }

  const exists = fs.existsSync(envPath);
  const current = exists ? fs.readFileSync(envPath, 'utf8') : '';

  // Only append keys that are genuinely absent. Overwriting a live
  // AUDIT_HASH_SECRET would make every existing audit record unverifiable, and
  // overwriting PASSWORD_PEPPER would lock every user out — so this script never
  // replaces a value it did not write.
  const missing = generated.filter(
    (entry) => !new RegExp(`^${entry.key}=`, 'm').test(current),
  );

  if (missing.length === 0) {
    console.log('All secrets are already present in .env. Nothing to do.');
    console.log('To rotate one deliberately, delete the line and re-run this script.');
    return;
  }

  const block = [
    '',
    '# ─── Generated secrets ' + '─'.repeat(50),
    `# Written by scripts/generate-secrets.js on ${new Date().toISOString()}`,
    '',
    ...missing.flatMap((entry) => [`# ${entry.comment}`, `${entry.key}=${entry.value}`, '']),
  ].join('\n');

  fs.appendFileSync(envPath, block, 'utf8');

  console.log(`Appended ${missing.length} secret(s) to ${envPath}:`);
  for (const entry of missing) {
    console.log(`  ${entry.key}`);
  }
  console.log('');
  console.log('Make sure .env is git-ignored. It is, in this repository.');
}

main();
