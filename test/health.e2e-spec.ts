import request from 'supertest';
import { createE2EApp, type E2EApp } from './support/e2e-app';

/**
 * End-to-end: real Postgres; real Redis in CI (the in-memory stand-in only when none is reachable).
 */
describe('Health (e2e)', () => {
  let e: E2EApp;

  beforeAll(async () => {
    e = await createE2EApp();
  });

  afterAll(async () => {
    await e.close();
  });

  it('GET /api/health → 200', async () => {
    await request(e.app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
  });

  it('GET /api/ready → 200 with database and redis up', async () => {
    const res = await request(e.app.getHttpServer()).get('/api/ready').expect(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
  });
});
