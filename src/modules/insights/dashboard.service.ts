import { Injectable } from '@nestjs/common';
import {
  assertPlant,
  canOnPlant,
  plantScope,
  type PlantNeed,
  type PlantScope,
} from '../../common/access/plant-scope';
import { isoDay, isoDayOrNull, namesOf } from '../../common/db/people-names';
import { Prisma } from '../../generated/prisma/client';
import {
  addDays,
  daysBetween,
  financialYearOf,
  financialYearRange,
  firstDayOfMonth,
  hoursBetween,
  istToday,
  lastDayOfMonth,
  licenceStatus,
  monthOf,
  observationUrgency,
  performanceBuckets,
  type DashboardCards,
  type DashboardExceptionRow,
  type DashboardModule,
  type DashboardPendingRow,
  type DashboardQuery,
  type DashboardView,
  type Module,
  type PerformanceRange,
  type PlantPerformance,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';

const view = (module: Module): PlantNeed => ({ module, capability: 'VIEW' });
const DASHBOARD = view('DASHBOARD');

/** Rows shown in each Dashboard table; the cards always count every row. */
export const DASHBOARD_TABLE_ROWS = 50;

const dateOf = (v: string): Date => new Date(`${v}T00:00:00.000Z`);
/** Hours rounded to one decimal (D-30), as on the approval queue. */
const waiting = (from: Date, to: Date): number => Math.round(hoursBetween(from, to) * 10) / 10;

/** The period a Dashboard search covers (D-122); null = everything still waiting. */
export interface DashboardPeriod {
  /** Daily MIS and Daily Exception report dates. */
  from: string;
  to: string;
  /** Monthly MIS months (1st of month). */
  monthFrom: string;
  monthTo: string;
}

export function dashboardPeriod(q: { date?: string; month?: string }): DashboardPeriod | null {
  if (q.date) {
    const m = firstDayOfMonth(monthOf(q.date));
    return { from: q.date, to: q.date, monthFrom: m, monthTo: m };
  }
  if (q.month) {
    const m = firstDayOfMonth(q.month);
    return { from: m, to: lastDayOfMonth(q.month), monthFrom: m, monthTo: m };
  }
  return null;
}

const plantIn = (scope: PlantScope): { plantId?: { in: string[] } } =>
  scope.all ? {} : { plantId: { in: scope.plantIds } };
const ids = (scope: PlantScope): string[] | null => (scope.all ? null : scope.plantIds);

const shows = (selected: DashboardModule, ...modules: DashboardModule[]): boolean =>
  selected === 'ALL' || modules.includes(selected);

/**
 * Dashboard (spec “Dashboard”, DASH-1…10). One layout for every role: each card and table counts
 * only the plants assigned to the login (Admin all) and only modules not Hidden for its role on
 * that plant (CARD-0, DASH-9). Nothing here is stored; every number comes from the saved rows.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  /**
   * Plants a module counts on: the chosen plant if the role there may view the module, otherwise
   * every plant where it may. Null = the module is Hidden everywhere for this login.
   */
  moduleScope(access: ResolvedAccess, module: Module, plantId?: string): PlantScope | null {
    if (plantId !== undefined)
      return canOnPlant(access, plantId, view(module)) ? { all: false, plantIds: [plantId] } : null;
    const s = plantScope(access, view(module));
    return s.all || s.plantIds.length > 0 ? s : null;
  }

  async view(access: ResolvedAccess, q: DashboardQuery): Promise<DashboardView> {
    if (q.plantId !== undefined) assertPlant(access, q.plantId, DASHBOARD);
    const period = dashboardPeriod(q);
    const scope = (m: Module): PlantScope | null => this.moduleScope(access, m, q.plantId);
    const daily = shows(q.module, 'DAILY_MIS') ? scope('DAILY_MIS') : null;
    const monthly = shows(q.module, 'MONTHLY_MIS') ? scope('MONTHLY_MIS') : null;
    const exceptions = shows(q.module, 'DAILY_EXCEPTIONS') ? scope('DAILY_EXCEPTIONS') : null;
    const licences = shows(q.module, 'LICENCES') ? scope('LICENCES') : null;
    const audit = q.module === 'AUDIT' ? scope('AUDIT') : null;
    const notInitiatedDate = q.date ?? istToday();
    // Not initiated looks at both Daily MIS and Daily Exception (D-18): shown when either is.
    const reportsVisible =
      shows(q.module, 'DAILY_MIS', 'DAILY_EXCEPTIONS') &&
      (scope('DAILY_MIS') !== null || scope('DAILY_EXCEPTIONS') !== null);

    return this.asActor(access, async (tx) => {
      const cards: DashboardCards = {
        waiting:
          daily || monthly
            ? {
                daily: daily ? await this.dailyPendingCount(tx, daily, period) : 0,
                monthly: monthly ? await this.monthlyPendingCount(tx, monthly, period) : 0,
              }
            : null,
        openExceptions: exceptions ? await this.openExceptionCounts(tx, exceptions, period) : null,
        licences: licences ? await this.licenceCounts(tx, licences) : null,
        auditOverdue: audit ? await this.auditOverdue(tx, audit) : null,
        notInitiated: reportsVisible
          ? await this.notInitiated(
              tx,
              q.plantId !== undefined
                ? { all: false, plantIds: [q.plantId] }
                : plantScope(access, DASHBOARD),
              notInitiatedDate,
            )
          : null,
        notInitiatedDate,
      };
      return {
        cards,
        pending: daily || monthly ? await this.pending(tx, access, daily, monthly, period) : null,
        openExceptions: exceptions ? await this.openExceptions(tx, exceptions, period) : null,
      };
    });
  }

  private dailyWhere(scope: PlantScope, period: DashboardPeriod | null): Prisma.DailyMisWhereInput {
    return {
      status: 'PENDING',
      plant: { deletedAt: null },
      ...plantIn(scope),
      ...(period ? { reportDate: { gte: dateOf(period.from), lte: dateOf(period.to) } } : {}),
    };
  }

  private monthlyWhere(
    scope: PlantScope,
    period: DashboardPeriod | null,
  ): Prisma.MonthlyMisWhereInput {
    return {
      status: 'PENDING',
      plant: { deletedAt: null },
      ...plantIn(scope),
      ...(period ? { month: { gte: dateOf(period.monthFrom), lte: dateOf(period.monthTo) } } : {}),
    };
  }

  private exceptionWhere(
    scope: PlantScope,
    period: DashboardPeriod | null,
  ): Prisma.DailyExceptionWhereInput {
    return {
      status: { in: ['PENDING', 'PARTIAL'] },
      plant: { deletedAt: null },
      ...plantIn(scope),
      ...(period ? { reportDate: { gte: dateOf(period.from), lte: dateOf(period.to) } } : {}),
    };
  }

  private dailyPendingCount(
    tx: Tx,
    scope: PlantScope,
    period: DashboardPeriod | null,
  ): Promise<number> {
    return tx.dailyMis.count({ where: this.dailyWhere(scope, period) });
  }

  private monthlyPendingCount(
    tx: Tx,
    scope: PlantScope,
    period: DashboardPeriod | null,
  ): Promise<number> {
    return tx.monthlyMis.count({ where: this.monthlyWhere(scope, period) });
  }

  /** DASH-2 / D-19: open = Pending or Partial. */
  private async openExceptionCounts(
    tx: Tx,
    scope: PlantScope,
    period: DashboardPeriod | null,
  ): Promise<{ pending: number; partial: number }> {
    const where = this.exceptionWhere(scope, period);
    const [pending, partial] = await Promise.all([
      tx.dailyException.count({ where: { ...where, status: 'PENDING' } }),
      tx.dailyException.count({ where: { ...where, status: 'PARTIAL' } }),
    ]);
    return { pending, partial };
  }

  /** DASH-3: licences Due or Expired today (status from the shared rule, never stored). */
  private async licenceCounts(
    tx: Tx,
    scope: PlantScope,
  ): Promise<{ due: number; expired: number }> {
    const today = istToday();
    const rows = await tx.licence.findMany({
      where: { plant: { deletedAt: null }, ...plantIn(scope) },
      select: { frequency: true, startDate: true, endDate: true, remindBeforeDays: true },
    });
    let due = 0;
    let expired = 0;
    for (const r of rows) {
      const s = licenceStatus(
        {
          frequency: r.frequency,
          startDate: isoDayOrNull(r.startDate),
          endDate: isoDayOrNull(r.endDate),
          remindBeforeDays: r.remindBeforeDays,
        },
        today,
      );
      if (s === 'DUE') due += 1;
      else if (s === 'EXPIRED') expired += 1;
    }
    return { due, expired };
  }

  /** Module filter Audit: observations past their (revised) target date (D-123). */
  private async auditOverdue(tx: Tx, scope: PlantScope): Promise<number> {
    const today = istToday();
    const rows = await tx.auditObservation.findMany({
      where: { status: 'PENDING', audit: { plant: { deletedAt: null } }, ...plantIn(scope) },
      select: { status: true, targetDate: true, revisedTargetDate: true },
    });
    return rows.filter(
      (o) =>
        observationUrgency(
          {
            status: o.status,
            targetDate: isoDayOrNull(o.targetDate),
            revisedTargetDate: isoDayOrNull(o.revisedTargetDate),
          },
          today,
        ) === 'OVERDUE',
    ).length;
  }

  /**
   * DASH-4 / D-18: WORKING plants (started by that day) with neither a Daily MIS nor a Daily
   * Exception row — any status, Draft included — for the day.
   */
  private async notInitiated(tx: Tx, scope: PlantScope, day: string): Promise<number> {
    const list = ids(scope);
    if (list !== null && list.length === 0) return 0;
    const rows = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM plants p
       WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND p.start_date <= ${day}::date
         AND (${list}::uuid[] IS NULL OR p.id = ANY(${list}::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM daily_mis m WHERE m.plant_id = p.id AND m.report_date = ${day}::date)
         AND NOT EXISTS (SELECT 1 FROM daily_exceptions e WHERE e.plant_id = p.id AND e.report_date = ${day}::date)`);
    return rows[0]?.n ?? 0;
  }

  /** DASH-5: Pending Daily and Monthly rows, oldest first, with Approve / Return per plant role. */
  private async pending(
    tx: Tx,
    access: ResolvedAccess,
    daily: PlantScope | null,
    monthly: PlantScope | null,
    period: DashboardPeriod | null,
  ): Promise<DashboardPendingRow[]> {
    const select = {
      id: true,
      enteredById: true,
      createdAt: true,
      updatedAt: true,
      version: true,
      plant: { select: { id: true, name: true, code: true } },
    } as const;
    const [d, m] = await Promise.all([
      daily
        ? tx.dailyMis.findMany({
            where: this.dailyWhere(daily, period),
            select: { ...select, reportDate: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: DASHBOARD_TABLE_ROWS,
          })
        : [],
      monthly
        ? tx.monthlyMis.findMany({
            where: this.monthlyWhere(monthly, period),
            select: { ...select, month: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: DASHBOARD_TABLE_ROWS,
          })
        : [],
    ]);
    const names = await namesOf(
      tx,
      [...d, ...m].map((r) => r.enteredById),
    );
    const now = new Date();
    const can = (module: 'DAILY_MIS' | 'MONTHLY_MIS', plantId: string) => ({
      approve: canOnPlant(access, plantId, { module, capability: 'APPROVE' }),
      return: canOnPlant(access, plantId, { module, capability: 'APPROVE', action: 'RETURN' }),
    });
    const rows = [
      ...d.map((r) => ({
        at: r.createdAt,
        row: {
          id: r.id,
          module: 'DAILY_MIS' as const,
          plant: r.plant,
          period: isoDay(r.reportDate),
          enteredBy: names.get(r.enteredById) ?? '—',
          lastSavedAt: r.updatedAt.toISOString(),
          waitingHours: waiting(r.createdAt, now),
          version: r.version,
          can: can('DAILY_MIS', r.plant.id),
        },
      })),
      ...m.map((r) => ({
        at: r.createdAt,
        row: {
          id: r.id,
          module: 'MONTHLY_MIS' as const,
          plant: r.plant,
          period: isoDay(r.month).slice(0, 7),
          enteredBy: names.get(r.enteredById) ?? '—',
          lastSavedAt: r.updatedAt.toISOString(),
          waitingHours: waiting(r.createdAt, now),
          version: r.version,
          can: can('MONTHLY_MIS', r.plant.id),
        },
      })),
    ];
    rows.sort((a, b) => a.at.getTime() - b.at.getTime() || a.row.id.localeCompare(b.row.id));
    return rows.slice(0, DASHBOARD_TABLE_ROWS).map((r) => r.row);
  }

  /** DASH-6: open Daily Exceptions, newest day first, Pending before Partial. */
  private async openExceptions(
    tx: Tx,
    scope: PlantScope,
    period: DashboardPeriod | null,
  ): Promise<DashboardExceptionRow[]> {
    const lineTotal = await tx.exceptionFormField.count({
      where: { kind: 'yes_no', form: { code: 'DAILY', active: true } },
    });
    const rows = await tx.dailyException.findMany({
      where: this.exceptionWhere(scope, period),
      select: {
        id: true,
        reportDate: true,
        status: true,
        problemHighlight: true,
        plant: { select: { id: true, name: true, code: true } },
        _count: { select: { lines: { where: { answer: { not: null } } } } },
      },
      orderBy: [{ reportDate: 'desc' }, { status: 'asc' }, { createdAt: 'asc' }],
      take: DASHBOARD_TABLE_ROWS,
    });
    return rows.map((r) => ({
      id: r.id,
      plant: r.plant,
      reportDate: isoDay(r.reportDate),
      problemHighlight: r.problemHighlight,
      status: r.status === 'PARTIAL' ? 'PARTIAL' : 'PENDING',
      answered: r._count.lines,
      lineTotal,
    }));
  }

  /**
   * DASH-10 / D-124: bottling achieved (Approved Daily MIS 11 + 13, MT) against the projected
   * bottling of the plant master (year-wise volume for the FY ÷ days in that FY), per bucket.
   */
  async performance(
    access: ResolvedAccess,
    range: PerformanceRange,
    plantId?: string,
  ): Promise<PlantPerformance> {
    if (plantId !== undefined) assertPlant(access, plantId, DASHBOARD);
    const buckets = performanceBuckets(range, istToday());
    const first = buckets[0]?.from ?? istToday();
    const last = buckets[buckets.length - 1]?.to ?? istToday();
    const scope = this.moduleScope(access, 'DAILY_MIS', plantId);
    if (!scope) {
      return {
        range,
        points: buckets.map((b) => ({ ...b, achieved: '0.000', target: '0.000' })),
        totals: { achieved: '0.000', target: '0.000' },
      };
    }
    const list = ids(scope);
    return this.asActor(access, async (tx) => {
      const achievedRows = await tx.$queryRaw<{ day: string; mt: string }[]>(Prisma.sql`
        SELECT m.report_date::text AS day,
               sum(COALESCE(m.normal_cylinder_despatch, 0) + COALESCE(m.ot_cylinder_despatch, 0))::text AS mt
          FROM daily_mis m JOIN plants p ON p.id = m.plant_id
         WHERE m.status = 'APPROVED' AND p.deleted_at IS NULL
           AND m.report_date BETWEEN ${first}::date AND ${last}::date
           AND (${list}::uuid[] IS NULL OR m.plant_id = ANY(${list}::uuid[]))
         GROUP BY m.report_date`);
      const achievedByDay = new Map(achievedRows.map((r) => [r.day, new Prisma.Decimal(r.mt)]));
      const plants = await tx.plant.findMany({
        where: { deletedAt: null, status: 'WORKING', ...(list ? { id: { in: list } } : {}) },
        select: {
          startDate: true,
          volumes: { where: { type: 'PROJECTED' }, select: { fy: true, volumeMt: true } },
        },
      });
      const perDay = new Map<string, Prisma.Decimal>();
      const fyDays = (fy: string): number => {
        const r = financialYearRange(fy);
        return daysBetween(r.start, r.end) + 1;
      };
      const targetOf = (day: string): Prisma.Decimal => {
        const fy = financialYearOf(day);
        let sum = new Prisma.Decimal(0);
        for (const p of plants) {
          if (isoDay(p.startDate) > day) continue;
          const v = p.volumes.find((x) => x.fy === fy);
          if (v) sum = sum.plus(v.volumeMt.div(fyDays(fy)));
        }
        return sum;
      };
      let totalA = new Prisma.Decimal(0);
      let totalT = new Prisma.Decimal(0);
      const points = buckets.map((b) => {
        let a = new Prisma.Decimal(0);
        let t = new Prisma.Decimal(0);
        for (let d = b.from; d <= b.to; d = addDays(d, 1)) {
          a = a.plus(achievedByDay.get(d) ?? 0);
          const cached = perDay.get(d) ?? targetOf(d);
          perDay.set(d, cached);
          t = t.plus(cached);
        }
        // Totals add the shown (rounded) values, so the table sums to its total row.
        const achieved = a.toFixed(3);
        const target = t.toFixed(3);
        totalA = totalA.plus(achieved);
        totalT = totalT.plus(target);
        return { ...b, achieved, target };
      });
      return { range, points, totals: { achieved: totalA.toFixed(3), target: totalT.toFixed(3) } };
    });
  }
}
