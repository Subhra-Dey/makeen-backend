/**
 * The seeded demo world reproduces the approved mockup (OPS-3), for SEED_TODAY = 2026-10-16.
 */
import { Client } from 'pg';
import { cumulativeDailySummary } from '../src/shared';

let c: Client;

beforeAll(async () => {
  c = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await c.connect();
});
afterAll(async () => {
  await c.end();
});

const one = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T> => {
  const r = await c.query(sql, params);
  return r.rows[0] as T;
};
const n = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await one<{ n: string }>(sql, params)).n);

const TODAY = '2026-10-16';

describe('plants, roles and people', () => {
  it('loads 22 plants (21 Working, 1 New) with the mockup contracts and keys', async () => {
    expect(await n(`SELECT count(*) AS n FROM plants`)).toBe(22);
    expect(await n(`SELECT count(*) AS n FROM plants WHERE status = 'WORKING'`)).toBe(21);
    expect(
      await one(
        `SELECT plant_key, to_char(start_date,'DD-MM-YYYY') s, to_char(end_date,'DD-MM-YYYY') e FROM plants WHERE code='HPY-011'`,
      ),
    ).toEqual({ plant_key: 'PK-7F3A21', s: '01-04-2022', e: '31-03-2027' });
    // Plant master card: contracts ending in 90 days = IOCL Korba · HPCL Chandrapur
    const ending = await c.query<{ name: string }>(
      `SELECT name FROM plants WHERE end_date BETWEEN $1::date AND $1::date + 90 ORDER BY name`,
      [TODAY],
    );
    expect(ending.rows.map((r) => r.name)).toEqual(['HPCL Chandrapur', 'IOCL Korba']);
  });

  it('loads the 14 standard roles and the mockup people', async () => {
    expect(await n(`SELECT count(*) AS n FROM roles WHERE is_standard`)).toBe(14);
    expect(
      await one(`SELECT login_status, working_status FROM users WHERE employee_code='MEI-00611'`),
    ).toEqual({
      login_status: 'INACTIVE',
      working_status: 'RESIGNED',
    });
    // Unmapped designation (Trainee Engineer) has no role and no plant.
    expect(
      await n(
        `SELECT count(*) AS n FROM designation_role_map WHERE designation = (SELECT designation FROM users WHERE employee_code='MEI-01022')`,
      ),
    ).toBe(0);
    expect(await one(`SELECT aadhaar_last4 FROM users WHERE employee_code='MEI-00412'`)).toEqual({
      aadhaar_last4: '4821',
    });
  });

  it('never stores Aadhaar in clear text', async () => {
    const leaks = await n(
      `SELECT count(*) AS n FROM users WHERE position(convert_to(aadhaar_last4, 'UTF8') in aadhaar_enc) > 0 AND length(aadhaar_enc) < 12`,
    );
    expect(leaks).toBe(0);
    expect(
      await n(
        `SELECT count(*) AS n FROM users WHERE aadhaar_enc IS NOT NULL AND length(aadhaar_enc) = 12 + 16 + 12`,
      ),
    ).toBeGreaterThan(50);
  });
});

