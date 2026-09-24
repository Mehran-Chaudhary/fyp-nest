import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { ForbiddenError } from '../../common/exceptions/app.exception';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface';
import { isUuid } from '../../common/utils/uuid.util';
import type { AccessPrincipal } from './domain/access';

/**
 * The knowledge layer's view of the caller, assembled from what the global
 * guards already verified.
 *
 * Nothing here comes from the request body or query string: the workspace,
 * the membership and the permission set were all resolved from the database by
 * the organization-context guard.
 */
export const CurrentAccessPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const organizationId = request.organization?.id;

    if (!organizationId) {
      throw new ForbiddenError(ErrorCode.ORGANIZATION_CONTEXT_REQUIRED);
    }

    if (request.apiKey) {
      return {
        organizationId,
        kind: 'api_key',
        apiKeyId: request.apiKey.id,
        permissions: request.permissions ?? [],
      };
    }

    // A platform administrator's synthetic membership id is not a UUID and
    // matches no row, so it is dropped rather than passed into SQL.
    const membershipId = request.membership?.id;

    return {
      organizationId,
      kind: 'user',
      userId: request.user?.id,
      membershipId: membershipId && isUuid(membershipId) ? membershipId : undefined,
      permissions: request.permissions ?? [],
    };
  },
);
