/**
 * Stable, machine readable error codes.
 *
 * Every error the API returns carries one of these. HTTP status codes are too
 * coarse for a client to act on (a 403 could mean "wrong role", "IP blocked" or
 * "workspace suspended", each of which needs different UI), so the code — not
 * the message — is the contract. Messages may be reworded or localised freely;
 * codes may not, because the React frontend branches on them.
 *
 * Naming convention: `DOMAIN_SPECIFIC_CONDITION`.
 */
export enum ErrorCode {
  // ── Generic ───────────────────────────────────────────────────────────────
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_CONFLICT = 'RESOURCE_CONFLICT',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  DEPENDENCY_FAILURE = 'DEPENDENCY_FAILURE',

  // ── Authentication ────────────────────────────────────────────────────────
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_MISSING = 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_REVOKED = 'AUTH_TOKEN_REVOKED',
  AUTH_REFRESH_TOKEN_INVALID = 'AUTH_REFRESH_TOKEN_INVALID',
  AUTH_REFRESH_TOKEN_REUSED = 'AUTH_REFRESH_TOKEN_REUSED',
  AUTH_SESSION_NOT_FOUND = 'AUTH_SESSION_NOT_FOUND',
  AUTH_SCHEME_NOT_ALLOWED = 'AUTH_SCHEME_NOT_ALLOWED',
  AUTH_PASSWORD_MISMATCH = 'AUTH_PASSWORD_MISMATCH',
  AUTH_PASSWORD_REUSED = 'AUTH_PASSWORD_REUSED',
  AUTH_PASSWORD_TOO_WEAK = 'AUTH_PASSWORD_TOO_WEAK',

  // ── Account state ─────────────────────────────────────────────────────────
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  ACCOUNT_ALREADY_EXISTS = 'ACCOUNT_ALREADY_EXISTS',
  ACCOUNT_EMAIL_NOT_VERIFIED = 'ACCOUNT_EMAIL_NOT_VERIFIED',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',

  // ── One-time tokens ───────────────────────────────────────────────────────
  TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_ALREADY_USED = 'TOKEN_ALREADY_USED',

  // ── Authorization / RBAC ──────────────────────────────────────────────────
  FORBIDDEN = 'FORBIDDEN',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  ROLE_NOT_FOUND = 'ROLE_NOT_FOUND',
  ROLE_ALREADY_EXISTS = 'ROLE_ALREADY_EXISTS',
  ROLE_IMMUTABLE = 'ROLE_IMMUTABLE',
  ROLE_IN_USE = 'ROLE_IN_USE',
  PERMISSION_NOT_FOUND = 'PERMISSION_NOT_FOUND',
  CANNOT_ESCALATE_PRIVILEGES = 'CANNOT_ESCALATE_PRIVILEGES',

  // ── Organization / tenancy ────────────────────────────────────────────────
  ORGANIZATION_CONTEXT_REQUIRED = 'ORGANIZATION_CONTEXT_REQUIRED',
  ORGANIZATION_NOT_FOUND = 'ORGANIZATION_NOT_FOUND',
  ORGANIZATION_SLUG_TAKEN = 'ORGANIZATION_SLUG_TAKEN',
  ORGANIZATION_SLUG_RESERVED = 'ORGANIZATION_SLUG_RESERVED',
  ORGANIZATION_SUSPENDED = 'ORGANIZATION_SUSPENDED',
  ORGANIZATION_LIMIT_REACHED = 'ORGANIZATION_LIMIT_REACHED',
  CROSS_TENANT_ACCESS_DENIED = 'CROSS_TENANT_ACCESS_DENIED',
  IP_NOT_ALLOWED = 'IP_NOT_ALLOWED',

