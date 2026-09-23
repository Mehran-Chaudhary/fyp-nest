import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

export type PasswordHashAlgorithm = 'argon2id' | 'scrypt';

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
}

export interface CookieConfig {
  enabled: boolean;
  name: string;
  domain?: string;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  secret: string;
}

export interface SecurityConfig {
  hashing: {
    algorithm: PasswordHashAlgorithm;
    argon2: {
      memoryCost: number;
      timeCost: number;
      parallelism: number;
    };
    /** Optional server-side value mixed into every password hash. */
    pepper: string;
  };
  passwordPolicy: PasswordPolicy;
  /** AES-256-GCM key for encrypting sensitive columns at rest. */
  encryptionKey: string;
  /** HMAC key protecting the audit log hash chain. */
  auditHashSecret: string;
  lockout: {
    maxFailedAttempts: number;
    lockoutDurationMs: number;
    attemptWindowMs: number;
  };
  tokens: {
    emailVerificationTtlMs: number;
    passwordResetTtlMs: number;
    invitationTtlMs: number;
    requireEmailVerification: boolean;
  };
  apiKeys: {
    prefix: string;
    defaultTtlMs: number;
  };
  refreshCookie: CookieConfig;
  cors: {
    origins: string[];
    allowAnyOrigin: boolean;
    credentials: boolean;
  };
  trustProxy: number | boolean;
  enforceIpAllowlist: boolean;
  helmet: {
    enabled: boolean;
    hstsMaxAge: number;
  };
}

export const SECURITY_CONFIG_KEY = 'security';

function parseOrigins(raw: string): { origins: string[]; allowAnyOrigin: boolean } {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    origins: entries.filter((entry) => entry !== '*'),
    allowAnyOrigin: entries.includes('*'),
  };
}

function parseTrustProxy(raw: string | undefined): number | boolean {
  if (raw === undefined || raw === '') return 1;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNumber = Number(raw);
  return Number.isInteger(asNumber) ? asNumber : 1;
}

export default registerAs(SECURITY_CONFIG_KEY, (): SecurityConfig => {
  const { origins, allowAnyOrigin } = parseOrigins(process.env.CORS_ORIGINS as string);

  return {
    hashing: {
      algorithm: (process.env.PASSWORD_HASH_ALGORITHM ??
        'argon2id') as PasswordHashAlgorithm,
      argon2: {
        memoryCost: Number(process.env.ARGON2_MEMORY_COST),
        timeCost: Number(process.env.ARGON2_TIME_COST),
        parallelism: Number(process.env.ARGON2_PARALLELISM),
      },
      pepper: process.env.PASSWORD_PEPPER ?? '',
    },
    passwordPolicy: {
      minLength: Number(process.env.PASSWORD_MIN_LENGTH),
      maxLength: Number(process.env.PASSWORD_MAX_LENGTH),
      requireUppercase: process.env.PASSWORD_REQUIRE_UPPERCASE !== 'false',
      requireLowercase: process.env.PASSWORD_REQUIRE_LOWERCASE !== 'false',
      requireNumber: process.env.PASSWORD_REQUIRE_NUMBER !== 'false',
      requireSymbol: process.env.PASSWORD_REQUIRE_SYMBOL === 'true',
    },
    encryptionKey: process.env.ENCRYPTION_KEY as string,
    auditHashSecret: process.env.AUDIT_HASH_SECRET as string,
    lockout: {
      maxFailedAttempts: Number(process.env.MAX_FAILED_LOGIN_ATTEMPTS),
      lockoutDurationMs: parseDuration(process.env.ACCOUNT_LOCKOUT_DURATION as string),
      attemptWindowMs: parseDuration(process.env.LOGIN_ATTEMPT_WINDOW as string),
    },
    tokens: {
      emailVerificationTtlMs: parseDuration(process.env.EMAIL_VERIFICATION_TTL as string),
      passwordResetTtlMs: parseDuration(process.env.PASSWORD_RESET_TTL as string),
      invitationTtlMs: parseDuration(process.env.INVITATION_TTL as string),
      requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
    },
    apiKeys: {
      prefix: process.env.API_KEY_PREFIX as string,
      defaultTtlMs: parseDuration(process.env.API_KEY_DEFAULT_TTL as string),
    },
    refreshCookie: {
      enabled: process.env.REFRESH_TOKEN_COOKIE_ENABLED !== 'false',
      name: process.env.REFRESH_TOKEN_COOKIE_NAME as string,
      domain: process.env.REFRESH_TOKEN_COOKIE_DOMAIN || undefined,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: (process.env.COOKIE_SAME_SITE ?? 'lax') as CookieConfig['sameSite'],
      // Falls back to the access secret so cookie signing is never unkeyed.
      secret: process.env.COOKIE_SECRET || (process.env.JWT_ACCESS_SECRET as string),
    },
    cors: {
      origins,
      allowAnyOrigin,
      credentials: process.env.CORS_CREDENTIALS !== 'false',
    },
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    enforceIpAllowlist: process.env.ENFORCE_IP_ALLOWLIST !== 'false',
    helmet: {
      enabled: process.env.HELMET_ENABLED !== 'false',
      hstsMaxAge: Number(process.env.HSTS_MAX_AGE),
    },
  };
});
