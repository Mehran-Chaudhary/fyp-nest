import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { PrincipalRevokedError, RunPrincipalService } from './run-principal.service';

/**
 * A run's initiator is re-checked before every step. The account rule must be
 * the one every HTTP request and socket applies: an account that has not yet
 * confirmed its email (PENDING) may act unless verification is required.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const RUN = {
  organizationId: ORG,
  initiatorUserId: USER,
  initiatorApiKeyId: null,
  initiatorMembershipId: null,
};

interface Rows {
  user?: { status: string; is_platform_admin: boolean; verified: boolean };
  permissions?: string[];
}

function service(rows: Rows, requireEmailVerification = false): RunPrincipalService {
  const dataSource = {
    query: (sql: string) => {
      if (sql.includes('FROM organizations'))
        return Promise.resolve([{ status: 'ACTIVE' }]);
      if (sql.includes('FROM users')) return Promise.resolve(rows.user ? [rows.user] : []);
      if (sql.includes('FROM organization_members')) {
        return Promise.resolve([
          {
            id: 'member-1',
            status: 'ACTIVE',
            permissions: rows.permissions ?? ['workflow:execute'],
          },
        ]);
      }
      return Promise.reject(new Error('unexpected query: ' + sql));
    },
  } as unknown as DataSource;
  const config = {
    getOrThrow: () => ({ tokens: { requireEmailVerification } }),
  } as unknown as ConfigService;
  return new RunPrincipalService(dataSource, config);
}

async function reason(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PrincipalRevokedError);
  return ((error as PrincipalRevokedError).details as { reason?: string }).reason;
}

describe('run principal', () => {
  it('lets an unverified (PENDING) account run when verification is not required', async () => {
    const principal = await service({
      user: { status: 'PENDING', is_platform_admin: false, verified: false },
    }).resolve(RUN);
    expect(principal).toMatchObject({
      kind: 'user',
      userId: USER,
      membershipId: 'member-1',
    });
  });

  it('stops an unverified account when verification is required', async () => {
    const failure = service(
      { user: { status: 'PENDING', is_platform_admin: false, verified: false } },
      true,
    ).resolve(RUN);
    expect(await reason(failure)).toBe('EMAIL_NOT_VERIFIED');
  });

  it('stops a suspended or deactivated account', async () => {
    for (const status of ['SUSPENDED', 'DEACTIVATED']) {
      const failure = service({
        user: { status, is_platform_admin: false, verified: true },
      }).resolve(RUN);
      expect(await reason(failure)).toBe('ACCOUNT_INACTIVE');
    }
  });

  it('stops a member who lost workflow:execute', async () => {
    const failure = service({
      user: { status: 'ACTIVE', is_platform_admin: false, verified: true },
      permissions: ['workflow:read'],
    }).resolve(RUN);
    expect(await reason(failure)).toBe('PERMISSION_WITHDRAWN');
  });
});
