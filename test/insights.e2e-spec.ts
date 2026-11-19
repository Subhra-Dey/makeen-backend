/**
 * Phase 11 suite: Dashboard, Management Review, Graphs and the command palette, end to end
 * against real PostgreSQL. Numbers are checked against SQL over the seeded rows (and the same
 * shared rules); access is checked per role. Read only, except the GR-4 setting (restored).
 */
import { Client } from 'pg';
import type { Response } from 'supertest';
import { hashPassword } from '../src/common/crypto/password';
import {
  INSIGHT_MESSAGES,
  addDays,
  istToday,
  licenceStatus,
  observationUrgency,
  sumDecimals,
  type Comparison,
  type DashboardView,
  type GraphsView,
  type PlantPerformance,
  type RenewalFrequency,
  type ReviewPack,
  type SearchHit,
} from '../src/shared';
import { createE2EApp, type E2EApp } from './support/e2e-app';
import { call, ipFactory, signIn, type Browser } from './support/http';

const PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? '';
const ANITA = 'anita.sharma@makeenenergy.com'; // Admin
const RAVI = 'ravi.kumar@makeenenergy.com'; // Plant Manager, Yediyur
const ASHA = 'asha.nair@makeenenergy.com'; // Maintenance Officer, Yediyur + Barhi
const GOPAL = 'gopal.das@makeenenergy.com'; // Staff, Barhi
const MEERA = 'meera.iyer@makeenenergy.com'; // Zonal Manager, South
const PEOPLE = [ANITA, RAVI, ASHA, GOPAL, MEERA];

/** The seed's authored day (SEED_TODAY) and the day before it. */
const SEED_DAY = '2026-10-16';
const PACK_DAY = '2026-10-15';

let e: E2EApp;
let db: Client;
const ip = ipFactory(61);
const plant: Record<string, string> = {};

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

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: number }>(sql, params);
  return r.rows[0]?.n ?? 0;
}

async function plantsOf(email: string): Promise<string[]> {
  const r = await db.query<{ plant_id: string }>(
    `SELECT a.plant_id FROM plant_assignments a JOIN users u ON u.id = a.user_id WHERE u.email = $1`,
    [email],
  );
  return r.rows.map((x) => x.plant_id);
}

