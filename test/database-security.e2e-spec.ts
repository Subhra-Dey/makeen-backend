/**
 * Database-level guarantees, proven against real PostgreSQL:
 * append-only audit log (SEC-20), one non-Draft Daily MIS per plant+date (BEV-3), one Monthly
 * row per plant+month (BEV-4), system-sum CHECKs (D-13), and row-level plant isolation (SEC-10).
 * Every test runs inside a transaction that is rolled back, so the seeded data stays intact.
 */
import { Client } from 'pg';

const ownerUrl = (): string => process.env['E2E_OWNER_URL'] ?? '';
const appUrl = (): string => process.env['E2E_APP_URL'] ?? '';

async function inRollback<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

async function expectSqlError(
  c: Client,
  sql: string,
  params: unknown[],
  pattern: RegExp,
): Promise<void> {
  await c.query('SAVEPOINT s');
  await expect(c.query(sql, params)).rejects.toThrow(pattern);
  await c.query('ROLLBACK TO SAVEPOINT s');
}

async function asUser(c: Client, userId: string | null, isAdmin = false): Promise<void> {
  await c.query(
    `SELECT set_config('app.user_id', $1, true), set_config('app.is_admin', $2, true)`,
    [userId ?? '', isAdmin ? 'true' : 'false'],
  );
}

async function idOf(c: Client, sql: string, params: unknown[] = []): Promise<string> {
  const r = await c.query<{ id: string }>(sql, params);
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`No row for ${sql}`);
  return id;
}

