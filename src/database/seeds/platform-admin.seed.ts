import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { evaluatePasswordStrength } from '../../common/validators/is-strong-password.validator';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { User, UserStatus } from '../../modules/users/entities/user.entity';
import { UsersService } from '../../modules/users/users.service';

/**
 * Provisions the initial platform administrator.
 *
 * Runs only when both `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` are
 * set, and does nothing if the account already exists. There is deliberately no
 * built-in default administrator: a shipped `admin@admin.com` with a known
 * password is the most reliably exploited vulnerability in self-hosted software,
 * and an operator who has not set these variables should have no privileged
 * account at all rather than a guessable one.
 *
 * The password is checked against the live policy before use, so an operator
 * cannot bootstrap the platform with a credential the platform would reject from
 * any of its own users.
 */
export async function seedPlatformAdmin(app: INestApplicationContext): Promise<void> {
  const logger = new Logger('Seed:PlatformAdmin');
  const configService = app.get(ConfigService);

  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const name = process.env.PLATFORM_ADMIN_NAME ?? 'Platform Administrator';

  if (!email || !password) {
    logger.log(
      'PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD not set; skipping. ' +
        'Register normally and promote the account manually if you need one.',
    );
    return;
  }

  const usersService = app.get(UsersService);
  const dataSource = app.get(DataSource);

  const existing = await usersService.findByEmail(email);

  if (existing) {
    if (!existing.isPlatformAdmin) {
      await dataSource
        .getRepository(User)
        .update({ id: existing.id }, { isPlatformAdmin: true });
      logger.log(`Promoted the existing account ${email} to platform administrator.`);
    } else {
      logger.log(`Platform administrator ${email} already exists; nothing to do.`);
    }
    return;
  }

  const security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  const strength = evaluatePasswordStrength(password, security.passwordPolicy, [email, name]);

  if (!strength.valid) {
    // Refusing is the right outcome: creating the single most privileged account
    // on the platform with a password the platform itself would reject is worse
    // than not creating it at all.
    throw new Error(
      `PLATFORM_ADMIN_PASSWORD does not satisfy the password policy:\n  - ${strength.errors.join(
        '\n  - ',
      )}`,
    );
  }

  const [firstName, ...rest] = name.split(' ');

  const admin = await usersService.create({
    email,
    password,
    firstName: firstName || 'Platform',
    lastName: rest.join(' ') || 'Administrator',
    // Pre-verified: the bootstrap account has no mailbox to confirm from, and
    // requiring verification would make the platform unadministrable on a
    // deployment whose SMTP is not configured yet.
    status: UserStatus.ACTIVE,
    isPlatformAdmin: true,
  });

  await dataSource
    .getRepository(User)
    .update({ id: admin.id }, { emailVerifiedAt: new Date() });

  logger.log(`Created platform administrator ${email}.`);
  logger.warn(
    'Sign in and change this password now. It is currently sitting in an ' +
      'environment variable and very likely in your shell history.',
  );
}
