import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

/**
 * Named throttle policies.
 *
 * `@ThrottlePolicy('auth')` on a controller selects one. Having named policies
 * rather than per-route magic numbers means the security posture of the whole
 * API can be reviewed by reading one file, and tuned without touching code.
 *
 * This is the foundation of proposal module 6.14; per-workspace token quotas and
 * agent circuit-breaking build on the same Redis buckets in phase 5.
 */
export interface ThrottlePolicyConfig {
  name: string;
  ttlMs: number;
  limit: number;
  description: string;
}

export interface ThrottleConfig {
  enabled: boolean;
  policies: Record<string, ThrottlePolicyConfig>;
  defaultPolicy: string;
}

export const THROTTLE_CONFIG_KEY = 'throttle';

export const THROTTLE_POLICY = {
  DEFAULT: 'default',
  AUTH: 'auth',
  EMAIL: 'email',
} as const;

export default registerAs(THROTTLE_CONFIG_KEY, (): ThrottleConfig => {
  const policies: Record<string, ThrottlePolicyConfig> = {
    [THROTTLE_POLICY.DEFAULT]: {
      name: THROTTLE_POLICY.DEFAULT,
      ttlMs: parseDuration(process.env.THROTTLE_TTL as string),
      limit: Number(process.env.THROTTLE_LIMIT),
      description: 'General API traffic, counted per authenticated principal or source IP.',
    },
    [THROTTLE_POLICY.AUTH]: {
      name: THROTTLE_POLICY.AUTH,
      ttlMs: parseDuration(process.env.THROTTLE_AUTH_TTL as string),
      limit: Number(process.env.THROTTLE_AUTH_LIMIT),
      description:
        'Credential-handling endpoints (sign-in, refresh, password reset). Tight, to blunt credential stuffing.',
    },
    [THROTTLE_POLICY.EMAIL]: {
      name: THROTTLE_POLICY.EMAIL,
      ttlMs: parseDuration(process.env.THROTTLE_EMAIL_TTL as string),
      limit: Number(process.env.THROTTLE_EMAIL_LIMIT),
      description:
        'Endpoints that trigger outbound email, so the platform cannot be used as a spam relay.',
    },
  };

  return {
    enabled: process.env.THROTTLE_ENABLED !== 'false',
    policies,
    defaultPolicy: THROTTLE_POLICY.DEFAULT,
  };
});
