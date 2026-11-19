/**
 * E2E global setup: rebuild the TEST database from the committed migrations + the demo seed.
 *
 * Safety: refuses to run unless the target database name ends with `_test`.
 * Provides two connections to the specs (via env, --runInBand):
 *   E2E_OWNER_URL — schema owner (seed, raw checks; not subject to RLS)
 *   E2E_APP_URL   — the runtime role makeen_app (subject to RLS, no audit_log UPDATE/DELETE)
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const APP_ROLE = 'makeen_app';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function ensureAppUrl(ownerUrl: string, testDb: string): Promise<string> {
  const explicit = process.env['TEST_APP_DATABASE_URL'];
  if (explicit) return explicit;
  // Local dev: DATABASE_URL already uses makeen_app (from `npm run db:bootstrap`).
  const runtime = process.env['DATABASE_URL'];
  if (runtime && new URL(runtime).username === APP_ROLE) return withDatabase(runtime, testDb);
  // CI: the owner is a superuser of a throw-away server — create the runtime role.
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    const password = randomBytes(18).toString('base64url');
    const exists = (await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]))
      .rowCount;
    await owner.query(
      `${exists ? 'ALTER' : 'CREATE'} ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
    );
    await owner.query(`GRANT CONNECT ON DATABASE "${testDb}" TO ${APP_ROLE}`);
    const u = new URL(ownerUrl);
    u.username = APP_ROLE;
    u.password = password;
    return u.toString();
  } finally {
    await owner.end();
  }
}

export default async function globalSetup(): Promise<void> {
  const root = resolve(__dirname, '..');
  if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

  const ownerUrl = process.env['TEST_DATABASE_URL'];
  if (!ownerUrl) throw new Error('TEST_DATABASE_URL is not set (see api/.env.example).');
  const testDb = new URL(ownerUrl).pathname.slice(1);
  if (!testDb.endsWith('_test')) {
    throw new Error(`Refusing to wipe "${testDb}": the e2e database name must end with _test.`);
  }

  const appUrl = await ensureAppUrl(ownerUrl, testDb);

  // Fresh schema → committed migrations → demo seed (fixed "today" so assertions are stable).
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.query('CREATE SCHEMA public');
  } finally {
    await owner.end();
  }
  const env = {
    ...process.env,
    MIGRATE_DATABASE_URL: ownerUrl,
    SEED_DATABASE_URL: ownerUrl,
    SEED_TODAY: '2026-10-16',
  };
  execSync('npx prisma migrate deploy', { cwd: root, env, stdio: 'pipe' });
  execSync('npx tsx prisma/seed/index.ts', { cwd: root, env, stdio: 'pipe' });

  process.env['E2E_OWNER_URL'] = ownerUrl;
  process.env['E2E_APP_URL'] = appUrl;
  // AppModule-based specs (health) talk to the test database as the runtime role.
  process.env['DATABASE_URL'] = appUrl;
  // Uploads go to a throw-away folder (the named local dev store), never to a real bucket.
  process.env['STORAGE_DRIVER'] = 'local';
  process.env['STORAGE_LOCAL_DIR'] = join(tmpdir(), 'makeen-e2e-uploads');
  // Specs run the daily job and the outbox themselves (no timers in tests).
  process.env['JOBS_ENABLED'] = 'false';
}
