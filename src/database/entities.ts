import { ApiKey } from '../modules/api-keys/entities/api-key.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';
import { Invitation } from '../modules/invitations/entities/invitation.entity';
import { Document } from '../modules/knowledge/entities/document.entity';
import { DocumentChunk } from '../modules/knowledge/entities/document-chunk.entity';
import { KnowledgeBaseGrant } from '../modules/knowledge/entities/knowledge-base-grant.entity';
import { KnowledgeBase } from '../modules/knowledge/entities/knowledge-base.entity';
import { OrganizationIpRule } from '../modules/organizations/entities/organization-ip-rule.entity';
import { Organization } from '../modules/organizations/entities/organization.entity';
import { OrganizationMember } from '../modules/memberships/entities/organization-member.entity';
import { Permission } from '../modules/rbac/entities/permission.entity';
import { Role } from '../modules/rbac/entities/role.entity';
import { Session } from '../modules/auth/entities/session.entity';
import { UserToken } from '../modules/users/entities/user-token.entity';
import { User } from '../modules/users/entities/user.entity';

/**
 * Every persisted entity, listed explicitly.
 *
 * Glob-based entity discovery (`src/**\/*.entity.ts`) is the Nest default but is
 * fragile in practice: the pattern that works under ts-node does not match
 * compiled output, and a missed entity surfaces as a confusing "no metadata
 * found" error at runtime rather than a compile error. An explicit list is
 * verified by the type checker and behaves identically in development, in the
 * compiled build and in the TypeORM CLI.
 */
export const entities = [
  User,
  UserToken,
  Session,
  Organization,
  OrganizationIpRule,
  OrganizationMember,
  Role,
  Permission,
  Invitation,
  ApiKey,
  AuditLog,
  KnowledgeBase,
  KnowledgeBaseGrant,
  Document,
  DocumentChunk,
];

export {
  ApiKey,
  AuditLog,
  Document,
  DocumentChunk,
  Invitation,
  KnowledgeBase,
  KnowledgeBaseGrant,
  Organization,
  OrganizationIpRule,
  OrganizationMember,
  Permission,
  Role,
  Session,
  User,
  UserToken,
};