beforeAll(async () => {
  e = await createE2EApp();
  db = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await db.connect();
  const hash = await hashPassword(PASSWORD, process.env['PASSWORD_PEPPER'] ?? '');
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false, login_status = 'ACTIVE'
      WHERE email = ANY($2)`,
    [hash, PEOPLE],
  );
  const p = await db.query<{ id: string; code: string }>(`SELECT id, code FROM plants`);
  for (const r of p.rows) plant[r.code] = r.id;
  await e.flushRedis();
});

afterAll(async () => {
  await db.query(`DELETE FROM app_settings WHERE key = 'graphs.manHour'`);
  await db.end();
  await e.close();
});

describe('Dashboard (DASH-1…9, CARD-0/1, BTN-D1…D4)', () => {
  it('Admin: cards equal the saved rows, everything still waiting', async () => {
    const admin = await as(ANITA);
    const v = (await call(admin, 'get', '/api/dashboard').expect(200)).body as DashboardView;
    const live = `JOIN plants p ON p.id = x.plant_id AND p.deleted_at IS NULL`;
    expect(v.cards.waiting).toEqual({
      daily: await count(
        `SELECT count(*)::int n FROM daily_mis x ${live} WHERE x.status = 'PENDING'`,
      ),
      monthly: await count(
        `SELECT count(*)::int n FROM monthly_mis x ${live} WHERE x.status = 'PENDING'`,
      ),
    });
    // The seed follows the mockup dashboard (D-57): Daily 15 + Monthly 3, Pending 5 + Partial 2.
    expect(v.cards.waiting).toEqual({ daily: 15, monthly: 3 });
    expect(v.cards.openExceptions).toEqual({ pending: 5, partial: 2 });

    const lic = await db.query<{
      frequency: RenewalFrequency;
      start_date: string | null;
      end_date: string | null;
      remind_before_days: number;
    }>(
      `SELECT l.frequency, l.start_date::text, l.end_date::text, l.remind_before_days
         FROM licences l JOIN plants p ON p.id = l.plant_id WHERE p.deleted_at IS NULL`,
    );
    const statuses = lic.rows.map((r) =>
      licenceStatus(
        {
          frequency: r.frequency,
          startDate: r.start_date,
          endDate: r.end_date,
          remindBeforeDays: r.remind_before_days,
        },
        istToday(),
      ),
    );
    expect(v.cards.licences).toEqual({
      due: statuses.filter((s) => s === 'DUE').length,
      expired: statuses.filter((s) => s === 'EXPIRED').length,
    });
    expect(v.cards.auditOverdue).toBeNull();
    expect(v.cards.notInitiatedDate).toBe(istToday());

    // Pending table: oldest first, Approve / Return for Admin.
    expect(v.pending?.length).toBe(18);
    const hours = (v.pending ?? []).map((r) => r.waitingHours);
    expect([...hours].sort((a, b) => b - a)).toEqual(hours);
    expect(v.pending?.every((r) => r.can.approve && r.can.return)).toBe(true);
    expect(v.openExceptions?.map((r) => r.status).filter((s) => s === 'PARTIAL')).toHaveLength(2);
  });

  it('Reports not initiated on the seed day = 4 plants with neither report (D-18)', async () => {
    const admin = await as(ANITA);
    const v = (await call(admin, 'get', `/api/dashboard?date=${SEED_DAY}`).expect(200))
      .body as DashboardView;
    const sql = await count(
      `SELECT count(*)::int n FROM plants p
        WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND p.start_date <= $1::date
          AND NOT EXISTS (SELECT 1 FROM daily_mis m WHERE m.plant_id = p.id AND m.report_date = $1::date)
          AND NOT EXISTS (SELECT 1 FROM daily_exceptions x WHERE x.plant_id = p.id AND x.report_date = $1::date)`,
      [SEED_DAY],
    );
    expect(v.cards.notInitiated).toBe(sql);
    expect(v.cards.notInitiated).toBe(4);
    expect(v.cards.notInitiatedDate).toBe(SEED_DAY);
  });

  it('a date filters Daily rows to that day and Monthly rows to its month', async () => {
    const admin = await as(ANITA);
    const v = (await call(admin, 'get', `/api/dashboard?date=${PACK_DAY}`).expect(200))
      .body as DashboardView;
    for (const r of v.pending ?? [])
      expect(r.period).toBe(r.module === 'DAILY_MIS' ? PACK_DAY : '2026-10');
    expect(v.cards.waiting?.daily).toBe(
      await count(
        `SELECT count(*)::int n FROM daily_mis WHERE status = 'PENDING' AND report_date = $1`,
        [PACK_DAY],
      ),
    );
    for (const r of v.openExceptions ?? []) expect(r.reportDate).toBe(PACK_DAY);
  });

  it('Module filter shows only that module (Licences; Audit overdue)', async () => {
    const admin = await as(ANITA);
    const lic = (await call(admin, 'get', '/api/dashboard?module=LICENCES').expect(200))
      .body as DashboardView;
    expect(lic.cards.waiting).toBeNull();
    expect(lic.cards.openExceptions).toBeNull();
    expect(lic.cards.notInitiated).toBeNull();
    expect(lic.cards.licences).not.toBeNull();
    expect(lic.pending).toBeNull();
    expect(lic.openExceptions).toBeNull();

    const audit = (await call(admin, 'get', '/api/dashboard?module=AUDIT').expect(200))
      .body as DashboardView;
    const obs = await db.query<{ target: string | null; revised: string | null }>(
      `SELECT o.target_date::text AS target, o.revised_target_date::text AS revised
         FROM audit_observations o JOIN audits a ON a.id = o.audit_id
         JOIN plants p ON p.id = a.plant_id AND p.deleted_at IS NULL
        WHERE o.status = 'PENDING'`,
    );
    expect(audit.cards.auditOverdue).toBe(
      obs.rows.filter(
        (o) =>
          observationUrgency(
            { status: 'PENDING', targetDate: o.target, revisedTargetDate: o.revised },
            istToday(),
          ) === 'OVERDUE',
      ).length,
    );
    expect(audit.cards.licences).toBeNull();
  });

  it('Plant Manager: own plant only, with Approve / Return; entry role without them', async () => {
    const ravi = await as(RAVI);
    const v = (await call(ravi, 'get', '/api/dashboard').expect(200)).body as DashboardView;
    expect(v.cards.waiting?.daily).toBe(2);
    expect(v.pending?.every((r) => r.plant.code === 'HPY-011')).toBe(true);
    expect(v.pending?.every((r) => r.can.approve && r.can.return)).toBe(true);

    const asha = await as(ASHA);
    const a = (await call(asha, 'get', '/api/dashboard').expect(200)).body as DashboardView;
    expect(a.cards.waiting?.daily).toBe(3);
    expect(a.pending?.every((r) => !r.can.approve && !r.can.return)).toBe(true);
    const mine = new Set(await plantsOf(ASHA));
    expect(a.pending?.every((r) => mine.has(r.plant.id))).toBe(true);
  });

  it('a plant the login is not assigned to is refused; a future date is refused', async () => {
    const ravi = await as(RAVI);
    await call(ravi, 'get', `/api/dashboard?plantId=${plant['HPB-017'] ?? ''}`).expect(403);
    const res = await call(ravi, 'get', '/api/dashboard?date=2999-01-01').expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    await call(ravi, 'get', `/api/dashboard?date=${PACK_DAY}&month=2026-09`).expect(400);
  });

  it('WF-2: Return from a Dashboard row without a reason is refused', async () => {
    const ravi = await as(RAVI);
    const v = (await call(ravi, 'get', '/api/dashboard?module=DAILY_MIS').expect(200))
      .body as DashboardView;
    const row = v.pending?.[0];
    expect(row).toBeDefined();
    const res = await call(ravi, 'post', `/api/daily-mis/${row?.id ?? ''}/return`)
      .send({ version: row?.version, reason: '' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(
      await count(`SELECT count(*)::int n FROM daily_mis WHERE id = $1 AND status = 'PENDING'`, [
        row?.id,
      ]),
    ).toBe(1);
  });

  it('Plant Performance: achieved = Approved Daily 11 + 13 in the range; totals add up', async () => {
    const admin = await as(ANITA);
    const p = (await call(admin, 'get', '/api/dashboard/performance?range=90D').expect(200))
      .body as PlantPerformance;
    expect(p.points).toHaveLength(13);
    const from = p.points[0]?.from ?? '';
    const to = p.points[12]?.to ?? '';
    expect(to).toBe(istToday());
    const sql = await db.query<{ mt: string }>(
      `SELECT COALESCE(sum(COALESCE(normal_cylinder_despatch,0) + COALESCE(ot_cylinder_despatch,0)), 0)::numeric(14,3)::text AS mt
         FROM daily_mis m JOIN plants p ON p.id = m.plant_id AND p.deleted_at IS NULL
        WHERE m.status = 'APPROVED' AND m.report_date BETWEEN $1 AND $2`,
      [from, to],
    );
    expect(p.totals.achieved).toBe(sql.rows[0]?.mt);
    expect(
      sumDecimals(
        p.points.map((x) => x.achieved),
        3,
      ),
    ).toBe(p.totals.achieved);
    expect(
      sumDecimals(
        p.points.map((x) => x.target),
        3,
      ),
    ).toBe(p.totals.target);
    expect(Number(p.totals.target)).toBeGreaterThan(0);
    const week = (await call(admin, 'get', '/api/dashboard/performance?range=7D').expect(200))
      .body as PlantPerformance;
    expect(week.points.map((x) => x.from)).toEqual(
      Array.from({ length: 7 }, (_, i) => addDays(istToday(), i - 6)),
    );
  });

  it('Download: Excel for Admin; Staff (Search only) may not download', async () => {
    const admin = await as(ANITA);
    const res = await call(admin, 'get', '/api/dashboard/export?format=xlsx')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(String(res.headers['content-type'])).toContain('spreadsheetml');
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const gopal = await as(GOPAL);
    await call(gopal, 'get', '/api/dashboard').expect(200);
    await call(gopal, 'get', '/api/dashboard/export?format=pdf').expect(403);
  });
});

describe('Management Review (MR-1…12, CARD-5)', () => {
  it('Hidden for entry roles and Plant Managers (ROLE-D7)', async () => {
    const asha = await as(ASHA);
    await call(asha, 'get', '/api/management-review').expect(403);
    const ravi = await as(RAVI);
    await call(ravi, 'get', '/api/management-review/comparison').expect(403);
  });

  it('day pack: filed counts, “report not submitted”, lapse and the cumulative summary', async () => {
    const admin = await as(ANITA);
    const p = (await call(admin, 'get', `/api/management-review?date=${PACK_DAY}`).expect(200))
      .body as ReviewPack;
    expect(p.kind).toBe('DAY');
    expect(p.period).toBe(PACK_DAY);
    const working = await count(
      `SELECT count(*)::int n FROM plants WHERE deleted_at IS NULL AND status = 'WORKING' AND start_date <= $1`,
      [PACK_DAY],
    );
    expect(p.cards.total).toBe(working);
    expect(p.rows).toHaveLength(working);
    expect(p.cards.filed).toBe(
      await count(
        `SELECT count(*)::int n FROM daily_mis m JOIN plants p ON p.id = m.plant_id
          WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND m.report_date = $1 AND m.status <> 'DRAFT'`,
        [PACK_DAY],
      ),
    );
    expect(p.cards.notFiled).toBe(p.cards.total - p.cards.filed);
    const missing = p.rows.filter((r) => r.exception.status === 'NOT_INITIATED');
    for (const r of missing) {
      expect(r.exception.text).toBe('report not submitted');
      expect(r.lapse.day).toBe(1);
      expect(r.lapse.month).toBeGreaterThanOrEqual(1);
      expect(r.lapse.year).toBeGreaterThanOrEqual(r.lapse.month);
    }
    expect(
      p.rows.filter((r) => r.exception.status === 'COMPLETED').every((r) => r.lapse.day === 0),
    ).toBe(true);
    const yediyur = p.rows.find((r) => r.plant.code === 'HPY-011');
    expect(yediyur?.daily).not.toBeNull();

    // MR-7: Cumulative Daily Summary from the 1st up to the pack day, all plants shown.
    expect(p.summary.from).toBe('2026-10-01');
    expect(p.summary.to).toBe(PACK_DAY);
    const s = await db.query<{ n: number; bottling: string }>(
      `SELECT count(*)::int n,
              COALESCE(sum(COALESCE(normal_cylinder_despatch,0) + COALESCE(ot_cylinder_despatch,0)),0)::numeric(14,3)::text AS bottling
         FROM daily_mis m JOIN plants p ON p.id = m.plant_id
        WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND m.status = 'APPROVED'
          AND m.report_date BETWEEN '2026-10-01' AND $1`,
      [PACK_DAY],
    );
    expect(p.summary.approvedDays).toBe(s.rows[0]?.n);
    expect(p.summary.items.despatchBottling).toBe(s.rows[0]?.bottling);
  });

  it('month pack: Monthly MIS status and highlight per plant', async () => {
    const admin = await as(ANITA);
    const p = (await call(admin, 'get', '/api/management-review?month=2026-09').expect(200))
      .body as ReviewPack;
    expect(p.kind).toBe('MONTH');
    expect(p.cards.filed).toBe(
      await count(
        `SELECT count(*)::int n FROM monthly_mis m JOIN plants p ON p.id = m.plant_id
          WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND p.start_date <= '2026-09-30'
            AND m.month = '2026-09-01' AND m.status <> 'DRAFT'`,
      ),
    );
    const korba = p.rows.find((r) => r.plant.code === 'IOK-021');
    expect(korba?.status).toBe('PENDING');
    const row = await db.query<{ eb: string | null; dg: string | null }>(
      `SELECT eb_units::text AS eb, dg_units::text AS dg FROM monthly_mis
        WHERE plant_id = $1 AND month = '2026-09-01'`,
      [korba?.plant.id],
    );
    expect(korba?.monthly?.electricity).toBe(
      sumDecimals([row.rows[0]?.eb ?? null, row.rows[0]?.dg ?? null], 2),
    );
    expect(p.summary.to).toBe('2026-09-30');
  });

  it('a Zonal Manager sees only the plants assigned to them; may download', async () => {
    const meera = await as(MEERA);
    const p = (await call(meera, 'get', `/api/management-review?date=${PACK_DAY}`).expect(200))
      .body as ReviewPack;
    const mine = new Set(await plantsOf(MEERA));
    expect(p.rows.length).toBeGreaterThan(0);
    expect(p.rows.every((r) => mine.has(r.plant.id))).toBe(true);
    const res = await call(
      meera,
      'get',
      `/api/management-review/export?date=${PACK_DAY}&format=pdf`,
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('Plant Comparison: across plants, and dates on one plant (≤ 31 days)', async () => {
    const admin = await as(ANITA);
    const across = (
      await call(admin, 'get', `/api/management-review/comparison?date=${PACK_DAY}`).expect(200)
    ).body as Comparison;
    expect(across.mode).toBe('PLANTS');
    expect(across.rows.map((r) => r.measure)).toEqual([
      'Stock gain / loss (MT)',
      'Sort-out ELD / OLD %',
      'Breakdown minutes',
      'Market returns',
      'Accuracy — 0 gms %',
      'Exception',
      'Lapse (month)',
    ]);
    expect(across.rows.every((r) => r.values.length === across.columns.length)).toBe(true);

    const yed = plant['HPY-011'] ?? '';
    const dates = (
      await call(
        admin,
        'get',
        `/api/management-review/comparison?mode=DATES&plantId=${yed}&from=2026-10-10&to=${PACK_DAY}`,
      ).expect(200)
    ).body as Comparison;
    expect(dates.columns.map((c) => c.key)).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    const res = await call(admin, 'get', '/api/management-review/comparison?mode=DATES').expect(
      400,
    );
    expect(JSON.stringify(res.body)).toContain(INSIGHT_MESSAGES.plantRequired);
  });

  it('Excel download of the pack (standard layout)', async () => {
    const admin = await as(ANITA);
    const res = await call(admin, 'get', '/api/management-review/export?month=2026-09&format=xlsx')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    await call(admin, 'get', '/api/management-review/export?format=xlsx&layout=fancy').expect(400);
  });
});

describe('Graphs (GR-0…GR-8, BTN-P9)', () => {
  it('eight charts from Approved rows only; tables repeat the chart numbers', async () => {
    const admin = await as(ANITA);
    const yed = plant['HPY-011'] ?? '';
    const v = (await call(admin, 'get', `/api/graphs?plantId=${yed}&month=2026-09`).expect(200))
      .body as GraphsView;
    expect(v.charts.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(v.months).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);

    const gr1 = v.charts[0];
    expect(gr1?.points).toHaveLength(30);
    const daily = await db.query<{ day: string; v: string | null }>(
      `SELECT report_date::text AS day, stock_gain_loss::text AS v FROM daily_mis
        WHERE plant_id = $1 AND status = 'APPROVED' AND report_date BETWEEN '2026-09-01' AND '2026-09-30'`,
      [yed],
    );
    const byDay = new Map(daily.rows.map((r) => [r.day, r.v]));
    gr1?.points.forEach((pt, i) => {
      const day = `2026-09-${String(i + 1).padStart(2, '0')}`;
      expect(pt.values['gainLoss'] ?? null).toBe(byDay.get(day) ?? null);
      expect(gr1.table.rows[i]?.[1] ?? null).toBe(pt.values['gainLoss'] ?? null);
    });

    // GR-2: Approved Monthly MIS only (Yediyur September is Pending → no value).
    const gr2 = v.charts[1];
    const monthly = await db.query<{ month: string; dg: string | null; status: string }>(
      `SELECT to_char(month, 'YYYY-MM') AS month, diesel_dg::text AS dg, status::text
         FROM monthly_mis WHERE plant_id = $1`,
      [yed],
    );
    v.months.forEach((m, i) => {
      const row = monthly.rows.find((r) => r.month === m && r.status === 'APPROVED');
      expect(gr2?.points[i]?.values['dg'] ?? null).toBe(row?.dg ?? null);
    });
    expect(monthly.rows.find((r) => r.month === '2026-09')?.status).toBe('PENDING');

    expect(v.manHour).toEqual({ enabled: false, hoursPerShift: null });
    expect(v.charts[3]?.series.map((s) => s.key)).toEqual(['production', 'otHours']);
  });

  it('GR-4 switch: Admin only, needs hours per shift; adds the MT per man hour line', async () => {
    const ravi = await as(RAVI);
    await call(ravi, 'put', '/api/graphs/settings')
      .send({ enabled: true, hoursPerShift: 8 })
      .expect(403);
    const admin = await as(ANITA);
    const bad = await call(admin, 'put', '/api/graphs/settings')
      .send({ enabled: true, hoursPerShift: null })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain(INSIGHT_MESSAGES.hoursRequired);
    await call(admin, 'put', '/api/graphs/settings')
      .send({ enabled: true, hoursPerShift: 8 })
      .expect(200);
    const yed = plant['HPY-011'] ?? '';
    const v = (await call(admin, 'get', `/api/graphs?plantId=${yed}&month=2026-09`).expect(200))
      .body as GraphsView;
    const gr4 = v.charts[3];
    expect(gr4?.series.map((s) => s.key)).toEqual(['production', 'otHours', 'perManHour']);
    const sep = gr4?.points[5]?.values;
    const shifts = await count(
      `SELECT COALESCE(sum(shifts_operated),0)::int n FROM daily_mis
        WHERE plant_id = $1 AND status = 'APPROVED' AND report_date BETWEEN '2026-09-01' AND '2026-09-30'`,
      [yed],
    );
    expect(shifts).toBeGreaterThan(0);
    // Exact decimal arithmetic in Postgres (never JS floats): production MT ÷ (shifts × 8).
    const exact = await db.query<{ v: string }>(
      `SELECT round($1::numeric / ($2::numeric * 8), 3)::text AS v`,
      [sep?.['production'], shifts],
    );
    expect(sep?.['perManHour']).toBe(exact.rows[0]?.v);
    await call(admin, 'put', '/api/graphs/settings')
      .send({ enabled: false, hoursPerShift: null })
      .expect(200);
  });

  it('needs a plant the login may see; PDF download', async () => {
    const admin = await as(ANITA);
    const res = await call(admin, 'get', '/api/graphs').expect(400);
    expect(JSON.stringify(res.body)).toContain(INSIGHT_MESSAGES.plantRequired);
    const ravi = await as(RAVI);
    await call(ravi, 'get', `/api/graphs?plantId=${plant['HPB-017'] ?? ''}`).expect(403);
    const pdf = await call(
      admin,
      'get',
      `/api/graphs/export?plantId=${plant['HPY-011'] ?? ''}&month=2026-09&format=pdf`,
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('Command palette search', () => {
  it('finds plants, dated reports and exceptions within the login’s plants', async () => {
    const admin = await as(ANITA);
    const hits = (await call(admin, 'get', '/api/search?q=Yediyur').expect(200))
      .body as SearchHit[];
    expect(hits.find((h) => h.kind === 'PLANT')?.href).toBe(
      `/plant-master/${plant['HPY-011'] ?? ''}`,
    );
    const dated = (await call(admin, 'get', `/api/search?q=16-10-2026`).expect(200))
      .body as SearchHit[];
    expect(dated.some((h) => h.kind === 'DAILY_MIS' || h.kind === 'EXCEPTION')).toBe(true);
    expect(dated.every((h) => h.title.endsWith('16-10-2026'))).toBe(true);

    const asha = await as(ASHA);
    const none = (await call(asha, 'get', '/api/search?q=Bokaro').expect(200)).body as SearchHit[];
    expect(none.filter((h) => h.kind === 'PLANT')).toEqual([]);
    await call(asha, 'get', '/api/search?q=a').expect(400);
  });
});