  // ── Membership ────────────────────────────────────────────────────────────
  MEMBERSHIP_NOT_FOUND = 'MEMBERSHIP_NOT_FOUND',
  MEMBERSHIP_ALREADY_EXISTS = 'MEMBERSHIP_ALREADY_EXISTS',
  MEMBERSHIP_SUSPENDED = 'MEMBERSHIP_SUSPENDED',
  CANNOT_REMOVE_LAST_OWNER = 'CANNOT_REMOVE_LAST_OWNER',
  CANNOT_MODIFY_SELF = 'CANNOT_MODIFY_SELF',
  SEAT_LIMIT_REACHED = 'SEAT_LIMIT_REACHED',

  // ── Invitations ───────────────────────────────────────────────────────────
  INVITATION_NOT_FOUND = 'INVITATION_NOT_FOUND',
  INVITATION_EXPIRED = 'INVITATION_EXPIRED',
  INVITATION_ALREADY_ACCEPTED = 'INVITATION_ALREADY_ACCEPTED',
  INVITATION_REVOKED = 'INVITATION_REVOKED',
  INVITATION_EMAIL_MISMATCH = 'INVITATION_EMAIL_MISMATCH',
  INVITATION_ALREADY_PENDING = 'INVITATION_ALREADY_PENDING',

  // ── API keys / service identities ─────────────────────────────────────────
  API_KEY_NOT_FOUND = 'API_KEY_NOT_FOUND',
  API_KEY_INVALID = 'API_KEY_INVALID',
  API_KEY_EXPIRED = 'API_KEY_EXPIRED',
  API_KEY_REVOKED = 'API_KEY_REVOKED',
  API_KEY_SCOPE_INSUFFICIENT = 'API_KEY_SCOPE_INSUFFICIENT',

  // ── Rate limiting / quota ─────────────────────────────────────────────────
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  TOO_MANY_LOGIN_ATTEMPTS = 'TOO_MANY_LOGIN_ATTEMPTS',

  // ── Audit ─────────────────────────────────────────────────────────────────
  AUDIT_CHAIN_BROKEN = 'AUDIT_CHAIN_BROKEN',
  AUDIT_LOG_IMMUTABLE = 'AUDIT_LOG_IMMUTABLE',

  // ── Knowledge bases ───────────────────────────────────────────────────────
  KNOWLEDGE_BASE_NOT_FOUND = 'KNOWLEDGE_BASE_NOT_FOUND',
  KNOWLEDGE_BASE_NAME_TAKEN = 'KNOWLEDGE_BASE_NAME_TAKEN',
  KNOWLEDGE_BASE_ACCESS_DENIED = 'KNOWLEDGE_BASE_ACCESS_DENIED',
  KNOWLEDGE_BASE_GRANT_NOT_FOUND = 'KNOWLEDGE_BASE_GRANT_NOT_FOUND',
  CLASSIFICATION_EXCEEDS_CLEARANCE = 'CLASSIFICATION_EXCEEDS_CLEARANCE',

  // ── Documents & ingestion ─────────────────────────────────────────────────
  DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
  DOCUMENT_DUPLICATE = 'DOCUMENT_DUPLICATE',
  DOCUMENT_TYPE_NOT_ALLOWED = 'DOCUMENT_TYPE_NOT_ALLOWED',
  DOCUMENT_CONTENT_MISMATCH = 'DOCUMENT_CONTENT_MISMATCH',
  DOCUMENT_EMPTY = 'DOCUMENT_EMPTY',
  DOCUMENT_PROCESSING = 'DOCUMENT_PROCESSING',
  DOCUMENT_CONTENT_UNAVAILABLE = 'DOCUMENT_CONTENT_UNAVAILABLE',
  STORAGE_QUOTA_EXCEEDED = 'STORAGE_QUOTA_EXCEEDED',

  // ── Knowledge-layer dependencies ──────────────────────────────────────────
  KNOWLEDGE_LAYER_NOT_CONFIGURED = 'KNOWLEDGE_LAYER_NOT_CONFIGURED',
  AI_SERVICE_UNAVAILABLE = 'AI_SERVICE_UNAVAILABLE',
  VECTOR_STORE_UNAVAILABLE = 'VECTOR_STORE_UNAVAILABLE',
  OBJECT_STORAGE_UNAVAILABLE = 'OBJECT_STORAGE_UNAVAILABLE',

