import { Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../prisma/prisma.service';
import { istToday } from '../../shared';

/** Go-live date for Lapse (app setting `lapse.startDate`, D-21); null = each plant's start. */
export async function lapseStartDate(tx: Tx): Promise<string | null> {
  const s = await tx.appSetting.findUnique({ where: { key: 'lapse.startDate' } });
  return typeof s?.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.value) ? s.value : null;
}

/**
 * Lapse days per plant (DEX-S6, D-21, D-100): Daily Exception plant-days with no report, for
 * WORKING plants from their start date (never stopped by the contract end date), from `from`
 * (no earlier than the Lapse go-live date) to `to` (no later than today, India time).
 * `plantIds` null = every plant row-level security lets the caller see.
 */
export async function lapseDaysByPlant(
  tx: Tx,
  plantIds: readonly string[] | null,
  from: string,
  to: string,
  start: string | null,
): Promise<Map<string, number>> {
  const today = istToday();
  const end = to < today ? to : today;
  const begin = start && start > from ? start : from;
  const out = new Map<string, number>();
  if (end < begin || (plantIds !== null && plantIds.length === 0)) return out;
  const ids = plantIds === null ? null : [...plantIds];
  const rows = await tx.$queryRaw<{ plant_id: string; n: number }[]>(Prisma.sql`
    SELECT p.id AS plant_id, count(*)::int AS n
      FROM plants p
      CROSS JOIN LATERAL generate_series(GREATEST(${begin}::date, p.start_date), ${end}::date,
                                         interval '1 day') AS d(day)
      LEFT JOIN daily_exceptions e ON e.plant_id = p.id AND e.report_date = d.day::date
     WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND e.id IS NULL
       AND (${ids}::uuid[] IS NULL OR p.id = ANY(${ids}::uuid[]))
     GROUP BY p.id`);
  for (const r of rows) out.set(r.plant_id, r.n);
  return out;
}
