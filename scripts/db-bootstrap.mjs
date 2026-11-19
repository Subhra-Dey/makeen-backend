#!/usr/bin/env node
// One-time local database setup (dev only). Run it yourself: `npm run db:bootstrap`.
//
// - Asks for a PostgreSQL superuser login (hidden password prompt; never stored or printed).
// - Creates/updates two roles with fresh random passwords:
//     makeen_owner — owns the schema, runs migrations and seeds
//     makeen_app   — what the running API uses (not owner, not superuser → row-level security applies)
// - Creates databases `makeen` and `makeen_test` (owned by makeen_owner) if missing.
// - Writes DATABASE_URL, MIGRATE_DATABASE_URL and TEST_DATABASE_URL into api/.env.
// Prints only role/database names — never passwords.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import pg from 'pg';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env');
const ROLES = { owner: 'makeen_owner', app: 'makeen_app' };
const DATABASES = ['makeen', 'makeen_test'];

if (process.env.NODE_ENV === 'production') {
  console.error('db:bootstrap is for local development only.');
  process.exit(1);
}

function ask(question, { hidden = false, fallback = '' } = {}) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mask typed characters.
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else if (!/\r|\n/.test(s)) rl.output.write('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      done(answer.trim() || fallback);
    });
  });
}

const password = () => randomBytes(24).toString('base64url'); // URL-safe
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const literal = (s) => `'${s.replace(/'/g, "''")}'`;

function setEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
}

// Non-interactive mode (CI / scripted setup): BOOTSTRAP_PG_PASSWORD (+ optional HOST/PORT/USER).
const scripted = Boolean(process.env['BOOTSTRAP_PG_PASSWORD']);
const host = scripted
  ? (process.env['BOOTSTRAP_PG_HOST'] ?? 'localhost')
  : await ask('PostgreSQL host [localhost]: ', { fallback: 'localhost' });
const port = scripted
  ? (process.env['BOOTSTRAP_PG_PORT'] ?? '5432')
  : await ask('PostgreSQL port [5432]: ', { fallback: '5432' });
const superuser = scripted
  ? (process.env['BOOTSTRAP_PG_USER'] ?? 'postgres')
  : await ask('Superuser login [postgres]: ', { fallback: 'postgres' });
const superPassword = scripted
  ? process.env['BOOTSTRAP_PG_PASSWORD']
  : await ask(`Password for ${superuser}: `, { hidden: true });

const admin = new pg.Client({ host, port: Number(port), user: superuser, password: superPassword, database: 'postgres' });
try {
  await admin.connect();
} catch (e) {
  console.error(`Could not connect as ${superuser}@${host}:${port} — ${e.code ?? ''} ${e.message}`);
  process.exit(1);
}

const secrets = { owner: password(), app: password() };
try {
  for (const [kind, role] of Object.entries(ROLES)) {
    const exists = (await admin.query('select 1 from pg_roles where rolname = $1', [role])).rowCount > 0;
    const opts = `LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(secrets[kind])}`;
    await admin.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${ident(role)} WITH ${opts}`);
    console.log(`${exists ? 'updated' : 'created'} role ${role}`);
  }
  for (const db of DATABASES) {
    const exists = (await admin.query('select 1 from pg_database where datname = $1', [db])).rowCount > 0;
    if (!exists) {
      await admin.query(
        `CREATE DATABASE ${ident(db)} OWNER ${ident(ROLES.owner)} ENCODING 'UTF8' TEMPLATE template0`,
      );
      console.log(`created database ${db}`);
    } else {
      await admin.query(`ALTER DATABASE ${ident(db)} OWNER TO ${ident(ROLES.owner)}`);
      console.log(`database ${db} exists (owner set to ${ROLES.owner})`);
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(ROLES.app)}`);
  }
} finally {
  await admin.end();
}

const url = (role, secret, db) => `postgresql://${role}:${secret}@${host}:${port}/${db}`;
let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(resolve(root, '.env.example'), 'utf8');
env = setEnv(env, 'DATABASE_URL', url(ROLES.app, secrets.app, 'makeen'));
env = setEnv(env, 'MIGRATE_DATABASE_URL', url(ROLES.owner, secrets.owner, 'makeen'));
env = setEnv(env, 'TEST_DATABASE_URL', url(ROLES.owner, secrets.owner, 'makeen_test'));
writeFileSync(envPath, env, { mode: 0o600 });

console.log('Wrote DATABASE_URL, MIGRATE_DATABASE_URL and TEST_DATABASE_URL to api/.env');
console.log('Done. Next: tell Claude to continue (migrations + seed run next).');
