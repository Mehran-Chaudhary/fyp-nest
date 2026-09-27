import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { summarizeCertificate } from '../../../common/utils/pem.util';
import { AI_SERVICE_CONFIG_KEY, type AiServiceConfig } from '../../../config/ai-service.config';
import type { ClientTlsConfig } from '../../../config/client-tls';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../../config/llm.config';
import { RowLevelSecurityService } from '../../../database/tenancy/row-level-security.service';

/** Certificates this close to expiry are reported degraded, early enough to renew. */
const EXPIRY_WARNING_DAYS = 21;

/**
 * Phase 5 controls whose absence is silent: nothing fails when row-level
 * security is not in force, or when a client certificate is about to expire —
 * until it matters. Reported **degraded**, never **down**, like every
 * dependency probe: they call for attention, not for taking the API out of
 * rotation.
 */
@Injectable()
export class SecurityHealthIndicator {
  private readonly aiTls: ClientTlsConfig;
  private readonly llmTls: ClientTlsConfig;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly rowLevelSecurity: RowLevelSecurityService,
    configService: ConfigService,
  ) {
    this.aiTls = configService.getOrThrow<AiServiceConfig>(AI_SERVICE_CONFIG_KEY).tls;
    this.llmTls = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY).tls;
  }

  async rowLevelSecurityStatus(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const status = await this.rowLevelSecurity.describe();
    const details = {
      binding: status.binding,
      enforced: status.enforced,
      policies: status.policies,
      role: status.role,
    };
    return status.problem
      ? indicator.degraded({ ...details, message: status.problem })
      : indicator.up(details);
  }

  mutualTls(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    const aiService = this.describe(this.aiTls);
    const llm = this.describe(this.llmTls);
    const expiring = [aiService, llm].filter(
      (entry) => entry.enabled && (entry.daysRemaining ?? Infinity) < EXPIRY_WARNING_DAYS,
    );
    const details = { aiService, llm };
    return expiring.length > 0
      ? indicator.degraded({
          ...details,
          message: `A client certificate expires within ${EXPIRY_WARNING_DAYS} days: renew it.`,
        })
      : indicator.up(details);
  }

  private describe(tls: ClientTlsConfig): {
    enabled: boolean;
    subject?: string;
    expiresAt?: string;
    daysRemaining?: number;
    privateCa: boolean;
  } {
    if (!tls.enabled || !tls.cert) return { enabled: false, privateCa: Boolean(tls.ca) };
    try {
      const certificate = summarizeCertificate(tls.cert);
      return {
        enabled: true,
        subject: certificate.subject,
        expiresAt: certificate.validTo,
        daysRemaining: certificate.daysRemaining,
        privateCa: Boolean(tls.ca),
      };
    } catch {
      return { enabled: true, privateCa: Boolean(tls.ca) };
    }
  }
}
