/**
 * The platform permission catalogue.
 *
 * This is the single source of truth for module 6.3 ("Strict RBAC"). It is
 * seeded into the `permissions` table at deploy time and referenced by
 * `@RequirePermissions(...)` on controllers.
 *
 * The catalogue deliberately covers all sixteen proposal modules, not only the
 * ones implemented in phase 1. Defining the whole vocabulary up front means a
 * workspace's custom roles stay meaningful as later phases land: an
 * administrator who builds a "Compliance Auditor" role today does not have to
 * revisit it when the workflow engine ships.
 *
 * Convention: `resource:action`, both lowercase. `*` is a wildcard understood by
 * the permission matcher and is reserved for built-in roles.
 */

export interface PermissionDefinition {
  /** Canonical `resource:action` key. */
  key: string;
  /** Grouping used by the role editor UI. */
  category: PermissionCategory;
  /** Human readable explanation shown next to the checkbox in the role editor. */
  description: string;
  /**
   * True when granting this permission is, by itself, a privilege escalation
   * risk. The RBAC service refuses to let an administrator grant a dangerous
   * permission they do not themselves hold.
   */
  dangerous?: boolean;
  /** The implementation phase that starts enforcing this permission. */
  phase: 1 | 2 | 3 | 4 | 5;
}

