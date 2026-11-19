import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { forbidden } from '../../common/access/access.guard';
import {
  assertPlant,
  canOnPlant,
  plantFilter,
  type PlantNeed,
  type PlantScope,
} from '../../common/access/plant-scope';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import {
  DAILY_MIS_MESSAGES,
  firstDayOfMonth,
  formatDate,
  fromScaled,
  hoursBetween,
  istToday,
  monthOf,
  toScaled,
  type ApprovalQueueItem,
  type DailyMisCards,
  type DailyMisDetail,
  type DailyMisFilter,
  type DailyMisListRow,
  type DailyMisPage,
  type DailyMisQuery,
  type DailyMisRevision,
  type DailyMisSaveInput,
  type DailyMisTotals,
  type PersonRef,
  type ReportStatus,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { completeValues, recordData, valuesFromRecord } from './daily-mis.mapper';

const MODULE = 'DAILY_MIS' as const;
const NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  submit: { module: MODULE, capability: 'SUBMIT' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
  approve: { module: MODULE, capability: 'APPROVE' },
  return: { module: MODULE, capability: 'APPROVE', action: 'RETURN' },
  reopen: { module: MODULE, capability: 'VIEW', action: 'REOPEN_APPROVED' },
} as const satisfies Record<string, PlantNeed>;

/** Most rows one download may hold (≈ 22 plants × 366 days, with room for extra Drafts). */
export const EXPORT_MAX_ROWS = 20_000;

const err = (status: HttpStatus, code: string, message: string): AppError =>
  new AppError(status, code, message);
const notFound = (): AppError =>
  err(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, DAILY_MIS_MESSAGES.notFound);
const conflict = (message: string): AppError =>
  err(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);

/** Hours rounded to one decimal (D-30). */
const waiting = (from: Date, to: Date): number => Math.round(hoursBetween(from, to) * 10) / 10;

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const dateOf = (v: string): Date => new Date(`${v}T00:00:00.000Z`);

const listSelect = {
  id: true,
  reportDate: true,
  status: true,
  physicalStock: true,
  normalCylinderDespatch: true,
  otCylinderDespatch: true,
  cylFilled142: true,
  cylFilled19: true,
  stockGainLoss: true,
  accuracyZero: true,
  enteredById: true,
  updatedAt: true,
  plant: { select: { id: true, name: true, code: true } },
} as const satisfies Prisma.DailyMisSelect;
type ListRecord = Prisma.DailyMisGetPayload<{ select: typeof listSelect }>;

const fixed = (v: Prisma.Decimal | null, dp: number): string | null =>
  v === null ? null : v.toFixed(dp);

/** Locked row (FOR UPDATE) with the fields every transition checks. */
interface Locked {
  id: string;
  plantId: string;
  reportDate: string;
  status: ReportStatus;
  version: number;
}

/**
 * Daily MIS (spec “Daily MIS — table / form”, “Approve / Return”). Plant scope is checked on the
 * role of THAT plant (assertPlant) and again by row-level security (runAs). Every save writes a
 * revision and an audit row in the same transaction; transitions use optimistic locking.
 */
@Injectable()
export class DailyMisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly notices: NotificationsService,
  ) {}

  /** Event 3 for this row (in the transition's transaction). */
  private async decided(
    tx: Tx,
    access: ResolvedAccess,
    id: string,
    decision: 'Approved' | 'Returned',
    reason?: string,
  ): Promise<void> {
    const r = await tx.dailyMis.findUniqueOrThrow({
      where: { id },
      select: { plantId: true, reportDate: true, enteredById: true },
    });
    await this.notices.reportDecided(tx, {
      what: 'Daily MIS',
      entity: 'daily_mis',
      id,
      plantId: r.plantId,
      period: formatDate(iso(r.reportDate)),
      enteredById: r.enteredById,
      deciderId: access.userId,
      decision,
      ...(reason ? { reason } : {}),
    });
  }

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  /** Default range: the 1st of the current India month to today (mockup 01-10 … 16-10). */
  range(f: DailyMisFilter): { from: string; to: string } {
    const today = istToday();
    const to = f.to ?? (f.from && f.from > today ? f.from : today);
    const from = f.from ?? firstDayOfMonth(monthOf(to));
    return { from, to };
  }

  /** The one query object behind the table AND its download (BEV-6). */
  private where(
    scope: PlantScope,
    f: DailyMisFilter,
    withStatus: boolean,
  ): Prisma.DailyMisWhereInput {
    const { from, to } = this.range(f);
    return {
      ...(scope.all ? {} : { plantId: { in: scope.plantIds } }),
      reportDate: { gte: dateOf(from), lte: dateOf(to) },
      plant: { deletedAt: null },
      ...(withStatus && f.status ? { status: f.status } : {}),
    };
  }

  private async names(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => i !== null))];
    if (unique.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toListRow(r: ListRecord, names: Map<string, string>): DailyMisListRow {
    const despatch =
      r.normalCylinderDespatch === null && r.otCylinderDespatch === null
        ? null
        : (r.normalCylinderDespatch ?? new Prisma.Decimal(0))
            .add(r.otCylinderDespatch ?? new Prisma.Decimal(0))
            .toFixed(3);
    return {
      id: r.id,
      plant: r.plant,
      reportDate: iso(r.reportDate),
      physicalStock: fixed(r.physicalStock, 3),
      bottlingDespatches: despatch,
      cylFilled142: r.cylFilled142,
      cylFilled19: r.cylFilled19,
      stockGainLoss: fixed(r.stockGainLoss, 3),
      accuracyZero: fixed(r.accuracyZero, 2),
      status: r.status,
      enteredBy: names.get(r.enteredById) ?? '—',
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /** Totals of the whole filter — the table footer and the download print exactly these. */
  private async totals(tx: Tx, where: Prisma.DailyMisWhereInput): Promise<DailyMisTotals> {
    const a = await tx.dailyMis.aggregate({
      where,
      _count: { _all: true, accuracyZero: true },
      _sum: {
        normalCylinderDespatch: true,
        otCylinderDespatch: true,
        cylFilled142: true,
        cylFilled19: true,
        stockGainLoss: true,
        accuracyZero: true,
      },
    });
    const sum3 = (v: Prisma.Decimal | null): bigint => toScaled(v?.toFixed(3) ?? null, 3) ?? 0n;
    const accCount = BigInt(a._count.accuracyZero);
    let average: string | null = null;
    if (accCount > 0n) {
      const total = toScaled(a._sum.accuracyZero?.toFixed(2) ?? '0', 2) ?? 0n;
      average = fromScaled((total * 2n + accCount) / (accCount * 2n), 2);
    }
    return {
      rows: a._count._all,
      bottlingDespatches: fromScaled(
        sum3(a._sum.normalCylinderDespatch) + sum3(a._sum.otCylinderDespatch),
        3,
      ),
      cylFilled142: a._sum.cylFilled142 ?? 0,
      cylFilled19: a._sum.cylFilled19 ?? 0,
      stockGainLoss: fromScaled(sum3(a._sum.stockGainLoss), 3),
      accuracyZeroAverage: average,
    };
  }

  /** Plant-days in the range (up to today, from each plant's start) with no Daily MIS row (D-18). */
  private async notInitiated(tx: Tx, scope: PlantScope, from: string, to: string): Promise<number> {
    const end = to < istToday() ? to : istToday();
    if (end < from) return 0;
    const ids = scope.all ? null : scope.plantIds;
    if (ids !== null && ids.length === 0) return 0;
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM plants p
        CROSS JOIN LATERAL generate_series(GREATEST(${from}::date, p.start_date), ${end}::date, interval '1 day') AS d(day)
       WHERE p.deleted_at IS NULL
         AND (${ids}::uuid[] IS NULL OR p.id = ANY(${ids}::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM daily_mis m WHERE m.plant_id = p.id AND m.report_date = d.day::date)`;
    return rows[0]?.n ?? 0;
  }

  async list(access: ResolvedAccess, q: DailyMisQuery): Promise<DailyMisPage> {
    const scope = plantFilter(access, q.plantId, NEED.view);
    const { from, to } = this.range(q);
    return this.asActor(access, async (tx) => {
      const where = this.where(scope, q, true);
      const records = await tx.dailyMis.findMany({
        where,
        select: listSelect,
        orderBy: [{ reportDate: 'desc' }, { plant: { name: 'asc' } }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      });
      const total = await tx.dailyMis.count({ where });
      const byStatus = await tx.dailyMis.groupBy({
        by: ['status'],
        where: this.where(scope, q, false),
        _count: { _all: true },
      });
      const count = (s: ReportStatus): number =>
        byStatus.find((b) => b.status === s)?._count._all ?? 0;
      const cards: DailyMisCards = {
        pending: count('PENDING'),
        approved: count('APPROVED'),
        returned: count('RETURNED'),
        draft: count('DRAFT'),
        notInitiated: await this.notInitiated(tx, scope, from, to),
      };
      const totals = await this.totals(tx, where);
      const names = await this.names(
        tx,
        records.map((r) => r.enteredById),
      );
      return {
        rows: records.map((r) => this.toListRow(r, names)),
        total,
        page: q.page,
        pageSize: q.pageSize,
        from,
        to,
        cards,
        totals,
      };
    });
  }

  /** Every row of the filter + its totals, for a download (same query as the table). */
  async exportRows(
    access: ResolvedAccess,
    f: DailyMisFilter,
  ): Promise<{
    rows: DailyMisListRow[];
    totals: DailyMisTotals;
    from: string;
    to: string;
    plantName: string | null;
  }> {
    const scope = plantFilter(access, f.plantId, NEED.download);
    const { from, to } = this.range(f);
    return this.asActor(access, async (tx) => {
      const where = this.where(scope, f, true);
      const total = await tx.dailyMis.count({ where });
      if (total > EXPORT_MAX_ROWS) {
        throw new AppError(
          HttpStatus.PAYLOAD_TOO_LARGE,
          ErrorCode.PAYLOAD_TOO_LARGE,
          'Too many rows for one download. Choose a shorter date range or one plant.',
        );
      }
      const records = await tx.dailyMis.findMany({
        where,
        select: listSelect,
        orderBy: [{ reportDate: 'desc' }, { plant: { name: 'asc' } }, { createdAt: 'desc' }],
      });
      const names = await this.names(
        tx,
        records.map((r) => r.enteredById),
      );
      const plant = f.plantId
        ? await tx.plant.findUnique({ where: { id: f.plantId }, select: { name: true } })
        : null;
      return {
        rows: records.map((r) => this.toListRow(r, names)),
        totals: await this.totals(tx, where),
        from,
        to,
        plantName: plant?.name ?? null,
      };
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<DailyMisDetail> {
    return this.asActor(access, (tx) => this.detail(tx, access, id));
  }

  private async detail(tx: Tx, access: ResolvedAccess, id: string): Promise<DailyMisDetail> {
    const r = await tx.dailyMis.findUnique({
      where: { id },
      include: {
        plant: { select: { id: true, name: true, code: true, deletedAt: true } },
        revisions: {
          select: { version: true, status: true, savedAt: true, savedById: true },
          orderBy: { version: 'desc' },
        },
      },
    });
    if (!r || r.plant.deletedAt !== null) throw notFound();
    assertPlant(access, r.plantId, NEED.view);
    const names = await this.names(tx, [
      r.enteredById,
      r.lastModifiedById,
      r.approvedById,
      r.returnedById,
      r.reopenedById,
      ...r.revisions.map((v) => v.savedById),
    ]);
    const ref = (userId: string | null): PersonRef | null =>
      userId === null ? null : { id: userId, name: names.get(userId) ?? '—' };
    const values = valuesFromRecord(r);
    const stamp = (d: Date | null): string | null => d?.toISOString() ?? null;
    const status = r.status;
    return {
      id: r.id,
      version: r.version,
      plant: { id: r.plant.id, name: r.plant.name, code: r.plant.code },
      reportDate: iso(r.reportDate),
      status,
      values,
      derived: {
        closingBookStock: fixed(r.closingBookStock, 3),
        stockGainLoss: fixed(r.stockGainLoss, 3),
        lossMechanicalTotal: r.lossMechanicalTotal,
        lossElectricalTotal: r.lossElectricalTotal,
        lossMiscTotal: r.lossMiscTotal,
        mrTotal: r.mrTotal,
      },
      enteredBy: ref(r.enteredById) ?? { id: r.enteredById, name: '—' },
      lastModifiedBy: ref(r.lastModifiedById),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      submittedAt: stamp(r.submittedAt),
      approvedBy: ref(r.approvedById),
      approvedAt: stamp(r.approvedAt),
      returnedBy: ref(r.returnedById),
      returnedAt: stamp(r.returnedAt),
      returnReason: r.returnReason,
      reopenedBy: ref(r.reopenedById),
      reopenedAt: stamp(r.reopenedAt),
      reopenReason: r.reopenReason,
      waitingHours: waiting(r.createdAt, r.approvedAt ?? new Date()),
      revisions: r.revisions.map((v) => ({
        version: v.version,
        status: v.status,
        savedAt: v.savedAt.toISOString(),
        savedBy: ref(v.savedById) ?? { id: v.savedById, name: '—' },
      })),
      can: {
        edit: status !== 'APPROVED' && canOnPlant(access, r.plantId, NEED.submit),
        approve: status === 'PENDING' && canOnPlant(access, r.plantId, NEED.approve),
        return: status === 'PENDING' && canOnPlant(access, r.plantId, NEED.return),
        reopen: status === 'APPROVED' && canOnPlant(access, r.plantId, NEED.reopen),
        download: canOnPlant(access, r.plantId, NEED.download),
      },
    };
  }

  async revision(access: ResolvedAccess, id: string, version: number): Promise<DailyMisRevision> {
    return this.asActor(access, async (tx) => {
      const rev = await tx.dailyMisRevision.findUnique({
        where: { dailyMisId_version: { dailyMisId: id, version } },
      });
      if (!rev) throw notFound();
      assertPlant(access, rev.plantId, NEED.view);
      const snapshot =
        rev.snapshot !== null && typeof rev.snapshot === 'object' ? rev.snapshot : {};
      const values = valuesFromRecord(snapshot);
      const names = await this.names(tx, [rev.savedById]);
      return {
        version: rev.version,
        status: rev.status,
        savedAt: rev.savedAt.toISOString(),
        savedBy: { id: rev.savedById, name: names.get(rev.savedById) ?? '—' },
        values,
        derived: recordData(values).derived,
      };
    });
  }

  /** Is there already a Pending / Approved / Returned row for this plant + date? (BEV-3) */
  private async nonDraftExists(
    tx: Tx,
    plantId: string,
    date: string,
    exceptId?: string,
  ): Promise<boolean> {
    const n = await tx.dailyMis.count({
      where: {
        plantId,
        reportDate: dateOf(date),
        status: { not: 'DRAFT' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    return n > 0;
  }

  private async revisionTx(
    tx: Tx,
    row: { id: string; plantId: string; version: number; status: ReportStatus },
    snapshot: Record<string, string | number | null>,
    savedById: string,
  ): Promise<void> {
    await tx.dailyMisRevision.create({
      data: {
        dailyMisId: row.id,
        plantId: row.plantId,
        version: row.version,
        status: row.status,
        snapshot,
        savedById,
      },
    });
  }

  private async plantExists(tx: Tx, plantId: string): Promise<void> {
    const p = await tx.plant.findFirst({
      where: { id: plantId, deletedAt: null },
      select: { id: true },
    });
    if (!p) throw forbidden('You do not have access to this plant.');
  }

  private uniqueViolation(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw conflict(DAILY_MIS_MESSAGES.alreadySubmitted);
    throw e;
  }

  /** Save draft / Submit for approval on a new row (DMIS-R1, DMIS-R2). */
  async create(
    access: ResolvedAccess,
    input: DailyMisSaveInput,
    ctx: RequestContext,
  ): Promise<DailyMisDetail> {
    assertPlant(access, input.plantId, NEED.submit);
    const values = completeValues(input.values);
    const { data } = recordData(values);
    const submit = input.action === 'submit';
    try {
      return await this.asActor(access, async (tx) => {
        await this.plantExists(tx, input.plantId);
        if (submit && (await this.nonDraftExists(tx, input.plantId, input.reportDate)))
          throw conflict(DAILY_MIS_MESSAGES.alreadySubmitted);
        const now = new Date();
        const status: ReportStatus = submit ? 'PENDING' : 'DRAFT';
        const row = await tx.dailyMis.create({
          data: {
            ...(data as Omit<
              Prisma.DailyMisUncheckedCreateInput,
              'plantId' | 'reportDate' | 'enteredById'
            >),
            plantId: input.plantId,
            reportDate: dateOf(input.reportDate),
            status,
            enteredById: access.userId,
            lastModifiedById: access.userId,
            submittedAt: submit ? now : null,
          },
          select: { id: true, plantId: true, version: true, status: true },
        });
        await this.revisionTx(tx, row, data, access.userId);
        await this.audit.record(
          {
            action: submit ? AuditAction.SUBMIT : AuditAction.CREATE,
            entity: 'daily_mis',
            entityId: row.id,
            plantId: row.plantId,
            actorId: access.userId,
            after: { reportDate: input.reportDate, status },
            ctx,
          },
          tx,
        );
        if (submit)
          await this.notices.reportSubmitted(tx, {
            what: 'Daily MIS',
            entity: 'daily_mis',
            id: row.id,
            plantId: row.plantId,
            period: formatDate(input.reportDate),
            senderId: access.userId,
          });
        return this.detail(tx, access, row.id);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  private async lock(tx: Tx, id: string): Promise<Locked> {
    const rows = await tx.$queryRaw<
      { id: string; plant_id: string; report_date: Date; status: ReportStatus; version: number }[]
    >`SELECT id, plant_id, report_date, status, version FROM daily_mis WHERE id = ${id}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r) throw notFound();
    return {
      id: r.id,
      plantId: r.plant_id,
      reportDate: iso(r.report_date),
      status: r.status,
      version: r.version,
    };
  }

  private checkVersion(row: Locked, version: number | undefined): void {
    if (version === undefined || row.version !== version) throw conflict(DAILY_MIS_MESSAGES.stale);
  }

  /**
   * Edit a Draft / Pending / Returned row (D-29, D-32, D-85):
   *   Draft    — Save draft keeps Draft; Submit → Pending.
   *   Pending  — Save keeps Pending (no new notice); Submit keeps Pending.
   *   Returned — Save draft keeps Returned (revision recorded); “Edit & save again” → Pending.
   *   Approved — locked (BEV-2) until reopened.
   */
  async update(
    access: ResolvedAccess,
    id: string,
    input: DailyMisSaveInput,
    ctx: RequestContext,
  ): Promise<DailyMisDetail> {
    const values = completeValues(input.values);
    const { data } = recordData(values);
    const submit = input.action === 'submit';
    try {
      return await this.asActor(access, async (tx) => {
        const row = await this.lock(tx, id);
        assertPlant(access, row.plantId, NEED.submit);
        if (row.status === 'APPROVED') throw conflict(DAILY_MIS_MESSAGES.locked);
        this.checkVersion(row, input.version);
        const moved = row.plantId !== input.plantId || row.reportDate !== input.reportDate;
        if (moved) {
          if (row.status !== 'DRAFT')
            throw new AppError(
              HttpStatus.BAD_REQUEST,
              ErrorCode.VALIDATION_FAILED,
              'Some fields are not valid.',
              [{ path: 'reportDate', message: DAILY_MIS_MESSAGES.plantDateFixed }],
            );
          assertPlant(access, input.plantId, NEED.submit);
          await this.plantExists(tx, input.plantId);
        }
        const next: ReportStatus = submit ? 'PENDING' : row.status;
        if (
          next !== 'DRAFT' &&
          row.status === 'DRAFT' &&
          (await this.nonDraftExists(tx, input.plantId, input.reportDate, id))
        )
          throw conflict(DAILY_MIS_MESSAGES.alreadySubmitted);
        const now = new Date();
        const updated = await tx.dailyMis.update({
          where: { id },
          data: {
            ...(data as Prisma.DailyMisUncheckedUpdateInput),
            plantId: input.plantId,
            reportDate: dateOf(input.reportDate),
            status: next,
            lastModifiedById: access.userId,
            version: { increment: 1 },
            ...(submit ? { submittedAt: now } : {}),
          },
          select: { id: true, plantId: true, version: true, status: true },
        });
        await this.revisionTx(tx, updated, data, access.userId);
        await this.audit.record(
          {
            action: submit ? AuditAction.SUBMIT : AuditAction.UPDATE,
            entity: 'daily_mis',
            entityId: id,
            plantId: updated.plantId,
            actorId: access.userId,
            before: { status: row.status, version: row.version },
            after: { status: next, version: updated.version },
            ctx,
          },
          tx,
        );
        // Notice only when the row becomes Pending (a Pending row saved again sends none).
        if (submit && row.status !== 'PENDING')
          await this.notices.reportSubmitted(tx, {
            what: 'Daily MIS',
            entity: 'daily_mis',
            id,
            plantId: updated.plantId,
            period: formatDate(input.reportDate),
            senderId: access.userId,
          });
        return this.detail(tx, access, id);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  private async snapshotOf(tx: Tx, id: string): Promise<Record<string, string | number | null>> {
    const r = await tx.dailyMis.findUniqueOrThrow({ where: { id } });
    return recordData(valuesFromRecord(r)).data;
  }

  /** Approve → Approved and locked (APPR-2). */
  async approve(
    access: ResolvedAccess,
    id: string,
    version: number,
    ctx: RequestContext,
  ): Promise<DailyMisDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.approve);
      if (row.status !== 'PENDING') throw conflict(DAILY_MIS_MESSAGES.notPending);
      this.checkVersion(row, version);
      const updated = await tx.dailyMis.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedById: access.userId,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
        select: { id: true, plantId: true, version: true, status: true },
      });
      await this.revisionTx(tx, updated, await this.snapshotOf(tx, id), access.userId);
      await this.audit.record(
        {
          action: AuditAction.APPROVE,
          entity: 'daily_mis',
          entityId: id,
          plantId: row.plantId,
          actorId: access.userId,
          before: { status: 'PENDING' },
          after: { status: 'APPROVED' },
          ctx,
        },
        tx,
      );
      await this.decided(tx, access, id, 'Approved');
      return this.detail(tx, access, id);
    });
  }

  /** Return → Returned with a mandatory reason (APPR-3, UXV-8). */
  async returnRow(
    access: ResolvedAccess,
    id: string,
    version: number,
    reason: string,
    ctx: RequestContext,
  ): Promise<DailyMisDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.return);
      if (row.status !== 'PENDING') throw conflict(DAILY_MIS_MESSAGES.notPending);
      this.checkVersion(row, version);
      const updated = await tx.dailyMis.update({
        where: { id },
        data: {
          status: 'RETURNED',
          returnedById: access.userId,
          returnedAt: new Date(),
          returnReason: reason,
          version: { increment: 1 },
        },
        select: { id: true, plantId: true, version: true, status: true },
      });
      await this.revisionTx(tx, updated, await this.snapshotOf(tx, id), access.userId);
      await this.audit.record(
        {
          action: AuditAction.RETURN,
          entity: 'daily_mis',
          entityId: id,
          plantId: row.plantId,
          actorId: access.userId,
          before: { status: 'PENDING' },
          after: { status: 'RETURNED' },
          reason,
          ctx,
        },
        tx,
      );
      await this.decided(tx, access, id, 'Returned', reason);
      return this.detail(tx, access, id);
    });
  }

  /** Reopen an Approved row (APPR-5, ACT-3): reason mandatory; the row goes back to Pending (D-86). */
  async reopen(
    access: ResolvedAccess,
    id: string,
    version: number,
    reason: string,
    ctx: RequestContext,
  ): Promise<DailyMisDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.reopen);
      if (row.status !== 'APPROVED') throw conflict(DAILY_MIS_MESSAGES.notApproved);
      this.checkVersion(row, version);
      const updated = await tx.dailyMis.update({
        where: { id },
        data: {
          status: 'PENDING',
          approvedById: null,
          approvedAt: null,
          reopenedById: access.userId,
          reopenedAt: new Date(),
          reopenReason: reason,
          version: { increment: 1 },
        },
        select: { id: true, plantId: true, version: true, status: true },
      });
      await this.revisionTx(tx, updated, await this.snapshotOf(tx, id), access.userId);
      await this.audit.record(
        {
          action: AuditAction.REOPEN,
          entity: 'daily_mis',
          entityId: id,
          plantId: row.plantId,
          actorId: access.userId,
          before: { status: 'APPROVED' },
          after: { status: 'PENDING' },
          reason,
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, id);
    });
  }

  /** Approval queue (APPR-Q1): Pending rows the person may approve, oldest first. */
  async queue(access: ResolvedAccess, plantId: string | undefined): Promise<ApprovalQueueItem[]> {
    const scope = plantFilter(access, plantId, NEED.approve);
    return this.asActor(access, async (tx) => {
      const rows = await tx.dailyMis.findMany({
        where: {
          status: 'PENDING',
          plant: { deletedAt: null },
          ...(scope.all ? {} : { plantId: { in: scope.plantIds } }),
        },
        select: {
          id: true,
          reportDate: true,
          enteredById: true,
          updatedAt: true,
          createdAt: true,
          version: true,
          plant: { select: { id: true, name: true, code: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      const names = await this.names(
        tx,
        rows.map((r) => r.enteredById),
      );
      const now = new Date();
      return rows.map((r) => ({
        id: r.id,
        module: MODULE,
        plant: r.plant,
        period: iso(r.reportDate),
        enteredBy: names.get(r.enteredById) ?? '—',
        lastSavedAt: r.updatedAt.toISOString(),
        waitingHours: waiting(r.createdAt, now),
        version: r.version,
      }));
    });
  }
}
