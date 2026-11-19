import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type { Redis } from 'ioredis';
import { REDIS } from '../../infra/redis.module';

/**
 * @nestjs/throttler storage in Redis (SEC-6), shared by every API instance.
 * Uses only INCR / PEXPIRE / PTTL / SET (no Lua), so it behaves the same on Redis, Valkey or
 * Memurai. Generic per-IP throttling fails OPEN when Redis is down (the API stays usable);
 * the brute-force limits on login and OTP fail closed in RateLimiter instead.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('Throttler');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `thr:${throttlerName}:${key}`;
    const blockKey = `${hitsKey}:blocked`;
    try {
      const blockedMs = await this.redis.pttl(blockKey);
      if (blockedMs > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: Math.ceil(blockedMs / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockedMs / 1000),
        };
      }
      const totalHits = await this.redis.incr(hitsKey);
      if (totalHits === 1) await this.redis.pexpire(hitsKey, ttl);
      let ttlMs = await this.redis.pttl(hitsKey);
      if (ttlMs < 0) {
        await this.redis.pexpire(hitsKey, ttl);
        ttlMs = ttl;
      }
      const isBlocked = totalHits > limit;
      const blockMs = blockDuration > 0 ? blockDuration : ttl;
      if (isBlocked) await this.redis.set(blockKey, '1', 'PX', blockMs);
      return {
        totalHits,
        timeToExpire: Math.ceil(ttlMs / 1000),
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil(blockMs / 1000) : 0,
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Redis unavailable, request not throttled: ${err instanceof Error ? err.name : 'error'}`,
      );
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
