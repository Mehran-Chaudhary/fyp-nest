import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

export interface RedisTlsConfig {
  enabled: boolean;
  rejectUnauthorized: boolean;
  ca?: string;
}

export interface RedisConfig {
  /** When present, every other connection field is ignored. */
  url?: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls: RedisTlsConfig;
  keyPrefix: string;
  connectTimeoutMs: number;
  maxRetriesPerRequest: number;
}

export const REDIS_CONFIG_KEY = 'redis';

export default registerAs(REDIS_CONFIG_KEY, (): RedisConfig => {
  return {
    url: process.env.REDIS_URL || undefined,
    host: process.env.REDIS_HOST as string,
    port: Number(process.env.REDIS_PORT),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB),
    tls: {
      enabled: process.env.REDIS_TLS === 'true',
      rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
      ca: process.env.REDIS_TLS_CA || undefined,
    },
    keyPrefix: process.env.REDIS_KEY_PREFIX as string,
    connectTimeoutMs: parseDuration(process.env.REDIS_CONNECT_TIMEOUT as string),
    maxRetriesPerRequest: Number(process.env.REDIS_MAX_RETRIES_PER_REQUEST),
  };
});
