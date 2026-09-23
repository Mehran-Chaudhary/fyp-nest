/**
 * IP address utilities backing the workspace-level IP allowlist described in
 * module 6.1 of the proposal ("IP-whitelisting at the workspace level").
 *
 * Everything here is dependency free and works on both IPv4 and IPv6 by
 * normalising each address to a BigInt, which makes CIDR containment a single
 * mask comparison regardless of family.
 */

export type IpFamily = 'ipv4' | 'ipv6';

export interface ParsedIp {
  value: bigint;
  family: IpFamily;
  bits: number;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Parses an IPv4 or IPv6 literal into a numeric representation.
 * Returns `null` for anything unparseable rather than throwing, because these
 * values routinely arrive from untrusted proxy headers.
 */
export function parseIp(input: string): ParsedIp | null {
  if (!input) return null;

  let address = input.trim();

  // Strip a bracketed IPv6 host and any :port suffix, and drop the zone index.
  if (address.startsWith('[')) {
    const closing = address.indexOf(']');
    if (closing > 0) address = address.slice(1, closing);
  }
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);

  // IPv4-mapped IPv6 (::ffff:192.0.2.1) is treated as the underlying IPv4 so
  // that an allowlist entry written as 192.0.2.0/24 behaves as an operator expects.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  if (mapped) address = mapped[1];

  const v4 = parseIpv4(address);
  if (v4 !== null) return { value: v4, family: 'ipv4', bits: 32 };

  const v6 = parseIpv6(address);
  if (v6 !== null) return { value: v6, family: 'ipv6', bits: 128 };

  return null;
}

function parseIpv4(address: string): bigint | null {
  const match = IPV4_PATTERN.exec(address);
  if (!match) return null;

  let value = 0n;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    // Reject leading zeros; "010" is ambiguous between decimal and octal and has
    // historically been used to bypass naive allowlist implementations.
    if (match[i].length > 1 && match[i].startsWith('0')) return null;
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(address: string): bigint | null {
  if (!address.includes(':')) return null;

  const doubleColonCount = (address.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];

  if (doubleColonCount === 1) {
    const [left, right] = address.split('::');
    head = left ? left.split(':') : [];
    tail = right ? right.split(':') : [];
  } else {
    head = address.split(':');
    tail = [];
  }

  // A trailing IPv4 literal (e.g. ::ffff:192.0.2.1) expands into two groups.
  const expand = (groups: string[]): string[] | null => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    if (!last.includes('.')) return groups;

    const v4 = parseIpv4(last);
    if (v4 === null) return null;

    const high = (v4 >> 16n) & 0xffffn;
    const low = v4 & 0xffffn;
    return [...groups.slice(0, -1), high.toString(16), low.toString(16)];
  };

  const expandedHead = expand(head);
  const expandedTail = expand(tail);
  if (expandedHead === null || expandedTail === null) return null;

  const missing = 8 - (expandedHead.length + expandedTail.length);
  if (missing < 0) return null;
  if (doubleColonCount === 0 && missing !== 0) return null;

  const groups = [
    ...expandedHead,
    ...Array.from({ length: missing }, () => '0'),
    ...expandedTail,
  ];

  let value = 0n;
  for (const group of groups) {
    if (group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/**
 * Tests whether `ip` falls inside `cidr`.
 *
 * `cidr` may be a bare address (treated as a /32 or /128 host route) or an
 * explicit `address/prefix` range. Families must match: an IPv6 client never
 * matches an IPv4 rule.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIp(ip);
  if (!parsedIp) return false;

  const slashIndex = cidr.indexOf('/');
  const networkPart = slashIndex === -1 ? cidr : cidr.slice(0, slashIndex);
  const parsedNetwork = parseIp(networkPart);
  if (!parsedNetwork) return false;
  if (parsedNetwork.family !== parsedIp.family) return false;

  const prefixLength =
    slashIndex === -1 ? parsedNetwork.bits : Number.parseInt(cidr.slice(slashIndex + 1), 10);

  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > parsedIp.bits) {
    return false;
  }

  if (prefixLength === 0) return true;

  const hostBits = BigInt(parsedIp.bits - prefixLength);
  const mask = ((1n << BigInt(prefixLength)) - 1n) << hostBits;

  return (parsedIp.value & mask) === (parsedNetwork.value & mask);
}

/** Returns true when `ip` matches at least one entry of the supplied allowlist. */
export function isIpAllowed(ip: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((entry) => isIpInCidr(ip, entry));
}

/** Validates a CIDR or bare-address allowlist entry before it is persisted. */
export function isValidCidr(cidr: string): boolean {
  const slashIndex = cidr.indexOf('/');
  const networkPart = slashIndex === -1 ? cidr : cidr.slice(0, slashIndex);
  const parsed = parseIp(networkPart);
  if (!parsed) return false;
  if (slashIndex === -1) return true;

  const prefixLength = Number.parseInt(cidr.slice(slashIndex + 1), 10);
  return Number.isInteger(prefixLength) && prefixLength >= 0 && prefixLength <= parsed.bits;
}

/**
 * Normalises whatever Express handed us into a comparable client IP string.
 *
 * `trustProxy` must be configured on the Express instance for `req.ip` to
 * already account for `X-Forwarded-For`; this helper only strips the IPv6
 * mapping so that a local IPv4 client is not recorded as `::ffff:127.0.0.1`.
 */
export function normaliseIp(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}
