import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

const blankToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const postgresUrl = z
  .url()
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'must be a postgres:// URL',
  });

const redisUrl = z.url().refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
  message: 'must be a redis:// or rediss:// URL',
});

/** A secret that must be long enough to resist guessing (values are never echoed in errors). */
const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);

/** PEM key, base64-encoded onto one line (as written by `npm run keys:generate`). */
const pemB64 = (kind: 'private' | 'public') =>
  z.string().refine(
    (v) => {
      try {
        const pem = Buffer.from(v, 'base64').toString('utf8');
        const key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
        return key.asymmetricKeyType === 'ed25519';
      } catch {
        return false;
      }
    },
    { message: `must be a base64-encoded Ed25519 ${kind} key (PEM)` },
  );

const aesKeyB64 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, { message: 'must be 32 bytes (base64)' });

const domainList = z
  .string()
  .min(1)
  .transform((v) =>
    v
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0),
  )
  .refine((list) => list.every((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)), {
    message: 'must be a comma-separated list of domains',
  });

/**
 * Environment contract for the API. Parsed once at boot; the process exits on any error (SEC-18).
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.preprocess(
      (v) => (v !== undefined && v !== '' ? v : process.env.PORT),
      z.coerce.number().int().min(1).max(65_535).default(4000),
    ),
    /** Public origin of the web app; the only allowed CORS origin. */
    WEB_ORIGIN: z.url(),
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Express `trust proxy` setting (hops or keyword). Needed for the real client IP behind Nginx. */
    TRUST_PROXY: z.string().default('loopback'),
    SWAGGER_ENABLED: booleanString.default(false),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2000),

    // ── authentication (Phase 3) ────────────────────────────────────────
    /** MAKEEN email domains allowed to sign in (UXV-1, D-09). */
    ALLOWED_EMAIL_DOMAINS: domainList.default(['makeenenergy.com']),
    JWT_PRIVATE_KEY_B64: pemB64('private'),
    JWT_PUBLIC_KEY_B64: pemB64('public'),
    JWT_ISSUER: z.string().min(1).default('makeen-fm-api'),
    JWT_AUDIENCE: z.string().min(1).default('makeen-fm-web'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /** Sliding refresh: idle cap and absolute cap from sign-in (D-07). */
    SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    SESSION_ABSOLUTE_MAX_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Token-version / login-status cache in Redis (≤ 60 s, SEC-4). */
    AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(60).default(60),
    /** Secure cookies (+ __Host-/__Secure- prefixes). Defaults to true in production. */
    COOKIE_SECURE: booleanString.optional(),
    PASSWORD_PEPPER: secret(16),
    OTP_PEPPER: secret(16),
    OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(10),
    AADHAAR_ENC_KEY_B64: aesKeyB64,
    AADHAAR_ENC_KEY_ID: z.string().min(1).max(32).default('k1'),

    // ── outbound messages ───────────────────────────────────────────────
    /** `console` (dev only) prints messages to the API console; `smtp` sends real email. */
    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().min(3).default('MAKEEN FM Portal <no-reply@makeenenergy.com>'),
    /** `console` (dev only) or `msg91` (India, DLT-registered template). */
    SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_OTP_TEMPLATE_ID: z.string().optional(),

    // ── people / KEKA (Phase 4) ─────────────────────────────────────────
    /**
     * Password set by Admin “Reset to default password” (ULG-T7). It never opens a session: signing
     * in with it answers “set a new password”, and the person sets one with OTP (D-72).
     */
    RESET_DEFAULT_PASSWORD: secret(12),
    /** KEKA API adapter (PPL-3). Unset → only the CSV / Excel loader is offered. */
    KEKA_API_URL: z.preprocess(blankToUndefined, z.url().optional()),
    KEKA_API_TOKEN: z.preprocess(blankToUndefined, secret(16).optional()),
    KEKA_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

    // ── private file storage (Phase 8) ──────────────────────────────────
    /** `s3` (S3-compatible; SeaweedFS in dev, the real store in production) or `local` (dev only). */
    STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
    /** `local` driver folder (git-ignored). */
    STORAGE_LOCAL_DIR: z.string().min(1).default('./var/uploads'),
    S3_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
    S3_REGION: z.string().min(1).default('ap-south-1'),
    S3_BUCKET: z.preprocess(blankToUndefined, z.string().min(3).max(63).optional()),
    S3_ACCESS_KEY_ID: z.preprocess(blankToUndefined, z.string().min(3).optional()),
    S3_SECRET_ACCESS_KEY: z.preprocess(blankToUndefined, secret(16).optional()),
    /** Path-style URLs (`endpoint/bucket/key`) — needed by SeaweedFS / MinIO. */
    S3_FORCE_PATH_STYLE: booleanString.default(true),

    // ── scheduled work (Phase 10) ───────────────────────────────────────
    /** Daily notice job + email outbox in this process (safe on several servers, D-117). */
    JOBS_ENABLED: booleanString.default(true),
    /** India time of the daily Licence / Audit notice run (NOTIF-J1). */
    NOTICE_DAILY_AT: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be hh:mm (24 h)' })
      .default('07:00'),
    /** When true, allows console email/sms, Swagger, and local storage for hosted demos. */
    DEMO_MODE: booleanString.default(false),
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === 'production' && !env.DEMO_MODE;
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (prod && env.SWAGGER_ENABLED)
      issue('SWAGGER_ENABLED', 'Swagger must be disabled in production');
    if (prod && !env.WEB_ORIGIN.startsWith('https://')) {
      issue('WEB_ORIGIN', 'WEB_ORIGIN must be https in production');
    }
    if (prod && env.COOKIE_SECURE === false)
      issue('COOKIE_SECURE', 'cookies must be Secure in production');
    if (prod && env.EMAIL_PROVIDER === 'console')
      issue('EMAIL_PROVIDER', 'console email is dev-only');
    if (prod && env.SMS_PROVIDER === 'console') issue('SMS_PROVIDER', 'console SMS is dev-only');
    if (env.SMS_PROVIDER === 'msg91' && (!env.MSG91_AUTH_KEY || !env.MSG91_OTP_TEMPLATE_ID)) {
      issue('MSG91_AUTH_KEY', 'MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required for msg91');
    }
    if (env.SESSION_IDLE_DAYS > env.SESSION_ABSOLUTE_MAX_DAYS) {
      issue('SESSION_IDLE_DAYS', 'must not exceed SESSION_ABSOLUTE_MAX_DAYS');
    }
    if (env.PASSWORD_PEPPER === env.OTP_PEPPER)
      issue('OTP_PEPPER', 'must differ from PASSWORD_PEPPER');
    if (env.KEKA_API_URL && !env.KEKA_API_TOKEN)
      issue('KEKA_API_TOKEN', 'KEKA_API_TOKEN is required when KEKA_API_URL is set');
    if (prod && env.KEKA_API_URL && !env.KEKA_API_URL.startsWith('https://'))
      issue('KEKA_API_URL', 'KEKA_API_URL must be https in production');
    if (prod && env.STORAGE_DRIVER === 'local')
      issue('STORAGE_DRIVER', 'local file storage is dev-only; use s3');
    if (env.STORAGE_DRIVER === 's3') {
      for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[k]) issue(k, `${k} is required when STORAGE_DRIVER=s3`);
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Validate raw env; throws an Error listing every problem (never the secret values). */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Cookies are Secure unless explicitly disabled outside production (plain-http local dev). */
export function cookiesSecure(env: Env): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}
