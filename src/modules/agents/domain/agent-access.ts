import { hasPermission, SUPER_PERMISSION } from '../../../common/utils/permission.util';
import { AgentAccessMode, AgentVisibility } from './agent-config';

/** The parts of an agent that decide who may see and use it. */
export interface AgentAccessFacts {
  visibility: AgentVisibility;
  accessMode: AgentAccessMode;
  allowedRoleIds: readonly string[];
  createdById: string | null;
}

/** Who is asking. */
export interface AgentViewer {
  kind: 'user' | 'api_key';
  userId?: string;
  permissions: readonly string[];
  /** The member's role ids; empty for API keys and break-glass administrators. */
  roleIds: ReadonlySet<string>;
}

/** Holders of `agent:update` configure agents, so they see every one, drafts included. */
export function canManageAgents(viewer: AgentViewer): boolean {
  return hasPermission(viewer.permissions, 'agent:update');
}

/**
 * Whether `viewer` may see (and, with `agent:execute`, use) an agent.
 *
 * An agent the viewer cannot see is reported as not found, exactly like a
 * compartment: a restricted HR agent is invisible to the rest of the
 * workspace, not merely forbidden.
 *
 * This decides only who may *talk to* an agent. What the agent can then read
 * is decided separately and always by the viewer's own access: an agent never
 * holds authority of its own (see ADR 0003). Restricting an agent to the HR
 * roles is about who may use it; it is not what keeps payroll away from
 * everyone else — their own lack of access to the HR compartment is.
 */
export function canSeeAgent(agent: AgentAccessFacts, viewer: AgentViewer): boolean {
  if (hasPermission(viewer.permissions, SUPER_PERMISSION)) return true;
  if (canManageAgents(viewer)) return true;
  if (viewer.kind === 'user' && viewer.userId && agent.createdById === viewer.userId) {
    return true;
  }

  if (agent.visibility !== AgentVisibility.WORKSPACE) return false;
  if (agent.accessMode === AgentAccessMode.WORKSPACE) return true;

  // RESTRICTED: a person holding one of the allowed roles. An API key has no
  // roles, so it cannot use a restricted agent; and a restricted agent whose
  // roles were all deleted is open to nobody — never to everybody.
  if (viewer.kind !== 'user') return false;
  return agent.allowedRoleIds.some((roleId) => viewer.roleIds.has(roleId));
}
