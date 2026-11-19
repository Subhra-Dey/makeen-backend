import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { EMAIL_PROVIDER, SMS_PROVIDER } from '../../src/infra/messaging/messaging';
import { REDIS } from '../../src/infra/redis.module';
import { CaptureEmail, CaptureSms } from './capture-messaging';
import { FakeRedis } from './fake-redis';

export interface E2EApp {
  app: NestExpressApplication;
  email: CaptureEmail;
  sms: CaptureSms;
  /** Real Redis (CI) or the in-memory stand-in (local dev without Redis). */
  redis: Redis | FakeRedis;
  realRedis: boolean;
  flushRedis: () => Promise<void>;
  close: () => Promise<void>;
}

/** Real Redis if one answers within 1 s, otherwise the in-memory stand-in (logged once). */
async function pickRedis(): Promise<{ redis: Redis | FakeRedis; real: boolean }> {
  const url = process.env['REDIS_URL'];
  if (url) {
    const real = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      retryStrategy: () => null,
    });
    real.on('error', () => undefined);
    try {
      await real.connect();
      await real.ping();
      return { redis: real, real: true };
    } catch {
      real.disconnect();
    }
  }
  console.warn(
    '[e2e] No Redis reachable — using the in-memory Redis stand-in (CI uses a real Redis).',
  );
  return { redis: new FakeRedis(), real: false };
}

/** `extraImports`: test-only modules (e.g. the access probe) mounted next to the real app. */
export async function createE2EApp(
  extraImports: NonNullable<ModuleMetadata['imports']> = [],
): Promise<E2EApp> {
  const { redis, real } = await pickRedis();
  const email = new CaptureEmail();
  const sms = new CaptureSms();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ...extraImports] })
    .overrideProvider(REDIS)
    .useValue(redis)
    .overrideProvider(EMAIL_PROVIDER)
    .useValue(email)
    .overrideProvider(SMS_PROVIDER)
    .useValue(sms)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return {
    app,
    email,
    sms,
    redis,
    realRedis: real,
    flushRedis: async () => {
      await redis.flushdb();
    },
    close: async () => {
      await app.close();
    },
  };
}