export enum PermissionCategory {
  WORKSPACE = 'workspace',
  MEMBERS = 'members',
  ACCESS_CONTROL = 'access_control',
  SECURITY = 'security',
  KNOWLEDGE = 'knowledge',
  AGENTS = 'agents',
  WORKFLOWS = 'workflows',
  TOOLS = 'tools',
  PRIVACY = 'privacy',
  OBSERVABILITY = 'observability',
  CLEARANCE = 'clearance',
}

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  // ── Workspace (6.2) ───────────────────────────────────────────────────────
  {
    key: 'workspace:read',
    category: PermissionCategory.WORKSPACE,
    description: 'View workspace details and settings.',
    phase: 1,
  },
  {
    key: 'workspace:update',
    category: PermissionCategory.WORKSPACE,
    description: 'Rename the workspace and change its settings.',
    phase: 1,
  },
  {
    key: 'workspace:delete',
    category: PermissionCategory.WORKSPACE,
    description: 'Permanently delete the workspace and everything inside it.',
    dangerous: true,
    phase: 1,
  },
  {
    key: 'workspace:transfer',
    category: PermissionCategory.WORKSPACE,
    description: 'Transfer ownership of the workspace to another member.',
    dangerous: true,
    phase: 1,
  },

  // ── Members & invitations (6.2) ───────────────────────────────────────────
  {
    key: 'member:read',
    category: PermissionCategory.MEMBERS,
    description: 'View the member directory of this workspace.',
    phase: 1,
  },
  {
    key: 'member:invite',
    category: PermissionCategory.MEMBERS,
    description: 'Invite new people into the workspace.',
    phase: 1,
  },
  {
    key: 'member:update',
    category: PermissionCategory.MEMBERS,
    description: 'Change a member’s roles or suspend their access.',
    dangerous: true,
    phase: 1,
  },
  {
    key: 'member:remove',
    category: PermissionCategory.MEMBERS,
    description: 'Remove a member from the workspace.',
    dangerous: true,
    phase: 1,
  },

  // ── Roles & permissions (6.3) ─────────────────────────────────────────────
  {
    key: 'role:read',
    category: PermissionCategory.ACCESS_CONTROL,
    description: 'View roles and their permissions.',
    phase: 1,
  },
  {
    key: 'role:create',
    category: PermissionCategory.ACCESS_CONTROL,
    description: 'Create custom roles in this workspace.',
    dangerous: true,
    phase: 1,
  },
  {
    key: 'role:update',
    category: PermissionCategory.ACCESS_CONTROL,
    description: 'Edit a custom role, including the permissions it grants.',
    dangerous: true,
    phase: 1,
  },
  {
    key: 'role:delete',
    category: PermissionCategory.ACCESS_CONTROL,
    description: 'Delete a custom role.',
    dangerous: true,
    phase: 1,
  },
  {
    key: 'role:assign',
    category: PermissionCategory.ACCESS_CONTROL,
    description: 'Assign roles to members.',
    dangerous: true,
    phase: 1,
  },

  // ── Security (6.1) ────────────────────────────────────────────────────────
  {
    key: 'apikey:read',
    category: PermissionCategory.SECURITY,
    description: 'List the workspace’s API keys and their metadata.',
    phase: 1,
  },
  {
    key: 'apikey:create',
    category: PermissionCategory.SECURITY,
    description: 'Issue a new API key for machine access to this workspace.',
    dangerous: true,
    phase: 1,
  },
  {
    key: 'apikey:revoke',
    category: PermissionCategory.SECURITY,
    description: 'Revoke an existing API key.',
    phase: 1,
  },
  {
    key: 'security:read',
    category: PermissionCategory.SECURITY,
    description: 'View security settings such as the IP allowlist.',
    phase: 1,
  },
  {
    key: 'security:update',
    category: PermissionCategory.SECURITY,
    description: 'Change security settings, including network restrictions.',
    dangerous: true,
    phase: 1,
  },

  // ── Observability & audit (6.15) ──────────────────────────────────────────
  {
    key: 'audit:read',
    category: PermissionCategory.OBSERVABILITY,
    description: 'Read the workspace audit log.',
    phase: 1,
  },
  {
    key: 'audit:export',
    category: PermissionCategory.OBSERVABILITY,
    description: 'Export the audit log for external compliance review.',
    phase: 1,
  },
  {
    key: 'audit:verify',
    category: PermissionCategory.OBSERVABILITY,
    description: 'Run an integrity check over the audit log hash chain.',
    phase: 1,
  },
  {
    key: 'usage:read',
    category: PermissionCategory.OBSERVABILITY,
    description: 'View token consumption and usage analytics.',
    // Enforced from phase 3, when the LLM gateway starts recording usage.
    phase: 3,
  },
  {
    key: 'quota:manage',
    category: PermissionCategory.OBSERVABILITY,
    description: 'Set token and rate-limit quotas for agents and members.',
    dangerous: true,
    phase: 5,
  },

  // ── Knowledge: documents & vectors (6.4, 6.5, 6.6) ────────────────────────
  {
    key: 'knowledgebase:read',
    category: PermissionCategory.KNOWLEDGE,
    description: 'View knowledge bases in this workspace.',
    phase: 2,
  },
  {
    key: 'knowledgebase:create',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Create a new knowledge base.',
    phase: 2,
  },
  {
    key: 'knowledgebase:update',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Rename a knowledge base or change its access rules.',
    phase: 2,
  },
  {
    key: 'knowledgebase:delete',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Delete a knowledge base and every vector derived from it.',
    dangerous: true,
    phase: 2,
  },
  {
    key: 'document:read',
    category: PermissionCategory.KNOWLEDGE,
    description: 'List and read documents the member is authorised to see.',
    phase: 2,
  },
  {
    key: 'document:create',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Upload documents into a knowledge base.',
    phase: 2,
  },
  {
    key: 'document:update',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Edit document metadata and access classification.',
    phase: 2,
  },
  {
    key: 'document:delete',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Delete documents and their embeddings.',
    dangerous: true,
    phase: 2,
  },
  {
    key: 'document:download',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Download the original uploaded file.',
    dangerous: true,
    phase: 2,
  },
  {
    key: 'document:reindex',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Re-run chunking and embedding for a document.',
    phase: 2,
  },
  {
    key: 'rag:query',
    category: PermissionCategory.KNOWLEDGE,
    description: 'Run retrieval queries against the workspace vector store.',
    phase: 2,
  },

  // ── Clearance: document sensitivity tiers (6.6) ───────────────────────────
  //
  // Every document carries a classification: PUBLIC, INTERNAL, CONFIDENTIAL or
  // RESTRICTED. A principal's clearance is the highest tier whose key it holds,
  // and clearance is hierarchical — holding `clearance:restricted` implies the
  // tiers beneath it. PUBLIC needs no key at all.
  //
  // Expressed as permissions rather than a separate attribute so that clearance
  // is granted, revoked, audited and escalation-checked by exactly the same
  // machinery as every other authority on the platform.
  {
    key: 'clearance:internal',
    category: PermissionCategory.CLEARANCE,
    description: 'Read documents classified INTERNAL.',
    phase: 2,
  },
  {
    key: 'clearance:confidential',
    category: PermissionCategory.CLEARANCE,
    description: 'Read documents classified CONFIDENTIAL.',
    dangerous: true,
    phase: 2,
  },
  {
    key: 'clearance:restricted',
    category: PermissionCategory.CLEARANCE,
    description:
      'Read documents classified RESTRICTED — the most sensitive tier, such as payroll.',
    dangerous: true,
    phase: 2,
  },

  // ── Agents (6.8, 6.10) ────────────────────────────────────────────────────
  {
    key: 'agent:read',
    category: PermissionCategory.AGENTS,
    description: 'View agent configurations.',
    phase: 3,
  },
  {
    key: 'agent:create',
    category: PermissionCategory.AGENTS,
    description: 'Create new agents.',
    phase: 3,
  },
  {
    key: 'agent:update',
    category: PermissionCategory.AGENTS,
    description: 'Edit an agent’s persona, system prompt and model settings.',
    phase: 3,
  },
  {
    key: 'agent:delete',
    category: PermissionCategory.AGENTS,
    description: 'Delete an agent.',
    dangerous: true,
    phase: 3,
  },
  {
    key: 'agent:execute',
    category: PermissionCategory.AGENTS,
    description: 'Chat with, and run, agents in this workspace.',
    phase: 3,
  },
  {
    key: 'agent:publish',
    category: PermissionCategory.AGENTS,
    description: 'Publish an agent so other members may use it.',
    phase: 3,
  },
  {
    key: 'conversation:read',
    category: PermissionCategory.AGENTS,
    description: 'Read your own conversation history with agents.',
    phase: 3,
  },
  {
    key: 'conversation:read_all',
    category: PermissionCategory.AGENTS,
    description: 'Read every member’s conversation history in this workspace.',
    dangerous: true,
    phase: 3,
  },
  {
    key: 'conversation:delete',
    category: PermissionCategory.AGENTS,
    description: 'Delete conversation history.',
    phase: 3,
  },
  {
    key: 'llm:invoke',
    category: PermissionCategory.AGENTS,
    description: 'Send prompts to the local LLM gateway.',
    phase: 3,
  },
  {
    key: 'llm:manage',
    category: PermissionCategory.AGENTS,
    description: 'Configure which local models the workspace may use.',
    dangerous: true,
    phase: 3,
  },

  // ── Workflows (6.9, 6.13) ─────────────────────────────────────────────────
  {
    key: 'workflow:read',
    category: PermissionCategory.WORKFLOWS,
    description: 'View workflow definitions and their execution history.',
    phase: 4,
  },
  {
    key: 'workflow:create',
    category: PermissionCategory.WORKFLOWS,
    description: 'Create multi-agent workflows on the canvas.',
    phase: 4,
  },
  {
    key: 'workflow:update',
    category: PermissionCategory.WORKFLOWS,
    description: 'Edit a workflow definition.',
    phase: 4,
  },
  {
    key: 'workflow:delete',
    category: PermissionCategory.WORKFLOWS,
    description: 'Delete a workflow.',
    dangerous: true,
    phase: 4,
  },
  {
    key: 'workflow:execute',
    category: PermissionCategory.WORKFLOWS,
    description: 'Trigger a workflow run.',
    phase: 4,
  },
  {
    key: 'workflow:publish',
    category: PermissionCategory.WORKFLOWS,
    description: 'Activate a workflow so that triggers may fire it.',
    phase: 4,
  },
  {
    key: 'workflow:approve',
    category: PermissionCategory.WORKFLOWS,
    description:
      'Approve or reject workflow steps that wait for a person, such as an action with side effects.',
    phase: 4,
  },
  {
    key: 'workflow:read_all',
    category: PermissionCategory.WORKFLOWS,
    description:
      'Read the inputs and outputs of every member’s workflow runs, with personal data masked.',
    dangerous: true,
    phase: 4,
  },

  // ── Tools (6.11) ──────────────────────────────────────────────────────────
  {
    key: 'tool:read',
    category: PermissionCategory.TOOLS,
    description: 'View the tools available to agents.',
    phase: 4,
  },
  {
    key: 'tool:create',
    category: PermissionCategory.TOOLS,
    description: 'Register a new executable tool.',
    dangerous: true,
    phase: 4,
  },
  {
    key: 'tool:update',
    category: PermissionCategory.TOOLS,
    description: 'Edit a tool definition or its credentials.',
    dangerous: true,
    phase: 4,
  },
  {
    key: 'tool:delete',
    category: PermissionCategory.TOOLS,
    description: 'Remove a tool.',
    dangerous: true,
    phase: 4,
  },
  {
    key: 'tool:execute',
    category: PermissionCategory.TOOLS,
    description: 'Allow agents acting on your behalf to execute tools.',
    phase: 4,
  },

  // ── Privacy / PII redaction (6.12) ────────────────────────────────────────
  {
    key: 'pii:policy:read',
    category: PermissionCategory.PRIVACY,
    description: 'View the redaction policy applied before prompts reach the model.',
    phase: 3,
  },
  {
    key: 'pii:policy:update',
    category: PermissionCategory.PRIVACY,
    description: 'Change which entity types are masked before inference.',
    dangerous: true,
    phase: 3,
  },
  {
    key: 'pii:reveal',
    category: PermissionCategory.PRIVACY,
    description:
      'See unmasked values in redaction reports. The most sensitive permission on the platform.',
    dangerous: true,
    phase: 3,
  },
];