  // ── LLM gateway ───────────────────────────────────────────────────────────
  LLM_NOT_CONFIGURED = 'LLM_NOT_CONFIGURED',
  LLM_UNAVAILABLE = 'LLM_UNAVAILABLE',
  LLM_BUSY = 'LLM_BUSY',
  LLM_TIMEOUT = 'LLM_TIMEOUT',
  LLM_MODEL_NOT_ALLOWED = 'LLM_MODEL_NOT_ALLOWED',
  LLM_MODEL_NOT_FOUND = 'LLM_MODEL_NOT_FOUND',
  LLM_CONTEXT_OVERFLOW = 'LLM_CONTEXT_OVERFLOW',
  LLM_REJECTED = 'LLM_REJECTED',
  LLM_RESPONSE_INVALID = 'LLM_RESPONSE_INVALID',
  LLM_CLASSIFICATION_EXCEEDED = 'LLM_CLASSIFICATION_EXCEEDED',

  // ── Agents & conversations ────────────────────────────────────────────────
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  AGENT_NAME_TAKEN = 'AGENT_NAME_TAKEN',
  AGENT_VERSION_NOT_FOUND = 'AGENT_VERSION_NOT_FOUND',
  AGENT_VERSION_CONFLICT = 'AGENT_VERSION_CONFLICT',
  AGENT_UNAVAILABLE = 'AGENT_UNAVAILABLE',
  CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND',
  CONVERSATION_BUSY = 'CONVERSATION_BUSY',
  CONVERSATION_ARCHIVED = 'CONVERSATION_ARCHIVED',
  MESSAGE_DUPLICATE = 'MESSAGE_DUPLICATE',

  // ── PII redaction ─────────────────────────────────────────────────────────
  PII_DETECTION_UNAVAILABLE = 'PII_DETECTION_UNAVAILABLE',
  PII_EGRESS_BLOCKED = 'PII_EGRESS_BLOCKED',

  // ── Tools (phase 4) ───────────────────────────────────────────────────────
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_NAME_TAKEN = 'TOOL_NAME_TAKEN',
  TOOL_DEFINITION_INVALID = 'TOOL_DEFINITION_INVALID',
  TOOL_DISABLED = 'TOOL_DISABLED',
  TOOL_NOT_GRANTED = 'TOOL_NOT_GRANTED',
  TOOL_ARGUMENTS_INVALID = 'TOOL_ARGUMENTS_INVALID',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT = 'TOOL_TIMEOUT',
  TOOL_EGRESS_BLOCKED = 'TOOL_EGRESS_BLOCKED',
  TOOL_INFORMATION_FLOW_BLOCKED = 'TOOL_INFORMATION_FLOW_BLOCKED',
  TOOL_PII_BLOCKED = 'TOOL_PII_BLOCKED',
  TOOL_APPROVAL_REQUIRED = 'TOOL_APPROVAL_REQUIRED',
  TOOL_CALL_LIMIT = 'TOOL_CALL_LIMIT',

