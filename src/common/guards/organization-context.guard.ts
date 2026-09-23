import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  HEADER,
  METADATA_KEY,
  ORGANIZATION_ROUTE_PARAMS,
} from '../constants/app.constants';
import { AuthType } from '../enums/auth-type.enum';
import { ErrorCode } from '../enums/error-code.enum';
import { BadRequestError, ForbiddenError } from '../exceptions/app.exception';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { normaliseIp } from '../utils/ip.util';
import { RequestContextService } from '../../shared/context/request-context.service';
import { OrganizationsService } from '../../modules/organizations/organizations.service';

/**
 * Establishes *which tenant* a request operates inside, and proves the caller
 * may be there.
 *
 * This is the tenant isolation boundary (proposal module 6.2). Every
 * workspace-scoped request passes through it, and nothing downstream needs to
 * re-derive the workspace: controllers and services take
 * `request.organization.id` as already-authorised fact.
 *
 * Runs after {@link AuthenticationGuard} and before {@link PermissionsGuard}.
 *
 * ## Resolution order
 *
 * 1. `X-Organization-Id` / `X-Organization-Slug` header — the normal path for
 *    the React frontend, which holds one active workspace at a time.
 * 2. A route parameter (`:organizationId`, `:orgId`, `:workspaceId`) — for
 *    explicitly addressed resources.
 * 3. For API-key requests, the workspace bound to the key, which is not
 *    overridable: a key issued for one tenant can never address another,
 *    whatever headers it sends.
 *
 * ## What it refuses
 *
 * A caller who is not a member receives `ORGANIZATION_NOT_FOUND`, never a 403.
 * Distinguishing "exists but you may not see it" from "does not exist" would let
 * anyone enumerate the platform's tenants by probing ids.
 */
@Injectable()
export class OrganizationContextGuard implements CanActivate {
  private readonly logger = new Logger(OrganizationContextGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly organizationsService: OrganizationsService,
    private readonly requestContext: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const authTypes = this.reflector.getAllAndOverride<AuthType[]>(METADATA_KEY.AUTH_TYPE, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [AuthType.Bearer];

    // Public routes have no principal, so there is nothing to scope.
    if (authTypes.includes(AuthType.None)) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(
      METADATA_KEY.SKIP_ORGANIZATION_CONTEXT,
      [context.getHandler(), context.getClass()],
    );

    // An API key is intrinsically bound to one workspace, so its context is
    // always established even on routes that opt out for human callers.
    if (request.apiKey) {
      await this.applyApiKeyContext(request);
      return true;
    }

    if (skip) return true;

    if (!request.user) {
      // Unreachable in practice: the authentication guard runs first and would
      // have thrown. Fail closed rather than assume.
      throw new ForbiddenError(ErrorCode.AUTH_REQUIRED);
    }

    const identifier = this.extractOrganizationIdentifier(request);

    if (!identifier) {
      throw new BadRequestError(ErrorCode.ORGANIZATION_CONTEXT_REQUIRED);
    }

    const accessContext = await this.organizationsService.resolveAccessContext(
      identifier,
      request.user.id,
      { isPlatformAdmin: request.user.isPlatformAdmin },
    );

    await this.enforceIpAllowlist(request, accessContext.organization.id);

    request.organization = {
      id: accessContext.organization.id,
      slug: accessContext.organization.slug,
      name: accessContext.organization.name,
      status: accessContext.organization.status,
    };

    request.membership = {
      id: accessContext.membership.id,
      userId: accessContext.membership.userId,
      organizationId: accessContext.membership.organizationId,
      status: accessContext.membership.status,
      roleSlugs: accessContext.roleSlugs,
      highestRolePriority: accessContext.priority,
      isOwner: accessContext.isOwner,
    };

    request.permissions = accessContext.permissions;

    this.requestContext.patch({
      organization: request.organization,
      membership: request.membership,
      permissions: accessContext.permissions,
    });

    return true;
  }

  /**
   * Binds the request to the workspace the API key belongs to.
   *
   * The key's own permissions are its scopes. They were already intersected with
   * its creator's authority at issue time, so no further narrowing is needed
   * here — and no widening is possible, because nothing in the request can
   * change which workspace the key addresses.
   */
  private async applyApiKeyContext(request: AuthenticatedRequest): Promise<void> {
    const apiKey = request.apiKey!;
    const organization = await this.organizationsService.findById(apiKey.organizationId);

    if (!organization || !organization.isActive) {
      throw new ForbiddenError(ErrorCode.ORGANIZATION_SUSPENDED, {
        message: 'The workspace this API key belongs to is not active.',
      });
    }

    await this.enforceIpAllowlist(request, organization.id);

    request.organization = {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      status: organization.status,
    };
    request.permissions = apiKey.scopes;

    this.requestContext.patch({
      organization: request.organization,
      permissions: apiKey.scopes,
    });
  }

  /**
   * Workspace-level IP allowlisting (proposal module 6.1).
   *
   * Applied after membership is established so that a rejection can be audited
   * against the right workspace — an unattributable "someone was blocked" entry
   * is of no use to a security reviewer.
   */
  private async enforceIpAllowlist(
    request: AuthenticatedRequest,
    organizationId: string,
  ): Promise<void> {
    const ip = normaliseIp(request.ip);
    const permitted = await this.organizationsService.isIpPermitted(organizationId, ip);

    if (permitted) return;

    this.logger.warn(
      `Blocked request from ${ip} to workspace ${organizationId}: not on the IP allowlist.`,
    );

    await this.organizationsService.recordIpRejection(organizationId, ip);

    throw new ForbiddenError(ErrorCode.IP_NOT_ALLOWED);
  }

  /**
   * Finds the workspace identifier on the request.
   *
   * Headers take precedence over route parameters so the frontend's active
   * workspace is authoritative; a route parameter is the fallback for deep links
   * and for server-to-server calls that address a workspace explicitly.
   */
  private extractOrganizationIdentifier(request: AuthenticatedRequest): string | null {
    const idHeader = request.headers[HEADER.ORGANIZATION_ID];
    const headerId = Array.isArray(idHeader) ? idHeader[0] : idHeader;
    if (headerId?.trim()) return headerId.trim();

    const slugHeader = request.headers[HEADER.ORGANIZATION_SLUG];
    const headerSlug = Array.isArray(slugHeader) ? slugHeader[0] : slugHeader;
    if (headerSlug?.trim()) return headerSlug.trim().toLowerCase();

    const params = request.params as Record<string, string> | undefined;
    if (params) {
      for (const name of ORGANIZATION_ROUTE_PARAMS) {
        const value = params[name];
        if (value?.trim()) return value.trim();
      }
    }

    return null;
  }
}