describe('audit_log is append-only (SEC-20)', () => {
  it('lets the runtime role insert and read, but never update or delete', async () => {
    await inRollback(appUrl(), async (c) => {
      await c.query(`INSERT INTO audit_log (action, entity) VALUES ('TEST', 'e2e')`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'e2e'`,
      );
      expect(rows[0].n).toBe(1);
      await expectSqlError(
        c,
        `UPDATE audit_log SET reason = 'x' WHERE entity = 'e2e'`,
        [],
        /permission denied/,
      );
      await expectSqlError(
        c,
        `DELETE FROM audit_log WHERE entity = 'e2e'`,
        [],
        /permission denied/,
      );
    });
  });

  it('blocks UPDATE, DELETE and TRUNCATE even for the schema owner (trigger)', async () => {
    await inRollback(ownerUrl(), async (c) => {
      await c.query(`INSERT INTO audit_log (action, entity) VALUES ('TEST', 'e2e')`);
      await expectSqlError(c, `UPDATE audit_log SET reason = 'x'`, [], /append-only/);
      await expectSqlError(c, `DELETE FROM audit_log`, [], /append-only/);
      await expectSqlError(c, `TRUNCATE audit_log`, [], /append-only/);
    });
  });
});

describe('Daily / Monthly uniqueness (BEV-3, BEV-4)', () => {
  it('allows extra Drafts but only ONE non-Draft row per plant + date', async () => {
    await inRollback(ownerUrl(), async (c) => {
      const plant = await idOf(c, `SELECT id FROM plants WHERE code = 'HPY-011'`);
      const user = await idOf(c, `SELECT id FROM users WHERE employee_code = 'MEI-00733'`);
      const insert = `INSERT INTO daily_mis (id, plant_id, report_date, status, entered_by_id, updated_at)
                      VALUES (gen_random_uuid(), $1, '2026-01-05', $2, $3, now())`;
      await c.query(insert, [plant, 'DRAFT', user]);
      await c.query(insert, [plant, 'DRAFT', user]);
      await c.query(insert, [plant, 'PENDING', user]);
      await expectSqlError(
        c,
        insert,
        [plant, 'PENDING', user],
        /daily_mis_one_non_draft_per_plant_date/,
      );
      await expectSqlError(
        c,
        insert,
        [plant, 'APPROVED', user],
        /daily_mis_one_non_draft_per_plant_date|daily_mis_approved_stamp/,
      );
    });
  });

  it('allows only one Monthly MIS per plant + month, and only on the 1st', async () => {
    await inRollback(ownerUrl(), async (c) => {
      const plant = await idOf(c, `SELECT id FROM plants WHERE code = 'HPY-011'`);
      const user = await idOf(c, `SELECT id FROM users WHERE employee_code = 'MEI-00733'`);
      const insert = `INSERT INTO monthly_mis (id, plant_id, month, entered_by_id, updated_at)
                      VALUES (gen_random_uuid(), $1, $2, $3, now())`;
      await expectSqlError(
        c,
        insert,
        [plant, '2026-09-01', user],
        /monthly_mis_plant_id_month_key|unique/i,
      );
      await expectSqlError(c, insert, [plant, '2026-03-15', user], /monthly_mis_first_of_month/);
    });
  });
});

describe('system sums are enforced by the database (D-13, DMIS-R5)', () => {
  it('rejects a typed total or a wrong closing stock', async () => {
    await inRollback(ownerUrl(), async (c) => {
      const plant = await idOf(c, `SELECT id FROM plants WHERE code = 'HPY-011'`);
      const user = await idOf(c, `SELECT id FROM users WHERE employee_code = 'MEI-00733'`);
      await expectSqlError(
        c,
        `INSERT INTO daily_mis (id, plant_id, report_date, entered_by_id, loss_carousel, loss_mechanical_total, updated_at)
         VALUES (gen_random_uuid(), $1, '2026-01-06', $2, 15, 999, now())`,
        [plant, user],
        /daily_mis_mechanical_total/,
      );
      await expectSqlError(
        c,
        `INSERT INTO daily_mis (id, plant_id, report_date, entered_by_id, opening_stock, bulk_receipts, closing_book_stock, updated_at)
         VALUES (gen_random_uuid(), $1, '2026-01-06', $2, 100, 50, 999, now())`,
        [plant, user],
        /daily_mis_closing_book_stock_formula/,
      );
      // The mockup record passes.
      const { rows } = await c.query(
        `SELECT closing_book_stock::text AS c, stock_gain_loss::text AS g FROM daily_mis d
           JOIN plants p ON p.id = d.plant_id WHERE p.code = 'HPY-011' AND report_date = '2026-10-15'`,
      );
      expect(rows[0]).toEqual({ c: '368.550', g: '-0.120' });
    });
  });

  it('rejects a Return without a reason and a plant end date that is not contract + period − 1 day', async () => {
    await inRollback(ownerUrl(), async (c) => {
      await expectSqlError(
        c,
        `UPDATE daily_mis SET status = 'RETURNED', return_reason = '  ' WHERE id = (SELECT id FROM daily_mis WHERE status = 'PENDING' LIMIT 1)`,
        [],
        /daily_mis_return_reason/,
      );
      await expectSqlError(
        c,
        `UPDATE plants SET end_date = '2027-04-01' WHERE code = 'HPY-011'`,
        [],
        /plants_end_date_formula/,
      );
    });
  });
});

describe('row-level security isolates plants (SEC-10)', () => {
  let ravi: string;
  let asha: string;
  let anita: string;
  let gwalior: string;

  beforeAll(async () => {
    await inRollback(ownerUrl(), async (c) => {
      ravi = await idOf(c, `SELECT id FROM users WHERE employee_code = 'MEI-00218'`);
      asha = await idOf(c, `SELECT id FROM users WHERE employee_code = 'MEI-00733'`);
      anita = await idOf(c, `SELECT id FROM users WHERE employee_code = 'MEI-00412'`);
      gwalior = await idOf(c, `SELECT id FROM plants WHERE code = 'IOW-025'`);
    });
  });

  it('shows nothing when no user is set (deny by default)', async () => {
    await inRollback(appUrl(), async (c) => {
      await asUser(c, null);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM daily_mis`);
      expect(rows[0].n).toBe(0);
      const plants = await c.query(`SELECT count(*)::int AS n FROM plants`);
      expect(plants.rows[0].n).toBe(0);
    });
  });

  it('shows a user only the plants assigned to them', async () => {
    await inRollback(appUrl(), async (c) => {
      await asUser(c, ravi);
      const raviPlants = await c.query<{ code: string }>(
        `SELECT DISTINCT p.code FROM daily_mis d JOIN plants p ON p.id = d.plant_id`,
      );
      expect(raviPlants.rows.map((r) => r.code)).toEqual(['HPY-011']);
      await asUser(c, asha);
      const ashaPlants = await c.query<{ code: string }>(`SELECT code FROM plants ORDER BY code`);
      expect(ashaPlants.rows.map((r) => r.code)).toEqual(['HPB-017', 'HPY-011']);
      // Children follow their parent: exception lines of other plants are invisible too.
      const foreign = await c.query(
        `SELECT count(*)::int AS n FROM daily_exception_lines l
           WHERE NOT EXISTS (SELECT 1 FROM daily_exceptions e WHERE e.id = l.exception_id)`,
      );
      expect(foreign.rows[0].n).toBe(0);
    });
  });

  it('refuses writes to an unassigned plant, even with a forged plant_id', async () => {
    await inRollback(appUrl(), async (c) => {
      await asUser(c, ravi);
      await expectSqlError(
        c,
        `INSERT INTO daily_mis (id, plant_id, report_date, entered_by_id, updated_at)
         VALUES (gen_random_uuid(), $1, '2026-01-07', $2, now())`,
        [gwalior, ravi],
        /row-level security/,
      );
      const upd = await c.query(`UPDATE daily_mis SET remarks = 'x' WHERE plant_id = $1`, [
        gwalior,
      ]);
      expect(upd.rowCount).toBe(0);
    });
  });

  it('lets Admin see every plant', async () => {
    await inRollback(appUrl(), async (c) => {
      await asUser(c, anita, true);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM plants`);
      expect(rows[0].n).toBe(22);
    });
  });
});
