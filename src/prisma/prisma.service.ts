import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type pg from 'pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
import { DB_POOL } from '../infra/database.module';

/** Who is acting — drives Postgres row-level security for the transaction (D-08). */
export interface DbActor {
  userId: string;
  isAdmin: boolean;
}

export type Tx = Prisma.TransactionClient;

/**
 * Prisma over the shared node-postgres pool (the same pool readiness checks use).
 * Plant-scoped data must be read and written inside `runAs`, which sets the RLS context
 * with `set_config(..., true)` — local to the transaction, so it never leaks to the next request.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) pool: pg.Pool) {
    super({ adapter: new PrismaPg(pool) });
  }

  async runAs<T>(actor: DbActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${actor.userId}, true),
                                  set_config('app.is_admin', ${actor.isAdmin ? 'true' : 'false'}, true)`;
      return fn(tx);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
