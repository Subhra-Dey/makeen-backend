import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatDateTimeIst, formatNumber } from '../../shared';

/**
 * Report downloads (BTN-4, BEV-6). Every file carries the report name and a report ID in the
 * header and the IST time stamp in the footer; numbers use en-IN grouping. Callers pass the rows
 * and totals of EXACTLY the query the screen shows, so file numbers equal screen numbers.
 */
export interface ReportColumn<T> {
  header: string;
  /** Excel width (characters) — PDF widths are proportional to it. */
  width: number;
  /** Decimal places for numeric columns; omit for text. */
  decimals?: number;
  value: (row: T) => string | number | null;
}

export interface ReportSpec<T> {
  reportName: string;
  /** Second header line, e.g. “HPCL Yediyur · 01-10-2026 to 16-10-2026”. */
  subtitle: string;
  columns: readonly ReportColumn<T>[];
  rows: readonly T[];
  /** Totals row, one cell per column (null = blank). */
  totals?: readonly (string | number | null)[];
  generatedAt: Date;
  reportId: string;
}

export interface ReportFile {
  body: Buffer;
  fileName: string;
  contentType: string;
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * `attachment` with a plain-ASCII fallback name and, when the name has other characters, the
 * exact UTF-8 name (RFC 6266 / 5987). Quotes and control characters never reach the header.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  if (ascii === fileName) return `attachment; filename="${ascii}"`;
  const utf8 = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Stream a report file as a download (`attachment`, never rendered inline; nosniff). */
export function sendFile(
  res: { setHeader: (name: string, value: string) => unknown; end: (body: Buffer) => unknown },
  file: ReportFile,
): void {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', contentDisposition(file.fileName));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.body);
}

/** e.g. RPT-7F3A21C4 — printed on the file and written to the audit log with the filter. */
export function newReportId(): string {
  return `RPT-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Excel cells must never start a formula from user text (CSV/formula injection). */
function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** en-IN number format with the column's decimals (lakh / crore grouping). */
function indianNumFmt(decimals: number): string {
  const frac = decimals > 0 ? `.${'0'.repeat(decimals)}` : '';
  return `[>=10000000]##\\,##\\,##\\,##0${frac};[>=100000]##\\,##\\,##0${frac};##,##0${frac}`;
}

function display(v: string | number | null, decimals: number | undefined): string {
  if (v === null || v === '') return '—';
  if (decimals === undefined) return String(v);
  return formatNumber(v, decimals);
}

export async function buildXlsx<T>(spec: ReportSpec<T>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MAKEEN FM Portal';
  wb.created = spec.generatedAt;
  const ws = wb.addWorksheet(spec.reportName.slice(0, 31), {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: 5 }],
  });
  const stamp = `Generated ${formatDateTimeIst(spec.generatedAt)}`;
  ws.headerFooter.oddHeader = `&L&B${spec.reportName}&R${spec.reportId}`;
  ws.headerFooter.oddFooter = `&L${stamp}&RPage &P of &N`;

  ws.addRow([spec.reportName]).font = { bold: true, size: 14 };
  ws.addRow([`Report ID: ${spec.reportId}`]);
  ws.addRow([spec.subtitle]);
  ws.addRow([]);
  const head = ws.addRow(spec.columns.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E9EF' } } };
  });
  spec.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
  });

  const put = (values: readonly (string | number | null)[], bold: boolean): void => {
    const row = ws.addRow(
      values.map((v, i) => {
        const col = spec.columns[i];
        if (v === null || v === '') return null;
        if (col?.decimals !== undefined) return typeof v === 'number' ? v : Number(v);
        return typeof v === 'string' ? safeText(v) : v;
      }),
    );
    row.font = { bold };
    spec.columns.forEach((c, i) => {
      if (c.decimals !== undefined) row.getCell(i + 1).numFmt = indianNumFmt(c.decimals);
    });
  };
  for (const r of spec.rows)
    put(
      spec.columns.map((c) => c.value(r)),
      false,
    );
  if (spec.totals) put(spec.totals, true);
  ws.addRow([]);
  ws.addRow([stamp]).font = { italic: true, color: { argb: 'FF4A5B6E' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Inter (latin) ships with @fontsource/inter; resolved from the installed package. */
function fontFile(weight: 400 | 700): string {
  const dir = dirname(require.resolve('@fontsource/inter/package.json'));
  return join(dir, 'files', `inter-latin-${weight}-normal.woff`);
}

function newPdf(): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  doc.registerFont('Body', fontFile(400));
  doc.registerFont('Bold', fontFile(700));
  return doc;
}

function finishPdf(
  doc: PDFKit.PDFDocument,
  spec: { generatedAt: Date; reportId: string },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const y = doc.page.height - 28;
    doc.font('Body').fontSize(8).fillColor('#4A5B6E');
    doc.text(`Generated ${formatDateTimeIst(spec.generatedAt)} · ${spec.reportId}`, 36, y, {
      lineBreak: false,
    });
    doc.text(`Page ${i + 1 - range.start} of ${range.count}`, doc.page.width - 136, y, {
      width: 100,
      align: 'right',
      lineBreak: false,
    });
  }
  doc.end();
  return done;
}

