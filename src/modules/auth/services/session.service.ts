import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository, type EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { UnauthorizedError } from '../../../common/exceptions/app.exception';
import { TokenService } from '../../../shared/crypto/token.service';
import { Session, SessionRevocationReason } from '../entities/session.entity';

export interface CreateSessionInput {
  /**
   * The id the tokens already carry as `sid`. The row must have it, or an
   * access token's session could not be found (to sign it out, or to mark it
   * verified with a second factor).
   */
  id?: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  familyId?: string;
  ipAddress?: string;
  userAgent?: string;
  organizationId?: string | null;
  /** When the sign-in passed a second factor (phase 5); inherited by every rotation. */
  mfaVerifiedAt?: Date | null;
}

export interface RotateSessionResult {
  session: Session;
  familyId: string;
}

/**
 * Refresh token lifecycle: creation, rotation, reuse detection and revocation.
 *
 * Implements the rotation scheme documented on {@link Session}. The
 * security-critical method is {@link rotate}, and the case that matters most is
 * the one where the presented token has *already* been rotated: that means two
 * parties hold it, so the entire family is revoked rather than just the
 * presented token. Revoking only the presented token would leave the attacker's
 * newer token working.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
    private readonly tokenService: TokenService,
  ) {}

  /** Records a new refresh token, starting a family unless one is supplied. */
  async create(input: CreateSessionInput, manager?: EntityManager): Promise<Session> {
    const repository = manager ? manager.getRepository(Session) : this.sessionRepository;

    const session = repository.create({
      ...(input.id ? { id: input.id } : {}),
      userId: input.userId,
      familyId: input.familyId ?? randomUUID(),
      tokenHash: this.tokenService.hashToken(input.refreshToken),
      expiresAt: input.expiresAt,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      deviceLabel: input.userAgent ? describeDevice(input.userAgent) : null,
      organizationId: input.organizationId ?? null,
      mfaVerifiedAt: input.mfaVerifiedAt ?? null,
      lastUsedAt: new Date(),
    });

    return repository.save(session);
  }

  /** Locates a session by the token presented, without judging its state. */
  async findByToken(
    refreshToken: string,
    manager?: EntityManager,
  ): Promise<Session | null> {
    const repository = manager ? manager.getRepository(Session) : this.sessionRepository;
    return repository.findOne({
      where: { tokenHash: this.tokenService.hashToken(refreshToken) },
    });
  }

  /**
   * Exchanges a refresh token for a new one, detecting reuse.
   *
   * The whole operation runs in one transaction with the row locked
   * (`SELECT ... FOR UPDATE`). Without the lock, two concurrent refreshes with
   * the same token could both read it as live and both rotate it, forking the
   * family and — worse — making a genuine replay attack indistinguishable from a
   * benign race.
   *
   * Callers must treat {@link ErrorCode.AUTH_REFRESH_TOKEN_REUSED} as a security
   * incident: it is audited at `CRITICAL` severity and every session in the
   * family is already gone by the time the error surfaces.
   */
  async rotate(
    manager: EntityManager,
    presentedToken: string,
    newToken: string,
    expiresAt: Date,
    context: { ipAddress?: string; userAgent?: string },
    replacementId?: string,
  ): Promise<RotateSessionResult> {
    const repository = manager.getRepository(Session);
    const tokenHash = this.tokenService.hashToken(presentedToken);

    const existing = await repository
      .createQueryBuilder('session')
      .setLock('pessimistic_write')
      .where('session.token_hash = :tokenHash', { tokenHash })
      .getOne();

    if (!existing) {
      // No such session. Either forged, or issued before a full session purge.
      throw new UnauthorizedError(ErrorCode.AUTH_REFRESH_TOKEN_INVALID);
    }

    if (existing.indicatesReuse) {
      // The token was already exchanged once. Someone else has a copy.
      this.logger.warn(
        `Refresh token reuse detected for user ${existing.userId} ` +
          `(family ${existing.familyId}). Revoking the entire family.`,
      );

      await this.revokeFamily(
        existing.familyId,
        SessionRevocationReason.REUSE_DETECTED,
        manager,
      );

      throw new UnauthorizedError(ErrorCode.AUTH_REFRESH_TOKEN_REUSED, {
        auditMetadata: {
          familyId: existing.familyId,
          originalSessionId: existing.id,
          revokedAt: existing.revokedAt?.toISOString(),
        },
      });
    }

    if (existing.isRevoked) {
      // Revoked for a non-rotation reason: signed out, password changed, and so
      // on. Not evidence of compromise, just no longer valid.
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_REVOKED);
    }

    if (existing.isExpired) {
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_EXPIRED);
    }

    const replacement = repository.create({
      // The id the new tokens carry as `sid`.
      ...(replacementId ? { id: replacementId } : {}),
      userId: existing.userId,
      familyId: existing.familyId,
      tokenHash: this.tokenService.hashToken(newToken),
      expiresAt,
      ipAddress: context.ipAddress ?? existing.ipAddress,
      userAgent: context.userAgent ?? existing.userAgent,
      deviceLabel: context.userAgent
        ? describeDevice(context.userAgent)
        : existing.deviceLabel,
      organizationId: existing.organizationId,
      // A refreshed token has exactly the assurance of the sign-in it descends from.
      mfaVerifiedAt: existing.mfaVerifiedAt,
      lastUsedAt: new Date(),
    });

    const saved = await repository.save(replacement);

    await repository.update(
      { id: existing.id },
      {
        revokedAt: new Date(),
        revokedReason: SessionRevocationReason.ROTATED,
        replacedBySessionId: saved.id,
        lastUsedAt: new Date(),
      },
    );

    return { session: saved, familyId: existing.familyId };
  }

  /** Revokes one session. Used when a user signs out of a single device. */
  async revoke(
    sessionId: string,
    reason: SessionRevocationReason,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = manager ? manager.getRepository(Session) : this.sessionRepository;

    await repository.update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /** Revokes every live session in a family: one device, signed out everywhere. */
  async revokeFamily(
    familyId: string,
    reason: SessionRevocationReason,
    manager?: EntityManager,
  ): Promise<number> {
    const repository = manager ? manager.getRepository(Session) : this.sessionRepository;

    const result = await repository
      .createQueryBuilder()
      .update(Session)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where('family_id = :familyId', { familyId })
      .andWhere('revoked_at IS NULL')
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Revokes every live session belonging to a user.
   *
   * `exceptFamilyId` keeps the caller's own device signed in, which is what
   * "sign out all other devices" means to a user.
   */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevocationReason,
    exceptFamilyId?: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repository = manager ? manager.getRepository(Session) : this.sessionRepository;

    const query = repository
      .createQueryBuilder()
      .update(Session)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL');

    if (exceptFamilyId) {
      query.andWhere('family_id != :exceptFamilyId', { exceptFamilyId });
    }

    const result = await query.execute();
    return result.affected ?? 0;
  }

  /**
   * Live sessions for a user, one row per device.
   *
   * Collapsed to the newest session per family: a user who has been signed in
   * for a month has hundreds of rotated rows for one device, and showing them
   * all would make the security screen unusable.
   */
  async listActiveDevices(userId: string): Promise<Session[]> {
    const sessions = await this.sessionRepository.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    const newestPerFamily = new Map<string, Session>();
    for (const session of sessions) {
      if (session.isExpired) continue;
      if (!newestPerFamily.has(session.familyId)) {
        newestPerFamily.set(session.familyId, session);
      }
    }

    return Array.from(newestPerFamily.values());
  }

  /** Looks up a session by id, scoped to its owner so ids cannot be probed. */
  async findOwnedById(sessionId: string, userId: string): Promise<Session | null> {
    return this.sessionRepository.findOne({ where: { id: sessionId, userId } });
  }

  /**
   * Deletes sessions that expired more than `retentionDays` ago.
   *
   * Expired rows are kept for a while rather than removed immediately: the
   * rotation chain is evidence, and an incident investigation needs to see the
   * sequence of refreshes leading up to a detected reuse. Scheduled from phase 5.
   */
  async purgeExpired(retentionDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const result = await this.sessionRepository.delete({ expiresAt: LessThan(cutoff) });
    return result.affected ?? 0;
  }

  /** Bulk revocation by id, used when an administrator terminates sessions. */
  async revokeMany(sessionIds: string[], reason: SessionRevocationReason): Promise<number> {
    if (sessionIds.length === 0) return 0;

    const result = await this.sessionRepository.update(
      { id: In(sessionIds), revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );

    return result.affected ?? 0;
  }
}

/**
 * Derives a coarse device label from a User-Agent string.
 *
 * Intentionally crude. The label exists so a user can recognise their own
 * devices on the security screen ("Chrome on Windows" versus "Safari on iOS"),
 * not for analytics, and a full UA-parsing dependency would be a large amount of
 * attack surface and maintenance for a cosmetic feature.
 */
export function describeDevice(userAgent: string): string {
  const ua = userAgent.toLowerCase();

  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome/') && !ua.includes('chromium')
      ? 'Chrome'
      : ua.includes('firefox/')
        ? 'Firefox'
        : ua.includes('safari/') && !ua.includes('chrome')
          ? 'Safari'
          : ua.includes('postman')
            ? 'Postman'
            : ua.includes('curl')
              ? 'curl'
              : ua.includes('python')
                ? 'Python client'
                : 'Unknown browser';

  const platform = ua.includes('windows')
    ? 'Windows'
    : ua.includes('iphone') || ua.includes('ipad')
      ? 'iOS'
      : ua.includes('mac os')
        ? 'macOS'
        : ua.includes('android')
          ? 'Android'
          : ua.includes('linux')
            ? 'Linux'
            : 'Unknown OS';

  return `${browser} on ${platform}`.slice(0, 128);
}
