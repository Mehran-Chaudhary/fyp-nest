/**
 * Transactional email templates.
 *
 * Kept as plain functions rather than a template-engine dependency: there are
 * five messages, they change rarely, and a template engine would add a
 * filesystem dependency that has to be handled again at build time for the
 * compiled output.
 *
 * Every message ships both an HTML and a plain-text body. Text is not a
 * courtesy — many corporate mail gateways strip HTML, and an invitation whose
 * link is invisible in the received message is an invitation that does not work.
 *
 * All interpolated values pass through {@link escapeHtml}. These templates carry
 * user-supplied names and workspace titles; without escaping, a workspace named
 * `<img src=x onerror=...>` would deliver script into every invitee's mail
 * client.
 */

export interface TemplateContext {
  appName: string;
  frontendUrl: string;
  supportAddress?: string;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

/** Escapes the five characters that matter in HTML text and attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND_COLOR = '#4f46e5';

function layout(context: TemplateContext, heading: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2933;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td>
          <p style="margin:0 0 24px;font-size:14px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${BRAND_COLOR};">${escapeHtml(context.appName)}</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(heading)}</h1>
          ${body}
        </td></tr>
      </table>
      <p style="max-width:560px;margin:24px auto 0;font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">
        This is an automated message from ${escapeHtml(context.appName)}.
        If you were not expecting it, you can safely ignore it.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:0 0 24px;">
    <a href="${escapeHtml(url)}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(label)}</a>
  </p>
  <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">If the button does not work, paste this address into your browser:</p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${escapeHtml(url)}" style="color:${BRAND_COLOR};">${escapeHtml(url)}</a></p>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(text)}</p>`;
}

// ── Templates ───────────────────────────────────────────────────────────────

export function verifyEmailTemplate(
  context: TemplateContext,
  params: { name: string; verificationUrl: string; expiresInHours: number },
): RenderedTemplate {
  const heading = 'Confirm your email address';

  return {
    subject: `Confirm your email address for ${context.appName}`,
    html: layout(
      context,
      heading,
      paragraph(`Hello ${params.name},`) +
        paragraph(
          'Confirm your email address to finish setting up your account and start creating workspaces.',
        ) +
        button(params.verificationUrl, 'Confirm email address') +
        paragraph(`This link expires in ${params.expiresInHours} hours.`),
    ),
    text: [
      `Hello ${params.name},`,
      '',
      `Confirm your email address to finish setting up your ${context.appName} account:`,
      params.verificationUrl,
      '',
      `This link expires in ${params.expiresInHours} hours.`,
      '',
      'If you did not create an account, you can ignore this message.',
    ].join('\n'),
  };
}

export function passwordResetTemplate(
  context: TemplateContext,
  params: { name: string; resetUrl: string; expiresInMinutes: number; requestIp?: string },
): RenderedTemplate {
  const heading = 'Reset your password';

  return {
    subject: `Reset your ${context.appName} password`,
    html: layout(
      context,
      heading,
      paragraph(`Hello ${params.name},`) +
        paragraph(
          'We received a request to reset your password. Choose a new one using the link below.',
        ) +
        button(params.resetUrl, 'Choose a new password') +
        paragraph(
          `This link expires in ${params.expiresInMinutes} minutes and can be used once.`,
        ) +
        // Including the requesting IP turns a phishing-shaped message into
        // something the recipient can actually evaluate.
        (params.requestIp ? paragraph(`This request came from ${params.requestIp}.`) : '') +
        paragraph(
          'If you did not request this, no action is needed — your password has not changed.',
        ),
    ),
    text: [
      `Hello ${params.name},`,
      '',
      'We received a request to reset your password. Use this link to choose a new one:',
      params.resetUrl,
      '',
      `This link expires in ${params.expiresInMinutes} minutes and can be used once.`,
      params.requestIp ? `This request came from ${params.requestIp}.` : '',
      '',
      'If you did not request this, no action is needed — your password has not changed.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function invitationTemplate(
  context: TemplateContext,
  params: {
    inviterName: string;
    organizationName: string;
    roleName: string;
    acceptUrl: string;
    expiresInDays: number;
    message?: string;
  },
): RenderedTemplate {
  const heading = `${params.inviterName} invited you to ${params.organizationName}`;

  return {
    subject: `You have been invited to join ${params.organizationName}`,
    html: layout(
      context,
      heading,
      paragraph(
        `${params.inviterName} has invited you to join the "${params.organizationName}" workspace as ${params.roleName}.`,
      ) +
        (params.message
          ? `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid ${BRAND_COLOR};background:#f9fafb;font-size:15px;color:#374151;">${escapeHtml(params.message)}</blockquote>`
          : '') +
        button(params.acceptUrl, 'Accept invitation') +
        paragraph(`This invitation expires in ${params.expiresInDays} days.`),
    ),
    text: [
      `${params.inviterName} has invited you to join the "${params.organizationName}" workspace as ${params.roleName}.`,
      '',
      params.message ? `Message: ${params.message}` : '',
      '',
      'Accept the invitation:',
      params.acceptUrl,
      '',
      `This invitation expires in ${params.expiresInDays} days.`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function passwordChangedTemplate(
  context: TemplateContext,
  params: { name: string; changedAt: string; ip?: string },
): RenderedTemplate {
  const heading = 'Your password was changed';

  return {
    subject: `Your ${context.appName} password was changed`,
    html: layout(
      context,
      heading,
      paragraph(`Hello ${params.name},`) +
        paragraph(`Your password was changed on ${params.changedAt}.`) +
        (params.ip ? paragraph(`The change was made from ${params.ip}.`) : '') +
        paragraph(
          'Every other signed-in session has been signed out. ' +
            'If this was not you, reset your password immediately and contact your administrator.',
        ),
    ),
    text: [
      `Hello ${params.name},`,
      '',
      `Your password was changed on ${params.changedAt}.`,
      params.ip ? `The change was made from ${params.ip}.` : '',
      '',
      'Every other signed-in session has been signed out.',
      'If this was not you, reset your password immediately and contact your administrator.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function securityAlertTemplate(
  context: TemplateContext,
  params: { name: string; event: string; detail: string; occurredAt: string },
): RenderedTemplate {
  const heading = 'Security alert on your account';

  return {
    subject: `Security alert: ${params.event}`,
    html: layout(
      context,
      heading,
      paragraph(`Hello ${params.name},`) +
        paragraph(`${params.detail}`) +
        paragraph(`This happened on ${params.occurredAt}.`) +
        paragraph(
          'As a precaution, you have been signed out on every device. ' +
            'Sign in again to continue, and change your password if you do not recognise this activity.',
        ),
    ),
    text: [
      `Hello ${params.name},`,
      '',
      params.detail,
      `This happened on ${params.occurredAt}.`,
      '',
      'As a precaution, you have been signed out on every device.',
      'Sign in again to continue, and change your password if you do not recognise this activity.',
    ].join('\n'),
  };
}

/**
 * A message an agent sent on a member's behalf (the `send_email` tool, phase 4).
 *
 * Says plainly that an agent wrote it and on whose behalf, so a recipient can
 * tell automation from a colleague — and can tell who to ask if it was
 * unexpected. The body is plain text written by a model: it is escaped and
 * rendered as preformatted text, never as HTML.
 */
export function agentMessageTemplate(
  context: TemplateContext,
  params: {
    subject: string;
    body: string;
    agentName: string;
    onBehalfOf: string;
    workspaceName: string;
  },
): RenderedTemplate {
  const provenance =
    `Sent by the agent “${params.agentName}” on behalf of ${params.onBehalfOf}, ` +
    `in the ${params.workspaceName} workspace.`;

  return {
    subject: params.subject,
    html: layout(
      context,
      params.subject,
      `<pre style="margin:0 0 24px;font-family:inherit;font-size:15px;line-height:1.6;color:#374151;white-space:pre-wrap;">${escapeHtml(params.body)}</pre>` +
        `<p style="margin:0;font-size:13px;color:#6b7280;">${escapeHtml(provenance)}</p>`,
    ),
    text: [params.body, '', '—', provenance].join('\n'),
  };
}
