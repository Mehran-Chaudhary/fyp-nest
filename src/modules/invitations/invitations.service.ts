import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../common/exceptions/app.exception';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/utils/pagination.util';
import { maskEmail } from '../../common/utils/redact.util';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import { TokenService } from '../../shared/crypto/token.service';
import { MailService } from '../../shared/mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { MembershipsService } from '../memberships/memberships.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../rbac/rbac.service';
import { UsersService } from '../users/users.service';
import { Invitation, InvitationStatus } from './entities/invitation.entity';

export interface CreateInvitationInput {
  organizationId: string;
  email: string;
  roleId?: string;
  message?: string;
  invitedById: string;
}

export interface InvitationView {
  id: string;
  email: string;
  status: InvitationStatus;
  role: { id: string; name: string; slug: string } | null;
  invitedBy: { id: string; name: string } | null;
  expiresAt: Date;
  createdAt: Date;
  lastSentAt: Date | null;
  sendCount: number;
}

/** What a recipient is shown before signing in, on the invitation landing page. */
export interface PublicInvitationPreview {
  organizationName: string;
  organizationSlug: string;
  roleName: string;
  inviterName: string;
  /** Masked: the page is reachable by anyone holding the link. */
  email: string;
  expiresAt: Date;
  requiresRegistration: boolean;
}

