/**
 * Phase 8 Daily Exceptions suite, end to end against real PostgreSQL.
 * Rows created here use June 2026 dates — before the seeded history (Aug 2026) — and are removed
 * in afterAll. Uploads go to the throw-away local store (e2e-global-setup).
 */
import * as ExcelJS from 'exceljs';
import { Client } from 'pg';
import type { Response } from 'supertest';
import { hashPassword } from '../src/common/crypto/password';
import {
  DAILY_EXCEPTION_MESSAGES,
  FIELD_MESSAGES,
  addDays,
  istToday,
  type DailyExceptionDetail,
  type DailyExceptionPage,
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
const ip = ipFactory(51);
let yediyur = '';
let barhi = '';

type Answer = 'YES' | 'NO' | null;
function lines(over: Record<string, { answer: Answer; details?: object }> = {}) {
  const out: Record<string, { answer: Answer; details: object }> = {};
  for (let n = 1; n <= 13; n += 1) {
    const o = over[String(n)];
    out[String(n)] = { answer: o ? o.answer : 'NO', details: o?.details ?? {} };
  }
  return out;
}

async function as(email: string): Promise<Browser> {
  const s = await signIn(e, ip(), email, PASSWORD);
  expect(s.res.status).toBe(200);
  return s;
}

function save(b: Browser, body: object, id?: string) {
  return call(
    b,
    id ? 'put' : 'post',
    id ? `/api/daily-exceptions/${id}` : '/api/daily-exceptions',
  ).send(body);
}

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => {
    cb(null, Buffer.concat(chunks));
  });
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0x20)]);

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
  const p = await db.query<{ id: string; code: string }>(
    `SELECT id, code::text FROM plants WHERE code IN ('HPY-011','HPB-017')`,
  );
  const id = (c: string): string => p.rows.find((r) => r.code === c)?.id ?? '';
  yediyur = id('HPY-011');
  barhi = id('HPB-017');
  await e.flushRedis();
});

afterAll(async () => {
  await db.query(
    `DELETE FROM attachments WHERE owner_type = 'DAILY_EXCEPTION' AND owner_id IN (
       SELECT id FROM daily_exceptions WHERE report_date BETWEEN '2026-06-01' AND '2026-06-30')`,
  );
  await db.query(
    `DELETE FROM daily_exceptions WHERE report_date BETWEEN '2026-06-01' AND '2026-06-30'`,
  );
  await db.query(`DELETE FROM lapse_notes WHERE date BETWEEN '2026-06-01' AND '2026-06-30'`);
  await db.end();
  await e.close();
});

