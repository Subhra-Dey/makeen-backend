import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../infra/redis.module';
import { AppError, ErrorCode } from '../errors/app-error';

export interface HitResult {
  count: number;
  allowed: boolean;
  /** Time until the window resets, ms. */
  retryAfterMs: number;
}

/**
 * Fixed-window counters in Redis for security limits (login, OTP).
 * Fails CLOSED: if Redis is unavailable the protected action is refused (503), so brute-force
 * limits cannot be bypassed by knocking Redis over.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowMs: number): Promise<HitResult> {
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.pexpire(key, windowMs);
      let ttl = await this.redis.pttl(key);
      if (ttl < 0) {
        await this.redis.pexpire(key, windowMs);
        ttl = windowMs;
      }
      return { count, allowed: count <= limit, retryAfterMs: ttl };
    } catch {
      throw unavailable();
    }
  }

  /** Remaining lock time in ms (0 when not locked). */
  async lockedFor(key: string): Promise<number> {
    try {
      const ttl = await this.redis.pttl(key);
      return ttl > 0 ? ttl : 0;
    } catch {
      throw unavailable();
    }
  }

  async lock(key: string, ms: number): Promise<void> {
    try {
      await this.redis.set(key, '1', 'PX', ms);
    } catch {
      throw unavailable();
    }
  }

  async clear(...keys: string[]): Promise<void> {
    try {
      if (keys.length > 0) await this.redis.del(...keys);
    } catch {
      throw unavailable();
    }
  }
}

function unavailable(): AppError {
  return new AppError(
    HttpStatus.SERVICE_UNAVAILABLE,
    ErrorCode.SERVICE_UNAVAILABLE,
    'Sign-in is temporarily unavailable. Please try again shortly.',
  );
}
