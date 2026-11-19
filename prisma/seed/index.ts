/**
 * Deterministic demo seed (OPS-3). Recreates the approved mockup's world so the running app
 * looks like the mockup. Run with `npm run db:seed` (or `npm run db:reset` for a clean rebuild).
 *
 * - Refuses to run when NODE_ENV=production, or when the database already has people.
 * - Fixed random seed → the same data on every run.
 * - SEED_TODAY=yyyy-mm-dd (default 2026-10-16, the mockup's today) or SEED_TODAY=now.
 * - Demo password = SEED_DEFAULT_PASSWORD (dev .env only). Runs as the schema owner
 *   (MIGRATE_DATABASE_URL), so row-level security does not apply to the seed itself.
 */
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { PG_SESSION_OPTIONS } from '../../src/infra/pg-session';
import { Rng, SeedCalendar, resolveSeedToday } from './context';
import { seedDailyExceptions } from './daily-exceptions';
import { seedDailyMis } from './daily-mis';
import { PEOPLE } from './data/people';
import { seedFoundation } from './foundation';
import { seedMonthlyMis } from './monthly-mis';
import { seedNotifications, seedSettings } from './notifications';
import { seedAudits, seedLicences, seedPlantDetails } from './operations';

const SEED = 20261016;

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '')
    throw new Error(`${name} is not set (run npm run keys:generate / db:bootstrap)`);
  return v;
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (process.env['NODE_ENV'] === 'production' && process.env['ALLOW_PROD_SEED'] !== 'true') {
    throw new Error('Refusing to seed demo data with NODE_ENV=production (set ALLOW_PROD_SEED=true to override).');
  }
  const url = process.env['SEED_DATABASE_URL'] ?? required('MIGRATE_DATABASE_URL');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, options: PG_SESSION_OPTIONS }),
  });
  try {
    if ((await prisma.user.count()) > 0) {
      throw new Error(
        'Database already has data — use `npm run db:reset` to rebuild it with the demo seed.',
      );
    }
    const cal = new SeedCalendar(resolveSeedToday(process.env['SEED_TODAY']));
    const rng = new Rng(SEED);
    const started = Date.now();
    const secrets = {
      password: required('SEED_DEFAULT_PASSWORD'),
      pepper: required('PASSWORD_PEPPER'),
      aadhaarKeyB64: required('AADHAAR_ENC_KEY_B64'),
      aadhaarKeyId: process.env['AADHAAR_ENC_KEY_ID'] ?? 'k1',
    };

    // All-or-nothing: a failure part-way leaves the database exactly as it was.
    const { daily, monthly, exceptions, observations, licences, notices } =
      await prisma.$transaction(
        async (tx) => {
          const f = await seedFoundation(tx, cal, rng, secrets);
          await seedPlantDetails(tx, cal, rng, f);
          const dailyResult = await seedDailyMis(tx, cal, rng, f);
          const result = {
            daily: dailyResult,
            monthly: await seedMonthlyMis(tx, cal, rng, f),
            exceptions: await seedDailyExceptions(tx, cal, rng, f, dailyResult.startDate),
            observations: await seedAudits(tx, cal, rng, f),
            licences: await seedLicences(tx, cal, rng, f),
            notices: await seedNotifications(tx, cal, rng, f),
          };
          await seedSettings(tx, cal, f, dailyResult.startDate, PEOPLE.length);
          return result;
        },
        { timeout: 600_000, maxWait: 30_000 },
      );

    console.log(
      [
        `Seeded MAKEEN demo world for ${cal.today} (offset ${cal.offset} days) in ${((Date.now() - started) / 1000).toFixed(1)} s:`,
        `  roles 14 · people ${PEOPLE.length} · plants 22`,
        `  daily MIS ${daily.rows} (from ${daily.startDate}) · monthly MIS ${monthly} · daily exceptions ${exceptions}`,
        `  audit observations ${observations} · licences ${licences} · notifications ${notices}`,
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
