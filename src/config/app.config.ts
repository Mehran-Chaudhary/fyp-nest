import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';
import type { NodeEnvironment } from './env.validation';

export interface AppConfig {
  env: NodeEnvironment;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  name: string;
  port: number;
  host: string;
  globalPrefix: string;
  apiVersion: string;
  url: string;
  frontendUrl: string;
  shutdownTimeoutMs: number;
  requestTimeoutMs: number;
  jsonBodyLimit: string;
  logLevel: string;
  logPretty: boolean;
  logHttpRequests: boolean;
  swagger: {
    enabled: boolean;
    path: string;
    jsonPath: string;
  };
  limits: {
    maxOwnedOrganizations: number;
    maxMembersPerOrganization: number;
  };
}

export const APP_CONFIG_KEY = 'app';

export default registerAs(APP_CONFIG_KEY, (): AppConfig => {
  const env = (process.env.NODE_ENV ?? 'development') as NodeEnvironment;

  return {
    env,
    isProduction: env === 'production',
    isDevelopment: env === 'development',
    isTest: env === 'test',
    name: process.env.APP_NAME as string,
    port: Number(process.env.APP_PORT),
    host: process.env.APP_HOST as string,
    globalPrefix: (process.env.APP_GLOBAL_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
    apiVersion: process.env.APP_API_VERSION as string,
    url: (process.env.APP_URL as string).replace(/\/+$/, ''),
    frontendUrl: (process.env.FRONTEND_URL as string).replace(/\/+$/, ''),
    shutdownTimeoutMs: parseDuration(process.env.APP_SHUTDOWN_TIMEOUT as string),
    requestTimeoutMs: parseDuration(process.env.REQUEST_TIMEOUT as string),
    jsonBodyLimit: process.env.JSON_BODY_LIMIT as string,
    logLevel: process.env.LOG_LEVEL as string,
    logPretty: process.env.LOG_PRETTY === 'true',
    logHttpRequests: process.env.LOG_HTTP_REQUESTS !== 'false',
    swagger: {
      enabled: process.env.SWAGGER_ENABLED === 'true',
      path: (process.env.SWAGGER_PATH as string).replace(/^\/+|\/+$/g, ''),
      jsonPath: (process.env.SWAGGER_JSON_PATH as string).replace(/^\/+|\/+$/g, ''),
    },
    limits: {
      maxOwnedOrganizations: Number(process.env.MAX_OWNED_ORGANIZATIONS),
      maxMembersPerOrganization: Number(process.env.MAX_MEMBERS_PER_ORGANIZATION),
    },
  };
});
