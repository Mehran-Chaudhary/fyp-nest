import { randomBytes } from 'node:crypto';

/**
 * Slug helpers for human friendly, URL safe identifiers such as organization
 * slugs and role slugs.
 */

const MAX_SLUG_LENGTH = 60;

/**
 * Converts arbitrary text into a lowercase, hyphen separated slug.
 * Diacritics are folded to ASCII, so "Anwältin GmbH" becomes "anwaltin-gmbh".
 */
export function slugify(input: string, maxLength: number = MAX_SLUG_LENGTH): string {
  return input
    .normalize('NFKD')
    // Strip the combining diacritical marks left behind by NFKD normalisation.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * Produces a slug guaranteed to be usable. Inputs that slugify to nothing (an
 * organization named entirely in a non-Latin script, for example) fall back to a
 * random suffix rather than failing the request.
 */
export function slugifyOrRandom(input: string, prefix = 'org'): string {
  const slug = slugify(input);
  return slug.length >= 2 ? slug : `${prefix}-${randomBytes(4).toString('hex')}`;
}

/**
 * Appends a short random discriminator, used when the desired slug is taken.
 * Kept short so the resulting URLs stay readable.
 */
export function withRandomSuffix(slug: string, bytes = 3): string {
  const suffix = randomBytes(bytes).toString('hex');
  const room = MAX_SLUG_LENGTH - suffix.length - 1;
  return `${slug.slice(0, Math.max(room, 1))}-${suffix}`;
}

/** Slugs the platform reserves for its own routes and must never hand to a tenant. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'dashboard',
  'docs',
  'health',
  'internal',
  'login',
  'logout',
  'metrics',
  'new',
  'platform',
  'public',
  'register',
  'root',
  'settings',
  'signup',
  'static',
  'status',
  'support',
  'system',
  'www',
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
