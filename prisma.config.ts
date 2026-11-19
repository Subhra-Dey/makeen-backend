import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env by itself. Load api/.env for local CLI use; on servers and in CI
// the variables come from the real environment.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Migrations and seeds run as the schema OWNER (MIGRATE_DATABASE_URL). The running API uses the
 * non-owner role (DATABASE_URL) so row-level security applies to it (DECISIONS D-08).
 * `prisma generate` needs no database, so a placeholder URL is fine when none is set.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/index.ts',
  },
  datasource: {
    url:
      process.env['MIGRATE_DATABASE_URL'] ??
      'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