  // ── Workflows (phase 4) ───────────────────────────────────────────────────
  WORKFLOW_NOT_FOUND = 'WORKFLOW_NOT_FOUND',
  WORKFLOW_NAME_TAKEN = 'WORKFLOW_NAME_TAKEN',
  WORKFLOW_VERSION_NOT_FOUND = 'WORKFLOW_VERSION_NOT_FOUND',
  WORKFLOW_VERSION_CONFLICT = 'WORKFLOW_VERSION_CONFLICT',
  WORKFLOW_INVALID = 'WORKFLOW_INVALID',
  WORKFLOW_NOT_ACTIVE = 'WORKFLOW_NOT_ACTIVE',
  WORKFLOW_INPUT_INVALID = 'WORKFLOW_INPUT_INVALID',
  WORKFLOW_CONCURRENCY_LIMIT = 'WORKFLOW_CONCURRENCY_LIMIT',
  WORKFLOW_RUN_NOT_FOUND = 'WORKFLOW_RUN_NOT_FOUND',
  WORKFLOW_RUN_FINISHED = 'WORKFLOW_RUN_FINISHED',
  WORKFLOW_RUN_NOT_RESUMABLE = 'WORKFLOW_RUN_NOT_RESUMABLE',
  WORKFLOW_RUN_DUPLICATE = 'WORKFLOW_RUN_DUPLICATE',
  WORKFLOW_STEP_NOT_FOUND = 'WORKFLOW_STEP_NOT_FOUND',
  WORKFLOW_APPROVAL_NOT_PENDING = 'WORKFLOW_APPROVAL_NOT_PENDING',
  WORKFLOW_SELF_APPROVAL_FORBIDDEN = 'WORKFLOW_SELF_APPROVAL_FORBIDDEN',
  WORKFLOW_APPROVAL_REJECTED = 'WORKFLOW_APPROVAL_REJECTED',
  WORKFLOW_STEP_LIMIT_EXCEEDED = 'WORKFLOW_STEP_LIMIT_EXCEEDED',
  WORKFLOW_TOKEN_BUDGET_EXCEEDED = 'WORKFLOW_TOKEN_BUDGET_EXCEEDED',
  WORKFLOW_TIMEOUT = 'WORKFLOW_TIMEOUT',
  WORKFLOW_STEP_TIMEOUT = 'WORKFLOW_STEP_TIMEOUT',
  WORKFLOW_LOOP_EXHAUSTED = 'WORKFLOW_LOOP_EXHAUSTED',
  WORKFLOW_NO_OUTPUT = 'WORKFLOW_NO_OUTPUT',
  WORKFLOW_OUTPUT_INVALID = 'WORKFLOW_OUTPUT_INVALID',
  WORKFLOW_ROUTING_FAILED = 'WORKFLOW_ROUTING_FAILED',
  WORKFLOW_TEMPLATE_ERROR = 'WORKFLOW_TEMPLATE_ERROR',
  WORKFLOW_PRINCIPAL_REVOKED = 'WORKFLOW_PRINCIPAL_REVOKED',
  WORKFLOW_DEPENDENCY_UNAVAILABLE = 'WORKFLOW_DEPENDENCY_UNAVAILABLE',

  // ── Real-time (phase 4) ───────────────────────────────────────────────────
  REALTIME_DISABLED = 'REALTIME_DISABLED',
  REALTIME_CONNECTION_LIMIT = 'REALTIME_CONNECTION_LIMIT',
  REALTIME_ORIGIN_NOT_ALLOWED = 'REALTIME_ORIGIN_NOT_ALLOWED',
}

/**
 * Human readable default messages. Services may always override with something
 * more specific; these exist so that a thrown domain error never surfaces a bare
 * code to an end user.
 */
