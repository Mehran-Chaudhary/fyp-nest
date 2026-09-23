/**
 * The controlled vocabulary of auditable actions.
 *
 * Module 6.15 of the proposal requires an immutable compliance log of "every
 * agent action, tool call, access denial and PII redaction event". A free-text
 * action column would make that log unqueryable, so actions are enumerated here
 * and the enum is treated as append-only: values are added over time but never
 * renamed or removed, because historical rows reference them forever.
 *
 * Actions for later phases are declared now so that the audit vocabulary — and
 * therefore the compliance dashboard — does not churn as modules land.
 */
export enum AuditAction {
  // ── Authentication (6.1) ──────────────────────────────────────────────────
  USER_REGISTERED = 'user.registered',
  USER_LOGIN_SUCCEEDED = 'user.login.succeeded',
  USER_LOGIN_FAILED = 'user.login.failed',
  USER_LOGGED_OUT = 'user.logged_out',
  USER_LOGGED_OUT_ALL = 'user.logged_out_all',
  USER_TOKEN_REFRESHED = 'user.token.refreshed',
  USER_TOKEN_REUSE_DETECTED = 'user.token.reuse_detected',
  USER_EMAIL_VERIFICATION_SENT = 'user.email.verification_sent',
  USER_EMAIL_VERIFIED = 'user.email.verified',
  USER_PASSWORD_CHANGED = 'user.password.changed',
  USER_PASSWORD_RESET_REQUESTED = 'user.password.reset_requested',
  USER_PASSWORD_RESET_COMPLETED = 'user.password.reset_completed',
  USER_ACCOUNT_LOCKED = 'user.account.locked',
  USER_ACCOUNT_UNLOCKED = 'user.account.unlocked',
  USER_PROFILE_UPDATED = 'user.profile.updated',
  USER_SESSION_REVOKED = 'user.session.revoked',
  USER_DEACTIVATED = 'user.deactivated',

  // ── Organization workspace (6.2) ──────────────────────────────────────────
  ORGANIZATION_CREATED = 'organization.created',
  ORGANIZATION_UPDATED = 'organization.updated',
  ORGANIZATION_DELETED = 'organization.deleted',
  ORGANIZATION_SUSPENDED = 'organization.suspended',
  ORGANIZATION_REACTIVATED = 'organization.reactivated',
  ORGANIZATION_OWNERSHIP_TRANSFERRED = 'organization.ownership.transferred',
  ORGANIZATION_SETTINGS_UPDATED = 'organization.settings.updated',
  ORGANIZATION_IP_RULE_ADDED = 'organization.ip_rule.added',
  ORGANIZATION_IP_RULE_REMOVED = 'organization.ip_rule.removed',
  ORGANIZATION_IP_BLOCKED = 'organization.ip.blocked',

  // ── Membership & invitations (6.2) ────────────────────────────────────────
  MEMBER_INVITED = 'member.invited',
  MEMBER_INVITATION_RESENT = 'member.invitation.resent',
  MEMBER_INVITATION_REVOKED = 'member.invitation.revoked',
  MEMBER_INVITATION_ACCEPTED = 'member.invitation.accepted',
  MEMBER_JOINED = 'member.joined',
  MEMBER_UPDATED = 'member.updated',
  MEMBER_SUSPENDED = 'member.suspended',
  MEMBER_REACTIVATED = 'member.reactivated',
  MEMBER_REMOVED = 'member.removed',
  MEMBER_LEFT = 'member.left',

  // ── RBAC (6.3) ────────────────────────────────────────────────────────────
  ROLE_CREATED = 'role.created',
  ROLE_UPDATED = 'role.updated',
  ROLE_DELETED = 'role.deleted',
  ROLE_PERMISSIONS_UPDATED = 'role.permissions.updated',
  ROLE_ASSIGNED = 'role.assigned',
  ROLE_UNASSIGNED = 'role.unassigned',
  ACCESS_DENIED = 'access.denied',

  // ── API keys / service identities ─────────────────────────────────────────
  API_KEY_CREATED = 'api_key.created',
  API_KEY_REVOKED = 'api_key.revoked',
  API_KEY_USED = 'api_key.used',
  API_KEY_REJECTED = 'api_key.rejected',

  // ── Documents & knowledge (6.4, 6.5) — later phases ───────────────────────
  DOCUMENT_UPLOADED = 'document.uploaded',
  DOCUMENT_PARSED = 'document.parsed',
  DOCUMENT_EMBEDDED = 'document.embedded',
  DOCUMENT_DELETED = 'document.deleted',
  DOCUMENT_DOWNLOADED = 'document.downloaded',
  KNOWLEDGE_BASE_CREATED = 'knowledge_base.created',
  KNOWLEDGE_BASE_UPDATED = 'knowledge_base.updated',
  KNOWLEDGE_BASE_DELETED = 'knowledge_base.deleted',

  // ── Secure RAG (6.6) — later phases ───────────────────────────────────────
  RAG_QUERY_EXECUTED = 'rag.query.executed',
  RAG_ACCESS_FILTERED = 'rag.access.filtered',

  // ── LLM gateway (6.7) — later phases ──────────────────────────────────────
  LLM_INFERENCE_REQUESTED = 'llm.inference.requested',
  LLM_INFERENCE_COMPLETED = 'llm.inference.completed',
  LLM_INFERENCE_FAILED = 'llm.inference.failed',