describe('table, cards, Not initiated and Lapse (DEX-T*, CARD-4, DEX-S4…S6)', () => {
  it('one row per working plant-day; missing days are Not initiated rows; cards add up', async () => {
    const admin = await as(ANITA);
    const page = (
      await call(
        admin,
        'get',
        '/api/daily-exceptions?from=2026-10-16&to=2026-10-16&pageSize=200',
      ).expect(200)
    ).body as DailyExceptionPage;
    const sql = await db.query<{ status: string; n: number }>(
      `SELECT COALESCE(e.status::text, 'NOT_INITIATED') status, count(*)::int n
         FROM plants p
         LEFT JOIN daily_exceptions e ON e.plant_id = p.id AND e.report_date = '2026-10-16'
        WHERE p.deleted_at IS NULL AND p.status = 'WORKING'
          AND p.start_date <= '2026-10-16'
        GROUP BY 1`,
    );
    const n = (s: string): number => sql.rows.find((r) => r.status === s)?.n ?? 0;
    expect(page.cards).toEqual({
      completed: n('COMPLETED'),
      submitted: n('COMPLETED') + n('PENDING'),
      pending: n('PENDING'),
      partial: n('PARTIAL'),
      notInitiated: n('NOT_INITIATED'),
    });
    expect(page.cards.notInitiated).toBeGreaterThan(0);
    expect(page.total).toBe(sql.rows.reduce((a, r) => a + r.n, 0));
    const missing = page.rows.filter((r) => r.status === 'NOT_INITIATED');
    expect(missing).toHaveLength(n('NOT_INITIATED'));
    expect(missing.every((r) => r.id === null && r.updatedAt === null)).toBe(true);
    const gwalior = page.rows.find((r) => r.plant.code === 'IOW-025');
    expect(gwalior).toMatchObject({
      status: 'PENDING',
      problemHighlight: 'Jockey pump no. 2 on manual — auto controller fault reported',
    });
    // Pending rows come first within a day.
    expect(page.rows[0]?.status).toBe('PENDING');
  });

  it('the status filter includes Not initiated', async () => {
    const admin = await as(ANITA);
    const page = (
      await call(
        admin,
        'get',
        '/api/daily-exceptions?from=2026-10-16&to=2026-10-16&status=NOT_INITIATED',
      ).expect(200)
    ).body as DailyExceptionPage;
    expect(page.total).toBe(page.cards.notInitiated);
    expect(page.rows.every((r) => r.status === 'NOT_INITIATED')).toBe(true);
  });

  it('Lapse counts missing days: today, this month and this FY up to yesterday (D-21)', async () => {
    const admin = await as(ANITA);
    const page = (await call(admin, 'get', '/api/daily-exceptions').expect(200))
      .body as DailyExceptionPage;
    const today = istToday();
    const yesterday = addDays(today, -1);
    const monthStart = `${today.slice(0, 7)}-01`;
    const start = await db.query<{ v: string }>(
      `SELECT value #>> '{}' AS v FROM app_settings WHERE key = 'lapse.startDate'`,
    );
    const lapseStart = start.rows[0]?.v ?? '1900-01-01';
    const count = async (from: string, to: string): Promise<number> => {
      const r = await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM plants p
           JOIN generate_series($1::date, $2::date, interval '1 day') d(day)
             ON d.day >= p.start_date
          WHERE p.deleted_at IS NULL AND p.status = 'WORKING'
            AND NOT EXISTS (SELECT 1 FROM daily_exceptions x
                             WHERE x.plant_id = p.id AND x.report_date = d.day::date)`,
        [from > lapseStart ? from : lapseStart, to],
      );
      return r.rows[0]?.n ?? 0;
    };
    const m = Number(today.slice(5, 7));
    const fyStart = `${m >= 4 ? today.slice(0, 4) : String(Number(today.slice(0, 4)) - 1)}-04-01`;
    expect(page.lapse.today).toBe(await count(today, today));
    expect(page.lapse.month.days).toBe(
      monthStart > yesterday ? 0 : await count(monthStart, yesterday),
    );
    expect(page.lapse.fy.days).toBe(await count(fyStart, yesterday));
    expect(page.lapse.fy.label).toMatch(/^FY \d{4}-\d{2}$/);
  });

  it('Staff on Barhi sees only Barhi; another plant’s report answers 404', async () => {
    const gopal = await as(GOPAL);
    const page = (
      await call(gopal, 'get', '/api/daily-exceptions?from=2026-10-15&to=2026-10-16').expect(200)
    ).body as DailyExceptionPage;
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.plant.code === 'HPB-017')).toBe(true);
    const other = await db.query<{ id: string }>(
      `SELECT id FROM daily_exceptions WHERE plant_id = $1 LIMIT 1`,
      [yediyur],
    );
    await call(gopal, 'get', `/api/daily-exceptions/${other.rows[0]?.id ?? ''}`).expect(404);
    await call(gopal, 'get', `/api/daily-exceptions?plantId=${yediyur}`).expect(403);
    await save(gopal, {
      action: 'draft',
      plantId: barhi,
      reportDate: '2026-06-02',
      lines: {},
    }).expect(403);
  });
});

describe('save and submit (DEX-R2…R7, UXV-9, APPR-6)', () => {
  let id = '';
  let version = 0;

  it('Save draft → Partial; one report per plant and date', async () => {
    const asha = await as(ASHA);
    const r = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      reportDate: '2026-06-03',
      lines: { '1': { answer: 'NO' }, '2': { answer: 'YES', details: { remarks: 'Panel test' } } },
    }).expect(201);
    const d = r.body as DailyExceptionDetail;
    id = d.id;
    version = d.version;
    expect(d).toMatchObject({
      status: 'PARTIAL',
      plantStatus: null,
      problemHighlight: null,
      lines: { '1': { answer: 'NO', details: {} }, '13': { answer: null, details: {} } },
      can: { edit: true, upload: true },
    });
    const dup = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      reportDate: '2026-06-03',
      lines: {},
    }).expect(409);
    expect(dup.body.message).toBe(DAILY_EXCEPTION_MESSAGES.alreadyExists);
  });

  it('Submit needs the plant status, all 13 answers, and the fields a Yes opens', async () => {
    const asha = await as(ASHA);
    const bad = await save(
      asha,
      {
        action: 'submit',
        version,
        plantId: yediyur,
        reportDate: '2026-06-03',
        lines: lines({
          '3': { answer: 'YES', details: { jockeyPump1: 'AUTO' } },
          '9': { answer: null },
          '13': { answer: 'YES' },
        }),
      },
      id,
    ).expect(400);
    expect(bad.body.details).toEqual(
      expect.arrayContaining([
        { path: 'plantStatus', message: DAILY_EXCEPTION_MESSAGES.plantStatusRequired },
        { path: 'lines.9.answer', message: DAILY_EXCEPTION_MESSAGES.answerRequired },
        { path: 'lines.3.details.jockeyPump2', message: DAILY_EXCEPTION_MESSAGES.detailRequired },
        { path: 'lines.13.details.remarks', message: DAILY_EXCEPTION_MESSAGES.incidentRequired },
      ]),
    );
  });

  it('all No + Operational → Completed; the client cannot set status or highlight', async () => {
    const asha = await as(ASHA);
    const r = await save(
      asha,
      {
        action: 'submit',
        version,
        plantId: yediyur,
        reportDate: '2026-06-03',
        plantStatus: 'OPERATIONAL',
        status: 'PENDING',
        problemHighlight: 'forged',
        lines: lines({ '1': { answer: 'NO', details: { remarks: 'cleared on No' } } }),
      },
      id,
    ).expect(200);
    const d = r.body as DailyExceptionDetail;
    expect(d).toMatchObject({ status: 'COMPLETED', problemHighlight: null, version: version + 1 });
    expect(d.lines['1']).toEqual({ answer: 'NO', details: {} });
    version = d.version;
  });

  it('a Yes line makes it Pending with the highlight; edits are allowed (no Approve lock)', async () => {
    const asha = await as(ASHA);
    const r = await save(
      asha,
      {
        action: 'submit',
        version,
        plantId: yediyur,
        reportDate: '2026-06-03',
        plantStatus: 'OPERATIONAL',
        lines: lines({
          '4': {
            answer: 'YES',
            details: {
              tankCount: '1',
              tankCapacityKl: '450',
              tankHeightM: '12',
              tankDiameterM: '7',
              tank1LevelM: '9.5',
              tank2LevelM: '9',
              min4hRequirementKl: '400',
              pumpableWaterKl: '380',
            },
          },
          '6': { answer: 'YES', details: { remarks: 'ESD button 3 stuck' } },
        }),
      },
      id,
    ).expect(200);
    const d = r.body as DailyExceptionDetail;
    expect(d.status).toBe('PENDING');
    expect(d.problemHighlight).toMatch(/^Line 4 — Total number of tanks: 1; /);
    expect(d.lines['4']?.details).not.toHaveProperty('tank2LevelM');
    expect(d.lines['4']?.details).toMatchObject({ tank1LevelM: '9.50' });
    version = d.version;
    const stale = await save(
      asha,
      { action: 'draft', version: 1, plantId: yediyur, reportDate: '2026-06-03', lines: {} },
      id,
    ).expect(409);
    expect(stale.body.message).toBe(DAILY_EXCEPTION_MESSAGES.stale);
  });

  it('Non-operational with every line No is Pending (D-20); there is no approve route', async () => {
    const asha = await as(ASHA);
    const r = await save(asha, {
      action: 'submit',
      plantId: barhi,
      reportDate: '2026-06-04',
      plantStatus: 'NON_OPERATIONAL',
      lines: lines(),
    }).expect(201);
    expect(r.body).toMatchObject({ status: 'PENDING', problemHighlight: 'Plant non-operational' });
    const ravi = await as(RAVI);
    await call(ravi, 'post', `/api/daily-exceptions/${id}/approve`).send({ version }).expect(404);
  });

  it('refuses a future India date, and the database refuses a Completed non-operational row', async () => {
    const asha = await as(ASHA);
    const future = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      reportDate: addDays(istToday(), 1),
      lines: {},
    }).expect(400);
    expect(future.body.details).toEqual([
      { path: 'reportDate', message: FIELD_MESSAGES.dateFuture },
    ]);
    await expect(
      db.query(
        `UPDATE daily_exceptions SET status = 'COMPLETED', plant_status = 'NON_OPERATIONAL',
                problem_highlight = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/daily_exceptions_completed/);
  });

  it('SQC report upload: real PDF/JPG/PNG/XLSX only; download is an attachment; removal is audited', async () => {
    const asha = await as(ASHA);
    const fake = await call(asha, 'post', `/api/daily-exceptions/${id}/files`)
      .attach('file', Buffer.from('MZ this is a program'), 'sqc.pdf')
      .expect(415);
    expect(fake.body.message).toBe(DAILY_EXCEPTION_MESSAGES.fileType);
    await call(asha, 'post', `/api/daily-exceptions/${id}/files`)
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1, 0x25), 'big.pdf')
      .expect(413);
    const ok = await call(asha, 'post', `/api/daily-exceptions/${id}/files`)
      .attach('file', PDF, '..\\SQC "June".exe')
      .expect(201);
    const d = ok.body as DailyExceptionDetail;
    expect(d.attachments).toHaveLength(1);
    const file = d.attachments[0];
    expect(file).toMatchObject({
      fileName: 'SQC June.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      uploadedBy: { name: 'Asha Nair' },
    });

    // Download: anyone who may open the record (Asha has Submit, not Download).
    const dl = await call(asha, 'get', `/api/daily-exceptions/${id}/files/${file?.id ?? ''}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="SQC June.pdf"');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect((dl.body as Buffer).equals(PDF)).toBe(true);

    // Staff on another plant cannot reach it.
    const gopal = await as(GOPAL);
    await call(gopal, 'get', `/api/daily-exceptions/${id}/files/${file?.id ?? ''}`).expect(404);

    const removed = await call(
      asha,
      'delete',
      `/api/daily-exceptions/${id}/files/${file?.id ?? ''}`,
    ).expect(200);
    expect((removed.body as DailyExceptionDetail).attachments).toHaveLength(0);
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'attachment' AND entity_id = $1 ORDER BY id`,
      [file?.id ?? ''],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(['FILE_UPLOAD', 'FILE_DOWNLOAD', 'DELETE']);
  });
});

