import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Outbound email.
 *
 * Global because authentication, invitations and (from phase 4) workflow
 * notifications all send mail, and a single transport instance means one SMTP
 * connection pool rather than one per importing module.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