function pdfHeader(doc: PDFKit.PDFDocument, name: string, id: string, subtitle: string): void {
  doc.font('Bold').fontSize(14).fillColor('#0D2B45').text(name, 36, 36);
  doc.font('Body').fontSize(9).fillColor('#4A5B6E').text(`Report ID: ${id}`);
  doc.text(subtitle);
  doc.moveDown(0.6);
}

/** One titled table of a multi-table report (Management Review pack, Graphs). */
export interface ReportSection {
  title: string;
  columns: readonly ReportColumn<readonly (string | number | null)[]>[];
  rows: readonly (readonly (string | number | null)[])[];
  totals?: readonly (string | number | null)[];
}

export interface ReportBook {
  reportName: string;
  subtitle: string;
  sections: readonly ReportSection[];
  generatedAt: Date;
  reportId: string;
}

/** A column that reads cell `i` of an array row (for `ReportSection`). */
export function cellColumn(
  header: string,
  i: number,
  width: number,
  decimals?: number,
): ReportColumn<readonly (string | number | null)[]> {
  return decimals === undefined
    ? { header, width, value: (r) => r[i] ?? null }
    : { header, width, decimals, value: (r) => r[i] ?? null };
}

/** Excel: one sheet per section, each with the report header and the IST time stamp. */
export async function buildBookXlsx(book: ReportBook): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MAKEEN FM Portal';
  wb.created = book.generatedAt;
  const stamp = `Generated ${formatDateTimeIst(book.generatedAt)}`;
  const used = new Set<string>();
  book.sections.forEach((s, n) => {
    let name = s.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28);
    if (used.has(name)) name = `${name.slice(0, 25)} ${String(n + 1)}`;
    used.add(name);
    const ws = wb.addWorksheet(name, {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    ws.headerFooter.oddHeader = `&L&B${book.reportName}&R${book.reportId}`;
    ws.headerFooter.oddFooter = `&L${stamp}&RPage &P of &N`;
    ws.addRow([book.reportName]).font = { bold: true, size: 14 };
    ws.addRow([`Report ID: ${book.reportId}`]);
    ws.addRow([book.subtitle]);
    ws.addRow([s.title]).font = { bold: true };
    const head = ws.addRow(s.columns.map((c) => c.header));
    head.font = { bold: true };
    head.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    });
    s.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width;
    });
    const put = (values: readonly (string | number | null)[], bold: boolean): void => {
      const row = ws.addRow(
        values.map((v, i) => {
          if (v === null || v === '') return null;
          if (s.columns[i]?.decimals !== undefined) return typeof v === 'number' ? v : Number(v);
          return typeof v === 'string' ? safeText(v) : v;
        }),
      );
      row.font = { bold };
      s.columns.forEach((c, i) => {
        if (c.decimals !== undefined) row.getCell(i + 1).numFmt = indianNumFmt(c.decimals);
      });
    };
    for (const r of s.rows)
      put(
        s.columns.map((c) => c.value(r)),
        false,
      );
    if (s.totals) put(s.totals, true);
    if (s.rows.length === 0) ws.addRow(['No rows']);
    ws.addRow([]);
    ws.addRow([stamp]).font = { italic: true, color: { argb: 'FF4A5B6E' } };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** PDF: the sections one after another, each with its title and header row. */
export function buildBookPdf(book: ReportBook): Promise<Buffer> {
  const doc = newPdf();
  pdfHeader(doc, book.reportName, book.reportId, book.subtitle);
  for (const s of book.sections) {
    if (doc.y + 60 > doc.page.height - 48) {
      doc.addPage();
      pdfHeader(doc, book.reportName, book.reportId, book.subtitle);
    }
    doc
      .font('Bold')
      .fontSize(10)
      .fillColor('#0D2B45')
      .text(s.title, 36, doc.y + 4);
    doc.moveDown(0.3);
    drawTable(doc, s, () => {
      pdfHeader(doc, book.reportName, book.reportId, book.subtitle);
    });
    doc.moveDown(0.8);
  }
  return finishPdf(doc, book);
}

