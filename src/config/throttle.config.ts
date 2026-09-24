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
  UPLOAD: 'upload',
  RAG: 'rag',
  INFERENCE: 'inference',
  PRIVACY: 'privacy',
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
    [THROTTLE_POLICY.UPLOAD]: {
      name: THROTTLE_POLICY.UPLOAD,
      ttlMs: parseDuration(process.env.THROTTLE_UPLOAD_TTL as string),
      limit: Number(process.env.THROTTLE_UPLOAD_LIMIT),
      description:
        'Document uploads. Each one costs storage, parsing and embedding compute downstream.',
    },
    [THROTTLE_POLICY.RAG]: {
      name: THROTTLE_POLICY.RAG,
      ttlMs: parseDuration(process.env.THROTTLE_RAG_TTL as string),
      limit: Number(process.env.THROTTLE_RAG_LIMIT),
      description:
        'Retrieval queries. Each one costs an embedding call and a vector search.',
    },
    [THROTTLE_POLICY.INFERENCE]: {
      name: THROTTLE_POLICY.INFERENCE,
      ttlMs: parseDuration(process.env.THROTTLE_INFERENCE_TTL as string),
      limit: Number(process.env.THROTTLE_INFERENCE_LIMIT),
      description:
        'Agent turns and direct model calls. Each one holds a GPU slot for seconds, ' +
        'so the budget is far tighter than for ordinary traffic.',
    },
    [THROTTLE_POLICY.PRIVACY]: {
      name: THROTTLE_POLICY.PRIVACY,
      ttlMs: parseDuration(process.env.THROTTLE_PII_TTL as string),
      limit: Number(process.env.THROTTLE_PII_LIMIT),
      description:
        'PII analysis previews and redaction reports. Each one runs the NER model.',
    },
  };

  return {
    enabled: process.env.THROTTLE_ENABLED !== 'false',
    policies,
    defaultPolicy: THROTTLE_POLICY.DEFAULT,
  };
});