  // ── Agents (6.8, 6.10) — later phases ─────────────────────────────────────
  AGENT_CREATED = 'agent.created',
  AGENT_UPDATED = 'agent.updated',
  AGENT_DELETED = 'agent.deleted',
  AGENT_INVOKED = 'agent.invoked',
  AGENT_CONVERSATION_STARTED = 'agent.conversation.started',
  AGENT_CONVERSATION_DELETED = 'agent.conversation.deleted',

  // ── Workflows & tools (6.9, 6.11) — later phases ──────────────────────────
  WORKFLOW_CREATED = 'workflow.created',
  WORKFLOW_UPDATED = 'workflow.updated',
  WORKFLOW_DELETED = 'workflow.deleted',
  WORKFLOW_EXECUTION_STARTED = 'workflow.execution.started',
  WORKFLOW_EXECUTION_COMPLETED = 'workflow.execution.completed',
  WORKFLOW_EXECUTION_FAILED = 'workflow.execution.failed',
  WORKFLOW_EXECUTION_DEAD_LETTERED = 'workflow.execution.dead_lettered',
  TOOL_EXECUTED = 'tool.executed',
  TOOL_EXECUTION_DENIED = 'tool.execution.denied',

  // ── PII redaction (6.12) — later phases ───────────────────────────────────
  PII_REDACTED = 'pii.redacted',
  PII_UNMASKED = 'pii.unmasked',
  PII_POLICY_UPDATED = 'pii.policy.updated',

  // ── Quota & throttling (6.14) ─────────────────────────────────────────────
  RATE_LIMIT_TRIGGERED = 'rate_limit.triggered',
  QUOTA_EXHAUSTED = 'quota.exhausted',
  AGENT_CIRCUIT_BROKEN = 'agent.circuit_broken',

  // ── Audit itself (6.15) ───────────────────────────────────────────────────
  AUDIT_LOG_EXPORTED = 'audit.log.exported',
  AUDIT_CHAIN_VERIFIED = 'audit.chain.verified',
  AUDIT_CHAIN_TAMPER_DETECTED = 'audit.chain.tamper_detected',
}

/** Outcome recorded alongside each audited action. */
export enum AuditStatus {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  DENIED = 'DENIED',
}

/**
 * Severity drives alerting and dashboard colour-coding. It is derived from the
 * action rather than stored per call site so that severity stays consistent.
 */
export enum AuditSeverity {
  INFO = 'INFO',
  NOTICE = 'NOTICE',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

/** Actions that always warrant security attention regardless of their outcome. */
const CRITICAL_ACTIONS: ReadonlySet<AuditAction> = new Set([
  AuditAction.USER_TOKEN_REUSE_DETECTED,
  AuditAction.AUDIT_CHAIN_TAMPER_DETECTED,
  AuditAction.ORGANIZATION_IP_BLOCKED,
  AuditAction.PII_UNMASKED,
]);

const WARNING_ACTIONS: ReadonlySet<AuditAction> = new Set([
  AuditAction.USER_LOGIN_FAILED,
  AuditAction.USER_ACCOUNT_LOCKED,
  AuditAction.ACCESS_DENIED,
  AuditAction.API_KEY_REJECTED,
  AuditAction.RATE_LIMIT_TRIGGERED,
  AuditAction.QUOTA_EXHAUSTED,
  AuditAction.TOOL_EXECUTION_DENIED,
  AuditAction.WORKFLOW_EXECUTION_DEAD_LETTERED,
  AuditAction.AGENT_CIRCUIT_BROKEN,
  AuditAction.RAG_ACCESS_FILTERED,
]);

const NOTICE_ACTIONS: ReadonlySet<AuditAction> = new Set([
  AuditAction.ORGANIZATION_OWNERSHIP_TRANSFERRED,
  AuditAction.ORGANIZATION_DELETED,
  AuditAction.ORGANIZATION_SUSPENDED,
  AuditAction.ROLE_PERMISSIONS_UPDATED,
  AuditAction.ROLE_ASSIGNED,
  AuditAction.ROLE_UNASSIGNED,
  AuditAction.API_KEY_CREATED,
  AuditAction.API_KEY_REVOKED,
  AuditAction.MEMBER_REMOVED,
  AuditAction.USER_PASSWORD_CHANGED,
  AuditAction.USER_PASSWORD_RESET_COMPLETED,
  AuditAction.USER_LOGGED_OUT_ALL,
  AuditAction.DOCUMENT_DELETED,
  AuditAction.PII_POLICY_UPDATED,
]);

export function severityForAction(action: AuditAction, status: AuditStatus): AuditSeverity {
  if (CRITICAL_ACTIONS.has(action)) return AuditSeverity.CRITICAL;
  if (status === AuditStatus.DENIED) return AuditSeverity.WARNING;
  if (WARNING_ACTIONS.has(action)) {
    return status === AuditStatus.FAILURE ? AuditSeverity.WARNING : AuditSeverity.NOTICE;
  }
  if (NOTICE_ACTIONS.has(action)) return AuditSeverity.NOTICE;
  return status === AuditStatus.FAILURE ? AuditSeverity.WARNING : AuditSeverity.INFO;
}
