import { createHmac } from 'node:crypto';
import { stableStringify } from './audit.service';
import { GENESIS_HASH, PLATFORM_CHAIN_ID } from './entities/audit-log.entity';

/**
 * The tamper-evident audit chain (proposal module 6.15).
 *
 * The chain's whole value rests on one property: the same record must always
 * produce the same hash, and any change to it must produce a different one.
 * These tests pin that property down, since a non-deterministic canonical form
 * would make verification fail on records nobody touched — which is worse than
 * no verification at all, because it trains operators to ignore the alarm.
 *
 * `canonicalise` and `computeHash` are private to `AuditService`, so the chain
 * arithmetic is reproduced here against the same exported `stableStringify`
 * helper the service uses for its metadata field.
 */
describe('audit chain', () => {
  describe('stableStringify', () => {
    it('is insensitive to key insertion order', () => {
      // The reason JSON.stringify is not used directly: it preserves insertion
      // order, so two structurally identical metadata objects built by different
      // code paths would hash differently.
      expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    });

    it('sorts keys recursively', () => {
      const first = stableStringify({ outer: { z: 1, a: { y: 2, b: 3 } } });
      const second = stableStringify({ outer: { a: { b: 3, y: 2 }, z: 1 } });
      expect(first).toBe(second);
    });

    it('preserves array order, which is semantically meaningful', () => {
      expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
    });

    it('serialises dates deterministically', () => {
      const date = new Date('2026-01-01T12:00:00.000Z');
      expect(stableStringify({ at: date })).toBe('{"at":"2026-01-01T12:00:00.000Z"}');
    });

    it('treats null and undefined consistently', () => {
      expect(stableStringify(null)).toBe('null');
      expect(stableStringify(undefined)).toBe('null');
      // An undefined property is dropped, so `{a: 1}` and `{a: 1, b: undefined}`
      // — which are indistinguishable after a JSON round trip — hash alike.
      expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    });

    it('handles nesting and mixed types', () => {
      const value = { n: 1, s: 'x', b: true, arr: [{ k: 'v' }], nested: { deep: [1, 2] } };
      expect(stableStringify(value)).toBe(stableStringify(structuredClone(value)));
    });

    it('produces different output for different content', () => {
      expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
      expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ b: 1 }));
    });
  });

  describe('chain construction', () => {
    const SECRET = 'test-audit-chain-secret-at-least-32-characters';

    interface ChainRecord {
      sequence: string;
      organizationId: string;
      action: string;
      status: string;
      actorId: string | null;
      metadata: Record<string, unknown>;
      previousHash: string;
      hash?: string;
    }

    /** Mirrors `AuditService.canonicalise` over the subset used in this test. */
    function canonicalise(record: Omit<ChainRecord, 'hash'>): string {
      return [
        ['sequence', record.sequence],
        ['organizationId', record.organizationId],
        ['action', record.action],
        ['status', record.status],
        ['actorId', record.actorId],
        ['metadata', stableStringify(record.metadata ?? {})],
      ]
        .map(
          ([key, value]) =>
            `${key}=${value === null || value === undefined ? '' : String(value)}`,
        )
        .join('');
    }

    function computeHash(record: Omit<ChainRecord, 'hash'>, previousHash: string): string {
      return createHmac('sha256', SECRET)
        .update(canonicalise(record))
        .update(previousHash)
        .digest('hex');
    }

    function buildChain(count: number): ChainRecord[] {
      const chain: ChainRecord[] = [];
      let previousHash = GENESIS_HASH;

      for (let i = 1; i <= count; i += 1) {
        const record: ChainRecord = {
          sequence: String(i),
          organizationId: PLATFORM_CHAIN_ID,
          action: 'user.login.succeeded',
          status: 'SUCCESS',
          actorId: `actor-${i}`,
          metadata: { index: i },
          previousHash,
        };
        record.hash = computeHash(record, previousHash);
        previousHash = record.hash;
        chain.push(record);
      }

      return chain;
    }

    /** Mirrors `AuditService.verifyChain`. */
    function verify(chain: ChainRecord[]): {
      valid: boolean;
      brokenAt?: string;
      reason?: string;
    } {
      let expectedPrevious = GENESIS_HASH;
      let expectedSequence = 1n;

      for (const record of chain) {
        if (BigInt(record.sequence) !== expectedSequence) {
          return { valid: false, brokenAt: record.sequence, reason: 'sequence gap' };
        }
        if (record.previousHash !== expectedPrevious) {
          return { valid: false, brokenAt: record.sequence, reason: 'link mismatch' };
        }
        if (computeHash(record, record.previousHash) !== record.hash) {
          return { valid: false, brokenAt: record.sequence, reason: 'content altered' };
        }
        expectedPrevious = record.hash;
        expectedSequence += 1n;
      }

      return { valid: true };
    }

    it('starts from the genesis hash', () => {
      expect(buildChain(1)[0].previousHash).toBe(GENESIS_HASH);
      expect(GENESIS_HASH).toHaveLength(64);
    });

    it('verifies an untouched chain', () => {
      expect(verify(buildChain(50))).toEqual({ valid: true });
    });

    it('is deterministic — the same input yields the same hashes', () => {
      expect(buildChain(10).map((r) => r.hash)).toEqual(buildChain(10).map((r) => r.hash));
    });

    it('detects an altered field', () => {
      const chain = buildChain(10);
      // The exact scenario the chain exists to catch: flipping a denial into a
      // success after the fact.
      chain[4].status = 'DENIED';

      const result = verify(chain);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe('5');
      expect(result.reason).toBe('content altered');
    });

    it('detects altered metadata', () => {
      const chain = buildChain(10);
      chain[2].metadata = { index: 999 };

      expect(verify(chain).valid).toBe(false);
    });

    it('detects a deleted record', () => {
      const chain = buildChain(10);
      chain.splice(4, 1);

      const result = verify(chain);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('sequence gap');
    });

    it('detects a re-linked chain after a deletion', () => {
      // A sophisticated tamperer deletes a record and renumbers the rest. The
      // link check catches it even though the sequence is now contiguous.
      const chain = buildChain(10);
      chain.splice(4, 1);
      chain.forEach((record, index) => {
        record.sequence = String(index + 1);
      });

      const result = verify(chain);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('link mismatch');
    });

    it('detects an inserted record', () => {
      const chain = buildChain(10);
      const forged: ChainRecord = {
        sequence: '5',
        organizationId: PLATFORM_CHAIN_ID,
        action: 'role.assigned',
        status: 'SUCCESS',
        actorId: 'attacker',
        metadata: {},
        previousHash: chain[3].hash as string,
      };
      forged.hash = computeHash(forged, forged.previousHash);
      chain.splice(4, 0, forged);

      // The forged record itself is internally consistent, but the record that
      // used to occupy position 5 still points at the old predecessor.
      expect(verify(chain).valid).toBe(false);
    });

    it('cannot be re-signed without the secret', () => {
      const chain = buildChain(5);
      chain[2].status = 'DENIED';

      // An attacker with database access but not the HMAC key can only produce
      // an unkeyed digest, which will not match.
      chain[2].hash = createHmac('sha256', 'wrong-secret')
        .update(canonicalise(chain[2]))
        .update(chain[2].previousHash)
        .digest('hex');

      expect(verify(chain).valid).toBe(false);
    });

    it('produces a 64-character hex digest', () => {
      for (const record of buildChain(3)) {
        expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
});