function drawTable<T>(
  doc: PDFKit.PDFDocument,
  spec: {
    columns: readonly ReportColumn<T>[];
    rows: readonly T[];
    totals?: readonly (string | number | null)[] | undefined;
  },
  onNewPage: () => void,
): void {
  const left = 36;
  const usable = doc.page.width - 72;
  const totalWidth = spec.columns.reduce((n, c) => n + c.width, 0);
  const widths = spec.columns.map((c) => (c.width / totalWidth) * usable);
  const bottom = doc.page.height - 48;

  const drawRow = (cells: readonly string[], opts: { bold?: boolean; fill?: string }): void => {
    doc.font(opts.bold ? 'Bold' : 'Body').fontSize(8);
    const heights = cells.map((t, i) => doc.heightOfString(t, { width: (widths[i] ?? 40) - 8 }));
    const h = Math.max(...heights, 10) + 8;
    if (doc.y + h > bottom) {
      doc.addPage();
      onNewPage();
      drawRow(
        spec.columns.map((c) => c.header),
        { bold: true, fill: '#F1F5F9' },
      );
      doc.font(opts.bold ? 'Bold' : 'Body').fontSize(8);
    }
    const y = doc.y;
    if (opts.fill) doc.rect(left, y, usable, h).fill(opts.fill);
    let x = left;
    cells.forEach((t, i) => {
      const w = widths[i] ?? 40;
      const numeric = spec.columns[i]?.decimals !== undefined;
      doc
        .fillColor('#0D2B45')
        .text(t, x + 4, y + 4, { width: w - 8, align: numeric ? 'right' : 'left' });
      x += w;
    });
    doc
      .moveTo(left, y + h)
      .lineTo(left + usable, y + h)
      .lineWidth(0.5)
      .strokeColor('#E2E9EF')
      .stroke();
    doc.x = left;
    doc.y = y + h;
  };

  drawRow(
    spec.columns.map((c) => c.header),
    { bold: true, fill: '#F1F5F9' },
  );
  for (const r of spec.rows) {
    drawRow(
      spec.columns.map((c) => display(c.value(r), c.decimals)),
      {},
    );
  }
  if (spec.totals) {
    drawRow(
      spec.totals.map((v, i) => (v === null ? '' : display(v, spec.columns[i]?.decimals))),
      { bold: true, fill: '#EAF6F6' },
    );
  }
  if (spec.rows.length === 0)
    doc
      .font('Body')
      .fontSize(9)
      .text('No rows', left, doc.y + 6);
}

export function buildPdf<T>(spec: ReportSpec<T>): Promise<Buffer> {
  const doc = newPdf();
  pdfHeader(doc, spec.reportName, spec.reportId, spec.subtitle);
  drawTable(doc, spec, () => {
    pdfHeader(doc, spec.reportName, spec.reportId, spec.subtitle);
  });
  return finishPdf(doc, spec);
}

export interface RecordSection {
  title: string;
  items: readonly { no?: number; label: string; value: string }[];
}

/** One record (e.g. a Daily MIS form) as a two-column field list. */
export function buildRecordPdf(spec: {
  reportName: string;
  subtitle: string;
  reportId: string;
  generatedAt: Date;
  sections: readonly RecordSection[];
}): Promise<Buffer> {
  const doc = newPdf();
  const left = 36;
  const usable = doc.page.width - 72;
  const colW = usable / 2;
  const bottom = doc.page.height - 48;
  pdfHeader(doc, spec.reportName, spec.reportId, spec.subtitle);
  for (const s of spec.sections) {
    if (doc.y + 40 > bottom) doc.addPage();
    doc
      .font('Bold')
      .fontSize(10)
      .fillColor('#0D2B45')
      .text(s.title, left, doc.y + 4);
    doc.moveDown(0.3);
    for (let i = 0; i < s.items.length; i += 2) {
      const pair = [s.items[i], s.items[i + 1]];
      doc.font('Body').fontSize(8.5);
      const texts = pair.map((it) =>
        it ? `${it.no !== undefined ? `${it.no}. ` : ''}${it.label}` : '',
      );
      const h =
        Math.max(
          ...pair.map((it, j) =>
            it ? doc.heightOfString(`${texts[j] ?? ''}  ${it.value}`, { width: colW - 12 }) : 0,
          ),
          10,
        ) + 4;
      if (doc.y + h > bottom) doc.addPage();
      const y = doc.y;
      pair.forEach((it, j) => {
        if (!it) return;
        const x = left + j * colW;
        doc
          .font('Body')
          .fillColor('#4A5B6E')
          .text(texts[j] ?? '', x, y, { width: colW * 0.62 - 8 });
        doc
          .font('Bold')
          .fillColor('#0D2B45')
          .text(it.value, x + colW * 0.62, y, { width: colW * 0.38 - 12 });
      });
      doc.x = left;
      doc.y = y + h;
    }
    doc.moveDown(0.5);
  }
  return finishPdf(doc, spec);
}
