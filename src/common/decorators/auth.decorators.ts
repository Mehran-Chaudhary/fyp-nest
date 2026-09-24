import { SetMetadata } from '@nestjs/common';
import type { RequestTimeoutBudget } from '../../config/app.config';
import { METADATA_KEY } from '../constants/app.constants';
import { AuthType } from '../enums/auth-type.enum';

/**
 * Declares which authentication schemes a route accepts.
 *
 * The global authentication guard defaults every route to
 * `[AuthType.Bearer]`, so a route is protected unless it says otherwise. That
 * default is the whole point: the common failure mode in guard-based systems is
 * a new endpoint that nobody remembered to protect, and fail-closed defaults
 * turn that from a silent vulnerability into an obvious 401 during development.
 *
 * @example
 * ```ts
 * // Accepts a user's JWT or the Python AI service's API key.
 * @Auth(AuthType.Bearer, AuthType.ApiKey)
 * @Get('search')
 * search() {}
 * ```
 */
export const Auth = (...types: AuthType[]) => SetMetadata(METADATA_KEY.AUTH_TYPE, types);

/**
 * Opens a route to unauthenticated callers.
 *
 * Reserved for sign-in, registration, health checks and invitation preview.
 * Every use should be obvious from the route's purpose; if it is not, the route
 * probably should not be public.
 */
export const Public = () => SetMetadata(METADATA_KEY.AUTH_TYPE, [AuthType.None]);

/**
 * Requires **all** of the listed permissions in the active workspace.
 *
 * Implies a workspace context: the permissions guard cannot evaluate anything
 * without one, so the organization-context guard must have resolved a membership
 * first.
 *
 * @example
 * ```ts
 * @RequirePermissions('agent:create', 'knowledgebase:read')
 * ```
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(METADATA_KEY.REQUIRED_PERMISSIONS, permissions);

/**
 * Requires **at least one** of the listed permissions.
 *
 * Used where several roles legitimately reach the same endpoint by different
 * routes — for instance, reading a conversation is allowed either by owning it
 * (`conversation:read`) or by supervising the workspace (`conversation:read_all`).
 */
export const RequireAnyPermission = (...permissions: string[]) => {
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    SetMetadata(METADATA_KEY.REQUIRED_PERMISSIONS, permissions)(
      target,
      key as string,
      descriptor as PropertyDescriptor,
    );
    SetMetadata(METADATA_KEY.PERMISSIONS_ANY_OF, true)(
      target,
      key as string,
      descriptor as PropertyDescriptor,
    );
  };
};

/**
 * Marks a route as not workspace-scoped.
 *
 * Needed for the handful of endpoints that legitimately operate outside any
 * single tenant: listing the workspaces a user belongs to, creating the first
 * one, reading one's own profile.
 */
export const SkipOrganizationContext = () =>
  SetMetadata(METADATA_KEY.SKIP_ORGANIZATION_CONTEXT, true);

/**
 * Restricts a route to platform administrators.
 *
 * Deliberately separate from the workspace permission system: platform
 * administration must never be grantable through a workspace's role editor,
 * because a tenant administrator could otherwise escalate to operating the
 * platform itself.
 */
export const PlatformAdminOnly = () => SetMetadata(METADATA_KEY.PLATFORM_ADMIN_ONLY, true);

/** Requires the caller's email address to be verified. */
export const RequireVerifiedEmail = () =>
  SetMetadata(METADATA_KEY.REQUIRE_VERIFIED_EMAIL, true);

/**
 * Selects a named rate-limit policy for this route.
 *
 * @see `src/config/throttle.config.ts` for the policy definitions.
 */
export const ThrottlePolicy = (policy: string) =>
  SetMetadata(METADATA_KEY.THROTTLE_POLICY, policy);

/** Returns the handler's response as-is, bypassing the standard envelope. */
export const SkipResponseEnvelope = () =>
  SetMetadata(METADATA_KEY.SKIP_RESPONSE_ENVELOPE, true);

/**
 * Selects a longer, named request-timeout budget for this route.
 *
 * A name rather than a number so the value stays in configuration, where it can
 * be tuned per deployment without a code change.
 *
 * @see `requestTimeoutBudgets` in `src/config/app.config.ts`.
 */
export const TimeoutBudget = (budget: RequestTimeoutBudget) =>
  SetMetadata(METADATA_KEY.TIMEOUT_BUDGET, budget);
