import { BlockList, isIP } from 'node:net';

/**
 * Egress control for tools that make outbound HTTP calls.
 *
 * An HTTP tool is a request an attacker can partly write: the model fills its
 * arguments, and the model's context may contain a poisoned document or web
 * page. Server-side request forgery (SSRF) is therefore the tool engine's
 * primary network threat — using the platform to reach what the attacker
 * cannot: the cloud metadata service at 169.254.169.254 (which hands out the
 * host's credentials), the database, Redis, anything on the private network.
 *
 * Two independent checks:
 *
 *  1. **The host allowlist.** A tool's origin is fixed when it is defined and
 *     must match `TOOL_HTTP_ALLOWED_HOSTS`; arguments can fill paths and query
 *     values, never the host.
 *  2. **The address check.** Whatever a name resolves to must be a public
 *     unicast address — not private, loopback, link-local, carrier-grade NAT,
 *     multicast, documentation, or any other special-purpose range (RFC 6890,
 *     RFC 6598, RFC 5737, RFC 4193 …). The check runs on *every* resolved
 *     address, and the connection is pinned to the address that was checked,
 *     which closes the DNS-rebinding window between checking and connecting.
 */

const CLOUD_METADATA = 'cloud metadata';

const IPV4_SPECIAL: ReadonlyArray<[string, number, string]> = [
  // First, so it is reported by name rather than as carrier-grade NAT.
  ['100.100.100.200', 32, CLOUD_METADATA], // Alibaba Cloud
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const IPV6_SPECIAL: ReadonlyArray<[string, number, string]> = [
  ['fd00:ec2::254', 128, CLOUD_METADATA], // AWS IMDS over IPv6
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['64:ff9b::', 96, 'NAT64'],
  ['64:ff9b:1::', 48, 'NAT64'],
  ['100::', 64, 'discard'],
  ['2001::', 23, 'IETF protocol assignments'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, '6to4'],
  ['fc00::', 7, 'unique local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

const blockLists = (() => {
  const byReason = new Map<string, BlockList>();
  for (const [network, prefix, reason] of IPV4_SPECIAL) {
    const list = byReason.get(reason) ?? new BlockList();
    list.addSubnet(network, prefix, 'ipv4');
    byReason.set(reason, list);
  }
  for (const [network, prefix, reason] of IPV6_SPECIAL) {
    const list = byReason.get(reason) ?? new BlockList();
    list.addSubnet(network, prefix, 'ipv6');
    byReason.set(reason, list);
  }
  return byReason;
})();

/**
 * Refused even when `TOOL_HTTP_ALLOW_PRIVATE_NETWORKS` is on (a development
 * convenience for reaching a local mock API): no tool has a reason to reach
 * the cloud metadata service, whose answer is the host's own credentials, or
 * an unspecified address.
 */
const ALWAYS_BLOCKED: ReadonlySet<string> = new Set([
  CLOUD_METADATA,
  'link-local (cloud metadata)',
  'link-local',
  'unspecified',
]);

/** Why `address` may not be contacted under the given policy, or null if it may. */
export function blockedReason(
  address: string,
  allowPrivateNetworks: boolean,
): string | null {
  const reason = classifyAddress(address);
  if (!reason) return null;
  return !allowPrivateNetworks || ALWAYS_BLOCKED.has(reason) ? reason : null;
}

/** Why an address may not be contacted, or null for a public unicast address. */
export function classifyAddress(address: string): string | null {
  const version = isIP(address);
  if (version === 0) return 'not an IP address';

  if (version === 6) {
    const embedded = embeddedIpv4(address);
    if (embedded) return classifyAddress(embedded);
  }

  const family = version === 4 ? 'ipv4' : 'ipv6';
  for (const [reason, list] of blockLists) {
    if (list.check(address, family)) return reason;
  }
  return null;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`), if any. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];

  const hex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return null;
}

// ── Host allowlist ──────────────────────────────────────────────────────────

export interface AllowlistEntry {
  /** Lower-case hostname, without a trailing dot. */
  host: string;
  /** `*.example.com`: any subdomain of example.com (not example.com itself). */
  wildcard: boolean;
  /** Null: the scheme's default port only. */
  port: number | null;
}

export function parseAllowlist(entries: readonly string[]): AllowlistEntry[] {
  return entries
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const wildcard = entry.startsWith('*.');
      const rest = wildcard ? entry.slice(2) : entry;
      const colon = rest.lastIndexOf(':');
      const hasPort = colon > -1 && /^\d+$/.test(rest.slice(colon + 1));
      return {
        host: normalizeHost(hasPort ? rest.slice(0, colon) : rest),
        wildcard,
        port: hasPort ? Number(rest.slice(colon + 1)) : null,
      };
    });
}

export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

/** Whether `url`'s host and port are on the allowlist. */
export function isHostAllowed(url: URL, allowlist: readonly AllowlistEntry[]): boolean {
  const host = normalizeHost(url.hostname);
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;

  return allowlist.some((entry) => {
    const hostMatches = entry.wildcard
      ? host.endsWith(`.${entry.host}`) && host.length > entry.host.length + 1
      : host === entry.host;
    const portMatches = entry.port === null ? port === defaultPort : port === entry.port;
    return hostMatches && portMatches;
  });
}

export type EgressRefusal =
  | 'SCHEME_NOT_ALLOWED'
  | 'CREDENTIALS_IN_URL'
  | 'HOST_NOT_ALLOWED'
  | 'ADDRESS_NOT_PUBLIC'
  | 'DNS_FAILURE';

export class EgressBlockedError extends Error {
  constructor(
    readonly reason: EgressRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

/**
 * Checks a URL before any connection is attempted: scheme, embedded
 * credentials, allowlist, and — for a literal IP host, which is connected to
 * without a DNS lookup — the address itself.
 */
export function assertUrlAllowed(
  url: URL,
  options: {
    allowlist: readonly AllowlistEntry[];
    allowInsecure: boolean;
    allowPrivateNetworks: boolean;
  },
): void {
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && options.allowInsecure)) {
    throw new EgressBlockedError(
      'SCHEME_NOT_ALLOWED',
      `Only https:// is permitted (got ${url.protocol}).`,
    );
  }
  if (url.username || url.password) {
    throw new EgressBlockedError(
      'CREDENTIALS_IN_URL',
      'URLs may not carry credentials; configure the tool’s authentication instead.',
    );
  }
  if (!isHostAllowed(url, options.allowlist)) {
    throw new EgressBlockedError(
      'HOST_NOT_ALLOWED',
      `The host ${normalizeHost(url.hostname)} is not on the platform egress allowlist ` +
        '(TOOL_HTTP_ALLOWED_HOSTS).',
    );
  }

  const literal = normalizeHost(url.hostname);
  if (isIP(literal)) {
    const reason = blockedReason(literal, options.allowPrivateNetworks);
    if (reason) {
      throw new EgressBlockedError(
        'ADDRESS_NOT_PUBLIC',
        `The address ${literal} is ${reason} and may not be contacted.`,
      );
    }
  }
}
