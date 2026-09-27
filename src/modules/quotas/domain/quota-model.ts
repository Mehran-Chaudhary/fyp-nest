/**
 * The vocabulary of token quotas (proposal module 6.14), and the calendar
 * arithmetic behind them. Pure: no I/O, so every rule is unit-testable.
 */

/** Who a quota constrains. */
export enum QuotaScope {
  /** The whole workspace, every caller together. */
  ORGANIZATION = 'ORGANIZATION',
  /** One member (a user id), across every agent and conversation. */
  MEMBER = 'MEMBER',
  /** One agent, whoever talks to it, in conversations and workflow runs alike. */
  AGENT = 'AGENT',
  /** One API key: a machine integration. */
  API_KEY = 'API_KEY',
}

/**
 * The window a limit applies to. `MINUTE` is a rate (a token bucket in
 * Redis, refilling continuously); `DAY` and `MONTH` are budgets (counters in
 * PostgreSQL, reset at the start of each UTC calendar period).
 */
export enum QuotaPeriod {
  MINUTE = 'MINUTE',
  DAY = 'DAY',
  MONTH = 'MONTH',
}

/** `HARD` refuses calls that would exceed the limit; `SOFT` alerts and allows them. */
export enum QuotaEnforcement {
  HARD = 'HARD',
  SOFT = 'SOFT',
}

/** Who owns a quota: the workspace's administrators, or the deployment. */
export enum QuotaManager {
  WORKSPACE = 'WORKSPACE',
  PLATFORM = 'PLATFORM',
}

/** A quota definition, as the admission path needs it. */
export interface QuotaDefinition {
  id: string;
  organizationId: string;
  scope: QuotaScope;
  subjectId: string | null;
  period: QuotaPeriod;
  tokenLimit: number;
  enforcement: QuotaEnforcement;
  alertThreshold: number;
  managedBy: QuotaManager;
}

/** Who is spending: every model call is attributed to these. */
export interface QuotaSubject {
  organizationId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  agentId?: string | null;
}

/** The quotas that constrain one call, split by how they are enforced. */
export interface ApplicableQuotas {
  budgets: QuotaDefinition[];
  rates: QuotaDefinition[];
}

/**
 * Which of a workspace's quotas bind a given call.
 *
 * Sorted by id: two admissions that lock the same counters always lock them
 * in the same order, so they cannot deadlock one another.
 */
export function applicableQuotas(
  definitions: readonly QuotaDefinition[],
  subject: QuotaSubject,
): ApplicableQuotas {
  const binding = definitions.filter((quota) => {
    switch (quota.scope) {
      case QuotaScope.ORGANIZATION:
        return true;
      case QuotaScope.MEMBER:
        return !!subject.userId && quota.subjectId === subject.userId;
      case QuotaScope.API_KEY:
        return !!subject.apiKeyId && quota.subjectId === subject.apiKeyId;
      case QuotaScope.AGENT:
        return !!subject.agentId && quota.subjectId === subject.agentId;
      default:
        return false;
    }
  });
  const byId = (a: QuotaDefinition, b: QuotaDefinition) => (a.id < b.id ? -1 : 1);
  return {
    budgets: binding.filter((quota) => quota.period !== QuotaPeriod.MINUTE).sort(byId),
    rates: binding.filter((quota) => quota.period === QuotaPeriod.MINUTE).sort(byId),
  };
}

/** Start of the UTC calendar period containing `at`. */
export function periodStart(period: QuotaPeriod, at: Date): Date {
  switch (period) {
    case QuotaPeriod.MINUTE:
      return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    case QuotaPeriod.DAY:
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    case QuotaPeriod.MONTH:
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  }
}

/** Start of the period after the one beginning at `start`. */
export function periodEnd(period: QuotaPeriod, start: Date): Date {
  switch (period) {
    case QuotaPeriod.MINUTE:
      return new Date(start.getTime() + 60_000);
    case QuotaPeriod.DAY:
      return new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1),
      );
    case QuotaPeriod.MONTH:
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
}

/** Whole seconds until the budget resets, never less than one. */
export function secondsUntilReset(period: QuotaPeriod, now: Date): number {
  const end = periodEnd(period, periodStart(period, now));
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

/**
 * Whether reserving `tokens` more would exceed a HARD budget. A SOFT budget
 * never refuses; it only alerts.
 */
export function wouldExceed(
  quota: Pick<QuotaDefinition, 'tokenLimit' | 'enforcement'>,
  used: number,
  reserved: number,
  tokens: number,
): boolean {
  if (quota.enforcement === QuotaEnforcement.SOFT) return false;
  return used + reserved + tokens > quota.tokenLimit;
}

/** Percentage of the limit consumed, counting reservations in flight. */
export function consumedPercent(limit: number, used: number, reserved = 0): number {
  if (limit <= 0) return 0;
  return Math.round(((used + reserved) / limit) * 10_000) / 100;
}

/**
 * The platform allowance for a workspace's plan; 0 means unlimited. Plans the
 * deployment does not know fall back to the most restrictive.
 */
export function planAllowance(
  plan: string,
  allowances: Readonly<Record<'FREE' | 'PRO' | 'ENTERPRISE', number>>,
): number {
  return plan === 'PRO' || plan === 'ENTERPRISE' || plan === 'FREE'
    ? allowances[plan]
    : allowances.FREE;
}
