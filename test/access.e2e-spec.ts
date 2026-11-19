/**
 * Phase 4 access-control suite, end to end against real PostgreSQL (real Redis in CI).
 * Exit criteria: Hidden → 403 for Search / Submit / Download / Approve, and plant-scope isolation.
 * A test-only probe module stands in for plant-scoped modules (wired like real endpoints).
 */
import { Client } from 'pg';
import { hashPassword } from '../src/common/crypto/password';
import { MODULES, ACTIONS } from '../src/shared';
import { createE2EApp, type E2EApp } from './support/e2e-app';
import { call, ipFactory, signIn, type Browser } from './support/http';
import { ProbeModule } from './support/probe.module';

const PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? '';
const ANITA = 'anita.sharma@makeenenergy.com'; // Admin
const RAVI = 'ravi.kumar@makeenenergy.com'; // Plant Manager, HPCL Yediyur
const ASHA = 'asha.nair@makeenenergy.com'; // Maintenance Officer, Yediyur + Barhi
const GOPAL = 'gopal.das@makeenenergy.com'; // Staff, HPCL Barhi

let e: E2EApp;
let db: Client;
const ip = ipFactory(41);
const plant: Record<string, string> = {};

async function as(email: string): Promise<Browser> {
  const s = await signIn(e, ip(), email, PASSWORD);
  expect(s.res.status).toBe(200);
  return s;
}

const probe = (plantId: string): string => `/api/probe/plants/${plantId}/daily-mis`;

/** Status codes for the four capabilities on one plant: [search, submit, download, approve]. */
async function four(b: Browser, plantId: string): Promise<number[]> {
  const base = probe(plantId);
  return [
    (await call(b, 'get', base)).status,
    (await call(b, 'post', base).send({})).status,
    (await call(b, 'get', `${base}/export`)).status,
    (await call(b, 'post', `${base}/approve`).send({})).status,
  ];
}

async function roleId(name: string): Promise<string> {
  const r = await db.query<{ id: string }>(`SELECT id FROM roles WHERE name = $1`, [name]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`role ${name} missing`);
  return id;
}