describe('Daily MIS (mockup counts)', () => {
  it('has 15 Pending and 3 Returned across all plants', async () => {
    expect(await n(`SELECT count(*) AS n FROM daily_mis WHERE status='PENDING'`)).toBe(15);
    expect(await n(`SELECT count(*) AS n FROM daily_mis WHERE status='RETURNED'`)).toBe(3);
  });

  it('Pending 2 for the HPCL Yediyur Plant Manager and 3 for Asha (Yediyur + Barhi) — spec example', async () => {
    const pendingFor = (code: string): Promise<number> =>
      n(
        `SELECT count(*) AS n FROM daily_mis d JOIN plant_assignments a ON a.plant_id = d.plant_id
           JOIN users u ON u.id = a.user_id WHERE u.employee_code = $1 AND d.status = 'PENDING'`,
        [code],
      );
    expect(await pendingFor('MEI-00218')).toBe(2);
    expect(await pendingFor('MEI-00733')).toBe(3);
  });

  it('contains the exact HPCL Yediyur 15-10-2026 record', async () => {
    expect(
      await one(
        `SELECT opening_stock::text o, bulk_receipts::text r, closing_book_stock::text c, physical_stock::text p,
                stock_gain_loss::text g, loss_mechanical_total m, mr_total t, d.status
           FROM daily_mis d JOIN plants p ON p.id = d.plant_id WHERE p.code='HPY-011' AND report_date='2026-10-15'`,
      ),
    ).toEqual({
      o: '412.380',
      r: '180.000',
      c: '368.550',
      p: '368.430',
      g: '-0.120',
      m: 50,
      t: 11,
      status: 'PENDING',
    });
  });

  it('keeps two Drafts for IOCL Nagpur 15-10 and no other row that day', async () => {
    const rows = await c.query<{ status: string }>(
      `SELECT d.status FROM daily_mis d JOIN plants p ON p.id=d.plant_id WHERE p.code='ION-028' AND report_date='2026-10-15'`,
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['DRAFT', 'DRAFT']);
  });

  it('has 4 working plants with neither a Daily MIS nor a Daily Exception today (D-18)', async () => {
    expect(
      await n(
        `SELECT count(*) AS n FROM plants p WHERE p.status='WORKING'
           AND NOT EXISTS (SELECT 1 FROM daily_mis d WHERE d.plant_id=p.id AND d.report_date=$1)
           AND NOT EXISTS (SELECT 1 FROM daily_exceptions e WHERE e.plant_id=p.id AND e.report_date=$1)`,
        [TODAY],
      ),
    ).toBe(4);
  });
});

describe('Monthly MIS', () => {
  it('September: 3 Pending, 1 Returned; Yediyur October Draft', async () => {
    expect(
      await n(
        `SELECT count(*) AS n FROM monthly_mis WHERE month='2026-09-01' AND status='PENDING'`,
      ),
    ).toBe(3);
    expect(
      await n(
        `SELECT count(*) AS n FROM monthly_mis WHERE month='2026-09-01' AND status='RETURNED'`,
      ),
    ).toBe(1);
    expect(
      await one(
        `SELECT m.status FROM monthly_mis m JOIN plants p ON p.id=m.plant_id WHERE p.code='HPY-011' AND month='2026-10-01'`,
      ),
    ).toEqual({ status: 'DRAFT' });
  });

  it('HPCL Yediyur September Cumulative Daily Summary equals the mockup (30 of 30 days)', async () => {
    const rows = await c.query(
      `SELECT d.* FROM daily_mis d JOIN plants p ON p.id=d.plant_id
         WHERE p.code='HPY-011' AND d.status='APPROVED' AND report_date BETWEEN '2026-09-01' AND '2026-09-30'`,
    );
    expect(rows.rowCount).toBe(30);
    const camel = (k: string): string =>
      k.replace(/_([a-z0-9])/g, (_, x: string) => x.toUpperCase());
    const daily = rows.rows.map((r: Record<string, unknown>) =>
      Object.fromEntries(
        // pg returns numeric/date columns as strings or Date — only numbers matter here.
        Object.entries(r).map(([k, v]) => [
          camel(k),
          typeof v === 'string' || typeof v === 'number' ? String(v) : null,
        ]),
      ),
    );
    expect(cumulativeDailySummary(daily)).toEqual({
      normalProduction: '6312.600',
      normalCylinderDespatch: '5952.600',
      normalTtLoading: '360.000',
      otProduction: '427.800',
      otCylinderDespatch: '427.800',
      otTtLoading: '0.000',
      totalProduction: '6740.400',
      totalCylinderDespatch: '6380.400',
      totalTtLoading: '360.000',
      totalShifts: '60',
      totalOtHours: '96.00',
      cumulativeReceipts: '5400.000',
      despatchBottling: '6380.400',
      despatchTtLoading: '360.000',
      stockGainLoss: '-2.840',
      lossMechanical: '1320',
      lossElectrical: '945',
      lossIndentTruck: '120',
      lossMisc: '540',
      accuracyZeroAvg: '61.80',
      accuracy50Avg: '35.10',
      accuracy100Avg: '2.70',
      eldAvg: '99.80',
      oldAvg: '99.60',
      marketReturns: '318',
    });
  });
});

