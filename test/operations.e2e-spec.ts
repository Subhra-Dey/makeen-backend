/**
 * Phase 9 Plant Operations suite (Plant master, Audit, Licences, Review Check), end to end against
 * real PostgreSQL. Statuses are checked against the SAME shared functions over SQL rows, with
 * India "today". Everything created hangs off plant E2E-901, removed in afterAll.
 */
import { Client } from 'pg';
import type { Response } from 'supertest';
import { hashPassword } from '../src/common/crypto/password';
import {
  OPERATIONS_MESSAGES,
  addDays,
  contractEndingSoon,
  istToday,
  licenceStatus,
  observationUrgency,
  plantEndDate,
  reviewCheckStatus,
  type AuditDetail,
  type AuditPage,
  type LicenceDetail,
  type LicencePage,
  type PersonOption,
  type PlantDetailView,
  type PlantPage,
  type ReviewCheckPage,
} from '../src/shared';
import { createE2EApp, type E2EApp } from './support/e2e-app';
import { call, ipFactory, signIn, type Browser } from './support/http';

const PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? '';
const ANITA = 'anita.sharma@makeenenergy.com'; // Admin
const RAVI = 'ravi.kumar@makeenenergy.com'; // Plant Manager, Yediyur
const ASHA = 'asha.nair@makeenenergy.com'; // Maintenance Officer, Yediyur + Barhi
const GOPAL = 'gopal.das@makeenenergy.com'; // Staff, Barhi

let e: E2EApp;
let db: Client;
const ip = ipFactory(57);
const today = istToday();
const ids: Record<string, string> = {};
let plantId = '';

/** Dates are read as `::text` (node-pg would turn a DATE into local midnight). */
const iso = (d: string | null): string | null => d;

async function as(email: string): Promise<Browser> {
  const s = await signIn(e, ip(), email, PASSWORD);
  expect(s.res.status).toBe(200);
  return s;
}

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => {
    cb(null, Buffer.concat(chunks));
  });
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100),
]);

beforeAll(async () => {
  e = await createE2EApp();
  db = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await db.connect();
  const hash = await hashPassword(PASSWORD, process.env['PASSWORD_PEPPER'] ?? '');
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false, login_status = 'ACTIVE'
      WHERE email = ANY($2)`,
    [hash, [ANITA, RAVI, ASHA, GOPAL]],
  );
  const u = await db.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email = ANY($1)`,
    [[ANITA, RAVI, ASHA, GOPAL]],
  );
  for (const r of u.rows) ids[r.email] = r.id;
  await e.flushRedis();
});

afterAll(async () => {
  const p = await db.query<{ id: string }>(`SELECT id FROM plants WHERE code LIKE 'E2E-%'`);
  const pids = p.rows.map((r) => r.id);
  if (pids.length > 0) {
    await db.query(`DELETE FROM attachments WHERE plant_id = ANY($1)`, [pids]);
    await db.query(`DELETE FROM audits WHERE plant_id = ANY($1)`, [pids]);
    await db.query(`DELETE FROM licences WHERE plant_id = ANY($1)`, [pids]);
    await db.query(`DELETE FROM plants WHERE id = ANY($1)`, [pids]);
  }
  await db.end();
  await e.close();
});

