import { registerAs } from '@nestjs/config';
import { parseDuration, parseDurationToSeconds } from '../common/utils/duration.util';

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  /** Access token lifetime in seconds. */
  accessTtlSeconds: number;
  /** Refresh token lifetime in seconds. */
  refreshTtlSeconds: number;
  /** Refresh token lifetime in milliseconds, for cookie maxAge and DB expiry. */
  refreshTtlMs: number;
  issuer: string;
  audience: string;
  algorithm: 'HS256' | 'HS384' | 'HS512';
  clockToleranceSeconds: number;
}

export const JWT_CONFIG_KEY = 'jwt';

export default registerAs(JWT_CONFIG_KEY, (): JwtConfig => {
  return {
    accessSecret: process.env.JWT_ACCESS_SECRET as string,
    refreshSecret: process.env.JWT_REFRESH_SECRET as string,
    accessTtlSeconds: parseDurationToSeconds(process.env.JWT_ACCESS_TTL as string),
    refreshTtlSeconds: parseDurationToSeconds(process.env.JWT_REFRESH_TTL as string),
    refreshTtlMs: parseDuration(process.env.JWT_REFRESH_TTL as string),
    issuer: process.env.JWT_ISSUER as string,
    audience: process.env.JWT_AUDIENCE as string,
    algorithm: (process.env.JWT_ALGORITHM ?? 'HS256') as JwtConfig['algorithm'],
    clockToleranceSeconds: Number(process.env.JWT_CLOCK_TOLERANCE),
  };
});
