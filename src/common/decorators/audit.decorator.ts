import { SetMetadata } from '@nestjs/common';
import { METADATA_KEY } from '../constants/app.constants';
import type { AuditAction } from '../enums/audit-action.enum';

/**
 * Describes how a route should be audited.
 *
 * The audit interceptor reads this and writes a record on both the success and
 * failure paths, so a denied or errored attempt is logged just as reliably as a
 * successful one. That symmetry is the point: from a compliance standpoint, the
 * attempt that failed is usually the interesting one.
 */
export interface AuditDescriptor {
  action: AuditAction;

  /** Entity kind this route acts on, e.g. `organization`, `role`, `member`. */
  resourceType?: string;

  /**
   * Where to find the resource id on the request.
   *
   * Dotted path resolved against `{ params, body, query }`, for example
   * `params.roleId` or `body.memberId`. When omitted, the interceptor falls back
   * to the handler's return value (`result.id`), which covers create routes
   * where the id does not exist until the handler has run.
   */
  resourceIdFrom?: string;

  /** Same, for a human readable label — `body.name`, `params.slug`. */
  resourceLabelFrom?: string;

  /**
   * Request body fields to copy into the audit record's metadata.
   *
   * An allowlist, never the whole body. Recording an entire request body is how
   * audit logs end up containing the very secrets they were meant to protect;
   * naming fields explicitly makes each inclusion a deliberate decision. Values
   * still pass through structural redaction afterwards, as defence in depth.
   */
  captureBodyFields?: string[];

  /**
   * Skip the record when the handler succeeds, logging only failures.
   *
   * For high-volume read endpoints where success is uninteresting but a denial
   * is worth seeing.
   */
  onlyOnFailure?: boolean;
}

/**
 * Marks a route for automatic auditing.
 *
 * Interceptor-driven auditing covers the uniform "who called what, and did it
 * work" case. Services still call `AuditService` directly for events with
 * domain-specific detail — refresh token reuse, a permission set diff — where a
 * generic descriptor could not capture what matters.
 *
 * @example
 * ```ts
 * @Audit({
 *   action: AuditAction.ROLE_CREATED,
 *   resourceType: 'role',
 *   captureBodyFields: ['name', 'permissionKeys'],
 * })
 * @Post('roles')
 * create(@Body() dto: CreateRoleDto) {}
 * ```
 */
export const Audit = (descriptor: AuditDescriptor) =>
  SetMetadata(METADATA_KEY.AUDIT, descriptor);
