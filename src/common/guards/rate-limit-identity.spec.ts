import { THROTTLE_POLICY } from '../../config/throttle.config';
import { resolveThrottleIdentity, type ThrottleIdentityInput } from './rate-limit.guard';

const base: ThrottleIdentityInput = {
  policyName: THROTTLE_POLICY.DEFAULT,
  userId: null,
  sessionFamily: null,
  ip: '203.0.113.7',
  email: null,
};

describe('resolveThrottleIdentity', () => {
  it('keys signed-in traffic by user, so one NAT address is not one shared budget', () => {
    const alice = resolveThrottleIdentity({ ...base, userId: 'alice' });
    const bob = resolveThrottleIdentity({ ...base, userId: 'bob' });
    expect(alice).toBe('user:alice');
    expect(bob).toBe('user:bob');
  });

  it('falls back to the source address without a verifiable identity', () => {
    expect(resolveThrottleIdentity(base)).toBe('ip:203.0.113.7');
  });

  it('keys the refresh route by session family', () => {
    expect(
      resolveThrottleIdentity({
        ...base,
        policyName: THROTTLE_POLICY.REFRESH,
        sessionFamily: 'fam-1',
        userId: 'alice',
      }),
    ).toBe('session:fam-1');
  });

  it('keys an unverifiable refresh by address', () => {
    expect(resolveThrottleIdentity({ ...base, policyName: THROTTLE_POLICY.REFRESH })).toBe(
      'ip:203.0.113.7',
    );
  });

  it('ignores a session family outside the refresh route', () => {
    expect(resolveThrottleIdentity({ ...base, sessionFamily: 'fam-1' })).toBe(
      'ip:203.0.113.7',
    );
  });

  it('keeps per-address budgets for requests naming an email, token or not', () => {
    const expected = 'ip:203.0.113.7:email:victim@example.com';
    expect(resolveThrottleIdentity({ ...base, email: 'Victim@Example.com' })).toBe(
      expected,
    );
    expect(
      resolveThrottleIdentity({ ...base, email: 'victim@example.com', userId: 'mallory' }),
    ).toBe(expected);
  });
});
