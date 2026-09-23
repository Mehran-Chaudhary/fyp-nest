import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SystemRoleSlug } from '../../common/constants/permissions.constants';
import { OrganizationsService } from '../../modules/organizations/organizations.service';
import { RbacService } from '../../modules/rbac/rbac.service';
import { User, UserStatus } from '../../modules/users/entities/user.entity';
import { UsersService } from '../../modules/users/users.service';
import { RequestContextService } from '../../shared/context/request-context.service';

/**
 * A demonstration workspace with a realistic role structure.
 *
 * Gated behind `SEED_DEMO_DATA=true` and refused outright in production. It
 * exists so the frontend team has something to build against on day one, and so
 * the RBAC behaviour described in the proposal — the "HR Manager" and "Standard
 * Employee" roles of module 6.3 — can be demonstrated rather than described.
 *
 * Every account uses the same well-known password. That is acceptable precisely
 * because this never runs outside development, which the guard below enforces.
 */
const DEMO_PASSWORD = 'Demo-Workspace-2026!';

interface DemoPerson {
  email: string;
  firstName: string;
  lastName: string;
  roleSlug: string;
  title: string;
}

const DEMO_PEOPLE: DemoPerson[] = [
  {
    email: 'owner@acme.test',
    firstName: 'Mehran',
    lastName: 'Chaudhary',
    roleSlug: SystemRoleSlug.OWNER,
    title: 'Chief Technology Officer',
  },
  {
    email: 'admin@acme.test',
    firstName: 'Ahmad',
    lastName: 'Hanbal',
    roleSlug: SystemRoleSlug.ADMIN,
    title: 'Platform Administrator',
  },
  {
    email: 'hr@acme.test',
    firstName: 'Ameer',
    lastName: 'Abdullah',
    roleSlug: 'hr-manager',
    title: 'Head of People',
  },
  {
    email: 'employee@acme.test',
    firstName: 'Sara',
    lastName: 'Khan',
    roleSlug: SystemRoleSlug.MEMBER,
    title: 'Operations Analyst',
  },
  {
    email: 'auditor@acme.test',
    firstName: 'Bilal',
    lastName: 'Ahmed',
    roleSlug: 'compliance-auditor',
    title: 'Compliance Auditor',
  },
];

/**
 * Custom roles illustrating the proposal's own examples.
 *
 * The auditor role is the interesting one: it can read every conversation and
 * the entire audit log, but cannot run an agent, upload a document or change a
 * permission. That separation — oversight without operational power — is the
 * shape a real compliance role takes, and it is only expressible because the
 * permission catalogue is fine-grained.
 */
const DEMO_ROLES = [
  {
    slug: 'hr-manager',
    name: 'HR Manager',
    description:
      'Manages people and the HR knowledge base. Cannot alter platform security settings.',
    priority: 60,
    color: '#0ea5e9',
    permissionKeys: [
      'workspace:read',
      'member:read',
      'member:invite',
      'role:read',
      'knowledgebase:read',
      'knowledgebase:create',
      'document:read',
      'document:create',
      'document:update',
      'rag:query',
      'agent:read',
      'agent:execute',
      'conversation:read',
      'llm:invoke',
      'workflow:read',
      'workflow:execute',
      'usage:read',
    ],
  },
  {
    slug: 'compliance-auditor',
    name: 'Compliance Auditor',
    description:
      'Read-only oversight: the full audit log and every conversation, but no ability ' +
      'to run, change or delete anything.',
    priority: 55,
    color: '#f59e0b',
    permissionKeys: [
      'workspace:read',
      'member:read',
      'role:read',
      'audit:read',
      'audit:export',
      'audit:verify',
      'document:read',
      'knowledgebase:read',
      'agent:read',
      'conversation:read',
      'conversation:read_all',
      'workflow:read',
      'tool:read',
      'usage:read',
      'pii:policy:read',
    ],
  },
];

export async function seedDemoData(app: INestApplicationContext): Promise<void> {
  const logger = new Logger('Seed:Demo');

  if (process.env.NODE_ENV === 'production') {
    logger.warn('SEED_DEMO_DATA is set but NODE_ENV is production. Refusing to seed.');
    return;
  }

  const usersService = app.get(UsersService);
  const organizationsService = app.get(OrganizationsService);
  const rbacService = app.get(RbacService);
  const requestContext = app.get(RequestContextService);
  const dataSource = app.get(DataSource);

  // Seeding writes audit records; running inside a synthetic context gives them
  // a real actor rather than a null one.
  await requestContext.runAsSystem('demo seeder', async () => {
    const owner = await ensureUser(usersService, dataSource, DEMO_PEOPLE[0]);

    const existing = await organizationsService.findBySlug('acme-corp');
    if (existing) {
      logger.log('Demo workspace "acme-corp" already exists; nothing to do.');
      return;
    }

    const organization = await organizationsService.create(owner.id, {
      name: 'Acme Corporation',
      slug: 'acme-corp',
      description: 'Demonstration workspace showcasing multi-tenant RBAC.',
    });

    logger.log(`Created demo workspace ${organization.slug} (${organization.id}).`);

    // Created as the owner, who holds `*:*`, so the escalation guard permits any
    // permission set.
    for (const definition of DEMO_ROLES) {
      await rbacService.createRole(
        {
          organizationId: organization.id,
          name: definition.name,
          description: definition.description,
          permissionKeys: definition.permissionKeys,
          priority: definition.priority,
          color: definition.color,
        },
        ['*:*'],
        1000,
      );
      logger.log(`  role: ${definition.name}`);
    }

    const roles = await rbacService.listRoles(organization.id);
    const roleBySlug = new Map(roles.map((role) => [role.slug, role]));

    for (const person of DEMO_PEOPLE.slice(1)) {
      const user = await ensureUser(usersService, dataSource, person);
      const role = roleBySlug.get(person.roleSlug);

      if (!role) {
        logger.warn(`  role "${person.roleSlug}" not found; skipping ${person.email}.`);
        continue;
      }

      await dataSource.transaction(async (manager) => {
        const { MembershipStatus, OrganizationMember } = await import(
          '../../modules/memberships/entities/organization-member.entity'
        );

        const member = manager.getRepository(OrganizationMember).create({
          organizationId: organization.id,
          userId: user.id,
          status: MembershipStatus.ACTIVE,
          joinedAt: new Date(),
          title: person.title,
          roles: [role],
        });

        const saved = await manager.getRepository(OrganizationMember).save(member);
        await rbacService.recomputeMemberPermissions(saved.id, manager);
      });

      logger.log(`  member: ${person.email} as ${role.name}`);
    }

    await organizationsService.refreshMemberCount(organization.id);
  });

  logger.log('');
  logger.log('Demo accounts (development only):');
  for (const person of DEMO_PEOPLE) {
    logger.log(`  ${person.email.padEnd(22)} ${DEMO_PASSWORD}   (${person.roleSlug})`);
  }
  logger.log('');
}

/** Creates a demo user, or returns the existing one. Idempotent. */
async function ensureUser(
  usersService: UsersService,
  dataSource: DataSource,
  person: DemoPerson,
): Promise<User> {
  const existing = await usersService.findByEmail(person.email);
  if (existing) return existing;

  const user = await usersService.create({
    email: person.email,
    password: DEMO_PASSWORD,
    firstName: person.firstName,
    lastName: person.lastName,
    status: UserStatus.ACTIVE,
  });

  await dataSource
    .getRepository(User)
    .update({ id: user.id }, { emailVerifiedAt: new Date() });

  return user;
}
