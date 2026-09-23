import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { PERMISSION_DEFINITIONS } from '../../common/constants/permissions.constants';
import { RbacService } from '../../modules/rbac/rbac.service';

/**
 * Reconciles the `permissions` table with the code-level catalogue.
 *
 * Idempotent and safe to run on every deploy — that is the point. The catalogue
 * in `permissions.constants.ts` is the source of truth, and
 * `@RequirePermissions('agent:create')` in a controller is useless if the
 * corresponding row does not exist. Running this as part of every deployment is
 * what keeps code and database from drifting apart.
 *
 * Rows are inserted and updated but never deleted: a key removed from the code
 * may still be referenced by a workspace's custom role, and dropping the row
 * would silently revoke that grant.
 */
export async function seedPermissions(app: INestApplicationContext): Promise<void> {
  const logger = new Logger('Seed:Permissions');
  const rbacService = app.get(RbacService);

  const result = await rbacService.syncPermissionCatalogue();

  logger.log(
    `Permission catalogue synchronised: ${PERMISSION_DEFINITIONS.length} defined, ` +
      `${result.created} created, ${result.updated} updated.`,
  );
}
