import appConfig, { APP_CONFIG_KEY } from './app.config';
import databaseConfig, { DATABASE_CONFIG_KEY } from './database.config';
import jwtConfig, { JWT_CONFIG_KEY } from './jwt.config';
import mailConfig, { MAIL_CONFIG_KEY } from './mail.config';
import redisConfig, { REDIS_CONFIG_KEY } from './redis.config';
import securityConfig, { SECURITY_CONFIG_KEY } from './security.config';
import throttleConfig, { THROTTLE_CONFIG_KEY } from './throttle.config';

export * from './app.config';
export * from './database.config';
export * from './jwt.config';
export * from './mail.config';
export * from './redis.config';
export * from './security.config';
export * from './throttle.config';
export * from './env.validation';

/** Every namespaced configuration factory, loaded by the root ConfigModule. */
export const configurations = [
  appConfig,
  databaseConfig,
  jwtConfig,
  mailConfig,
  redisConfig,
  securityConfig,
  throttleConfig,
];

export const CONFIG_KEYS = {
  APP: APP_CONFIG_KEY,
  DATABASE: DATABASE_CONFIG_KEY,
  JWT: JWT_CONFIG_KEY,
  MAIL: MAIL_CONFIG_KEY,
  REDIS: REDIS_CONFIG_KEY,
  SECURITY: SECURITY_CONFIG_KEY,
  THROTTLE: THROTTLE_CONFIG_KEY,
} as const;
