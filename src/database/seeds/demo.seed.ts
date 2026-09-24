import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SystemRoleSlug } from '../../common/constants/permissions.constants';
import { AgentsService } from '../../modules/agents/agents.service';
import { AgentAccessMode } from '../../modules/agents/domain/agent-config';
import { ListAgentsQueryDto } from '../../modules/agents/dto/agent.dto';
import {
  AccessLevel,
  KnowledgeBaseAccessMode,
  type AccessPrincipal,
} from '../../modules/knowledge/domain/access';
import { Classification } from '../../modules/knowledge/domain/classification';
import { GrantSubjectType } from '../../modules/knowledge/entities/knowledge-base-grant.entity';
import { KnowledgeBasesService } from '../../modules/knowledge/knowledge-bases/knowledge-bases.service';
import {
  MembershipStatus,
  OrganizationMember,
} from '../../modules/memberships/entities/organization-member.entity';
import { OrganizationsService } from '../../modules/organizations/organizations.service';
import { PiiPolicyService } from '../../modules/privacy/pii-policy.service';
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
      'knowledgebase:update',
      'document:read',
      'document:create',
      'document:update',
      'document:download',
      'rag:query',
      // Holds the highest clearance in the workspace: payroll is RESTRICTED.
      'clearance:restricted',
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
      'clearance:confidential',
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
      logger.log('Demo workspace "acme-corp" already exists.');
      await seedDemoKnowledge(app, existing.id, owner.id, logger);
      await seedDemoAgents(app, existing.id, owner.id, logger);
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
    await seedDemoKnowledge(app, organization.id, owner.id, logger);
    await seedDemoAgents(app, organization.id, owner.id, logger);
  });

  logger.log('');
  logger.log('Demo accounts (development only):');
  for (const person of DEMO_PEOPLE) {
    logger.log(`  ${person.email.padEnd(22)} ${DEMO_PASSWORD}   (${person.roleSlug})`);
  }
  logger.log('');
}

/**
 * Two knowledge bases that make the phase 2 access model demonstrable:
 *
 *  - **Company Handbook** — WORKSPACE mode, INTERNAL. Every member can search it.
 *  - **HR Policies** — a RESTRICTED compartment, CONFIDENTIAL by default. Only
 *    the HR Manager role (MANAGE) and the Compliance Auditor role (READ) are
 *    admitted; to everyone else, including the administrator, it does not exist.
 *
 * Created through the same service the API uses, as the owner. Documents are not
 * seeded: they need the object store, the vector store and the AI service, and
 * uploading a few through the API is the better demonstration anyway.
 */
