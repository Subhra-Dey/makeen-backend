import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { REDIS } from '../../infra/redis.module';
import { PrismaService } from '../../prisma/prisma.service';

export interface UserAuthState {
  tokenVersion: number;
  /**
   * ACTIVE login, WORKING, password set. `mustSetPassword` is NOT part of it: after an Admin reset
   * the person “stays signed in until Logout” (spec Login, D-72); it only blocks new sign-ins.
   */
  usable: boolean;
}

export type FamilyState = 'ok' | 'revoked';

/**
 * Per-request checks behind every access token (SEC-4): token version + login status, and
 * whether the session family was revoked (logout, reuse, password change). Cached in Redis for
 * at most AUTH_CACHE_TTL_SECONDS; the database stays the source of truth, so a Redis outage or
 * restart only costs a database read — never a skipped check.
 */
@Injectable()
export class AuthStateService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch {
      return load();
    }
    const value = await load();
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.env.AUTH_CACHE_TTL_SECONDS);
    } catch {
      /* cache write is best-effort */
    }
    return value;
  }

  userState(userId: string): Promise<UserAuthState | null> {
    return this.cached(`auth:user:${userId}`, async () => {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          tokenVersion: true,
          loginStatus: true,
          workingStatus: true,
          passwordHash: true,
        },
      });
      if (!u) return null;
      return {
        tokenVersion: u.tokenVersion,
        usable:
          u.loginStatus === 'ACTIVE' && u.workingStatus === 'WORKING' && u.passwordHash !== null,
      };
    });
  }

  familyState(familyId: string): Promise<FamilyState> {
    return this.cached(`auth:family:${familyId}`, async () => {
      const live = await this.prisma.session.findFirst({
        where: { familyId, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
        select: { id: true },
      });
      return live ? 'ok' : 'revoked';
    });
  }

  /** Called after logout / reuse / password change / admin changes, so the next request re-reads. */
  async invalidateUser(userId: string): Promise<void> {
    await this.redis.del(`auth:user:${userId}`).catch(() => 0);
  }

  async markFamilyRevoked(familyId: string): Promise<void> {
    await this.redis
      .set(
        `auth:family:${familyId}`,
        JSON.stringify('revoked'),
        'EX',
        Math.max(this.env.ACCESS_TOKEN_TTL_SECONDS, 60),
      )
      .catch(() => 'OK');
  }
}
