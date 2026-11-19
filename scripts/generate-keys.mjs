#!/usr/bin/env node
// Creates .env from .env.example (if missing) and fills every `__GENERATE__` value with a fresh secret.
// Existing non-placeholder values are never overwritten. Prints only key NAMES, never values.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const examplePath = resolve(root, '.env.example');
const envPath = resolve(root, '.env');

const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (pem) => Buffer.from(pem, 'utf8').toString('base64');

/** Generators per variable; anything else gets a random URL-safe token. */
const generators = {
  JWT_PRIVATE_KEY_B64: () => b64(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  JWT_PUBLIC_KEY_B64: () => b64(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  AADHAAR_ENC_KEY_B64: () => randomBytes(32).toString('base64'),
  // Passwords that end up inside URLs must stay URL-safe.
  POSTGRES_PASSWORD: () => token(24),
  REDIS_PASSWORD: () => token(24),
  // Dev demo password: readable, satisfies the 8+ char policy, not a common password.
  SEED_DEFAULT_PASSWORD: () => `Mk-${token(9)}`,
  // Admin-reset password: never opens a session, so it only needs to satisfy the env minimum.
  RESET_DEFAULT_PASSWORD: () => `Reset-${token(12)}`,
};

const source = existsSync(envPath)
  ? readFileSync(envPath, 'utf8')
  : readFileSync(examplePath, 'utf8');
const filled = [];
const output = source
  .split(/\r?\n/)
  .map((line) => {
    const m = /^([A-Z0-9_]+)=__GENERATE__$/.exec(line);
    if (!m) return line;
    const name = m[1];
    filled.push(name);
    return `${name}=${(generators[name] ?? token)()}`;
  })
  .join('\n');

// Expand ${VAR} references (e.g. DATABASE_URL uses POSTGRES_PASSWORD) so tools that do not expand work too.
const values = Object.fromEntries(
  output
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const expanded = output.replace(/\$\{([A-Z0-9_]+)\}/g, (all, name) => values[name] ?? all);

writeFileSync(envPath, expanded.endsWith('\n') ? expanded : `${expanded}\n`, { mode: 0o600 });
console.log(
  filled.length
    ? `Generated: ${filled.join(', ')}`
    : 'Nothing to generate — .env already complete.',
);
console.log(`Wrote ${envPath}`);
