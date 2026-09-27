import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AuditAction, AuditStatus } from '../../../common/enums/audit-action.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { AppException } from '../../../common/exceptions/app.exception';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../../config/security.config';
import { MetricsService } from '../../../observability/metrics.service';
import { withoutTracing } from '../../../observability/telemetry';
import { AuditService } from '../../audit/audit.service';

/** Injected for tests; production uses the global fetch. */
export const BREACH_FETCH = Symbol('BREACH_FETCH');
export type BreachFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BreachCheckResult {
  /** Times the password appears in the breach corpus; 0 when not found. */
  occurrences: number;
  /** False when the lookup could not be completed (and so was skipped). */
  checked: boolean;
}

/**
 * Screens new passwords against the corpus of passwords exposed in data
 * breaches (Have I Been Pwned's Pwned Passwords), as NIST SP 800-63B §5.1.1.2
 * asks of any verifier: a password attackers already hold is tried first in
 * every credential-stuffing run, however "strong" its composition looks.
 *
 * ## What leaves the platform
 *
 * The k-anonymity range API: only the first five hex characters of the
 * password's SHA-1 are sent, and the service returns every suffix in that
 * range (hundreds) for the comparison to happen here. `Add-Padding` makes
 * every response the same size, so even the response length says nothing
 * about the prefix. The password, and even its full hash, never leave.
 *
 * This is the only outbound call the platform makes to a party it did not
 * configure, which is why it is a deliberate, documented choice
 * (`PASSWORD_BREACH_CHECK`) rather than a silent default of a library.
 *
 * ## Failure posture
 *
 * Fails open. An outage of a third-party service must not stop sign-ups or
 * password resets — the password still has to satisfy the composition policy,
 * and the skipped check is logged and counted.
 */
@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);
  private readonly config: SecurityConfig['breachedPasswords'];
  private readonly fetchImpl: BreachFetch;

  constructor(
    configService: ConfigService,
    private readonly auditService: AuditService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() @Inject(BREACH_FETCH) fetchImpl?: BreachFetch,
  ) {
    this.config =
      configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY).breachedPasswords;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  get mode(): SecurityConfig['breachedPasswords']['mode'] {
    return this.config.mode;
  }

  /** Looks a password up. Never throws: an unavailable service reports `checked: false`. */
  async check(password: string): Promise<BreachCheckResult> {
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);

    try {
      // Not traced: the URL carries the hash prefix, which must not be copied
      // into a tracing backend alongside the user it belongs to.
      const response = await withoutTracing(() =>
        this.fetchImpl(`${this.config.apiUrl}/range/${prefix}`, {
          method: 'GET',
          headers: {
            'Add-Padding': 'true',
            'User-Agent': 'daiap-backend (breached-password screening)',
          },
          signal: AbortSignal.timeout(this.config.timeoutMs),
        }),
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = await response.text();
      for (const line of body.split('\n')) {
        const [candidate, count] = line.trim().split(':');
        // Padding entries carry a count of zero and match nothing real.
        if (candidate === suffix) {
          const occurrences = Number(count);
          return { occurrences: Number.isFinite(occurrences) ? occurrences : 0, checked: true };
        }
      }
      return { occurrences: 0, checked: true };
    } catch (error) {
      this.logger.warn(
        `Breached-password lookup unavailable (${(error as Error).message}); skipped.`,
      );
      this.metrics?.breachedPasswordChecks.inc({ outcome: 'unavailable' });
      return { occurrences: 0, checked: false };
    }
  }

  /**
   * Applies the configured policy to a new password: refuses it (`enforce`)
   * or records it (`warn`) when it is breached at least
   * `PASSWORD_BREACH_MIN_OCCURRENCES` times.
   */
  async assertAcceptable(
    password: string,
    context: { userId?: string; purpose: 'registration' | 'reset' | 'change' },
  ): Promise<void> {
    if (this.config.mode === 'off') return;

    const result = await this.check(password);
    if (!result.checked) return;

    const breached = result.occurrences >= this.config.minOccurrences;
    this.metrics?.breachedPasswordChecks.inc({ outcome: breached ? 'breached' : 'clean' });
    if (!breached) return;

    await this.auditService.recordSafe({
      action: AuditAction.USER_PASSWORD_BREACH_DETECTED,
      status: this.config.mode === 'enforce' ? AuditStatus.DENIED : AuditStatus.SUCCESS,
      resourceType: 'user',
      resourceId: context.userId,
      // The count is public information about the password corpus, not about
      // this user; it tells a reviewer how common the choice was.
      metadata: {
        purpose: context.purpose,
        occurrences: result.occurrences,
        mode: this.config.mode,
      },
    });

    if (this.config.mode === 'enforce') {
      throw new AppException(ErrorCode.AUTH_PASSWORD_BREACHED, HttpStatus.UNPROCESSABLE_ENTITY, {
        details: { occurrences: result.occurrences },
      });
    }
  }
}
