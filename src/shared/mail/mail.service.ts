import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { APP_CONFIG_KEY, type AppConfig } from '../../config/app.config';
import { MAIL_CONFIG_KEY, type MailConfig } from '../../config/mail.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { maskEmail } from '../../common/utils/redact.util';
import { RequestContextService } from '../context/request-context.service';
import {
  agentMessageTemplate,
  invitationTemplate,
  passwordChangedTemplate,
  passwordResetTemplate,
  securityAlertTemplate,
  verifyEmailTemplate,
  type TemplateContext,
} from './mail.templates';
import type { MailMessage, MailSendResult, MailTransport } from './mail.types';

/**
 * Development transport: prints the message instead of sending it.
 *
 * The link is printed in full and deliberately unredacted, because the whole
 * point is that a developer can copy it out of the terminal and complete the
 * flow. This transport must never be selected outside development, which
 * {@link MailService} warns loudly about at boot.
 */
class LogMailTransport implements MailTransport {
  readonly name = 'log';
  private readonly logger = new Logger('MailTransport:log');

  // Implements the async MailTransport interface; nothing to await here.
  // eslint-disable-next-line @typescript-eslint/require-await
  async send(message: MailMessage): Promise<MailSendResult> {
    this.logger.log(
      [
        '',
        '━'.repeat(78),
        `  OUTBOUND EMAIL (not actually sent — MAIL_TRANSPORT=log)`,
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        message.tag ? `  Tag:     ${message.tag}` : '',
        '─'.repeat(78),
        message.text,
        '━'.repeat(78),
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return { accepted: true, messageId: `log-${Date.now()}`, transport: this.name };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface shape.
  async verify(): Promise<boolean> {
    return true;
  }
}

/** SMTP transport backed by nodemailer. */
class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly logger = new Logger('MailTransport:smtp');

  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
    private readonly defaultReplyTo?: string,
  ) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    const info: { accepted?: unknown[]; messageId?: string } =
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo ?? this.defaultReplyTo,
      });

    return {
      accepted: (info.accepted?.length ?? 0) > 0,
      messageId: info.messageId,
      transport: this.name,
    };
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      this.logger.warn(`SMTP verification failed: ${(error as Error).message}`);
      return false;
    }
  }
}

