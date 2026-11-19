import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/** Injection token for the shared Redis client (throttler, caches, BullMQ in later phases). */
export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis => {
        const logger = new Logger('Redis');
        const client = new Redis(env.REDIS_URL, {
          lazyConnect: true,
          // Fail fast instead of queueing commands forever when Redis is down (readiness must report it).
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: env.READINESS_TIMEOUT_MS,
          // Reconnect with capped backoff: 200 ms, 400 ms … max 5 s.
          retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
        });
        // Without a listener ioredis prints "Unhandled error event" on every retry.
        // Log once per outage (no URL — it contains the password) and once on recovery.
        let down = false;
        client.on('error', (err: Error) => {
          if (!down) logger.warn(`Redis unavailable: ${err.name}`);
          down = true;
        });
        client.on('ready', () => {
          if (down) logger.log('Redis connection restored');
          down = false;
        });
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready' || this.redis.status === 'connect') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