describe('lapse note (DEX-S7)', () => {
  it('a short note explains a missed day and shows on its Not initiated row', async () => {
    const asha = await as(ASHA);
    await call(asha, 'put', '/api/daily-exceptions/lapse-notes')
      .send({ plantId: yediyur, date: '2026-06-05', note: 'Plant shut for annual maintenance' })
      .expect(200);
    const page = (
      await call(
        asha,
        'get',
        `/api/daily-exceptions?plantId=${yediyur}&from=2026-06-05&to=2026-06-05`,
      ).expect(200)
    ).body as DailyExceptionPage;
    expect(page.rows[0]).toMatchObject({
      status: 'NOT_INITIATED',
      lapseNote: 'Plant shut for annual maintenance',
    });
    const taken = await call(asha, 'put', '/api/daily-exceptions/lapse-notes')
      .send({ plantId: yediyur, date: '2026-06-03', note: 'x' })
      .expect(409);
    expect(taken.body.message).toBe(DAILY_EXCEPTION_MESSAGES.noteNotMissed);
  });
});

describe('downloads (BTN-4, BEV-6)', () => {
  it('Excel rows and counts equal the list for the same filter', async () => {
    const admin = await as(ANITA);
    const filter = 'from=2026-10-15&to=2026-10-16';
    const page = (
      await call(admin, 'get', `/api/daily-exceptions?${filter}&pageSize=5`).expect(200)
    ).body as DailyExceptionPage;
    const res = await call(admin, 'get', `/api/daily-exceptions/export?${filter}&format=xlsx`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    const wb = new ExcelJS.Workbook();
    const body = res.body as Buffer;
    const ab = new ArrayBuffer(body.length);
    new Uint8Array(ab).set(body);
    await wb.xlsx.load(ab);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('no sheet');
    let totals = '';
    ws.eachRow((row) => {
      const first = row.getCell(1).value;
      const third = row.getCell(3).value;
      if (typeof first === 'string' && first.startsWith('Total (') && typeof third === 'string') {
        totals = `${first} ${third}`;
      }
    });
    const c = page.cards;
    expect(totals).toBe(
      `Total (${String(page.total)} rows) Completed ${String(c.completed)} · Submitted ${String(c.submitted)} · Pending ${String(c.pending)} · Partial ${String(c.partial)} · Not initiated ${String(c.notInitiated)}`,
    );
  });

  it('PDF of one report; downloads need the Download capability', async () => {
    const admin = await as(ANITA);
    const one = await db.query<{ id: string }>(
      `SELECT id FROM daily_exceptions WHERE status = 'PENDING' LIMIT 1`,
    );
    const rec = await call(admin, 'get', `/api/daily-exceptions/${one.rows[0]?.id ?? ''}/pdf`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((rec.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const asha = await as(ASHA);
    await call(asha, 'get', '/api/daily-exceptions/export?format=xlsx').expect(403);
  });
});