describe('Plant master (PLT-*, CARD-8, BTN-P5)', () => {
  it('cards count working, new and contracts ending in 90 days', async () => {
    const admin = await as(ANITA);
    const page = (await call(admin, 'get', '/api/plants?pageSize=200').expect(200))
      .body as PlantPage;
    const sql = await db.query<{ status: string; end_date: string; name: string }>(
      `SELECT status, end_date::text AS end_date, name FROM plants WHERE deleted_at IS NULL`,
    );
    const ending = sql.rows.filter((r) => contractEndingSoon(iso(r.end_date) ?? '', today));
    expect(page.cards).toEqual({
      working: sql.rows.filter((r) => r.status === 'WORKING').length,
      new: sql.rows.filter((r) => r.status === 'NEW').length,
      endingSoon: ending.length,
      endingSoonNames: ending.map((r) => r.name).sort((a, b) => a.localeCompare(b)),
    });
    expect(page.rows.find((r) => r.code === 'HPY-011')).toMatchObject({
      plantKey: 'PK-7F3A21',
      periodYears: 5,
      manager: { name: 'Ravi Kumar' },
    });
  });

  it('a Plant Manager sees only their plants; Staff cannot create', async () => {
    const ravi = await as(RAVI);
    const page = (await call(ravi, 'get', '/api/plants').expect(200)).body as PlantPage;
    expect(page.rows.map((r) => r.code)).toEqual(['HPY-011']);
    const gopal = await as(GOPAL);
    await call(gopal, 'get', '/api/plants/people-options').expect(403);
  });

  it('Admin creates a plant: start = contract date, end per D-15, key shown, manager seated', async () => {
    const admin = await as(ANITA);
    const r = await call(admin, 'post', '/api/plants')
      .send({
        name: 'E2E Test Terminal',
        address: 'Plot 9, Test Road',
        code: 'e2e-901',
        managerId: ids[RAVI],
        userIds: [ids[ASHA]],
        contractDate: '2026-02-01',
        periodYears: 3,
        extensionYears: 2,
        status: 'WORKING',
        // Client-sent computed values are ignored (SEC-14).
        endDate: '2099-01-01',
      })
      .expect(201);
    const d = r.body as PlantDetailView;
    plantId = d.plant.id;
    expect(d.plant).toMatchObject({
      code: 'E2E-901',
      startDate: '2026-02-01',
      endDate: plantEndDate('2026-02-01', 3),
      extensionYears: 2,
      manager: { name: 'Ravi Kumar' },
    });
    expect(d.plant.plantKey).toMatch(/^PK-[0-9A-F]{6}$/);
    expect(d.users.map((u) => u.name)).toEqual(['Asha Nair', 'Ravi Kumar']);
    const role = await db.query<{ name: string }>(
      `SELECT r.name FROM plant_assignments a JOIN roles r ON r.id = a.role_id
        WHERE a.plant_id = $1 AND a.user_id = $2`,
      [plantId, ids[RAVI]],
    );
    expect(role.rows[0]?.name).toBe('Plant Manager');

    const dup = await call(admin, 'post', '/api/plants')
      .send({
        name: 'E2E Other',
        address: 'x',
        code: 'E2E-901',
        managerId: ids[RAVI],
        contractDate: '2026-02-01',
        periodYears: 1,
        status: 'NEW',
      })
      .expect(400);
    expect(dup.body.details).toEqual([
      { path: 'code', message: OPERATIONS_MESSAGES.plantCodeTaken },
    ]);
    const ravi = await as(RAVI);
    await call(ravi, 'post', '/api/plants').send({}).expect(403);
  });

  it('a new period recomputes the end date; extension stays stored only', async () => {
    const admin = await as(ANITA);
    const r = await call(admin, 'put', `/api/plants/${plantId}`)
      .send({
        name: 'E2E Test Terminal',
        address: 'Plot 9, Test Road',
        code: 'E2E-901',
        managerId: ids[RAVI],
        contractDate: '2026-02-01',
        periodYears: 5,
        extensionYears: 2,
        status: 'WORKING',
      })
      .expect(200);
    expect((r.body as PlantDetailView).plant.endDate).toBe('2031-01-31');
  });

  it('the Plant Manager keeps details, activities with images and contract files', async () => {
    const ravi = await as(RAVI);
    const dup = await call(ravi, 'put', `/api/plants/${plantId}/details`)
      .send({
        volumes: [
          { type: 'PROJECTED', fy: '2026-27', volumeMt: '1000' },
          { type: 'PROJECTED', fy: '2026-27', volumeMt: '2000' },
        ],
      })
      .expect(400);
    expect(dup.body.details[0].message).toBe(OPERATIONS_MESSAGES.fyDuplicate);
    const r = await call(ravi, 'put', `/api/plants/${plantId}/details`)
      .send({
        capacity: '1,20,000',
        production: '84600',
        volumes: [
          { type: 'PROJECTED', fy: '2026-27', volumeMt: '86000' },
          { type: 'MINIMUM', fy: '2026-27', volumeMt: '68000' },
        ],
        equipment: { PUMPS: { quantity: 6, note: '2 standby' }, CCTV_CAMERAS: { quantity: '32' } },
      })
      .expect(200);
    const d = r.body as PlantDetailView;
    expect(d.details).toMatchObject({
      capacity: '120000.000',
      production: '84600.000',
      volumes: [
        { type: 'PROJECTED', fy: '2026-27', volumeMt: '86000.000' },
        { type: 'MINIMUM', fy: '2026-27', volumeMt: '68000.000' },
      ],
      equipment: {
        PUMPS: { quantity: 6, note: '2 standby' },
        CCTV_CAMERAS: { quantity: 32, note: null },
        FIRE_ENGINE: { quantity: 0, note: null },
      },
      updatedBy: { name: 'Ravi Kumar' },
    });
    expect(d.can).toEqual({ editMaster: false, editDetails: true, delete: false });

    const act = (
      await call(ravi, 'post', `/api/plants/${plantId}/activities`)
        .send({ heading: 'Carousel line C commissioned', description: 'Trial run done' })
        .expect(201)
    ).body as PlantDetailView;
    const activityId = act.activities[0]?.id ?? '';
    const pdf = await call(ravi, 'post', `/api/plants/${plantId}/activities/${activityId}/images`)
      .attach('file', PDF, 'not-an-image.pdf')
      .expect(415);
    expect(pdf.body.message).toBe(OPERATIONS_MESSAGES.imageType);
    const img = (
      await call(ravi, 'post', `/api/plants/${plantId}/activities/${activityId}/images`)
        .attach('file', PNG, 'carousel.png')
        .expect(201)
    ).body as PlantDetailView;
    expect(img.activities[0]?.images.map((i) => i.fileName)).toEqual(['carousel.png']);
    const contract = (
      await call(ravi, 'post', `/api/plants/${plantId}/files`)
        .attach('file', PDF, 'Contract.pdf')
        .expect(201)
    ).body as PlantDetailView;
    const fileId = contract.contractFiles[0]?.id ?? '';
    const dl = await call(ravi, 'get', `/api/plants/${plantId}/files/${fileId}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="Contract.pdf"');

    const gopal = await as(GOPAL);
    await call(gopal, 'put', `/api/plants/${plantId}/details`).send({}).expect(403);
  });
});

describe('Audit (AUD-*, CARD-6, BTN-P6)', () => {
  let auditId = '';
  let version = 0;

  it('cards and row order follow the shared urgency rule (revised target date first)', async () => {
    const admin = await as(ANITA);
    const page = (await call(admin, 'get', '/api/audits?pageSize=200').expect(200))
      .body as AuditPage;
    const obs = await db.query<{
      status: 'PENDING' | 'COMPLIED';
      target_date: string | null;
      revised_target_date: string | null;
    }>(`SELECT o.status, o.target_date::text AS target_date,
               o.revised_target_date::text AS revised_target_date FROM audit_observations o
          JOIN audits a ON a.id = o.audit_id JOIN plants p ON p.id = a.plant_id
         WHERE p.deleted_at IS NULL`);
    const u = obs.rows.map((o) =>
      observationUrgency(
        {
          status: o.status,
          targetDate: iso(o.target_date),
          revisedTargetDate: iso(o.revised_target_date),
        },
        today,
      ),
    );
    const total = await db.query<{ n: number }>(
      `SELECT COALESCE(sum(a.total_recommendations), 0)::int n FROM audits a
         JOIN plants p ON p.id = a.plant_id WHERE p.deleted_at IS NULL`,
    );
    expect(page.cards).toEqual({
      totalRecommendations: total.rows[0]?.n,
      complied: u.filter((x) => x === 'COMPLIED').length,
      pending: u.filter((x) => x === 'PENDING' || x === 'DUE_SOON').length,
      overdue: u.filter((x) => x === 'OVERDUE').length,
    });
    const rank = { OVERDUE: 0, DUE_SOON: 1, PENDING: 2, COMPLIED: 3 } as const;
    const ranks = page.rows.map((r) => (r.urgency ? rank[r.urgency] : 4));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const overdue = (await call(admin, 'get', '/api/audits?status=OVERDUE').expect(200))
      .body as AuditPage;
    expect(overdue.rows.every((r) => r.counts.overdue > 0)).toBe(true);
  });

  it('save: Observation Ids come from the system; revised before target is refused', async () => {
    const ravi = await as(RAVI);
    const max = await db.query<{ n: number }>(
      `SELECT max(substring(observation_code FROM 4)::int)::int n FROM audit_observations`,
    );
    const body = {
      plantId,
      auditType: 'OISD',
      frequency: 'MONTHS_12',
      fy: '2026-27',
      totalRecommendations: 2,
      startDate: '2026-05-05',
      endDate: '2026-05-07',
      observations: [
        {
          subGroupCode: 'FS-02',
          checklistRef: 'OISD-144/4.2',
          observation: 'Hydrant H-14 valve stuck',
          targetDate: addDays(today, -5),
          revisedTargetDate: addDays(today, -10),
          status: 'PENDING',
        },
      ],
    };
    const bad = await call(ravi, 'post', '/api/audits').send(body).expect(400);
    expect(bad.body.details).toEqual([
      {
        path: 'observations.0.revisedTargetDate',
        message: OPERATIONS_MESSAGES.revisedBeforeTarget,
      },
    ]);
    const r = await call(ravi, 'post', '/api/audits')
      .send({
        ...body,
        observations: [
          { ...body.observations[0], revisedTargetDate: addDays(today, -1) },
          { observation: 'Guard missing', targetDate: addDays(today, 3), status: 'PENDING' },
        ],
      })
      .expect(201);
    const d = r.body as AuditDetail;
    auditId = d.id;
    version = d.version;
    const n = max.rows[0]?.n ?? 0;
    expect(d.observations.map((o) => o.code).sort()).toEqual([
      `OB-${String(n + 1).padStart(4, '0')}`,
      `OB-${String(n + 2).padStart(4, '0')}`,
    ]);
    expect(d.observations.map((o) => o.urgency)).toEqual(['OVERDUE', 'DUE_SOON']);
  });

  it('update edits, removes and adds rows in one save; stale versions are refused', async () => {
    const ravi = await as(RAVI);
    const current = (await call(ravi, 'get', `/api/audits/${auditId}`).expect(200))
      .body as AuditDetail;
    const [first] = current.observations;
    const r = await call(ravi, 'put', `/api/audits/${auditId}`)
      .send({
        version,
        plantId,
        auditType: 'OISD',
        frequency: 'MONTHS_12',
        fy: '2026-27',
        totalRecommendations: 2,
        startDate: '2026-05-05',
        endDate: '2026-05-07',
        observations: [
          { ...first, status: 'COMPLIED' },
          { observation: 'Earth pit E-6 high', targetDate: addDays(today, 30), status: 'PENDING' },
        ],
      })
      .expect(200);
    const d = r.body as AuditDetail;
    expect(d.version).toBe(version + 1);
    expect(d.observations.map((o) => [o.code === first?.code, o.urgency])).toEqual([
      [false, 'PENDING'],
      [true, 'COMPLIED'],
    ]);
    await call(ravi, 'put', `/api/audits/${auditId}`)
      .send({
        version,
        plantId,
        auditType: 'OISD',
        frequency: 'MONTHS_12',
        fy: '2026-27',
        totalRecommendations: 2,
        startDate: '2026-05-05',
        endDate: '2026-05-07',
        observations: [],
      })
      .expect(409);
    const gopal = await as(GOPAL);
    await call(gopal, 'get', `/api/audits/${auditId}`).expect(404);
  });

  it('the audit file is uploaded to the audit and listed on its row', async () => {
    const ravi = await as(RAVI);
    await call(ravi, 'post', `/api/audits/${auditId}/files`)
      .attach('file', PDF, 'OISD_Audit_E2E.pdf')
      .expect(201);
    const page = (await call(ravi, 'get', `/api/audits?plantId=${plantId}`).expect(200))
      .body as AuditPage;
    expect(page.rows[0]?.attachment?.fileName).toBe('OISD_Audit_E2E.pdf');
  });
});

describe('Licences (LIC-*, CARD-7, BTN-P7)', () => {
  let licenceId = '';

  it('each tab counts its own rows by the shared status rule; Expired and Due come first', async () => {
    const admin = await as(ANITA);
    for (const category of ['STATUTORY', 'INTERNAL'] as const) {
      const page = (
        await call(admin, 'get', `/api/licences?category=${category}&pageSize=200`).expect(200)
      ).body as LicencePage;
      const sql = await db.query<{
        frequency: 'YEARLY' | 'NA';
        start_date: string | null;
        end_date: string | null;
        remind_before_days: number;
      }>(
        `SELECT l.frequency, l.start_date::text AS start_date, l.end_date::text AS end_date,
                l.remind_before_days FROM licences l
           JOIN plants p ON p.id = l.plant_id WHERE p.deleted_at IS NULL AND l.category = $1`,
        [category],
      );
      const s = sql.rows.map((l) =>
        licenceStatus(
          {
            frequency: l.frequency,
            startDate: iso(l.start_date),
            endDate: iso(l.end_date),
            remindBeforeDays: l.remind_before_days,
          },
          today,
        ),
      );
      const n = (x: string): number => s.filter((v) => v === x).length;
      expect(page.cards).toEqual({
        total: s.length,
        active: n('ACTIVE'),
        expired: n('EXPIRED'),
        due: n('DUE'),
        na: n('NA'),
        notInitiated: n('NOT_INITIATED'),
      });
      const rank = { EXPIRED: 0, DUE: 1, ACTIVE: 2, NOT_INITIATED: 3, NA: 4 } as const;
      const ranks = page.rows.map((r) => rank[r.status]);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      expect(
        page.rows.every((r) =>
          category === 'STATUTORY'
            ? ['STATUTORY', 'SAFETY_CALIBRATION'].includes(r.licenceType)
            : ['ELECTRICAL_CALIBRATION', 'MAINTENANCE_CALIBRATION'].includes(r.licenceType),
        ),
      ).toBe(true);
    }
  });

  it('save: the item must match the type; status is set by the system (Due in the window)', async () => {
    const ravi = await as(RAVI);
    const items = await db.query<{ id: string; licence_type: string; title: string }>(
      `SELECT id, licence_type, title FROM licence_items`,
    );
    const peso = items.rows.find((i) => i.title === 'PESO storage licence')?.id ?? '';
    const earth = items.rows.find((i) => i.title === 'Earth pit resistance test')?.id ?? '';
    const options = (
      await call(ravi, 'get', `/api/licences/remind-options?plantId=${plantId}`).expect(200)
    ).body as PersonOption[];
    expect(options.map((o) => o.name)).toEqual(
      expect.arrayContaining(['Ravi Kumar', 'Anita Sharma']),
    );
    const base = {
      plantId,
      licenceType: 'STATUTORY',
      itemId: earth,
      docRef: 'PESO/E2E/1',
      startDate: addDays(today, -355),
      endDate: addDays(today, 10),
      frequency: 'YEARLY',
      remindBeforeDays: 30,
      remindUserIds: [ids[RAVI]],
    };
    const wrong = await call(ravi, 'post', '/api/licences').send(base).expect(400);
    expect(wrong.body.details).toEqual([
      { path: 'itemId', message: OPERATIONS_MESSAGES.itemWrongType },
    ]);
    const none = await call(ravi, 'post', '/api/licences')
      .send({ ...base, itemId: peso, remindUserIds: [] })
      .expect(400);
    expect(none.body.details[0].message).toBe(OPERATIONS_MESSAGES.remindUsersRequired);
    const r = await call(ravi, 'post', '/api/licences')
      .send({ ...base, itemId: peso, status: 'ACTIVE' })
      .expect(201);
    const d = r.body as LicenceDetail;
    licenceId = d.id;
    expect(d).toMatchObject({
      status: 'DUE',
      category: 'STATUTORY',
      item: { title: 'PESO storage licence' },
      remindUsers: [{ name: 'Ravi Kumar' }],
    });
    // Title and type can be edited (LIC-4); NA wins.
    const edit = await call(ravi, 'put', `/api/licences/${licenceId}`)
      .send({
        ...base,
        itemId: earth,
        licenceType: 'ELECTRICAL_CALIBRATION',
        frequency: 'NA',
        version: d.version,
      })
      .expect(200);
    expect(edit.body).toMatchObject({
      status: 'NA',
      category: 'INTERNAL',
      item: { title: 'Earth pit resistance test' },
    });
    const gopal = await as(GOPAL);
    await call(gopal, 'get', `/api/licences/${licenceId}`).expect(404);
  });
});

describe('Review Check (RC-1…RC-3)', () => {
  it('every plant row equals the shared D-27 rule over its own counts', async () => {
    const admin = await as(ANITA);
    const page = (await call(admin, 'get', '/api/review-check').expect(200))
      .body as ReviewCheckPage;
    expect(page.today).toBe(today);
    for (const r of page.rows) {
      expect(r.status).toBe(
        reviewCheckStatus(
          {
            contractEnd: r.contractEnd,
            observationsOverdue: r.audit.overdue,
            observationsDueSoon: r.audit.dueSoon,
            licencesExpired: r.statutory.expired + r.internal.expired,
            licencesDue: r.statutory.due + r.internal.due,
          },
          today,
        ),
      );
    }
    const barhi = page.rows.find((r) => r.plant.code === 'HPB-017');
    expect(barhi?.status).toBe('CRITICAL'); // contract ended 31-07-2025
    const rank = { CRITICAL: 0, ATTENTION: 1, OK: 2 } as const;
    const ranks = page.rows.map((r) => rank[r.status]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const e2e = page.rows.find((r) => r.plant.id === plantId);
    expect(e2e?.audit).toMatchObject({ complied: 1, pending: 1, overdue: 0 });
  });

  it('downloads the table; Staff sees only their plant', async () => {
    const admin = await as(ANITA);
    const x = await call(admin, 'get', '/api/review-check/export?format=xlsx')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(x.headers['content-disposition']).toBe('attachment; filename="review-check.xlsx"');
    const gopal = await as(GOPAL);
    const page = (await call(gopal, 'get', '/api/review-check').expect(200))
      .body as ReviewCheckPage;
    expect(page.rows.map((r) => r.plant.code)).toEqual(['HPB-017']);
  });
});

describe('Admin delete (ACT-3)', () => {
  it('needs the Delete switch and a reason; the plant disappears and the delete is audited', async () => {
    const ravi = await as(RAVI);
    await call(ravi, 'post', `/api/plants/${plantId}/delete`).send({ reason: 'x' }).expect(403);
    const admin = await as(ANITA);
    await call(admin, 'post', `/api/plants/${plantId}/delete`).send({ reason: ' ' }).expect(400);
    await call(admin, 'post', `/api/plants/${plantId}/delete`)
      .send({ reason: 'Created by the e2e suite' })
      .expect(204);
    await call(admin, 'get', `/api/plants/${plantId}`).expect(404);
    const audit = await db.query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE entity = 'plant' AND entity_id = $1 AND action = 'DELETE'`,
      [plantId],
    );
    expect(audit.rows[0]?.reason).toBe('Created by the e2e suite');
  });
});
