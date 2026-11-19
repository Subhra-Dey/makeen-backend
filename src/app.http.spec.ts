import type { NestExpressApplication } from '@nestjs/platform-express';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';
import { routesWithoutRule } from './common/access/access-metadata.check';
import { configureApp } from './app.setup';
import { DB_POOL } from './infra/database.module';
import { REDIS } from './infra/redis.module';
import { FakeRedis } from '../test/support/fake-redis';

/** Fakes standing in for Postgres/Redis so the full HTTP stack can be tested without containers. */
const fakePool = {
  healthy: true,
  query(): Promise<unknown> {
    return this.healthy
      ? Promise.resolve({ rows: [{ '?column?': 1 }] })
      : Promise.reject(new Error('ECONNREFUSED'));
  },
  end: (): Promise<void> => Promise.resolve(),
};
const fakeRedis = new FakeRedis();

describe('HTTP stack (health, security headers, error envelope)', () => {
  let app: NestExpressApplication;

  // Env comes from vitest.config.ts (`test.env`); ConfigModule validates it at import time.
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB_POOL)
      .useValue(fakePool)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    fakePool.healthy = true;
    fakeRedis.healthy = true;
  });

  it('GET /api/health is 200 without touching dependencies', async () => {
    fakePool.healthy = false;
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/ready is 200 when DB and Redis are up', async () => {
    const res = await request(app.getHttpServer()).get('/api/ready').expect(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
  });

  it('GET /api/ready is 503 when the database is down', async () => {
    fakePool.healthy = false;
    const res = await request(app.getHttpServer()).get('/api/ready').expect(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'down', redis: 'up' } });
  });

  it('GET /api/ready is 503 when Redis is down', async () => {
    fakeRedis.healthy = false;
    const res = await request(app.getHttpServer()).get('/api/ready').expect(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'up', redis: 'down' } });
  });

  it('sets hardening headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('echoes a safe inbound request id and mints one otherwise', async () => {
    const echoed = await request(app.getHttpServer())
      .get('/api/health')
      .set('X-Request-Id', 'nginx-abc-12345');
    expect(echoed.headers['x-request-id']).toBe('nginx-abc-12345');
    const minted = await request(app.getHttpServer())
      .get('/api/health')
      .set('X-Request-Id', '<script>');
    expect(minted.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the error envelope for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Not found.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('only allows the web origin for CORS', async () => {
    const ok = await request(app.getHttpServer())
      .options('/api/health')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const evil = await request(app.getHttpServer())
      .options('/api/health')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not expose Swagger when disabled', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(404);
  });

  it('answers a malformed JSON body with a generic message and a request id', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);
    expect(res.body.message).toBe('The request could not be read.');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/position|property name/);
  });

  it('boots only when every route carries an access rule (AccessMetadataCheck)', () => {
    const missing = routesWithoutRule(
      app.get(DiscoveryService),
      app.get(MetadataScanner),
      app.get(Reflector),
    );
    expect(missing).toEqual([]);
  });

  it('requires a session on the People routes', async () => {
    await request(app.getHttpServer()).get('/api/people').expect(401);
    await request(app.getHttpServer()).get('/api/roles').expect(401);
  });

  it('requires a session on every non-public route (global JwtAuthGuard)', async () => {
    const res = await request(app.getHttpServer()).get('/api/me').expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Please sign in.' });
  });

  it('requires the CSRF double-submit token on state-changing calls, even public ones', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'a@makeenenergy.com', password: 'x' })
      .expect(403);
    expect(res.body.code).toBe('CSRF_FAILED');
  });

  it('issues a CSRF cookie that is readable by the web app but SameSite=Strict', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    const cookie = String((res.headers['set-cookie'] as unknown as string[] | undefined)?.[0]);
    expect(cookie).toMatch(/^mk_csrf=/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/HttpOnly/);
    expect(res.body.csrfToken).toHaveLength(43);
  });
});