/**
 * Outbound transactional email.
 *
 * ## Delivery is never allowed to fail a request
 *
 * Every public method resolves even when delivery fails, logging the failure.
 * A user whose account was created successfully must not see a 500 because the
 * mail server was briefly unreachable — their account exists, and verification
 * can be re-requested. The failure is logged (and, for security-relevant
 * messages, audited by the caller) rather than surfaced.
 *
 * A durable outbox backed by BullMQ arrives with the queue infrastructure in
 * phase 4; until then, a failed send is retried by the user, not by the server.
 *
 * ## Addresses are masked in logs
 *
 * Recipient addresses are logged masked. They are personal data, and a platform
 * whose stated purpose is privacy preservation should not spill them into log
 * aggregation as a side effect of sending a password reset.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly mailConfig: MailConfig;
  private readonly appConfig: AppConfig;
  private readonly securityConfig: SecurityConfig;
  private transport!: MailTransport;

  constructor(
    private readonly configService: ConfigService,
    private readonly requestContext: RequestContextService,
  ) {
    this.mailConfig = this.configService.getOrThrow<MailConfig>(MAIL_CONFIG_KEY);
    this.appConfig = this.configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    this.securityConfig =
      this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  onModuleInit(): void {
    this.transport = this.createTransport();

    if (this.mailConfig.transport === 'log' && this.appConfig.isProduction) {
      this.logger.error(
        'MAIL_TRANSPORT is "log" in production. No email is being delivered — ' +
          'invitations, verification links and password resets will never reach anyone. ' +
          'Set MAIL_TRANSPORT=smtp and configure SMTP_*.',
      );
    } else {
      this.logger.log(`Mail transport: ${this.transport.name}`);
    }
  }

  private createTransport(): MailTransport {
    if (this.mailConfig.transport !== 'smtp') {
      return new LogMailTransport();
    }

    const transporter = nodemailer.createTransport({
      host: this.mailConfig.smtp.host,
      port: this.mailConfig.smtp.port,
      secure: this.mailConfig.smtp.secure,
      auth: this.mailConfig.smtp.username
        ? {
            user: this.mailConfig.smtp.username,
            pass: this.mailConfig.smtp.password,
          }
        : undefined,
      tls: {
        // Disabling certificate validation would make STARTTLS decorative, so
        // it is opt-out via configuration and defaults to on.
        rejectUnauthorized: this.mailConfig.smtp.rejectUnauthorized,
      },
    });

    return new SmtpMailTransport(
      transporter,
      `"${this.mailConfig.from.name}" <${this.mailConfig.from.address}>`,
      this.mailConfig.replyTo,
    );
  }

  private get templateContext(): TemplateContext {
    return {
      appName: this.appConfig.name,
      frontendUrl: this.appConfig.frontendUrl,
    };
  }

  /**
   * Sends a message, swallowing delivery failures.
   *
   * See the class comment for why this never throws.
   */
  private async deliver(message: MailMessage): Promise<MailSendResult> {
    const correlationId = message.correlationId ?? this.requestContext.requestId;

    try {
      const result = await this.transport.send({ ...message, correlationId });

      this.logger.log(
        { tag: message.tag, messageId: result.messageId, requestId: correlationId },
        `Sent "${message.subject}" to ${maskEmail(message.to)}.`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        { tag: message.tag, requestId: correlationId, err: error as Error },
        `Failed to send "${message.subject}" to ${maskEmail(message.to)}.`,
      );

      return { accepted: false, transport: this.transport.name };
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async sendEmailVerification(
    to: string,
    name: string,
    token: string,
  ): Promise<MailSendResult> {
    const url = `${this.appConfig.frontendUrl}/auth/verify-email?token=${encodeURIComponent(token)}`;
    const hours = Math.round(this.securityConfig.tokens.emailVerificationTtlMs / 3_600_000);

    const rendered = verifyEmailTemplate(this.templateContext, {
      name,
      verificationUrl: url,
      expiresInHours: hours,
    });

    return this.deliver({ to, ...rendered, tag: 'email-verification' });
  }

  async sendPasswordReset(
    to: string,
    name: string,
    token: string,
    requestIp?: string,
  ): Promise<MailSendResult> {
    const url = `${this.appConfig.frontendUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
    const minutes = Math.round(this.securityConfig.tokens.passwordResetTtlMs / 60_000);

    const rendered = passwordResetTemplate(this.templateContext, {
      name,
      resetUrl: url,
      expiresInMinutes: minutes,
      requestIp,
    });

    return this.deliver({ to, ...rendered, tag: 'password-reset' });
  }

  async sendInvitation(
    to: string,
    params: {
      inviterName: string;
      organizationName: string;
      roleName: string;
      token: string;
      message?: string;
    },
  ): Promise<MailSendResult> {
    const url = `${this.appConfig.frontendUrl}/invitations/accept?token=${encodeURIComponent(params.token)}`;
    const days = Math.round(this.securityConfig.tokens.invitationTtlMs / 86_400_000);

    const rendered = invitationTemplate(this.templateContext, {
      inviterName: params.inviterName,
      organizationName: params.organizationName,
      roleName: params.roleName,
      acceptUrl: url,
      expiresInDays: days,
      message: params.message,
    });

    return this.deliver({ to, ...rendered, tag: 'invitation' });
  }

  /**
   * Notifies a user that their password changed.
   *
   * Sent after the fact, not as a confirmation step. If the change was made by
   * an attacker who already held the account, this message is the legitimate
   * owner's only signal that it happened.
   */
  async sendPasswordChangedNotice(
    to: string,
    name: string,
    ip?: string,
  ): Promise<MailSendResult> {
    const rendered = passwordChangedTemplate(this.templateContext, {
      name,
      changedAt: new Date().toUTCString(),
      ip,
    });

    return this.deliver({ to, ...rendered, tag: 'password-changed' });
  }

  /** Notifies a user of a detected security event, such as refresh token reuse. */
  async sendSecurityAlert(
    to: string,
    name: string,
    event: string,
    detail: string,
  ): Promise<MailSendResult> {
    const rendered = securityAlertTemplate(this.templateContext, {
      name,
      event,
      detail,
      occurredAt: new Date().toUTCString(),
    });

    return this.deliver({ to, ...rendered, tag: 'security-alert' });
  }

  /**
   * A message written by an agent for a workspace member (the `send_email`
   * tool). Resolves `accepted: false` rather than throwing, like every send.
   */
  async sendAgentMessage(
    to: string,
    params: {
      subject: string;
      body: string;
      agentName: string;
      onBehalfOf: string;
      workspaceName: string;
    },
  ): Promise<MailSendResult> {
    const rendered = agentMessageTemplate(this.templateContext, params);
    return this.deliver({ to, ...rendered, tag: 'agent-message' });
  }

  /** Connectivity check, surfaced by the health endpoint. */
  async verifyTransport(): Promise<boolean> {
    return this.transport.verify();
  }

  get transportName(): string {
    return this.transport?.name ?? this.mailConfig.transport;
  }
}
