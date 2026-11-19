import { generateKeyPairSync, randomBytes } from 'node:crypto';

// Unit / in-process HTTP tests replace Postgres and Redis with fakes, so the env is fixed here.
// ConfigModule validates env when AppModule is imported, so this must run before any test file.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (pem: string | Buffer): string => Buffer.from(pem).toString('base64');

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/unit_test_unused',
  REDIS_URL: 'redis://localhost:6379/15',
  SWAGGER_ENABLED: 'false',
  JWT_PRIVATE_KEY_B64: b64(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  JWT_PUBLIC_KEY_B64: b64(publicKey.export({ type: 'spki', format: 'pem' })),
  PASSWORD_PEPPER: 'unit-test-password-pepper',
  OTP_PEPPER: 'unit-test-otp-pepper-value',
  AADHAAR_ENC_KEY_B64: randomBytes(32).toString('base64'),
  RESET_DEFAULT_PASSWORD: 'unit-reset-Default-1',
  // No scheduled work (daily notices, email outbox) in unit tests.
  JOBS_ENABLED: 'false',
});
