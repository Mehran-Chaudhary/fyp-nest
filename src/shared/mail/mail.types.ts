export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /**
   * Correlates the send with the request that triggered it, so a "did the
   * invitation go out?" question can be answered from the logs.
   */
  correlationId?: string;
  /** Categorises the send for rate limiting and reporting. */
  tag?: string;
}

export interface MailSendResult {
  accepted: boolean;
  messageId?: string;
  transport: string;
}

/**
 * A delivery mechanism.
 *
 * Abstracted so that development needs no SMTP server at all — the log transport
 * prints the message, including the verification or invitation link, straight to
 * the console. That removes the single most common onboarding obstacle for a
 * project like this: a new contributor cannot complete registration because
 * nobody gave them mail credentials.
 */
export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<MailSendResult>;
  verify(): Promise<boolean>;
}
