import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { DB_POOL } from '../../infra/database.module';
import { REDIS } from '../../infra/redis.module';

export type CheckState = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: { database: CheckState; redis: CheckState };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database === 'up' && redis === 'up' ? 'ready' : 'not_ready',
      checks: { database, redis },
    };
  }

  private async checkDatabase(): Promise<CheckState> {
    try {
      await withTimeout(this.pool.query('SELECT 1'), this.env.READINESS_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<CheckState> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        await withTimeout(this.redis.connect(), this.env.READINESS_TIMEOUT_MS);
      }
      // ping() resolves only with PONG; any failure rejects and is reported as down.
      await withTimeout(this.redis.ping(), this.env.READINESS_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
