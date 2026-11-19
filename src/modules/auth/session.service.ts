import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { randomToken, sha256Hex } from '../../common/crypto/tokens';
import type { RequestContext } from '../../common/security/request-context';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { AuthStateService } from './auth-state.service';

const DAY_MS = 86_400_000;

export interface IssuedSession {
  userId: string;
  familyId: string;
  tokenVersion: number;
  refreshToken: string;
  /** Cookie lifetime: until the absolute expiry. */
  refreshMaxAgeMs: number;
}

export function sessionExpired(): AppError {
  return new AppError(
    HttpStatus.UNAUTHORIZED,
    ErrorCode.UNAUTHENTICATED,
    'Your session has ended. Please sign in again.',
  );
}

/**
 * Refresh-token sessions (SEC-2, D-07): opaque 256-bit tokens stored as SHA-256, rotated on every
 * use. A family = one sign-in; every rotation adds a row to it. Presenting an already-rotated
 * token is treated as theft: the whole family is revoked.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly authState: AuthStateService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(
    userId: string,
    tokenVersion: number,
    ctx: RequestContext,
    tx?: Tx,
  ): Promise<IssuedSession> {
    const now = Date.now();
    const absolute = new Date(now + this.env.SESSION_ABSOLUTE_MAX_DAYS * DAY_MS);
    const refreshToken = randomToken();
    const familyId = randomUUID();
    await (tx ?? this.prisma).session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: sha256Hex(refreshToken),
        tokenVersion,
        idleExpiresAt: new Date(
          Math.min(now + this.env.SESSION_IDLE_DAYS * DAY_MS, absolute.getTime()),
        ),
        absoluteExpiresAt: absolute,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
    return {
      userId,
      familyId,
      tokenVersion,
      refreshToken,
      refreshMaxAgeMs: absolute.getTime() - now,
    };
  }

  /** Rotate a refresh token. Throws 401 for unknown/expired/revoked tokens and on reuse. */
  async rotate(refreshToken: string, ctx: RequestContext): Promise<IssuedSession> {
    const hash = sha256Hex(refreshToken);
    const outcome = await this.prisma.$transaction(async (tx) => {
      // Row lock: two concurrent uses of the same token cannot both rotate it.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sessions WHERE refresh_token_hash = ${hash} FOR UPDATE`;
      const id = locked[0]?.id;
      if (!id) return { kind: 'invalid' as const };
      const s = await tx.session.findUniqueOrThrow({
        where: { id },
        include: {
          user: {
            select: {
              tokenVersion: true,
              loginStatus: true,
              workingStatus: true,
            },
          },
        },
      });
      if (s.revokedAt) return { kind: 'invalid' as const };
      if (s.rotatedAt) {
        await this.revokeFamilyTx(tx, s.familyId, 'REUSE_DETECTED');
        await this.audit.record(
          {
            action: AuditAction.SESSION_REUSE_DETECTED,
            entity: 'session',
            entityId: s.familyId,
            actorId: s.userId,
            ctx,
          },
          tx,
        );
        return { kind: 'reuse' as const, familyId: s.familyId, userId: s.userId };
      }
      const now = Date.now();
      const u = s.user;
      if (
        s.idleExpiresAt.getTime() <= now ||
        s.absoluteExpiresAt.getTime() <= now ||
        s.tokenVersion !== u.tokenVersion ||
        u.loginStatus !== 'ACTIVE' ||
        u.workingStatus !== 'WORKING'
      ) {
        await this.revokeFamilyTx(tx, s.familyId, 'EXPIRED');
        return { kind: 'invalid' as const, familyId: s.familyId };
      }
      const next = randomToken();
      await tx.session.update({
        where: { id: s.id },
        data: { rotatedAt: new Date(now), lastUsedAt: new Date(now) },
      });
      await tx.session.create({
        data: {
          userId: s.userId,
          familyId: s.familyId,
          refreshTokenHash: sha256Hex(next),
          tokenVersion: s.tokenVersion,
          idleExpiresAt: new Date(
            Math.min(now + this.env.SESSION_IDLE_DAYS * DAY_MS, s.absoluteExpiresAt.getTime()),
          ),
          absoluteExpiresAt: s.absoluteExpiresAt,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      });
      return {
        kind: 'ok' as const,
        session: {
          userId: s.userId,
          familyId: s.familyId,
          tokenVersion: s.tokenVersion,
          refreshToken: next,
          refreshMaxAgeMs: s.absoluteExpiresAt.getTime() - now,
        },
      };
    });
    if (outcome.kind === 'ok') return outcome.session;
    if ('familyId' in outcome && outcome.familyId)
      await this.authState.markFamilyRevoked(outcome.familyId);
    throw sessionExpired();
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.revokeFamilyTx(tx, familyId, reason));
    await this.authState.markFamilyRevoked(familyId);
  }

  /** Revoke every session of a person (password change, deactivation, admin reset). */
  async revokeAllForUser(tx: Tx, userId: string, reason: string): Promise<string[]> {
    const families = await tx.session.findMany({
      where: { userId, revokedAt: null },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return families.map((f) => f.familyId);
  }

  private async revokeFamilyTx(tx: Tx, familyId: string, reason: string): Promise<void> {
    await tx.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }
}
