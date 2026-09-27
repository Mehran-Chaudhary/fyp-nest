import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG_KEY, type DatabaseConfig } from '../config/database.config';
import { entities } from './entities';
import { migrations } from './migrations';
import { RowLevelSecurityService } from './tenancy/row-level-security.service';

/**
 * PostgreSQL connectivity.
 *
 * The connection is configured from validated configuration rather than read
 * from `process.env` directly, so the same guarantees that prevent the app from
 * booting with a bad JWT secret also prevent it from booting pointed at an
 * unparseable pool size.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const database = configService.getOrThrow<DatabaseConfig>(DATABASE_CONFIG_KEY);

        return {
          type: 'postgres' as const,
          host: database.host,
          port: database.port,
          username: database.username,
          password: database.password,
          database: database.database,
          schema: database.schema,
          entities,
          migrations,
          migrationsTableName: 'typeorm_migrations',
          migrationsRun: database.migrationsRun,
          synchronize: database.synchronize,
          logging: database.logging ? ('all' as const) : (['error', 'warn'] as const),
          ssl: database.ssl.enabled
            ? {
                rejectUnauthorized: database.ssl.rejectUnauthorized,
                ...(database.ssl.ca ? { ca: database.ssl.ca } : {}),
              }
            : false,
          extra: {
            max: database.poolMax,
            idleTimeoutMillis: database.idleTimeoutMs,
            connectionTimeoutMillis: database.connectionTimeoutMs,
            // A server-side statement timeout is the last line of defence
            // against a pathological query pinning a connection for minutes and
            // starving the pool.
            statement_timeout: database.statementTimeoutMs,
            application_name: 'daiap-backend',
          },
          // Retry on boot: in Docker Compose the API frequently starts before
          // PostgreSQL finishes initialising.
          retryAttempts: 10,
          retryDelay: 3_000,
          autoLoadEntities: false,
        };
      },
    }),
  ],
  // Phase 5: binds every pooled connection to the workspace of the work using
  // it, for PostgreSQL row-level security (the third tenancy layer).
  providers: [RowLevelSecurityService],
  exports: [RowLevelSecurityService],
})
export class DatabaseModule {}
