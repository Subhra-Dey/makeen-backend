import { Injectable } from '@nestjs/common';
import {
  buildBookPdf,
  buildBookXlsx,
  cellColumn,
  newReportId,
  XLSX_TYPE,
  type ReportBook,
  type ReportFile,
  type ReportSection,
} from '../../common/export/report-file';
import type { RequestContext } from '../../common/security/request-context';
import {
  DASHBOARD_MODULE_LABEL,
  EXCEPTION_STATUS_TEXT,
  formatDate,
  formatMonthYear,
  type DashboardQuery,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { DashboardService } from './dashboard.service';

type Format = 'xlsx' | 'pdf';

const periodText = (p: string): string => (p.length === 7 ? formatMonthYear(p) : formatDate(p));

/** Dashboard download. The file is built from the same service call the screen makes. */
@Injectable()
export class InsightsExport {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly audit: AuditLogService,
  ) {}

  private async file(
    book: ReportBook,
    format: Format,
    name: string,
    entity: string,
    access: ResolvedAccess,
    filter: object,
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const body = format === 'xlsx' ? await buildBookXlsx(book) : await buildBookPdf(book);
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity,
      entityId: book.reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter } },
      ctx,
    });
    return {
      body,
      fileName: `${name}.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }

  async dashboardFile(
    access: ResolvedAccess,
    q: DashboardQuery,
    format: Format,
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const v = await this.dashboard.view(access, q);
    const c = v.cards;
    const cards: (string | number | null)[][] = [];
    if (c.waiting)
      cards.push([
        'Days waiting approval',
        c.waiting.daily + c.waiting.monthly,
        `Daily ${String(c.waiting.daily)} · Monthly ${String(c.waiting.monthly)}`,
      ]);
    if (c.openExceptions)
      cards.push([
        'Exceptions still open',
        c.openExceptions.pending + c.openExceptions.partial,
        `Pending ${String(c.openExceptions.pending)} · Partial ${String(c.openExceptions.partial)}`,
      ]);
    if (c.licences)
      cards.push([
        'Licences due',
        c.licences.due + c.licences.expired,
        `Due ${String(c.licences.due)} · Expired ${String(c.licences.expired)}`,
      ]);
    if (c.auditOverdue !== null) cards.push(['Audit observations overdue', c.auditOverdue, null]);
    if (c.notInitiated !== null)
      cards.push([
        'Reports not initiated',
        c.notInitiated,
        `No Daily MIS and no Exception · ${formatDate(c.notInitiatedDate)}`,
      ]);
    const sections: ReportSection[] = [
      {
        title: 'Count cards',
        columns: [
          cellColumn('Card', 0, 30),
          cellColumn('Count', 1, 10, 0),
          cellColumn('Detail', 2, 40),
        ],
        rows: cards,
      },
    ];
    if (v.pending)
      sections.push({
        title: 'Pending approval',
        columns: [
          cellColumn('Plant', 0, 24),
          cellColumn('Date / Month', 1, 14),
          cellColumn('Module', 2, 14),
          cellColumn('Entered by', 3, 20),
          cellColumn('Status', 4, 10),
          cellColumn('Waiting hours', 5, 12, 1),
        ],
        rows: v.pending.map((r) => [
          r.plant.name,
          periodText(r.period),
          r.module === 'DAILY_MIS' ? 'Daily MIS' : 'Monthly MIS',
          r.enteredBy,
          'Pending',
          r.waitingHours,
        ]),
      });
    if (v.openExceptions)
      sections.push({
        title: 'Open exceptions',
        columns: [
          cellColumn('Plant', 0, 24),
          cellColumn('Date', 1, 12),
          cellColumn('Problem highlight', 2, 50),
          cellColumn('Status', 3, 10),
        ],
        rows: v.openExceptions.map((r) => [
          r.plant.name,
          formatDate(r.reportDate),
          r.problemHighlight ??
            (r.answered >= r.lineTotal
              ? 'All lines answered'
              : `Lines ${String(r.answered + 1)}–${String(r.lineTotal)} not yet answered`),
          EXCEPTION_STATUS_TEXT[r.status],
        ]),
      });
    const book: ReportBook = {
      reportName: 'Dashboard',
      subtitle: [
        DASHBOARD_MODULE_LABEL[q.module],
        q.date ? formatDate(q.date) : q.month ? formatMonthYear(q.month) : 'Everything waiting',
      ].join(' · '),
      sections,
      generatedAt: new Date(),
      reportId: newReportId(),
    };
    return this.file(book, format, 'dashboard', 'dashboard', access, q, ctx);
  }
}
