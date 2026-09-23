import { registerAs } from '@nestjs/config';

export type MailTransportKind = 'log' | 'smtp';

export interface MailConfig {
  transport: MailTransportKind;
  from: {
    name: string;
    address: string;
  };
  replyTo?: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username?: string;
    password?: string;
    rejectUnauthorized: boolean;
  };
}

export const MAIL_CONFIG_KEY = 'mail';

export default registerAs(MAIL_CONFIG_KEY, (): MailConfig => {
  return {
    transport: (process.env.MAIL_TRANSPORT ?? 'log') as MailTransportKind,
    from: {
      name: process.env.MAIL_FROM_NAME as string,
      address: process.env.MAIL_FROM_ADDRESS as string,
    },
    replyTo: process.env.MAIL_REPLY_TO || undefined,
    smtp: {
      host: process.env.SMTP_HOST ?? '',
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      username: process.env.SMTP_USERNAME || undefined,
      password: process.env.SMTP_PASSWORD || undefined,
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
    },
  };
});
