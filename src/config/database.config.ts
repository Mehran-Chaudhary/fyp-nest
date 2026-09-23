import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

export interface DatabaseSslConfig {
  enabled: boolean;
  rejectUnauthorized: boolean;
  ca?: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema: string;
  ssl: DatabaseSslConfig;
  logging: boolean;
  synchronize: boolean;
  migrationsRun: boolean;
  poolMax: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
}

export const DATABASE_CONFIG_KEY = 'database';

export default registerAs(DATABASE_CONFIG_KEY, (): DatabaseConfig => {
  const sslEnabled = process.env.DB_SSL === 'true';

  return {
    host: process.env.DB_HOST as string,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME as string,
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME as string,
    schema: process.env.DB_SCHEMA as string,
    ssl: {
      enabled: sslEnabled,
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
      ca: process.env.DB_SSL_CA || undefined,
    },
    logging: process.env.DB_LOGGING === 'true',
    // Guarded a second time here, not just in documentation: `synchronize` can
    // silently drop columns, and the audit log is append-only by contract.
    synchronize:
      process.env.DB_SYNCHRONIZE === 'true' && process.env.NODE_ENV !== 'production',
    migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
    poolMax: Number(process.env.DB_POOL_MAX),
    idleTimeoutMs: parseDuration(process.env.DB_POOL_IDLE_TIMEOUT as string),
    connectionTimeoutMs: parseDuration(process.env.DB_CONNECTION_TIMEOUT as string),
    statementTimeoutMs: parseDuration(process.env.DB_STATEMENT_TIMEOUT as string),
  };
});
