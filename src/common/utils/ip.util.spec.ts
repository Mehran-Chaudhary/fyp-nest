import { isIpAllowed, isIpInCidr, isValidCidr, normaliseIp, parseIp } from './ip.util';

/**
 * The workspace IP allowlist (proposal module 6.1) is only as good as this
 * matcher. A false positive lets a blocked network through; a false negative
 * locks a legitimate office out. The bypass cases at the end are the ones that
 * have historically broken naive implementations.
 */
describe('IP matching', () => {
  describe('parseIp', () => {
    it('parses IPv4', () => {
      expect(parseIp('192.0.2.1')).toMatchObject({ family: 'ipv4', bits: 32 });
    });

    it('parses IPv6', () => {
      expect(parseIp('2001:db8::1')).toMatchObject({ family: 'ipv6', bits: 128 });
    });

    it('treats an IPv4-mapped IPv6 address as IPv4', () => {
      // Otherwise a rule written as 192.0.2.0/24 would not match a client that
      // arrives over a dual-stack socket, which is the common case on Linux.
      expect(parseIp('::ffff:192.0.2.1')).toMatchObject({ family: 'ipv4' });
      expect(parseIp('::ffff:192.0.2.1')?.value).toBe(parseIp('192.0.2.1')?.value);
    });

    it('strips a zone index', () => {
      expect(parseIp('fe80::1%eth0')).toMatchObject({ family: 'ipv6' });
    });

    it('unwraps a bracketed IPv6 host', () => {
      expect(parseIp('[2001:db8::1]')?.value).toBe(parseIp('2001:db8::1')?.value);
    });

    it('rejects octets above 255', () => {
      expect(parseIp('256.0.0.1')).toBeNull();
      expect(parseIp('192.0.2.999')).toBeNull();
    });

    it('rejects leading zeros in IPv4 octets', () => {
      // "010.0.0.1" is ambiguous between decimal and octal and has been used to
      // slip past allowlists that parse loosely.
      expect(parseIp('010.0.0.1')).toBeNull();
      expect(parseIp('192.0.2.01')).toBeNull();
    });

    it('rejects more than one :: elision', () => {
      expect(parseIp('2001::db8::1')).toBeNull();
    });

    it('rejects an under-specified IPv6 address without ::', () => {
      expect(parseIp('2001:db8:1:2:3')).toBeNull();
    });

    it('rejects nonsense', () => {
      expect(parseIp('')).toBeNull();
      expect(parseIp('not-an-ip')).toBeNull();
      expect(parseIp('192.0.2')).toBeNull();
    });
  });

  describe('isIpInCidr — IPv4', () => {
    it('matches inside the range', () => {
      expect(isIpInCidr('192.0.2.5', '192.0.2.0/24')).toBe(true);
      expect(isIpInCidr('192.0.2.255', '192.0.2.0/24')).toBe(true);
    });

    it('rejects outside the range', () => {
      expect(isIpInCidr('192.0.3.1', '192.0.2.0/24')).toBe(false);
      expect(isIpInCidr('10.0.0.1', '192.0.2.0/24')).toBe(false);
    });

    it('treats a bare address as a host route', () => {
      expect(isIpInCidr('192.0.2.7', '192.0.2.7')).toBe(true);
      expect(isIpInCidr('192.0.2.8', '192.0.2.7')).toBe(false);
    });

    it('handles a /32', () => {
      expect(isIpInCidr('192.0.2.7', '192.0.2.7/32')).toBe(true);
      expect(isIpInCidr('192.0.2.8', '192.0.2.7/32')).toBe(false);
    });

    it('handles a /0 as match-everything', () => {
      expect(isIpInCidr('203.0.113.9', '0.0.0.0/0')).toBe(true);
    });

    it('handles non-byte-aligned prefixes', () => {
      // /28 covers .16 through .31 only.
      expect(isIpInCidr('192.0.2.16', '192.0.2.16/28')).toBe(true);
      expect(isIpInCidr('192.0.2.31', '192.0.2.16/28')).toBe(true);
      expect(isIpInCidr('192.0.2.32', '192.0.2.16/28')).toBe(false);
      expect(isIpInCidr('192.0.2.15', '192.0.2.16/28')).toBe(false);
    });

    it('matches even when the rule is not the network address', () => {
      // 192.0.2.77/24 is sloppy but common in hand-written allowlists.
      expect(isIpInCidr('192.0.2.5', '192.0.2.77/24')).toBe(true);
    });
  });

  describe('isIpInCidr — IPv6', () => {
    it('matches inside the range', () => {
      expect(isIpInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
      expect(isIpInCidr('2001:db8:ffff::9', '2001:db8::/32')).toBe(true);
    });

    it('rejects outside the range', () => {
      expect(isIpInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    });

    it('handles a /128', () => {
      expect(isIpInCidr('2001:db8::1', '2001:db8::1/128')).toBe(true);
      expect(isIpInCidr('2001:db8::2', '2001:db8::1/128')).toBe(false);
    });
  });

  describe('family isolation', () => {
    it('never matches an IPv6 client against an IPv4 rule', () => {
      expect(isIpInCidr('2001:db8::1', '0.0.0.0/0')).toBe(false);
    });

    it('never matches an IPv4 client against an IPv6 rule', () => {
      expect(isIpInCidr('192.0.2.1', '::/0')).toBe(false);
    });
  });

  describe('malformed input fails closed', () => {
    it('rejects a negative prefix', () => {
      expect(isIpInCidr('192.0.2.1', '192.0.2.0/-1')).toBe(false);
    });

    it('rejects an over-wide prefix', () => {
      expect(isIpInCidr('192.0.2.1', '192.0.2.0/33')).toBe(false);
    });

    it('rejects a non-numeric prefix', () => {
      expect(isIpInCidr('192.0.2.1', '192.0.2.0/abc')).toBe(false);
    });

    it('rejects an unparseable client address', () => {
      expect(isIpInCidr('unknown', '0.0.0.0/0')).toBe(false);
    });
  });

  describe('isIpAllowed', () => {
    it('allows everything when the list is empty', () => {
      // An empty allowlist means "not configured", not "deny all" — otherwise
      // enabling enforcement before adding rules would lock a workspace out.
      expect(isIpAllowed('203.0.113.1', [])).toBe(true);
    });

    it('allows a match against any entry', () => {
      expect(isIpAllowed('10.0.4.9', ['192.0.2.0/24', '10.0.4.0/24'])).toBe(true);
    });

    it('denies when no entry matches', () => {
      expect(isIpAllowed('172.16.0.1', ['192.0.2.0/24', '10.0.4.0/24'])).toBe(false);
    });
  });

  describe('isValidCidr', () => {
    it('accepts valid forms', () => {
      expect(isValidCidr('192.0.2.0/24')).toBe(true);
      expect(isValidCidr('192.0.2.7')).toBe(true);
      expect(isValidCidr('2001:db8::/32')).toBe(true);
      expect(isValidCidr('::1')).toBe(true);
    });

    it('rejects invalid forms', () => {
      expect(isValidCidr('192.0.2.0/33')).toBe(false);
      expect(isValidCidr('999.0.0.1')).toBe(false);
      expect(isValidCidr('not-a-cidr')).toBe(false);
      expect(isValidCidr('')).toBe(false);
    });
  });

  describe('normaliseIp', () => {
    it('unwraps IPv4-mapped IPv6, so a local client is not recorded as ::ffff:127.0.0.1', () => {
      expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    });

    it('leaves a plain address alone', () => {
      expect(normaliseIp('203.0.113.4')).toBe('203.0.113.4');
      expect(normaliseIp('2001:db8::1')).toBe('2001:db8::1');
    });

    it('reports "unknown" rather than empty for a missing address', () => {
      expect(normaliseIp(undefined)).toBe('unknown');
      expect(normaliseIp(null)).toBe('unknown');
      expect(normaliseIp('')).toBe('unknown');
    });
  });
});
