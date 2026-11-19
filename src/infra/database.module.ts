import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PG_SESSION_OPTIONS } from './pg-session';

/** Injection token for the shared node-postgres pool (Prisma's pg adapter reuses it from Phase 2). */
export const DB_POOL = Symbol('DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [ENV],
      useFactory: (env: Env): pg.Pool => {
        const isLocal =
          env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1');
        return new pg.Pool({
          connectionString: env.DATABASE_URL,
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: env.READINESS_TIMEOUT_MS,
          application_name: 'makeen-api',
          options: PG_SESSION_OPTIONS,
          ssl: isLocal ? undefined : { rejectUnauthorized: false },
        });
      },
    },
  ],
  exports: [DB_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
