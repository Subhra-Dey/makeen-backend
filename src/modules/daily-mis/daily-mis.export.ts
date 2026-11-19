import { Injectable } from '@nestjs/common';
import {
  buildPdf,
  buildRecordPdf,
  buildXlsx,
  newReportId,
  XLSX_TYPE,
  type ReportColumn,
  type ReportFile,
  type RecordSection,
} from '../../common/export/report-file';
import type { RequestContext } from '../../common/security/request-context';
import {
  DAILY_MIS_FIELDS,
  DAILY_MIS_SECTIONS,
  formatDate,
  formatDateTimeIst,
  formatMonthYear,
  formatNumber,
  type DailyMisDetail,
  type DailyMisFilter,
  type DailyMisListRow,
  type FieldDef,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { DailyMisService } from './daily-mis.service';

export const STATUS_LABEL = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  APPROVED: 'Approved',
  RETURNED: 'Returned',
};

/** Columns of the Daily MIS table (DMIS-T1…T10), the same in Excel and PDF. */
const COLUMNS: readonly ReportColumn<DailyMisListRow>[] = [
  { header: 'Plant', width: 22, value: (r) => r.plant.name },
  { header: 'Date', width: 12, value: (r) => formatDate(r.reportDate) },
  { header: 'Physical stock (MT)', width: 16, decimals: 3, value: (r) => r.physicalStock },
  {
    header: 'Bottling despatches (MT)',
    width: 18,
    decimals: 3,
    value: (r) => r.bottlingDespatches,
  },
  { header: 'Cyl. filled 14.2 kg', width: 15, decimals: 0, value: (r) => r.cylFilled142 },
  { header: 'Cyl. filled 19 kg', width: 14, decimals: 0, value: (r) => r.cylFilled19 },
  { header: 'Stock loss / gain (MT)', width: 17, decimals: 3, value: (r) => r.stockGainLoss },
  { header: 'Accuracy (%)', width: 12, decimals: 2, value: (r) => r.accuracyZero },
  { header: 'Status', width: 11, value: (r) => STATUS_LABEL[r.status] },
  { header: 'Entered by', width: 16, value: (r) => r.enteredBy },
  {
    header: 'Last modified (IST)',
    width: 20,
    value: (r) => formatDateTimeIst(new Date(r.updatedAt)),
  },
];

/**
 * Daily MIS downloads (BTN-4, BEV-6, D-87). The table download reads the SAME filter object as
 * the screen (DailyMisService.exportRows uses the list's `where` and totals), so file numbers equal
 * screen numbers. Each download is audited with its report ID and filter.
 */
@Injectable()
export class DailyMisExport {
  constructor(
    private readonly daily: DailyMisService,
    private readonly audit: AuditLogService,
  ) {}

  async table(
    access: ResolvedAccess,
    filter: DailyMisFilter,
    format: 'xlsx' | 'pdf',
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const data = await this.daily.exportRows(access, filter);
    const reportId = newReportId();
    const generatedAt = new Date();
    const period =
      data.from === data.to
        ? formatDate(data.from)
        : `${formatDate(data.from)} to ${formatDate(data.to)}`;
    const t = data.totals;
    const spec = {
      reportName: 'Daily MIS',
      subtitle: `${data.plantName ?? 'All plants this login may see'} · ${period}${
        filter.status ? ` · ${STATUS_LABEL[filter.status]}` : ''
      } · ${formatNumber(t.rows, 0)} rows`,
      columns: COLUMNS,
      rows: data.rows,
      totals: [
        `Total (${formatNumber(t.rows, 0)} rows)`,
        null,
        null,
        t.bottlingDespatches,
        t.cylFilled142,
        t.cylFilled19,
        t.stockGainLoss,
        t.accuracyZeroAverage,
        null,
        null,
        null,
      ],
      generatedAt,
      reportId,
    };
    const body = format === 'xlsx' ? await buildXlsx(spec) : await buildPdf(spec);
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity: 'daily_mis',
      entityId: reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter }, rows: t.rows },
      ctx,
    });
    const stem = `daily-mis_${data.from}_${data.to}`;
    return {
      body,
      fileName: `${stem}.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }

  /** One report, all 60 fields (form “Download PDF”). */
  async record(access: ResolvedAccess, id: string, ctx: RequestContext): Promise<ReportFile> {
    const d = await this.daily.get(access, id);
    const reportId = newReportId();
    const body = await buildRecordPdf({
      reportName: `Daily MIS — ${d.plant.name}, ${formatDate(d.reportDate)}`,
      subtitle: `Status ${STATUS_LABEL[d.status]} · entered by ${d.enteredBy.name} · last updated ${formatDateTimeIst(new Date(d.updatedAt))}`,
      reportId,
      generatedAt: new Date(),
      sections: sectionsOf(d),
    });
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity: 'daily_mis',
      entityId: reportId,
      plantId: d.plant.id,
      actorId: access.userId,
      after: { format: 'pdf', dailyMisId: id },
      ctx,
    });
    return {
      body,
      fileName: `daily-mis_${d.plant.code}_${d.reportDate}.pdf`,
      contentType: 'application/pdf',
    };
  }
}

function shown(def: FieldDef, d: DailyMisDetail): string {
  const derived: Record<string, string | number | null> = { ...d.derived };
  const header: Record<string, string> = {
    plantId: d.plant.name,
    reportDate: formatDate(d.reportDate),
    monthYear: formatMonthYear(d.reportDate),
    updatedAt: formatDateTimeIst(new Date(d.updatedAt)),
    enteredBy: d.enteredBy.name,
    status: STATUS_LABEL[d.status],
  };
  if (def.key in header) return header[def.key] ?? '—';
  const raw =
    def.key in derived
      ? derived[def.key]
      : (d.values as Record<string, string | number | null>)[def.key];
  if (raw === null || raw === undefined || raw === '') return '—';
  if (def.kind === 'text' || def.kind === 'time' || def.kind === 'select') return String(raw);
  return `${formatNumber(raw, def.decimals)}${def.unit && def.unit !== 'count' ? ` ${def.unit}` : ''}`;
}

function sectionsOf(d: DailyMisDetail): RecordSection[] {
  return Object.values(DAILY_MIS_SECTIONS).map((title) => ({
    title,
    items: (DAILY_MIS_FIELDS as readonly FieldDef[])
      .filter((f) => f.section === title)
      .map((f) => ({ no: f.no, label: f.label, value: shown(f, d) })),
  }));
}