export const ERROR_CODE_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.INTERNAL_SERVER_ERROR]: 'An unexpected error occurred.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable.',
  [ErrorCode.NOT_IMPLEMENTED]: 'This capability is not available yet.',
  [ErrorCode.BAD_REQUEST]: 'The request could not be processed.',
  [ErrorCode.VALIDATION_FAILED]: 'One or more fields failed validation.',
  [ErrorCode.RESOURCE_NOT_FOUND]: 'The requested resource was not found.',
  [ErrorCode.RESOURCE_CONFLICT]:
    'The request conflicts with the current state of the resource.',
  [ErrorCode.REQUEST_TIMEOUT]: 'The request took too long to complete.',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'The request payload is too large.',
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 'The supplied media type is not supported.',
  [ErrorCode.DEPENDENCY_FAILURE]: 'A downstream dependency failed.',

  [ErrorCode.AUTH_REQUIRED]: 'Authentication is required to access this resource.',
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 'Invalid email address or password.',
  [ErrorCode.AUTH_TOKEN_MISSING]: 'No authentication token was supplied.',
  [ErrorCode.AUTH_TOKEN_INVALID]: 'The authentication token is invalid.',
  [ErrorCode.AUTH_TOKEN_EXPIRED]: 'The authentication token has expired.',
  [ErrorCode.AUTH_TOKEN_REVOKED]: 'The authentication token has been revoked.',
  [ErrorCode.AUTH_REFRESH_TOKEN_INVALID]: 'The refresh token is invalid.',
  [ErrorCode.AUTH_REFRESH_TOKEN_REUSED]:
    'This refresh token has already been used. For your protection every session on this account has been signed out.',
  [ErrorCode.AUTH_SESSION_NOT_FOUND]: 'The session no longer exists.',
  [ErrorCode.AUTH_SCHEME_NOT_ALLOWED]:
    'This authentication scheme is not accepted on this route.',
  [ErrorCode.AUTH_PASSWORD_MISMATCH]: 'The current password is incorrect.',
  [ErrorCode.AUTH_PASSWORD_REUSED]:
    'The new password must differ from the current password.',
  [ErrorCode.AUTH_PASSWORD_TOO_WEAK]: 'The password does not meet the security policy.',

  [ErrorCode.ACCOUNT_NOT_FOUND]: 'No account was found.',
  [ErrorCode.ACCOUNT_ALREADY_EXISTS]: 'An account with this email address already exists.',
  [ErrorCode.ACCOUNT_EMAIL_NOT_VERIFIED]:
    'Please verify your email address before continuing.',
  [ErrorCode.ACCOUNT_SUSPENDED]: 'This account has been suspended.',
  [ErrorCode.ACCOUNT_DEACTIVATED]: 'This account has been deactivated.',
  [ErrorCode.ACCOUNT_LOCKED]:
    'This account is temporarily locked after too many failed sign-in attempts.',

  [ErrorCode.TOKEN_NOT_FOUND]: 'The token is not valid.',
  [ErrorCode.TOKEN_EXPIRED]: 'The token has expired.',
  [ErrorCode.TOKEN_ALREADY_USED]: 'The token has already been used.',

  [ErrorCode.FORBIDDEN]: 'You do not have access to this resource.',
  [ErrorCode.PERMISSION_DENIED]: 'You lack the permissions required for this action.',
  [ErrorCode.ROLE_NOT_FOUND]: 'The role was not found.',
  [ErrorCode.ROLE_ALREADY_EXISTS]:
    'A role with this name already exists in this workspace.',
  [ErrorCode.ROLE_IMMUTABLE]: 'Built-in roles cannot be modified.',
  [ErrorCode.ROLE_IN_USE]: 'This role is still assigned to one or more members.',
  [ErrorCode.PERMISSION_NOT_FOUND]: 'One or more permissions do not exist.',
  [ErrorCode.CANNOT_ESCALATE_PRIVILEGES]:
    'You cannot grant permissions that you do not hold yourself.',

  [ErrorCode.ORGANIZATION_CONTEXT_REQUIRED]:
    'This endpoint requires a workspace context. Supply the X-Organization-Id header.',
  [ErrorCode.ORGANIZATION_NOT_FOUND]: 'The workspace was not found.',
  [ErrorCode.ORGANIZATION_SLUG_TAKEN]: 'That workspace URL is already taken.',
  [ErrorCode.ORGANIZATION_SLUG_RESERVED]: 'That workspace URL is reserved.',
  [ErrorCode.ORGANIZATION_SUSPENDED]: 'This workspace has been suspended.',
  [ErrorCode.ORGANIZATION_LIMIT_REACHED]:
    'You have reached the maximum number of workspaces.',
  [ErrorCode.CROSS_TENANT_ACCESS_DENIED]: 'The resource belongs to a different workspace.',
  [ErrorCode.IP_NOT_ALLOWED]:
    'Your network address is not permitted to access this workspace.',

  [ErrorCode.MEMBERSHIP_NOT_FOUND]: 'That member does not belong to this workspace.',
  [ErrorCode.MEMBERSHIP_ALREADY_EXISTS]: 'That user is already a member of this workspace.',
  [ErrorCode.MEMBERSHIP_SUSPENDED]: 'Your membership of this workspace has been suspended.',
  [ErrorCode.CANNOT_REMOVE_LAST_OWNER]:
    'A workspace must always retain at least one owner.',
  [ErrorCode.CANNOT_MODIFY_SELF]: 'You cannot perform this action on your own membership.',
  [ErrorCode.SEAT_LIMIT_REACHED]: 'This workspace has reached its member limit.',

  [ErrorCode.INVITATION_NOT_FOUND]: 'The invitation was not found.',
  [ErrorCode.INVITATION_EXPIRED]: 'This invitation has expired.',
  [ErrorCode.INVITATION_ALREADY_ACCEPTED]: 'This invitation has already been accepted.',
  [ErrorCode.INVITATION_REVOKED]: 'This invitation has been revoked.',
  [ErrorCode.INVITATION_EMAIL_MISMATCH]:
    'This invitation was issued to a different email address.',
  [ErrorCode.INVITATION_ALREADY_PENDING]:
    'An invitation is already pending for this email address.',

  [ErrorCode.API_KEY_NOT_FOUND]: 'The API key was not found.',
  [ErrorCode.API_KEY_INVALID]: 'The supplied API key is not valid.',
  [ErrorCode.API_KEY_EXPIRED]: 'The supplied API key has expired.',
  [ErrorCode.API_KEY_REVOKED]: 'The supplied API key has been revoked.',
  [ErrorCode.API_KEY_SCOPE_INSUFFICIENT]:
    'The API key lacks the scope required for this action.',

  [ErrorCode.RATE_LIMIT_EXCEEDED]: 'Too many requests. Please slow down.',
  [ErrorCode.QUOTA_EXCEEDED]: 'This workspace has exhausted its allocated quota.',
  [ErrorCode.TOO_MANY_LOGIN_ATTEMPTS]: 'Too many sign-in attempts. Please try again later.',

  [ErrorCode.AUDIT_CHAIN_BROKEN]: 'The audit log integrity chain could not be verified.',
  [ErrorCode.AUDIT_LOG_IMMUTABLE]: 'Audit records cannot be modified or deleted.',

  [ErrorCode.KNOWLEDGE_BASE_NOT_FOUND]: 'The knowledge base was not found.',
  [ErrorCode.KNOWLEDGE_BASE_NAME_TAKEN]:
    'A knowledge base with this name already exists in this workspace.',
  [ErrorCode.KNOWLEDGE_BASE_ACCESS_DENIED]:
    'Your access to this knowledge base does not permit this action.',
  [ErrorCode.KNOWLEDGE_BASE_GRANT_NOT_FOUND]: 'The access grant was not found.',
  [ErrorCode.CLASSIFICATION_EXCEEDS_CLEARANCE]:
    'You cannot assign a classification above your own clearance.',

  [ErrorCode.DOCUMENT_NOT_FOUND]: 'The document was not found.',
  [ErrorCode.DOCUMENT_DUPLICATE]:
    'An identical file already exists in this knowledge base.',
  [ErrorCode.DOCUMENT_TYPE_NOT_ALLOWED]: 'This file type is not accepted.',
  [ErrorCode.DOCUMENT_CONTENT_MISMATCH]: 'The file’s contents do not match its extension.',
  [ErrorCode.DOCUMENT_EMPTY]: 'The file is empty or contains no extractable text.',
  [ErrorCode.DOCUMENT_PROCESSING]:
    'The document is still being processed. Try again when processing finishes.',
  [ErrorCode.DOCUMENT_CONTENT_UNAVAILABLE]:
    'The document’s content has been destroyed and cannot be retrieved.',
  [ErrorCode.STORAGE_QUOTA_EXCEEDED]: 'This workspace has used its document storage quota.',

  [ErrorCode.KNOWLEDGE_LAYER_NOT_CONFIGURED]:
    'Document storage and retrieval are not configured on this deployment.',
  [ErrorCode.AI_SERVICE_UNAVAILABLE]: 'The AI service is temporarily unavailable.',
  [ErrorCode.VECTOR_STORE_UNAVAILABLE]: 'The vector store is temporarily unavailable.',
  [ErrorCode.OBJECT_STORAGE_UNAVAILABLE]: 'Document storage is temporarily unavailable.',

  [ErrorCode.LLM_NOT_CONFIGURED]: 'No language model is configured on this deployment.',
  [ErrorCode.LLM_UNAVAILABLE]: 'The language model is temporarily unavailable.',
  [ErrorCode.LLM_BUSY]:
    'The language model is serving other requests. Try again in a few seconds.',
  [ErrorCode.LLM_TIMEOUT]: 'The language model took too long to respond.',
  [ErrorCode.LLM_MODEL_NOT_ALLOWED]: 'That model is not enabled for this workspace.',
  [ErrorCode.LLM_MODEL_NOT_FOUND]: 'The model endpoint does not serve that model.',
  [ErrorCode.LLM_CONTEXT_OVERFLOW]:
    'The message is too long for the model’s context window.',
  [ErrorCode.LLM_REJECTED]: 'The language model rejected the request.',
  [ErrorCode.LLM_RESPONSE_INVALID]: 'The language model returned an unusable response.',
  [ErrorCode.LLM_CLASSIFICATION_EXCEEDED]:
    'This input is more sensitive than the model endpoint is trusted to receive.',

  [ErrorCode.AGENT_NOT_FOUND]: 'The agent was not found.',
  [ErrorCode.AGENT_NAME_TAKEN]: 'An agent with this name already exists in this workspace.',
  [ErrorCode.AGENT_VERSION_NOT_FOUND]: 'That version of the agent does not exist.',
  [ErrorCode.AGENT_VERSION_CONFLICT]:
    'The agent was changed by someone else. Reload it and apply your change again.',
  [ErrorCode.AGENT_UNAVAILABLE]: 'The agent behind this conversation has been deleted.',
  [ErrorCode.CONVERSATION_NOT_FOUND]: 'The conversation was not found.',
  [ErrorCode.CONVERSATION_BUSY]:
    'This conversation is still answering the previous message.',
  [ErrorCode.CONVERSATION_ARCHIVED]:
    'This conversation is archived. Unarchive it to continue.',
  [ErrorCode.MESSAGE_DUPLICATE]: 'This message has already been sent.',

  [ErrorCode.PII_DETECTION_UNAVAILABLE]:
    'Sensitive-data detection is unavailable, and this workspace refuses to send ' +
    'unprotected text to the model.',
  [ErrorCode.PII_EGRESS_BLOCKED]:
    'The request was stopped because sensitive data would have reached the model.',

  [ErrorCode.TOOL_NOT_FOUND]: 'The tool was not found.',
  [ErrorCode.TOOL_NAME_TAKEN]: 'A tool with this name already exists in this workspace.',
  [ErrorCode.TOOL_DEFINITION_INVALID]: 'The tool definition is not valid.',
  [ErrorCode.TOOL_DISABLED]: 'This tool is disabled.',
  [ErrorCode.TOOL_NOT_GRANTED]: 'The agent has not been granted this tool.',
  [ErrorCode.TOOL_ARGUMENTS_INVALID]: 'The tool was called with invalid arguments.',
  [ErrorCode.TOOL_EXECUTION_FAILED]: 'The tool failed to execute.',
  [ErrorCode.TOOL_TIMEOUT]: 'The tool took too long to respond.',
  [ErrorCode.TOOL_EGRESS_BLOCKED]:
    'The tool tried to reach a destination that is not on the egress allowlist.',
  [ErrorCode.TOOL_INFORMATION_FLOW_BLOCKED]:
    'The tool call was stopped: data this sensitive, or this untrusted, may not flow into it.',
  [ErrorCode.TOOL_PII_BLOCKED]:
    'The tool call was stopped because it would have sent personal data to a destination not ' +
    'permitted to receive it.',
  [ErrorCode.TOOL_APPROVAL_REQUIRED]: 'This tool can only run after a person approves it.',
  [ErrorCode.TOOL_CALL_LIMIT]: 'The tool-call limit for this request has been reached.',

  [ErrorCode.WORKFLOW_NOT_FOUND]: 'The workflow was not found.',
  [ErrorCode.WORKFLOW_NAME_TAKEN]:
    'A workflow with this name already exists in this workspace.',
  [ErrorCode.WORKFLOW_VERSION_NOT_FOUND]: 'That version of the workflow does not exist.',
  [ErrorCode.WORKFLOW_VERSION_CONFLICT]:
    'The workflow was changed by someone else. Reload it and apply your change again.',
  [ErrorCode.WORKFLOW_INVALID]: 'The workflow definition is not valid.',
  [ErrorCode.WORKFLOW_NOT_ACTIVE]: 'The workflow must be published before it can run.',
  [ErrorCode.WORKFLOW_INPUT_INVALID]:
    'The run input does not match the workflow’s trigger.',
  [ErrorCode.WORKFLOW_CONCURRENCY_LIMIT]:
    'This workspace already has the maximum number of workflow runs in progress.',
  [ErrorCode.WORKFLOW_RUN_NOT_FOUND]: 'The workflow run was not found.',
  [ErrorCode.WORKFLOW_RUN_FINISHED]: 'The workflow run has already finished.',
  [ErrorCode.WORKFLOW_RUN_NOT_RESUMABLE]: 'This workflow run cannot be resumed.',
  [ErrorCode.WORKFLOW_RUN_DUPLICATE]: 'A run with this idempotency key already exists.',
  [ErrorCode.WORKFLOW_STEP_NOT_FOUND]: 'The workflow step was not found.',
  [ErrorCode.WORKFLOW_APPROVAL_NOT_PENDING]: 'This step is not waiting for approval.',
  [ErrorCode.WORKFLOW_SELF_APPROVAL_FORBIDDEN]:
    'You cannot approve a step of a run you started yourself.',
  [ErrorCode.WORKFLOW_APPROVAL_REJECTED]: 'An approver rejected this step.',
  [ErrorCode.WORKFLOW_STEP_LIMIT_EXCEEDED]:
    'The run was stopped because it reached its step ceiling.',
  [ErrorCode.WORKFLOW_TOKEN_BUDGET_EXCEEDED]:
    'The run was stopped because it exhausted its token budget.',
  [ErrorCode.WORKFLOW_TIMEOUT]: 'The run exceeded its maximum duration.',
  [ErrorCode.WORKFLOW_STEP_TIMEOUT]: 'A workflow step exceeded its maximum duration.',
  [ErrorCode.WORKFLOW_LOOP_EXHAUSTED]:
    'A loop in the workflow reached its iteration limit and is configured to fail.',
  [ErrorCode.WORKFLOW_NO_OUTPUT]: 'The run finished without reaching an output node.',
  [ErrorCode.WORKFLOW_OUTPUT_INVALID]:
    'An agent’s structured output did not match the schema the workflow expects.',
  [ErrorCode.WORKFLOW_ROUTING_FAILED]: 'The supervisor could not decide the next step.',
  [ErrorCode.WORKFLOW_TEMPLATE_ERROR]: 'A step’s input template could not be rendered.',
  [ErrorCode.WORKFLOW_PRINCIPAL_REVOKED]:
    'The run was stopped because the member who started it no longer has access.',
  [ErrorCode.WORKFLOW_DEPENDENCY_UNAVAILABLE]:
    'A service a workflow step depends on is temporarily unavailable.',

  [ErrorCode.REALTIME_DISABLED]: 'Real-time events are disabled on this deployment.',
  [ErrorCode.REALTIME_CONNECTION_LIMIT]:
    'Too many simultaneous real-time connections for this account.',
  [ErrorCode.REALTIME_ORIGIN_NOT_ALLOWED]:
    'Real-time connections are not accepted from this origin.',
};