beforeAll(async () => {
  e = await createE2EApp([ProbeModule]);
  db = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await db.connect();
  // Known state for the people used here, whatever other suites did before.
  const hash = await hashPassword(PASSWORD, process.env['PASSWORD_PEPPER'] ?? '');
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false, login_status = 'ACTIVE'
      WHERE email = ANY($2)`,
    [hash, [ANITA, RAVI, ASHA, GOPAL]],
  );
  const plants = await db.query<{ id: string; code: string }>(`SELECT id, code::text FROM plants`);
  for (const p of plants.rows) plant[p.code] = p.id;
});

afterAll(async () => {
  await db.end();
  await e.close();
});

beforeEach(async () => {
  await e.flushRedis();
});

describe('module settings are bundles (D-10) and Hidden refuses everything (ROLE-9)', () => {
  it('Maintenance Officer: Search + Submit on Daily MIS, no Download, no Approve', async () => {
    const asha = await as(ASHA);
    expect(await four(asha, plant['HPY-011'] ?? '')).toEqual([200, 200, 403, 403]);
  });

  it('Plant Manager: Search + Download + Approve, never Submit', async () => {
    const ravi = await as(RAVI);
    expect(await four(ravi, plant['HPY-011'] ?? '')).toEqual([200, 403, 200, 200]);
  });

  it('Hidden on Daily MIS → 403 on all four, at once, for everyone in the role', async () => {
    const admin = await as(ANITA);
    const asha = await as(ASHA);
    const mo = await roleId('Maintenance Officer');
    const current = await call(admin, 'get', `/api/roles/${mo}`).expect(200);
    const hidden = { ...current.body.modules, DAILY_MIS: 'HIDDEN' };
    try {
      await call(admin, 'put', `/api/roles/${mo}`)
        .send({ version: current.body.version, modules: hidden, actions: current.body.actions })
        .expect(200);
      // Same session, no sign-in again: the next request already sees the change.
      expect(await four(asha, plant['HPY-011'] ?? '')).toEqual([403, 403, 403, 403]);
      const me = await call(asha, 'get', '/api/me').expect(200);
      expect(me.body.access.modules.DAILY_MIS).toEqual([]);
    } finally {
      const now = await call(admin, 'get', `/api/roles/${mo}`).expect(200);
      await call(admin, 'post', `/api/roles/${mo}/reset`)
        .send({ version: now.body.version })
        .expect(200);
    }
    expect(await four(asha, plant['HPY-011'] ?? '')).toEqual([200, 200, 403, 403]);
  });

  it('Hide all modules leaves a role with nothing but its profile', async () => {
    const admin = await as(ANITA);
    const gopal = await as(GOPAL);
    const staff = await roleId('Staff');
    const current = await call(admin, 'get', `/api/roles/${staff}`).expect(200);
    try {
      await call(admin, 'put', `/api/roles/${staff}`)
        .send({
          version: current.body.version,
          modules: Object.fromEntries(MODULES.map((m) => [m, 'HIDDEN'])),
          actions: Object.fromEntries(ACTIONS.map((a) => [a, false])),
        })
        .expect(200);
      expect(await four(gopal, plant['HPB-017'] ?? '')).toEqual([403, 403, 403, 403]);
      await call(gopal, 'get', '/api/me').expect(200);
      await call(gopal, 'get', '/api/people').expect(403);
    } finally {
      const now = await call(admin, 'get', `/api/roles/${staff}`).expect(200);
      await call(admin, 'post', `/api/roles/${staff}/reset`)
        .send({ version: now.body.version })
        .expect(200);
    }
  });

  it('People is Hidden for every role but Admin (ROLE-D6)', async () => {
    const ravi = await as(RAVI);
    await call(ravi, 'get', '/api/people').expect(403);
    await call(ravi, 'get', '/api/people/logins').expect(403);
    await call(ravi, 'get', '/api/roles').expect(403);
    await call(ravi, 'get', '/api/designations').expect(403);
    await call(ravi, 'post', '/api/people/import').expect(403);
    const res = await call(ravi, 'get', '/api/people').expect(403);
    expect(res.body).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have access to this.',
    });
  });
});

describe('plant scope (GEN-1, GEN-2, SEC-9)', () => {
  it('refuses a plant that is not assigned, even with the right role (forged plantId)', async () => {
    const asha = await as(ASHA);
    expect(await four(asha, plant['HPB-017'] ?? '')).toEqual([200, 200, 403, 403]);
    expect(await four(asha, plant['IOW-025'] ?? '')).toEqual([403, 403, 403, 403]);
    const ravi = await as(RAVI);
    expect(await four(ravi, plant['HPB-017'] ?? '')).toEqual([403, 403, 403, 403]);
  });

  it('a random plant id is refused, a malformed one is a 400', async () => {
    const asha = await as(ASHA);
    await call(asha, 'get', probe('0190a000-0000-7000-8000-00000000dead')).expect(403);
    await call(asha, 'get', probe('not-a-uuid')).expect(400);
  });

  it('Admin may act on every plant', async () => {
    const admin = await as(ANITA);
    expect(await four(admin, plant['IOW-025'] ?? '')).toEqual([200, 200, 200, 200]);
  });

  it('uses the role on THAT plant (D-11): a Plant Manager role on Barhi only', async () => {
    const admin = await as(ANITA);
    const asha = await as(ASHA);
    const ashaId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [ASHA]))
      .rows[0]?.id;
    const mo = await roleId('Maintenance Officer');
    const pm = await roleId('Plant Manager');
    const body = (pmOnBarhi: boolean): object => ({
      plantIds: [plant['HPY-011'], plant['HPB-017']],
      roleId: mo,
      plantRoles: pmOnBarhi ? [{ plantId: plant['HPB-017'], roleId: pm }] : [],
      loginStatus: 'ACTIVE',
      remarks: 'e2e role per plant',
    });
    try {
      const res = await call(admin, 'put', `/api/people/${ashaId}/assignment`)
        .send(body(true))
        .expect(200);
      expect(res.body.plants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'HPB-017',
            role: expect.objectContaining({ name: 'Plant Manager' }),
          }),
          expect.objectContaining({
            code: 'HPY-011',
            role: expect.objectContaining({ name: 'Maintenance Officer' }),
          }),
        ]),
      );
      expect(await four(asha, plant['HPY-011'] ?? '')).toEqual([200, 200, 403, 403]);
      expect(await four(asha, plant['HPB-017'] ?? '')).toEqual([200, 403, 200, 200]);
    } finally {
      await call(admin, 'put', `/api/people/${ashaId}/assignment`).send(body(false)).expect(200);
    }
  });

  it('RLS: /me lists only assigned plants; Admin sees all 22', async () => {
    const asha = await as(ASHA);
    const me = await call(asha, 'get', '/api/me').expect(200);
    expect((me.body.plants as { code: string }[]).map((p) => p.code).sort()).toEqual([
      'HPB-017',
      'HPY-011',
    ]);
    const admin = await as(ANITA);
    const all = await call(admin, 'get', '/api/me').expect(200);
    expect(all.body.plants).toHaveLength(22);
  });
});
