import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { hasPermission } from '../../common/utils/permission.util';
import type { AccessPrincipal } from '../knowledge/domain/access';
import type { WorkflowRun } from './entities/workflow-run.entity';

/** The permission a run's initiator must still hold for it to keep running. */
export const RUN_PERMISSION = 'workflow:execute';

export class PrincipalRevokedError extends AppException {
  constructor(reason: string) {
    super(ErrorCode.WORKFLOW_PRINCIPAL_REVOKED, HttpStatus.FORBIDDEN, {
      details: { reason },
    });
  }
}

/**
 * Who a run acts for, re-established from the database before every step.
 *
 * A run is a delegate of the person (or API key) that started it, exactly as
 * an agent is (ADR 0003) — and it may run for minutes or, waiting for an
 * approval, for days. Taking the initiator's access once, at the start, would
 * let a run carry on with access its initiator has since lost. So each step
 * re-reads the membership, its status and its materialised permissions (not
 * the five-minute cache), and a run whose initiator was removed, suspended or
 * stripped of `workflow:execute` stops at its next step.
 */
@Injectable()
export class RunPrincipalService {
  constructor(private readonly dataSource: DataSource) {}

  async resolve(
    run: Pick<
      WorkflowRun,
      'organizationId' | 'initiatorUserId' | 'initiatorApiKeyId' | 'initiatorMembershipId'
    >,
  ): Promise<AccessPrincipal> {
    const [organization]: Array<{ status: string }> = await this.dataSource.query(
      `SELECT status FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [run.organizationId],
    );
    if (!organization || organization.status !== 'ACTIVE') {
      throw new PrincipalRevokedError('WORKSPACE_INACTIVE');
    }

    if (run.initiatorApiKeyId) {
      const [key]: Array<{
        scopes: string[];
        revoked_at: Date | null;
        expires_at: Date | null;
      }> = await this.dataSource.query(
        `SELECT scopes, revoked_at, expires_at FROM api_keys
          WHERE id = $1 AND organization_id = $2`,
        [run.initiatorApiKeyId, run.organizationId],
      );
      if (
        !key ||
        key.revoked_at ||
        (key.expires_at && key.expires_at.getTime() < Date.now())
      ) {
        throw new PrincipalRevokedError('API_KEY_REVOKED');
      }
      const permissions = key.scopes ?? [];
      if (!hasPermission(permissions, RUN_PERMISSION)) {
        throw new PrincipalRevokedError('PERMISSION_WITHDRAWN');
      }
      return {
        organizationId: run.organizationId,
        kind: 'api_key',
        apiKeyId: run.initiatorApiKeyId,
        permissions,
      };
    }

    if (!run.initiatorUserId) throw new PrincipalRevokedError('NO_INITIATOR');

    const [user]: Array<{ status: string; is_platform_admin: boolean }> =
      await this.dataSource.query(
        `SELECT status, is_platform_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [run.initiatorUserId],
      );
    if (!user || user.status !== 'ACTIVE')
      throw new PrincipalRevokedError('ACCOUNT_INACTIVE');

    const [member]: Array<{ id: string; status: string; permissions: string[] }> =
      await this.dataSource.query(
        `SELECT id, status, effective_permissions AS permissions FROM organization_members
          WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [run.organizationId, run.initiatorUserId],
      );

    if (!member) {
      // A platform administrator's break-glass run: they hold everything, and
      // must still be an administrator now.
      if (user.is_platform_admin && !run.initiatorMembershipId) {
        return {
          organizationId: run.organizationId,
          kind: 'user',
          userId: run.initiatorUserId,
          permissions: ['*:*'],
        };
      }
      throw new PrincipalRevokedError('MEMBERSHIP_REMOVED');
    }
    if (member.status !== 'ACTIVE') throw new PrincipalRevokedError('MEMBERSHIP_SUSPENDED');

    const permissions = member.permissions ?? [];
    if (!hasPermission(permissions, RUN_PERMISSION)) {
      throw new PrincipalRevokedError('PERMISSION_WITHDRAWN');
    }
    return {
      organizationId: run.organizationId,
      kind: 'user',
      userId: run.initiatorUserId,
      membershipId: member.id,
      permissions,
    };
  }
}
