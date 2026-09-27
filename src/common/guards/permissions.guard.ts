import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { METADATA_KEY } from '../constants/app.constants';
import { AuditAction, AuditStatus } from '../enums/audit-action.enum';
import { AuthType } from '../enums/auth-type.enum';
import { ErrorCode } from '../enums/error-code.enum';
import { ForbiddenError, PermissionDeniedError } from '../exceptions/app.exception';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { hasAnyPermission, missingPermissions } from '../utils/permission.util';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { AuditService } from '../../modules/audit/audit.service';

/**
 * Enforces `@RequirePermissions(...)` — the final authorization gate.
 *
 * Runs last among the global guards, on a request whose principal and workspace
 * are already established. Its inputs are therefore facts, not claims: the
 * permission set it reads was materialised from the database by the RBAC service
 * and attached by the organization-context guard, never taken from the token.
 *
 * That is deliberate and is the reason permissions are absent from the JWT. A
 * permission set embedded in a token cannot be revoked before the token expires,
 * so a member stripped of `document:read` would keep reading documents for up to
 * a full access-token lifetime. "Strict RBAC" has to mean strict *now*.
 *
 * ## Denials are audited
 *
 * Every rejection writes an `ACCESS_DENIED` record. In a compliance log the
 * denied attempts are usually the interesting ones: they are what reveal an
 * account probing beyond its remit, and they are the first thing a reviewer
 * looks for after an incident.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly mfaRequiredForPlatformAdmins: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.mfaRequiredForPlatformAdmins =
      configService.get<SecurityConfig>(SECURITY_CONFIG_KEY)?.mfa.requiredForPlatformAdmins ??
      false;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const authTypes = this.reflector.getAllAndOverride<AuthType[]>(METADATA_KEY.AUTH_TYPE, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [AuthType.Bearer];

    if (authTypes.includes(AuthType.None)) return true;

    // ── Platform administration ─────────────────────────────────────────────
    const platformAdminOnly = this.reflector.getAllAndOverride<boolean>(
      METADATA_KEY.PLATFORM_ADMIN_ONLY,
      [context.getHandler(), context.getClass()],
    );

    if (platformAdminOnly) {
      // An API key can never reach a platform-administration route. Keys are
      // issued by workspace administrators, so honouring one here would let a
      // tenant mint itself platform-level access.
      if (!request.user?.isPlatformAdmin) {
        await this.recordDenial(request, ['platform:admin']);
        throw new ForbiddenError(ErrorCode.FORBIDDEN, {
          message: 'This endpoint is restricted to platform administrators.',
        });
      }
      // Phase 5: operating the platform can be made to require a session
      // that passed a second factor (MFA_REQUIRED_FOR_PLATFORM_ADMINS).
      if (this.mfaRequiredForPlatformAdmins && !request.user.mfaVerified) {
        throw new ForbiddenError(ErrorCode.MFA_REQUIRED, {
          message: 'Platform administration requires a session verified with two-step verification.',
          details: { requiredBy: 'platform' },
        });
      }
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[]>(
      METADATA_KEY.REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const granted = request.permissions ?? [];

    if (granted.length === 0) {
      // Reaching a permission-gated route with no resolved permission set means
      // the organization-context guard was skipped on a route that needed it —
      // a wiring mistake. Fail closed and say so clearly.
      await this.recordDenial(request, required);
      throw new ForbiddenError(ErrorCode.ORGANIZATION_CONTEXT_REQUIRED, {
        message:
          'This endpoint requires a workspace context. Supply the X-Organization-Id header.',
      });
    }

    const anyOf = this.reflector.getAllAndOverride<boolean>(
      METADATA_KEY.PERMISSIONS_ANY_OF,
      [context.getHandler(), context.getClass()],
    );

    if (anyOf) {
      if (hasAnyPermission(granted, required)) return true;

      await this.recordDenial(request, required);
      throw new PermissionDeniedError(required, {
        message: `This action requires at least one of: ${required.join(', ')}.`,
      });
    }

    const missing = missingPermissions(granted, required);
    if (missing.length === 0) return true;

    await this.recordDenial(request, missing);
    throw new PermissionDeniedError(missing);
  }

  private async recordDenial(
    request: AuthenticatedRequest,
    missing: string[],
  ): Promise<void> {
    await this.auditService.recordSafe({
      action: AuditAction.ACCESS_DENIED,
      status: AuditStatus.DENIED,
      organizationId: request.organization?.id,
      resourceType: 'endpoint',
      resourceId: request.originalUrl?.split('?')[0],
      metadata: {
        missingPermissions: missing,
        method: request.method,
        authType: request.authType,
      },
    });
  }
}
