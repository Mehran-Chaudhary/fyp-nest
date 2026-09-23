import * as dotenv from 'dotenv';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { entities } from './entities';
import { migrations } from './migrations';

// The TypeORM CLI runs outside the Nest application context, so ConfigModule has
// not loaded anything yet. Loading .env here keeps `npm run migration:run` and
// the running server pointed at the same database.
dotenv.config();

/**
 * Builds the connection options shared by the CLI and the Nest application.
 *
 * Keeping one builder is what stops the classic failure where migrations are
 * applied to a different database, schema or SSL mode than the one the server
 * connects to.
 */
export function buildDataSourceOptions(): DataSourceOptions {
  const sslEnabled = process.env.DB_SSL === 'true';

  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'ai_agent_platform',
    schema: process.env.DB_SCHEMA ?? 'public',
    ssl: sslEnabled
      ? {
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {}),
        }
      : false,
    entities,
    migrations,
    migrationsTableName: 'typeorm_migrations',
    // Never on. The schema is owned by migrations; `synchronize` will happily
    // drop the audit log's immutability triggers and any column it does not
    // recognise.
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true' ? 'all' : ['error', 'warn', 'migration'],
  };
}

/**
 * Default export consumed by the TypeORM CLI
 * (`typeorm-ts-node-commonjs -d src/database/data-source.ts`).
 */
const dataSource = new DataSource(buildDataSourceOptions());

export default dataSource;
