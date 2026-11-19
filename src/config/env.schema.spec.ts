import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cookiesSecure, parseEnv } from './env.schema';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (pem: string | Buffer): string => Buffer.from(pem).toString('base64');

const valid = {
  NODE_ENV: 'development',
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/makeen',
  REDIS_URL: 'redis://:p@localhost:6379',
  JWT_PRIVATE_KEY_B64: b64(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  JWT_PUBLIC_KEY_B64: b64(publicKey.export({ type: 'spki', format: 'pem' })),
  PASSWORD_PEPPER: 'a-long-password-pepper',
  OTP_PEPPER: 'a-different-otp-pepper',
  AADHAAR_ENC_KEY_B64: randomBytes(32).toString('base64'),
  RESET_DEFAULT_PASSWORD: 'a-reset-default-1',
};

const prod = {
  ...valid,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://fm.makeenenergy.com',
  EMAIL_PROVIDER: 'smtp',
  SMS_PROVIDER: 'msg91',
  MSG91_AUTH_KEY: 'k',
  MSG91_OTP_TEMPLATE_ID: 't',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'makeen-files',
  S3_ACCESS_KEY_ID: 'prod-key',
  S3_SECRET_ACCESS_KEY: 'a-long-s3-secret-key',
};

describe('parseEnv', () => {
  it('accepts a minimal valid env and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.ALLOWED_EMAIL_DOMAINS).toEqual(['makeenenergy.com']);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.SESSION_ABSOLUTE_MAX_DAYS).toBe(30);
    expect(env.OTP_TTL_MINUTES).toBe(10);
    expect(cookiesSecure(env)).toBe(false);
  });

  it('fails fast listing every missing variable', () => {
    expect(() => parseEnv({ NODE_ENV: 'development' })).toThrow(
      /WEB_ORIGIN[\s\S]*DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_PRIVATE_KEY_B64/,
    );
  });

  it('rejects a non-postgres database URL and non-Ed25519 keys', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://localhost/x' })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => parseEnv({ ...valid, JWT_PUBLIC_KEY_B64: 'bm90LWEta2V5' })).toThrow(
      /JWT_PUBLIC_KEY_B64/,
    );
  });

  it('rejects short or identical peppers', () => {
    expect(() => parseEnv({ ...valid, PASSWORD_PEPPER: 'short' })).toThrow(/PASSWORD_PEPPER/);
    expect(() => parseEnv({ ...valid, OTP_PEPPER: valid.PASSWORD_PEPPER })).toThrow(/OTP_PEPPER/);
  });

  it('parses the email domain allow-list', () => {
    expect(
      parseEnv({ ...valid, ALLOWED_EMAIL_DOMAINS: ' MakeenEnergy.com , makeen.in' })
        .ALLOWED_EMAIL_DOMAINS,
    ).toEqual(['makeenenergy.com', 'makeen.in']);
  });

  it('refuses dev-only settings in production', () => {
    expect(() => parseEnv({ ...prod, SWAGGER_ENABLED: 'true' })).toThrow(
      /Swagger must be disabled/,
    );
    expect(() => parseEnv({ ...prod, WEB_ORIGIN: 'http://x.example' })).toThrow(/https/);
    expect(() => parseEnv({ ...prod, EMAIL_PROVIDER: 'console' })).toThrow(/dev-only/);
    expect(() => parseEnv({ ...prod, SMS_PROVIDER: 'console' })).toThrow(/dev-only/);
    expect(() => parseEnv({ ...prod, COOKIE_SECURE: 'false' })).toThrow(/Secure/);
    expect(() => parseEnv({ ...prod, STORAGE_DRIVER: 'local' })).toThrow(/dev-only/);
    expect(cookiesSecure(parseEnv(prod))).toBe(true);
  });

  it('S3 storage needs its bucket and keys', () => {
    expect(() => parseEnv({ ...valid, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(parseEnv(valid).STORAGE_DRIVER).toBe('local');
  });

  it('treats an empty KEKA API URL as not connected, and needs a token and https when set', () => {
    expect(parseEnv({ ...valid, KEKA_API_URL: '', KEKA_API_TOKEN: '' }).KEKA_API_URL).toBe(
      undefined,
    );
    expect(() => parseEnv({ ...valid, KEKA_API_URL: 'https://keka.example/api' })).toThrow(
      /KEKA_API_TOKEN/,
    );
    expect(() =>
      parseEnv({
        ...prod,
        KEKA_API_URL: 'http://keka.example/api',
        KEKA_API_TOKEN: 'a-long-keka-api-token',
      }),
    ).toThrow(/https/);
  });

  it('requires a reset default password of at least 12 characters', () => {
    expect(() => parseEnv({ ...valid, RESET_DEFAULT_PASSWORD: 'short' })).toThrow(
      /RESET_DEFAULT_PASSWORD/,
    );
  });

  it('requires MSG91 credentials when msg91 is chosen', () => {
    expect(() => parseEnv({ ...valid, SMS_PROVIDER: 'msg91' })).toThrow(/MSG91/);
  });

  it('does not echo secret values in the error', () => {
    try {
      parseEnv({
        ...valid,
        DATABASE_URL: 'mysql://user:SuperSecret@host/db',
        PASSWORD_PEPPER: 'tiny',
      });
    } catch (e) {
      expect((e as Error).message).not.toContain('SuperSecret');
      expect((e as Error).message).not.toContain('tiny');
    }
  });
});
