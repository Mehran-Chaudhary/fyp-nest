import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { AppException } from '../../../common/exceptions/app.exception';
import { InvocationStatus } from '../../llm/entities/llm-invocation.entity';
import { GenerationInterruptedError, invocationStatusOf } from '../../llm/llm-errors';
import {
  applicableQuotas,
  consumedPercent,
  periodEnd,
  periodStart,
  planAllowance,
  QuotaEnforcement,
  QuotaManager,
  QuotaPeriod,
  QuotaScope,
  secondsUntilReset,
  wouldExceed,
  type QuotaDefinition,
} from './quota-model';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

function quota(overrides: Partial<QuotaDefinition>): QuotaDefinition {
  return {
    id: 'q',
    organizationId: ORG,
    scope: QuotaScope.ORGANIZATION,
    subjectId: null,
    period: QuotaPeriod.MONTH,
    tokenLimit: 1_000,
    enforcement: QuotaEnforcement.HARD,
    alertThreshold: 80,
    managedBy: QuotaManager.WORKSPACE,
    ...overrides,
  };
}

describe('token quotas (phase 5)', () => {
  describe('which quotas bind a call', () => {
    const definitions = [
      quota({ id: 'd', scope: QuotaScope.ORGANIZATION, period: QuotaPeriod.MINUTE }),
      quota({ id: 'b', scope: QuotaScope.MEMBER, subjectId: USER, period: QuotaPeriod.DAY }),
      quota({ id: 'a', scope: QuotaScope.ORGANIZATION, managedBy: QuotaManager.PLATFORM }),
      quota({ id: 'c', scope: QuotaScope.AGENT, subjectId: AGENT }),
      quota({ id: 'e', scope: QuotaScope.API_KEY, subjectId: KEY }),
      quota({ id: 'f', scope: QuotaScope.MEMBER, subjectId: 'someone-else' }),
    ];

    it('applies the workspace, the member and the agent, never someone else’s', () => {
      const { budgets, rates } = applicableQuotas(definitions, {
        organizationId: ORG,
        userId: USER,
        agentId: AGENT,
      });
      expect(budgets.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
      expect(rates.map((entry) => entry.id)).toEqual(['d']);
    });

    it('applies an API key’s quota to that key only', () => {
      const { budgets } = applicableQuotas(definitions, { organizationId: ORG, apiKeyId: KEY });
      expect(budgets.map((entry) => entry.id)).toEqual(['a', 'e']);
    });

    it('orders budgets by id, so concurrent admissions lock in the same order', () => {
      const shuffled = [...definitions].reverse();
      const { budgets } = applicableQuotas(shuffled, {
        organizationId: ORG,
        userId: USER,
        agentId: AGENT,
      });
      expect(budgets.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('calendar periods (UTC)', () => {
    const at = new Date('2026-09-26T21:47:13.500Z');

    it('starts days at midnight and months on the first', () => {
      expect(periodStart(QuotaPeriod.DAY, at).toISOString()).toBe('2026-09-26T00:00:00.000Z');
      expect(periodStart(QuotaPeriod.MONTH, at).toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(periodStart(QuotaPeriod.MINUTE, at).toISOString()).toBe('2026-09-26T21:47:00.000Z');
    });

    it('ends periods across month and year boundaries', () => {
      expect(periodEnd(QuotaPeriod.MONTH, new Date('2026-12-01T00:00:00Z')).toISOString()).toBe(
        '2027-01-01T00:00:00.000Z',
      );
      expect(periodEnd(QuotaPeriod.DAY, new Date('2028-02-28T00:00:00Z')).toISOString()).toBe(
        '2028-02-29T00:00:00.000Z',
      );
    });

    it('tells a refused caller when to come back', () => {
      expect(secondsUntilReset(QuotaPeriod.DAY, at)).toBe(Math.ceil((2 * 3600 + 12 * 60 + 46.5)));
      expect(secondsUntilReset(QuotaPeriod.MINUTE, new Date('2026-01-01T00:00:59.999Z'))).toBe(1);
    });
  });

  describe('admission arithmetic', () => {
    it('counts in-flight reservations against a hard limit', () => {
      const hard = quota({ tokenLimit: 1_000 });
      expect(wouldExceed(hard, 600, 300, 100)).toBe(false);
      expect(wouldExceed(hard, 600, 300, 101)).toBe(true);
    });

    it('never refuses under a soft limit', () => {
      expect(wouldExceed(quota({ enforcement: QuotaEnforcement.SOFT }), 5_000, 0, 5_000)).toBe(
        false,
      );
    });

    it('reports consumption as a percentage', () => {
      expect(consumedPercent(1_000, 250, 50)).toBe(30);
      expect(consumedPercent(0, 10)).toBe(0);
    });

    it('maps plans to allowances, unknown plans to the most restrictive', () => {
      const allowances = { FREE: 1, PRO: 2, ENTERPRISE: 0 };
      expect(planAllowance('PRO', allowances)).toBe(2);
      expect(planAllowance('ENTERPRISE', allowances)).toBe(0);
      expect(planAllowance('PLATINUM', allowances)).toBe(1);
    });
  });

  describe('usage ledger status of a refused call', () => {
    it('records governance refusals as THROTTLED, not FAILED', () => {
      for (const code of [
        ErrorCode.QUOTA_EXCEEDED,
        ErrorCode.TOKEN_RATE_LIMITED,
        ErrorCode.AGENT_CIRCUIT_OPEN,
        ErrorCode.CONVERSATION_TOKEN_BUDGET_EXCEEDED,
      ]) {
        expect(invocationStatusOf(new AppException(code, HttpStatus.TOO_MANY_REQUESTS))).toBe(
          InvocationStatus.THROTTLED,
        );
      }
    });

    it('keeps the earlier outcomes', () => {
      expect(
        invocationStatusOf(
          new AppException(ErrorCode.PII_EGRESS_BLOCKED, HttpStatus.INTERNAL_SERVER_ERROR),
        ),
      ).toBe(InvocationStatus.BLOCKED);
      expect(
        invocationStatusOf(
          new GenerationInterruptedError(
            ErrorCode.REQUEST_TIMEOUT,
            HttpStatus.REQUEST_TIMEOUT,
            { text: '', maskedText: '', ttftMs: null },
            true,
          ),
        ),
      ).toBe(InvocationStatus.CANCELLED);
      expect(invocationStatusOf(new Error('boom'))).toBe(InvocationStatus.FAILED);
    });
  });
});
