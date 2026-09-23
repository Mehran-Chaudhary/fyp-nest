import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedApiKey,
  AuthenticatedRequest,
  AuthenticatedUser,
  RequestMembership,
  RequestOrganization,
  RequestPrincipal,
} from '../interfaces/authenticated-request.interface';
import { normaliseIp } from '../utils/ip.util';

/**
 * Parameter decorators exposing what the guards resolved.
 *
 * Controllers use these instead of reaching into the request object. Beyond
 * readability, it means the shape the guards attach can change without editing
 * every controller, and it keeps `@Req()` — which invites accidentally passing a
 * whole Express request into a service — out of handler signatures.
 */

/**
 * The authenticated user.
 *
 * Non-null on any route the authentication guard protected with
 * `AuthType.Bearer`. On a route that also accepts an API key this may be
 * undefined, so prefer `@CurrentPrincipal()` where both schemes are allowed.
 *
 * @example
 * ```ts
 * findMe(@CurrentUser() user: AuthenticatedUser) {}
 * findMyId(@CurrentUser('id') userId: string) {}
 * ```
 */
export const CurrentUser = createParamDecorator(
  (property: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) return undefined;
    return property ? user[property] : user;
  },
);

/** The API key behind a machine-authenticated request, if any. */
export const CurrentApiKey = createParamDecorator(
  (property: keyof AuthenticatedApiKey | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.apiKey;
    if (!apiKey) return undefined;
    return property ? apiKey[property] : apiKey;
  },
);

/**
 * The resolved principal, regardless of authentication scheme.
 *
 * The right choice for audit-relevant handlers: it normalises "a user did this"
 * and "a service key did this" into one shape.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestPrincipal | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);

/**
 * The active workspace.
 *
 * Non-null on any route that did not opt out with `@SkipOrganizationContext()`.
 */
export const CurrentOrganization = createParamDecorator(
  (property: keyof RequestOrganization | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const organization = request.organization;
    if (!organization) return undefined;
    return property ? organization[property] : organization;
  },
);

/** Shorthand for the active workspace's id, the most common tenant-scoped need. */
export const CurrentOrganizationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().organization?.id,
);

/** The caller's membership of the active workspace. */
export const CurrentMembership = createParamDecorator(
  (property: keyof RequestMembership | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const membership = request.membership;
    if (!membership) return undefined;
    return property ? membership[property] : membership;
  },
);

/** Effective permission keys in the active workspace, wildcards included. */
export const CurrentPermissions = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string[] =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().permissions ?? [],
);

/**
 * The client IP, normalised.
 *
 * Reads Express's `req.ip`, which already accounts for `X-Forwarded-For` when
 * `TRUST_PROXY` is set correctly. Reading the header directly would be
 * spoofable, which matters because this value feeds the IP allowlist and the
 * rate limiter.
 */
export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext): string =>
  normaliseIp(context.switchToHttp().getRequest<AuthenticatedRequest>().ip),
);

/** The request's correlation id. */
export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().requestId,
);

/** The raw User-Agent header, truncated to the column width it is stored in. */
export const UserAgent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const value = context.switchToHttp().getRequest<AuthenticatedRequest>().get('user-agent');
    return value ? value.slice(0, 512) : undefined;
  },
);