/**
 * Workspace invitations (proposal module 6.2).
 *
 * An invitation is a bearer credential: whoever holds the token can join the
 * workspace with the role it names. It is therefore handled like a password
 * reset link — stored only as an HMAC digest, expiring, single use, revocable.
 *
 * Two checks are worth calling out because both are easy to omit and both are
 * exploitable:
 *
 *  - **The invited address is re-checked at acceptance.** A forwarded invitation
 *    email would otherwise let an unintended recipient join. That is precisely
 *    the kind of quiet access leak an audit log exists to catch, and it is
 *    better prevented than detected.
 *  - **An inviter cannot grant a role above their own authority.** Otherwise
 *    `member:invite` — a routine permission — becomes an escalation path: invite
 *    a throwaway address as Owner, accept it, and the workspace is taken.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);
  private readonly security: SecurityConfig;

  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    private readonly organizationsService: OrganizationsService,
    private readonly membershipsService: MembershipsService,
    private readonly rbacService: RbacService,
    private readonly usersService: UsersService,
    private readonly mailService: MailService,
    private readonly auditService: AuditService,
    private readonly tokenService: TokenService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  // ── Creation ──────────────────────────────────────────────────────────────

  async create(
    input: CreateInvitationInput,
    actorPermissions: readonly string[],
    actorPriority: number,
  ): Promise<{ invitation: Invitation; view: InvitationView }> {
    const email = UsersService.normaliseEmail(input.email);
    const organization = await this.organizationsService.findByIdOrFail(
      input.organizationId,
    );

    await this.organizationsService.assertSeatAvailable(input.organizationId);
    this.assertEmailDomainAllowed(organization.settings.allowedEmailDomains, email);

    const role = input.roleId
      ? await this.rbacService.findRoleByIdOrFail(input.roleId, input.organizationId)
      : await this.rbacService.getDefaultRole(input.organizationId);

    // Inviting someone at or above your own level is an escalation path, not an
    // administrative convenience.
    if (role.priority >= actorPriority) {
      throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
        message: `You cannot invite someone as "${role.name}", which ranks at or above your own role.`,
        details: { rolePriority: role.priority, yourPriority: actorPriority },
      });
    }

    const missing = this.rbacService
      .expandToConcretePermissions(role.permissionKeys ?? [])
      .filter((permission) => !this.rbacService.can(actorPermissions, permission));

    if (missing.length > 0) {
      throw new ForbiddenError(ErrorCode.CANNOT_ESCALATE_PRIVILEGES, {
        message: `The "${role.name}" role grants permissions you do not hold, so you cannot invite anyone into it.`,
        details: { deniedPermissions: missing.slice(0, 20) },
      });
    }

    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      const existingMembership = await this.membershipsService.findByUserId(
        input.organizationId,
        existingUser.id,
      );
      if (existingMembership && existingMembership.isActive) {
        throw new ConflictError(ErrorCode.MEMBERSHIP_ALREADY_EXISTS);
      }
    }

    // A pending invitation for this address already exists. Enforced by a partial
    // unique index too, so two concurrent invites cannot both succeed.
    const pending = await this.invitationRepository.findOne({
      where: {
        organizationId: input.organizationId,
        emailNormalized: email,
        status: InvitationStatus.PENDING,
      },
    });

    if (pending && !pending.isExpired) {
      throw new ConflictError(ErrorCode.INVITATION_ALREADY_PENDING, {
        details: { invitationId: pending.id, expiresAt: pending.expiresAt },
      });
    }

    if (pending?.isExpired) {
      pending.status = InvitationStatus.EXPIRED;
      await this.invitationRepository.save(pending);
    }

    const generated = this.tokenService.generateToken(32);
    const inviter = await this.usersService.findByIdOrFail(input.invitedById);

    const invitation = await this.invitationRepository.save(
      this.invitationRepository.create({
        organizationId: input.organizationId,
        email: input.email.trim(),
        emailNormalized: email,
        tokenHash: generated.hash,
        status: InvitationStatus.PENDING,
        roleId: role.id,
        expiresAt: new Date(Date.now() + this.security.tokens.invitationTtlMs),
        invitedById: input.invitedById,
        message: input.message?.trim() ?? null,
        sendCount: 1,
        lastSentAt: new Date(),
      }),
    );

    await this.mailService.sendInvitation(invitation.email, {
      inviterName: inviter.preferredName,
      organizationName: organization.name,
      roleName: role.name,
      token: generated.token,
      message: invitation.message ?? undefined,
    });

    await this.auditService.recordSafe({
      action: AuditAction.MEMBER_INVITED,
      organizationId: input.organizationId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      resourceLabel: maskEmail(email),
      metadata: { roleSlug: role.slug, expiresAt: invitation.expiresAt.toISOString() },
    });

    return {
      invitation,
      view: await this.toView(invitation),
    };
  }

  /**
   * Re-sends an invitation with a brand-new token.
   *
   * The previous token is invalidated by overwriting the stored digest. Leaving
   * it live would mean an invitation the administrator believes they replaced is
   * still redeemable — for example after resending because the first link was
   * accidentally shared with the wrong person.
   */
  async resend(organizationId: string, invitationId: string): Promise<InvitationView> {
    const invitation = await this.findByIdOrFail(organizationId, invitationId);

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new ConflictError(
        invitation.status === InvitationStatus.ACCEPTED
          ? ErrorCode.INVITATION_ALREADY_ACCEPTED
          : ErrorCode.INVITATION_REVOKED,
      );
    }

    const organization = await this.organizationsService.findByIdOrFail(organizationId);
    const role = await this.rbacService.findRoleByIdOrFail(
      invitation.roleId,
      organizationId,
    );
    const inviter = await this.usersService.findByIdOrFail(invitation.invitedById);

    const generated = this.tokenService.generateToken(32);

    invitation.tokenHash = generated.hash;
    invitation.expiresAt = new Date(Date.now() + this.security.tokens.invitationTtlMs);
    invitation.sendCount += 1;
    invitation.lastSentAt = new Date();

    await this.invitationRepository.save(invitation);

    await this.mailService.sendInvitation(invitation.email, {
      inviterName: inviter.preferredName,
      organizationName: organization.name,
      roleName: role.name,
      token: generated.token,
      message: invitation.message ?? undefined,
    });

    await this.auditService.recordSafe({
      action: AuditAction.MEMBER_INVITATION_RESENT,
      organizationId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      resourceLabel: maskEmail(invitation.emailNormalized),
      metadata: { sendCount: invitation.sendCount },
    });

    return this.toView(invitation);
  }

  // ── Redemption ────────────────────────────────────────────────────────────

  /**
   * Public preview of an invitation, shown before the recipient signs in.
   *
   * The email address is masked. The page is reachable by anyone holding the
   * link, and an unmasked address would turn a forwarded invitation into a
   * disclosure of who else was invited.
   */
  async preview(token: string): Promise<PublicInvitationPreview> {
    const invitation = await this.findByToken(token);

    if (!invitation) throw new NotFoundError(ErrorCode.INVITATION_NOT_FOUND);
    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new ConflictError(ErrorCode.INVITATION_ALREADY_ACCEPTED);
    }
    if (invitation.status === InvitationStatus.REVOKED) {
      throw new ConflictError(ErrorCode.INVITATION_REVOKED);
    }
    if (invitation.isExpired) {
      throw new ConflictError(ErrorCode.INVITATION_EXPIRED);
    }

    const organization = await this.organizationsService.findByIdOrFail(
      invitation.organizationId,
    );
    const role = await this.rbacService.findRoleByIdOrFail(
      invitation.roleId,
      invitation.organizationId,
    );
    const inviter = await this.usersService.findById(invitation.invitedById);
    const existingUser = await this.usersService.findByEmail(invitation.emailNormalized);

    return {
      organizationName: organization.name,
      organizationSlug: organization.slug,
      roleName: role.name,
      inviterName: inviter?.preferredName ?? 'A workspace administrator',
      email: maskEmail(invitation.emailNormalized),
      expiresAt: invitation.expiresAt,
      requiresRegistration: !existingUser,
    };
  }

  /**
   * Redeems an invitation for a signed-in user.
   *
   * Runs as one transaction with the invitation row locked, so a token cannot be
   * redeemed twice concurrently — which would otherwise produce two memberships
   * or a membership plus a confusing error.
   */
  async accept(
    token: string,
    acceptingUser: { id: string; emailNormalized: string },
  ): Promise<{ organizationId: string; organizationSlug: string; memberId: string }> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Invitation);
      const tokenHash = this.tokenService.hashToken(token);

      const invitation = await repository
        .createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.token_hash = :tokenHash', { tokenHash })
        .getOne();

      if (!invitation) throw new NotFoundError(ErrorCode.INVITATION_NOT_FOUND);

      if (invitation.status === InvitationStatus.ACCEPTED) {
        throw new ConflictError(ErrorCode.INVITATION_ALREADY_ACCEPTED);
      }
      if (invitation.status === InvitationStatus.REVOKED) {
        throw new ConflictError(ErrorCode.INVITATION_REVOKED);
      }
      if (invitation.isExpired) {
        invitation.status = InvitationStatus.EXPIRED;
        await repository.save(invitation);
        throw new ConflictError(ErrorCode.INVITATION_EXPIRED);
      }

      // The binding check. Without it, a forwarded invitation email is a valid
      // credential for whoever received it.
      if (invitation.emailNormalized !== acceptingUser.emailNormalized) {
        await this.auditService.recordSafe({
          action: AuditAction.MEMBER_INVITATION_ACCEPTED,
          status: AuditStatus.FAILURE,
          organizationId: invitation.organizationId,
          resourceType: 'invitation',
          resourceId: invitation.id,
          errorCode: ErrorCode.INVITATION_EMAIL_MISMATCH,
          metadata: {
            invitedFor: maskEmail(invitation.emailNormalized),
            attemptedBy: maskEmail(acceptingUser.emailNormalized),
          },
        });

        throw new UnauthorizedError(ErrorCode.INVITATION_EMAIL_MISMATCH, {
          message:
            'This invitation was issued to a different email address. ' +
            'Sign in with the address it was sent to.',
        });
      }

      const member = await this.membershipsService.addMember(
        invitation.organizationId,
        acceptingUser.id,
        [invitation.roleId],
        invitation.invitedById,
        manager,
      );

      invitation.status = InvitationStatus.ACCEPTED;
      invitation.acceptedAt = new Date();
      invitation.acceptedById = acceptingUser.id;
      await repository.save(invitation);

      const organization = await this.organizationsService.findById(
        invitation.organizationId,
        manager,
      );

      await this.auditService.record(
        {
          action: AuditAction.MEMBER_INVITATION_ACCEPTED,
          organizationId: invitation.organizationId,
          resourceType: 'member',
          resourceId: member.id,
          resourceLabel: maskEmail(acceptingUser.emailNormalized),
          metadata: { invitationId: invitation.id, roleId: invitation.roleId },
        },
        manager,
      );

      return {
        organizationId: invitation.organizationId,
        organizationSlug: organization?.slug ?? '',
        memberId: member.id,
      };
    });
  }

  // ── Management ────────────────────────────────────────────────────────────

  async list(
    organizationId: string,
    page: number,
    limit: number,
    status?: InvitationStatus,
  ): Promise<PaginatedResult<InvitationView>> {
    const [invitations, total] = await this.invitationRepository.findAndCount({
      where: { organizationId, ...(status ? { status } : {}) },
      relations: { role: true, invitedBy: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const items = await Promise.all(
      invitations.map((invitation) => this.toView(invitation)),
    );

    return { items, meta: buildPaginationMeta(total, page, limit) };
  }

  async revoke(
    organizationId: string,
    invitationId: string,
    revokedById: string,
  ): Promise<InvitationView> {
    const invitation = await this.findByIdOrFail(organizationId, invitationId);

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new ConflictError(ErrorCode.INVITATION_ALREADY_ACCEPTED, {
        message: 'This invitation has already been accepted. Remove the member instead.',
      });
    }

    invitation.status = InvitationStatus.REVOKED;
    invitation.revokedAt = new Date();
    invitation.revokedById = revokedById;
    // Overwritten so the outstanding link stops working immediately.
    invitation.tokenHash = this.tokenService.hashToken(
      `revoked:${invitation.id}:${Date.now()}`,
    );

    await this.invitationRepository.save(invitation);

    await this.auditService.recordSafe({
      action: AuditAction.MEMBER_INVITATION_REVOKED,
      organizationId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      resourceLabel: maskEmail(invitation.emailNormalized),
    });

    return this.toView(invitation);
  }

  /** Marks lapsed invitations as expired, for accurate dashboard counts. */
  async expireStale(): Promise<number> {
    const result = await this.invitationRepository.update(
      { status: InvitationStatus.PENDING, expiresAt: LessThan(new Date()) },
      { status: InvitationStatus.EXPIRED },
    );

    return result.affected ?? 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async findByToken(token: string): Promise<Invitation | null> {
    return this.invitationRepository.findOne({
      where: { tokenHash: this.tokenService.hashToken(token) },
    });
  }

  private async findByIdOrFail(
    organizationId: string,
    invitationId: string,
  ): Promise<Invitation> {
    const invitation = await this.invitationRepository.findOne({
      where: { id: invitationId, organizationId },
      relations: { role: true, invitedBy: true },
    });

    if (!invitation) throw new NotFoundError(ErrorCode.INVITATION_NOT_FOUND);
    return invitation;
  }

  private assertEmailDomainAllowed(
    allowedDomains: string[] | undefined,
    email: string,
  ): void {
    if (!allowedDomains || allowedDomains.length === 0) return;

    const domain = email.split('@')[1];
    const permitted = allowedDomains.some(
      (allowed) => allowed.toLowerCase().replace(/^@/, '') === domain,
    );

    if (!permitted) {
      throw new BadRequestError(ErrorCode.BAD_REQUEST, {
        message: `This workspace only accepts members from: ${allowedDomains.join(', ')}.`,
        details: { allowedDomains },
      });
    }
  }

  private async toView(invitation: Invitation): Promise<InvitationView> {
    const role =
      invitation.role ??
      (await this.rbacService.findRoleById(invitation.roleId, invitation.organizationId));

    const inviter =
      invitation.invitedBy ?? (await this.usersService.findById(invitation.invitedById));

    return {
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      role: role ? { id: role.id, name: role.name, slug: role.slug } : null,
      invitedBy: inviter ? { id: inviter.id, name: inviter.preferredName } : null,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      lastSentAt: invitation.lastSentAt,
      sendCount: invitation.sendCount,
    };
  }
}