async function seedDemoKnowledge(
  app: INestApplicationContext,
  organizationId: string,
  ownerUserId: string,
  logger: Logger,
): Promise<void> {
  const knowledgeBases = app.get(KnowledgeBasesService);
  const rbacService = app.get(RbacService);
  const dataSource = app.get(DataSource);

  const [membership]: Array<{ id: string }> = await dataSource.query(
    `SELECT id FROM organization_members
      WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [organizationId, ownerUserId],
  );

  const owner: AccessPrincipal = {
    organizationId,
    kind: 'user',
    userId: ownerUserId,
    membershipId: membership?.id,
    permissions: ['*:*'],
  };

  const existing = await knowledgeBases.list(owner, {
    page: 1,
    limit: 100,
    sortDirection: 'ASC',
  });
  const names = new Set(existing.items.map((base) => base.name));

  if (!names.has('Company Handbook')) {
    await knowledgeBases.create(owner, {
      name: 'Company Handbook',
      description: 'Policies and guides every employee may read.',
      accessMode: KnowledgeBaseAccessMode.WORKSPACE,
      defaultClassification: Classification.INTERNAL,
    });
    logger.log('  knowledge base: Company Handbook (WORKSPACE, INTERNAL)');
  }

  if (!names.has('HR Policies')) {
    const hr = await knowledgeBases.create(owner, {
      name: 'HR Policies',
      description: 'Compensation, disciplinary and payroll material. Restricted to HR.',
      accessMode: KnowledgeBaseAccessMode.RESTRICTED,
      defaultClassification: Classification.CONFIDENTIAL,
    });

    const roles = new Map(
      (await rbacService.listRoles(organizationId)).map((role) => [role.slug, role]),
    );
    const grants: Array<[string, AccessLevel]> = [
      ['hr-manager', AccessLevel.MANAGE],
      ['compliance-auditor', AccessLevel.READ],
    ];

    for (const [slug, accessLevel] of grants) {
      const role = roles.get(slug);
      if (!role) continue;
      await knowledgeBases.upsertGrant(owner, hr.id, {
        subjectType: GrantSubjectType.ROLE,
        subjectId: role.id,
        accessLevel,
      });
    }
    logger.log(
      '  knowledge base: HR Policies (RESTRICTED, CONFIDENTIAL; HR Manager + Auditor)',
    );
  }
}

/**
 * Phase 3: two agents and a redaction policy that make the privacy design
 * demonstrable.
 *
 *  - **Company Helpdesk** — published to the whole workspace, answers from the
 *    Company Handbook.
 *  - **HR Assistant** — published but RESTRICTED to the HR Manager role, and
 *    answers from the HR Policies compartment. Even if someone else could use
 *    it, it would retrieve only what *they* may read.
 *
 * The demo policy degrades to pattern-only detection when the NER detector is
 * unreachable, so the demo works before the AI service implements
 * `/v1/pii/analyze`. The platform default, and the right production setting,
 * is to refuse instead.
 */
async function seedDemoAgents(
  app: INestApplicationContext,
  organizationId: string,
  ownerUserId: string,
  logger: Logger,
): Promise<void> {
  const agents = app.get(AgentsService);
  const knowledgeBases = app.get(KnowledgeBasesService);
  const policies = app.get(PiiPolicyService);
  const rbacService = app.get(RbacService);
  const dataSource = app.get(DataSource);

  const [membership]: Array<{ id: string }> = await dataSource.query(
    `SELECT id FROM organization_members
      WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [organizationId, ownerUserId],
  );
  const owner: AccessPrincipal = {
    organizationId,
    kind: 'user',
    userId: ownerUserId,
    membershipId: membership?.id,
    permissions: ['*:*'],
  };

  const policy = await policies.getEffective(organizationId);
  if (policy.source === 'default') {
    await policies.update(organizationId, ownerUserId, {
      onDetectorFailure: 'DEGRADE_TO_PATTERNS',
      allowList: ['Acme Corporation'],
      denyList: ['Project Falcon'],
    });
    logger.log('  PII policy: defaults, degrade-to-patterns, deny list "Project Falcon"');
  }

  const bases = new Map(
    (
      await knowledgeBases.list(owner, { page: 1, limit: 100, sortDirection: 'ASC' })
    ).items.map((base) => [base.name, base.id]),
  );
  const existing = new Set(
    (
      await agents.list(owner, Object.assign(new ListAgentsQueryDto(), { limit: 100 }))
    ).items.map((agent) => agent.name),
  );

  if (!existing.has('Company Helpdesk') && bases.has('Company Handbook')) {
    const helpdesk = await agents.create(owner, {
      name: 'Company Helpdesk',
      description: 'Answers questions about company policies from the handbook.',
      persona: {
        role: 'the company helpdesk',
        tone: 'friendly',
        greeting: 'Hi! Ask me anything about our policies.',
      },
      instructions:
        'Help employees understand company policy. Keep answers short and point to the ' +
        'relevant section of the handbook.',
      retrieval: { knowledgeBaseIds: [bases.get('Company Handbook') as string] },
    });
    await agents.setPublished(owner, helpdesk.id, true);
    logger.log('  agent: Company Helpdesk (published, handbook)');
  }

  if (!existing.has('HR Assistant') && bases.has('HR Policies')) {
    const roles = new Map(
      (await rbacService.listRoles(organizationId)).map((role) => [role.slug, role.id]),
    );
    const hrManager = roles.get('hr-manager');
    const assistant = await agents.create(owner, {
      name: 'HR Assistant',
      description: 'Answers HR questions, including compensation, for the HR team.',
      persona: { role: 'a careful HR policy assistant', tone: 'formal' },
      instructions:
        'You support the HR team. Be precise about figures and always cite the source. ' +
        'Never speculate about individual employees beyond what the sources say.',
      retrieval: { knowledgeBaseIds: [bases.get('HR Policies') as string] },
      accessMode: AgentAccessMode.RESTRICTED,
      allowedRoleIds: hrManager ? [hrManager] : [],
    });
    await agents.setPublished(owner, assistant.id, true);
    logger.log('  agent: HR Assistant (published, RESTRICTED to HR Manager, HR Policies)');
  }
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
