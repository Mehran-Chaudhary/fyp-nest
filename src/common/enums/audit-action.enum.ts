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
  // Phase 5: the second factor, breached-password screening, and data rights.
  USER_MFA_ENROLLMENT_STARTED = 'user.mfa.enrollment_started',
  USER_MFA_ENABLED = 'user.mfa.enabled',
  USER_MFA_DISABLED = 'user.mfa.disabled',
  USER_MFA_CHALLENGE_FAILED = 'user.mfa.challenge_failed',
  USER_MFA_RECOVERY_CODE_USED = 'user.mfa.recovery_code_used',
  USER_MFA_RECOVERY_CODES_REGENERATED = 'user.mfa.recovery_codes_regenerated',
  /** A new password was refused (or, in `warn` mode, accepted) because it is breached. */
  USER_PASSWORD_BREACH_DETECTED = 'user.password.breach_detected',
  USER_DATA_EXPORTED = 'user.data.exported',
  /** The right to be forgotten: identity anonymised, personal content crypto-shredded. */
  USER_ERASED = 'user.erased',

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

  // ── Documents & knowledge (6.4, 6.5) ──────────────────────────────────────
  DOCUMENT_UPLOADED = 'document.uploaded',
  DOCUMENT_PARSED = 'document.parsed',
  DOCUMENT_EMBEDDED = 'document.embedded',
  DOCUMENT_DELETED = 'document.deleted',
  DOCUMENT_DOWNLOADED = 'document.downloaded',
  KNOWLEDGE_BASE_CREATED = 'knowledge_base.created',
  KNOWLEDGE_BASE_UPDATED = 'knowledge_base.updated',
  KNOWLEDGE_BASE_DELETED = 'knowledge_base.deleted',
  KNOWLEDGE_BASE_ACCESS_GRANTED = 'knowledge_base.access.granted',
  KNOWLEDGE_BASE_ACCESS_REVOKED = 'knowledge_base.access.revoked',
  DOCUMENT_UPDATED = 'document.updated',
  DOCUMENT_RECLASSIFIED = 'document.reclassified',
  DOCUMENT_REINDEX_REQUESTED = 'document.reindex_requested',
  /** A file was refused at upload: wrong type, disguised content, macros. */
  DOCUMENT_UPLOAD_REJECTED = 'document.upload.rejected',
  DOCUMENT_INGESTION_FAILED = 'document.ingestion.failed',
  DOCUMENT_INGESTION_DEAD_LETTERED = 'document.ingestion.dead_lettered',
  /** Content destroyed: vectors, chunks, stored object and the data key. */
  DOCUMENT_PURGED = 'document.purged',

  // ── Secure RAG (6.6) ──────────────────────────────────────────────────────
  RAG_QUERY_EXECUTED = 'rag.query.executed',
  RAG_ACCESS_FILTERED = 'rag.access.filtered',

  // ── LLM gateway (6.7) ─────────────────────────────────────────────────────
  LLM_INFERENCE_REQUESTED = 'llm.inference.requested',
  LLM_INFERENCE_COMPLETED = 'llm.inference.completed',
  LLM_INFERENCE_FAILED = 'llm.inference.failed',
  LLM_POLICY_UPDATED = 'llm.policy.updated',

  // ── Agents (6.8, 6.10) ────────────────────────────────────────────────────
  AGENT_CREATED = 'agent.created',
  AGENT_UPDATED = 'agent.updated',
  AGENT_DELETED = 'agent.deleted',
  AGENT_INVOKED = 'agent.invoked',
  AGENT_CONVERSATION_STARTED = 'agent.conversation.started',
  AGENT_CONVERSATION_DELETED = 'agent.conversation.deleted',
  AGENT_PUBLISHED = 'agent.published',
  AGENT_UNPUBLISHED = 'agent.unpublished',
  AGENT_ACCESS_UPDATED = 'agent.access.updated',
  AGENT_VERSION_RESTORED = 'agent.version.restored',
  /** Someone read a conversation that is not theirs (supervision). */
  AGENT_CONVERSATION_SUPERVISED = 'agent.conversation.supervised',

  // ── Workflows & tools (6.9, 6.11) ─────────────────────────────────────────
  WORKFLOW_CREATED = 'workflow.created',
  WORKFLOW_UPDATED = 'workflow.updated',
  WORKFLOW_DELETED = 'workflow.deleted',
  WORKFLOW_EXECUTION_STARTED = 'workflow.execution.started',
  WORKFLOW_EXECUTION_COMPLETED = 'workflow.execution.completed',
  WORKFLOW_EXECUTION_FAILED = 'workflow.execution.failed',
  WORKFLOW_EXECUTION_DEAD_LETTERED = 'workflow.execution.dead_lettered',
  TOOL_EXECUTED = 'tool.executed',
  TOOL_EXECUTION_DENIED = 'tool.execution.denied',
  /** Published, so that runs may start. */
  WORKFLOW_PUBLISHED = 'workflow.published',
  WORKFLOW_ARCHIVED = 'workflow.archived',
  WORKFLOW_VERSION_RESTORED = 'workflow.version.restored',
  WORKFLOW_EXECUTION_CANCELLED = 'workflow.execution.cancelled',
  WORKFLOW_EXECUTION_RESUMED = 'workflow.execution.resumed',
  WORKFLOW_EXECUTION_TIMED_OUT = 'workflow.execution.timed_out',
  WORKFLOW_RUN_DELETED = 'workflow.run.deleted',
  /** Someone read the content of a run they did not start (supervision). */
  WORKFLOW_RUN_SUPERVISED = 'workflow.run.supervised',
  /** One node of a run finished. The unit from which a run's trace is rebuilt. */
  WORKFLOW_STEP_COMPLETED = 'workflow.step.completed',
  WORKFLOW_STEP_FAILED = 'workflow.step.failed',
  /** A queued job failed authentication: forged, tampered with or replayed across runs. */
  WORKFLOW_STEP_REJECTED = 'workflow.step.rejected',
  WORKFLOW_APPROVAL_REQUESTED = 'workflow.approval.requested',
  WORKFLOW_APPROVAL_GRANTED = 'workflow.approval.granted',
  WORKFLOW_APPROVAL_REJECTED = 'workflow.approval.rejected',
  TOOL_CREATED = 'tool.created',
  TOOL_UPDATED = 'tool.updated',
  TOOL_DELETED = 'tool.deleted',
  /** Authorised and started, but the tool itself failed or timed out. */
  TOOL_EXECUTION_FAILED = 'tool.execution.failed',

  // ── Real-time (6.16) ──────────────────────────────────────────────────────
  REALTIME_CONNECTION_REJECTED = 'realtime.connection.rejected',
  /** A socket asked for events it may not see — usually a probe across tenants. */
  REALTIME_SUBSCRIPTION_DENIED = 'realtime.subscription.denied',

  // ── PII redaction (6.12) ──────────────────────────────────────────────────
  PII_REDACTED = 'pii.redacted',
  PII_UNMASKED = 'pii.unmasked',
  PII_POLICY_UPDATED = 'pii.policy.updated',
  /** Detection was unavailable and the policy refused to proceed (fail closed). */
  PII_REDACTION_FAILED = 'pii.redaction.failed',
  /** The gateway's final check found sensitive data in an outgoing prompt. */
  PII_EGRESS_BLOCKED = 'pii.egress.blocked',

  // ── Quota & throttling (6.14) ─────────────────────────────────────────────
  RATE_LIMIT_TRIGGERED = 'rate_limit.triggered',
  QUOTA_EXHAUSTED = 'quota.exhausted',
  AGENT_CIRCUIT_BROKEN = 'agent.circuit_broken',
  // Phase 5.
  QUOTA_CREATED = 'quota.created',
  QUOTA_UPDATED = 'quota.updated',
  QUOTA_DELETED = 'quota.deleted',
  /** A budget crossed its alert threshold (once per period). */
  QUOTA_THRESHOLD_REACHED = 'quota.threshold_reached',
  /** The per-minute token rate refused a model call. */
  QUOTA_RATE_LIMITED = 'quota.rate_limited',
  AGENT_CIRCUIT_RESET = 'agent.circuit_reset',

  // ── Audit itself (6.15) ───────────────────────────────────────────────────
  AUDIT_LOG_EXPORTED = 'audit.log.exported',
  AUDIT_CHAIN_VERIFIED = 'audit.chain.verified',
  AUDIT_CHAIN_TAMPER_DETECTED = 'audit.chain.tamper_detected',
  // Phase 5: retention through the documented deletion escape hatch.
  AUDIT_LOG_PRUNED = 'audit.log.pruned',

  // ── Data lifecycle (phase 5) ──────────────────────────────────────────────
  DATA_RETENTION_APPLIED = 'data.retention.applied',
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
  AuditAction.PII_EGRESS_BLOCKED,
  AuditAction.WORKFLOW_STEP_REJECTED,
  AuditAction.USER_MFA_DISABLED,
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
  AuditAction.DOCUMENT_UPLOAD_REJECTED,
  AuditAction.DOCUMENT_INGESTION_FAILED,
  AuditAction.DOCUMENT_INGESTION_DEAD_LETTERED,
  AuditAction.PII_REDACTION_FAILED,
  AuditAction.LLM_INFERENCE_FAILED,
  AuditAction.WORKFLOW_EXECUTION_FAILED,
  AuditAction.WORKFLOW_EXECUTION_TIMED_OUT,
  AuditAction.WORKFLOW_STEP_FAILED,
  AuditAction.TOOL_EXECUTION_FAILED,
  AuditAction.REALTIME_CONNECTION_REJECTED,
  AuditAction.REALTIME_SUBSCRIPTION_DENIED,
  AuditAction.USER_MFA_CHALLENGE_FAILED,
  AuditAction.USER_PASSWORD_BREACH_DETECTED,
  AuditAction.QUOTA_RATE_LIMITED,
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
  AuditAction.DOCUMENT_DOWNLOADED,
  AuditAction.DOCUMENT_RECLASSIFIED,
  AuditAction.DOCUMENT_PURGED,
  AuditAction.KNOWLEDGE_BASE_DELETED,
  AuditAction.KNOWLEDGE_BASE_ACCESS_GRANTED,
  AuditAction.KNOWLEDGE_BASE_ACCESS_REVOKED,
  AuditAction.PII_POLICY_UPDATED,
  AuditAction.LLM_POLICY_UPDATED,
  AuditAction.AGENT_DELETED,
  AuditAction.AGENT_PUBLISHED,
  AuditAction.AGENT_UNPUBLISHED,
  AuditAction.AGENT_ACCESS_UPDATED,
  AuditAction.AGENT_VERSION_RESTORED,
  AuditAction.AGENT_CONVERSATION_DELETED,
  AuditAction.AGENT_CONVERSATION_SUPERVISED,
  AuditAction.WORKFLOW_DELETED,
  AuditAction.WORKFLOW_PUBLISHED,
  AuditAction.WORKFLOW_ARCHIVED,
  AuditAction.WORKFLOW_VERSION_RESTORED,
  AuditAction.WORKFLOW_EXECUTION_CANCELLED,
  AuditAction.WORKFLOW_EXECUTION_RESUMED,
  AuditAction.WORKFLOW_RUN_DELETED,
  AuditAction.WORKFLOW_RUN_SUPERVISED,
  AuditAction.WORKFLOW_APPROVAL_REQUESTED,
  AuditAction.WORKFLOW_APPROVAL_GRANTED,
  AuditAction.WORKFLOW_APPROVAL_REJECTED,
  AuditAction.TOOL_CREATED,
  AuditAction.TOOL_UPDATED,
  AuditAction.TOOL_DELETED,
  AuditAction.USER_MFA_ENABLED,
  AuditAction.USER_MFA_RECOVERY_CODE_USED,
  AuditAction.USER_MFA_RECOVERY_CODES_REGENERATED,
  AuditAction.USER_DATA_EXPORTED,
  AuditAction.USER_ERASED,
  AuditAction.QUOTA_CREATED,
  AuditAction.QUOTA_UPDATED,
  AuditAction.QUOTA_DELETED,
  AuditAction.QUOTA_THRESHOLD_REACHED,
  AuditAction.AGENT_CIRCUIT_RESET,
  AuditAction.AUDIT_LOG_PRUNED,
  AuditAction.DATA_RETENTION_APPLIED,
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