/** Every permission key, sorted. Used to expand wildcards for the frontend. */
export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSION_DEFINITIONS.map(
  (definition) => definition.key,
).sort();

/** Permission keys that require the grantor to already hold them. */
export const DANGEROUS_PERMISSION_KEYS: readonly string[] = PERMISSION_DEFINITIONS.filter(
  (definition) => definition.dangerous,
).map((definition) => definition.key);

export const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDefinition> = new Map(
  PERMISSION_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function isKnownPermission(key: string): boolean {
  return PERMISSION_BY_KEY.has(key);
}

// ── Built-in roles ──────────────────────────────────────────────────────────

/**
 * Slugs of the roles every workspace receives on creation. They are marked
 * `isSystem` in the database and cannot be edited or deleted, which guarantees a
 * workspace can never lock itself out of its own administration.
 */
export enum SystemRoleSlug {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer',
}

export interface SystemRoleDefinition {
  slug: SystemRoleSlug;
  name: string;
  description: string;
  /**
   * Higher wins when comparing two members. Used to stop an admin from
   * modifying an owner, and to pick a member's "primary" role for display.
   */
  priority: number;
  permissions: readonly string[];
  /** Exactly one role is the default for newly accepted invitations. */
  isDefault?: boolean;
}

export const SYSTEM_ROLE_DEFINITIONS: readonly SystemRoleDefinition[] = [
  {
    slug: SystemRoleSlug.OWNER,
    name: 'Owner',
    description:
      'Full control of the workspace, including billing, deletion and ownership transfer.',
    priority: 100,
    permissions: ['*:*'],
  },
  {
    slug: SystemRoleSlug.ADMIN,
    name: 'Administrator',
    description:
      'Manages members, roles, agents and knowledge bases. Cannot delete the workspace or transfer ownership.',
    priority: 80,
    permissions: [
      'workspace:read',
      'workspace:update',
      'member:*',
      'role:*',
      'apikey:*',
      'security:*',
      'audit:read',
      'audit:export',
      'audit:verify',
      'usage:read',
      'quota:manage',
      'knowledgebase:*',
      'document:*',
      'rag:query',
      // Not RESTRICTED: an administrator runs the workspace, which is a
      // different thing from being entitled to read its payroll.
      'clearance:internal',
      'clearance:confidential',
      'agent:*',
      'conversation:read',
      'conversation:read_all',
      'conversation:delete',
      'llm:*',
      'workflow:*',
      'tool:*',
      'pii:policy:read',
      'pii:policy:update',
    ],
  },
  {
    slug: SystemRoleSlug.MEMBER,
    name: 'Member',
    description:
      'Day-to-day use of the workspace: chats with agents, uploads documents and runs workflows.',
    priority: 50,
    isDefault: true,
    permissions: [
      'workspace:read',
      'member:read',
      'role:read',
      'knowledgebase:read',
      'document:read',
      'document:create',
      'document:reindex',
      'rag:query',
      'clearance:internal',
      'agent:read',
      'agent:execute',
      'conversation:read',
      'conversation:delete',
      'llm:invoke',
      'workflow:read',
      'workflow:execute',
      'tool:read',
      'tool:execute',
      'usage:read',
      'pii:policy:read',
    ],
  },
  {
    slug: SystemRoleSlug.VIEWER,
    name: 'Viewer',
    description:
      'Read-only observer. Can see configuration but cannot change or run anything.',
    priority: 20,
    permissions: [
      'workspace:read',
      'member:read',
      'role:read',
      'knowledgebase:read',
      'document:read',
      'clearance:internal',
      'agent:read',
      'conversation:read',
      'workflow:read',
      'tool:read',
    ],
  },
];

export const SYSTEM_ROLE_BY_SLUG: ReadonlyMap<string, SystemRoleDefinition> = new Map(
  SYSTEM_ROLE_DEFINITIONS.map((definition) => [definition.slug, definition]),
);

export const DEFAULT_SYSTEM_ROLE_SLUG = SystemRoleSlug.MEMBER;

// ── API key scopes ──────────────────────────────────────────────────────────

/**
 * Scopes an API key may carry. A key's effective permissions are the
 * intersection of its scopes with the permissions of the role it was issued
 * under, so a key can never exceed the authority of its creator.
 *
 * `clearance:restricted` is deliberately absent. The most sensitive tier is
 * reachable only by a person, never by a machine credential that can be copied
 * into a config file and forgotten. So are `pii:reveal` and
 * `conversation:read_all`, for the same reason: seeing raw personal data and
 * supervising other people's conversations are acts a person must answer for.
 */
export const API_KEY_SCOPES: readonly string[] = [
  'rag:query',
  'document:read',
  'document:create',
  'document:reindex',
  'knowledgebase:read',
  'clearance:internal',
  'clearance:confidential',
  'agent:read',
  'agent:execute',
  // A key reads and deletes only the conversations it started itself.
  'conversation:read',
  'conversation:delete',
  'llm:invoke',
  // A key reads only the workflow runs it started itself (`workflow:read_all`
  // is deliberately absent, like `conversation:read_all`).
  'workflow:read',
  'workflow:execute',
  'tool:read',
  'tool:execute',
  'usage:read',
  'pii:policy:read',
];