describe('exceptions, licences, audits, notifications', () => {
  it('has 7 open exceptions: 5 Pending + 2 Partial', async () => {
    expect(await n(`SELECT count(*) AS n FROM daily_exceptions WHERE status='PENDING'`)).toBe(5);
    expect(await n(`SELECT count(*) AS n FROM daily_exceptions WHERE status='PARTIAL'`)).toBe(2);
    expect(
      await one(
        `SELECT problem_highlight FROM daily_exceptions e JOIN plants p ON p.id=e.plant_id WHERE p.code='IOW-025' AND report_date=$1`,
        [TODAY],
      ),
    ).toEqual({
      problem_highlight: 'Jockey pump no. 2 on manual — auto controller fault reported',
    });
  });

  it('has 9 licences due: 6 Due + 3 Expired (status rule LIC-S1)', async () => {
    const status = `CASE WHEN frequency='NA' THEN 'NA' WHEN start_date IS NULL THEN 'NOT_YET'
                         WHEN end_date < $1::date THEN 'EXPIRED'
                         WHEN $1::date >= end_date - remind_before_days THEN 'DUE' ELSE 'ACTIVE' END`;
    const counts = await c.query<{ s: string; n: string }>(
      `SELECT ${status} s, count(*) n FROM licences GROUP BY 1`,
      [TODAY],
    );
    const by = Object.fromEntries(counts.rows.map((r) => [r.s, Number(r.n)]));
    expect(by['DUE']).toBe(6);
    expect(by['EXPIRED']).toBe(3);
    expect(by['NA']).toBeGreaterThan(0);
    expect(by['NOT_YET']).toBeGreaterThan(0);
  });

  it('has 64 audit observations: 41 Complied, 17 Pending, 6 Overdue', async () => {
    const eff = `COALESCE(revised_target_date, target_date)`;
    expect(await n(`SELECT count(*) AS n FROM audit_observations`)).toBe(64);
    expect(await n(`SELECT count(*) AS n FROM audit_observations WHERE status='COMPLIED'`)).toBe(
      41,
    );
    expect(
      await n(
        `SELECT count(*) AS n FROM audit_observations WHERE status='PENDING' AND ${eff} >= $1::date`,
        [TODAY],
      ),
    ).toBe(17);
    expect(
      await n(
        `SELECT count(*) AS n FROM audit_observations WHERE status='PENDING' AND ${eff} < $1::date`,
        [TODAY],
      ),
    ).toBe(6);
  });

  it('gives Anita the mockup inbox: 48 all, 12 unread, 7 to acknowledge, 2 awaiting reply', async () => {
    const base = `FROM notification_recipients r JOIN notifications n ON n.id=r.notification_id
                  JOIN users u ON u.id=r.user_id WHERE u.employee_code='MEI-00412'`;
    expect(await n(`SELECT count(*) AS n ${base}`)).toBe(48);
    expect(await n(`SELECT count(*) AS n ${base} AND r.read_at IS NULL`)).toBe(12);
    expect(
      await n(`SELECT count(*) AS n ${base} AND n.can_acknowledge AND r.acknowledged_at IS NULL`),
    ).toBe(7);
    expect(await n(`SELECT count(*) AS n ${base} AND n.can_reply AND r.reply IS NULL`)).toBe(2);
  });
});
