import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type pg from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { DB_POOL } from '../infra/database.module';

export interface DbRoleFacts {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownsTables: boolean;
}

/** Problems that would silently switch off row-level security (D-08). */
export function rlsBypassReasons(f: DbRoleFacts): string[] {
  const reasons: string[] = [];
  if (f.superuser) reasons.push('is a superuser');
  if (f.bypassRls) reasons.push('has BYPASSRLS');
  if (f.ownsTables) reasons.push('owns the application tables');
  return reasons;
}

/**
 * Boot check: the runtime database role must be subject to row-level security.
 * Production refuses to start otherwise; development only warns (dev tools may use the owner).
 */
@Injectable()
export class DbRoleCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('DbRoleCheck');

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.NODE_ENV === 'test') return;
    let facts: DbRoleFacts;
    try {
      const { rows } = await this.pool.query<DbRoleFacts>(
        `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS "bypassRls",
                EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public'
                          AND t.tablename = 'daily_mis' AND t.tableowner = current_user) AS "ownsTables"
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      const row = rows[0];
      if (!row) return;
      facts = row;
    } catch {
      // Database unreachable at boot: readiness reports it; nothing to check yet.
      return;
    }
    const reasons = rlsBypassReasons(facts);
    if (reasons.length === 0) return;
    const message = `Database role "${facts.role}" ${reasons.join(', ')} — row-level security would not apply. Use the runtime role (makeen_app) in DATABASE_URL.`;
    if (this.env.NODE_ENV === 'production' && !this.env.DEMO_MODE) throw new Error(message);
    this.logger.warn(message);
  }
}
