// Must stay first: it disables queue workers before configuration is read.
import './seed-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { seedDemoData } from './demo.seed';
import { seedPermissions } from './permission.seed';
import { seedPlatformAdmin } from './platform-admin.seed';

/**
 * Seed entry point: `npm run seed`.
 *
 * Boots a full Nest application context rather than talking to the database
 * directly. That costs a second at startup and buys a great deal: the seeders
 * reuse the same services, validation, password hashing and audit logging as the
 * running API, so seeded data is indistinguishable from data created through it.
 * Raw SQL seeds routinely drift from application invariants — a workspace with
 * no system roles, a user whose password was hashed with the wrong parameters —
 * and those defects surface much later, as inexplicable runtime behaviour.
 *
 * Every step is idempotent, so this is safe to run on each deploy.
 */
async function runSeed(): Promise<void> {
  const logger = new Logger('Seed');
  const startedAt = Date.now();

  logger.log('Starting database seed...');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
    abortOnError: true,
  });

  try {
    // Order matters: roles reference permissions, and the demo workspace
    // references both.
    await seedPermissions(app);
    await seedPlatformAdmin(app);

    if (process.env.SEED_DEMO_DATA === 'true') {
      await seedDemoData(app);
    }

    logger.log(`Seed completed in ${Date.now() - startedAt}ms.`);
  } catch (error) {
    logger.error(`Seed failed: ${(error as Error).message}`);
    logger.error((error as Error).stack ?? '');
    await app.close();
    process.exit(1);
  }

  await app.close();
  process.exit(0);
}

void runSeed();
