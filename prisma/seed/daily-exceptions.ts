import type { Prisma } from '../../src/generated/prisma/client';
import { DAILY_EXCEPTION_LINE_COUNT, addDays, type IsoDate } from '../../src/shared';
import type { Rng, SeedCalendar } from './context';
import { entryPersonFor } from './data/people';
import { WORKING_PLANTS } from './data/plants';
import type { Foundation } from './foundation';

interface OpenException {
  status: 'PENDING' | 'PARTIAL';
  time: string;
  highlight: string | null;
  /** lineNo → details for the Yes line(s); unanswered lines for Partial. */
  yes?: Record<number, Record<string, string | number>>;
  answeredUpTo?: number;
  by?: string;
}

/** The open exceptions shown on the mockup Dashboard / Daily Exceptions table (authored dates). */
const OPEN: Record<string, OpenException> = {
  'IOW-025|2026-10-16': {
    status: 'PENDING',
    time: '08:41',
    by: 'MEI-00901',
    highlight: 'Jockey pump no. 2 on manual — auto controller fault reported',
    yes: { 3: { jockeyPump1: 'AUTO', jockeyPump2: 'MANUAL', jockeyRuns24h: 14 } },
  },
  'HPM-019|2026-10-16': {
    status: 'PENDING',
    time: '07:55',
    highlight: 'CCTV camera 7 (TLD bay) not recording since 06:40',
    yes: {
      12: { cameraTotal: 24, dsoObservation: 'CCTV camera 7 (TLD bay) not recording since 06:40' },
    },
  },
  'ION-028|2026-10-15': {
    status: 'PENDING',
    time: '14:22',
    highlight: 'Incident: minor LPG leak at carousel head 12 — isolated, no injury',
    yes: { 13: { remarks: 'Minor LPG leak at carousel head 12 — isolated, no injury' } },
  },
  'BPD-014|2026-10-15': {
    status: 'PENDING',
    time: '08:10',
    highlight: 'Fire engine 2 under repair — battery replaced, awaiting trial run',
    yes: { 1: { remarks: 'Fire engine 2 under repair — battery replaced, awaiting trial run' } },
  },
  'HPW-023|2026-10-14': {
    status: 'PENDING',
    time: '08:25',
    highlight: 'Line 9 — 2 smoke detectors in the cylinder shed not responding',
    yes: { 9: { gasDetectors: 18, smokeDetectors: 12, alarms24h: 2 } },
  },
  'HPG-022|2026-10-16': { status: 'PARTIAL', time: '09:30', highlight: null, answeredUpTo: 8 },
  'HPB-017|2026-10-15': { status: 'PARTIAL', time: '10:12', highlight: null, answeredUpTo: 6 },
};

/** Today (authored 16-10-2026): these plants have not started their exception yet. */
const NOT_INITIATED_TODAY = new Set(['BPK-012', 'IOM-027', 'BPB-007', 'IOJ-026']);

export async function seedDailyExceptions(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  f: Foundation,
  startDate: IsoDate,
): Promise<number> {
  const rows: Prisma.DailyExceptionCreateManyInput[] = [];
  const lines: Prisma.DailyExceptionLineCreateManyInput[] = [];

  for (const plant of WORKING_PLANTS) {
    const plantId = f.plantId[plant.code];
    if (!plantId) throw new Error(`Plant ${plant.code} missing`);
    for (let date = startDate; date <= cal.today; date = addDays(date, 1)) {
      const authored = addDays(date, -cal.offset);
      const key = `${plant.code}|${authored}`;
      const open = OPEN[key];
      if (date === cal.today && NOT_INITIATED_TODAY.has(plant.code)) continue;
      // A few missed days earlier (Lapse is counted from these; never typed).
      if (!open && date < cal.today && rng.chance(0.012)) continue;

      const enteredCode = open?.by ?? entryPersonFor(plant.code);
      const entered = f.userId[enteredCode];
      if (!entered) throw new Error(`Person ${enteredCode} missing`);
      const createdAt = cal.at(
        date,
        open?.time ?? `0${rng.int(7, 9)}:${String(rng.int(0, 59)).padStart(2, '0')}`,
      );
      const id = crypto.randomUUID();
      rows.push({
        id,
        plantId,
        reportDate: cal.date(date),
        plantStatus: open?.status === 'PARTIAL' ? null : 'OPERATIONAL',
        status: open?.status ?? 'COMPLETED',
        problemHighlight: open?.highlight ?? null,
        enteredById: entered,
        lastModifiedById: entered,
        createdAt,
        updatedAt: createdAt,
      });
      for (let lineNo = 1; lineNo <= DAILY_EXCEPTION_LINE_COUNT; lineNo++) {
        const yes = open?.yes?.[lineNo];
        const unanswered = open?.answeredUpTo !== undefined && lineNo > open.answeredUpTo;
        lines.push({
          exceptionId: id,
          lineNo,
          answer: unanswered ? null : yes ? 'YES' : 'NO',
          details: yes ?? {},
        });
      }
    }
  }

  for (let i = 0; i < rows.length; i += 500)
    await prisma.dailyException.createMany({ data: rows.slice(i, i + 500) });
  for (let i = 0; i < lines.length; i += 2000) {
    await prisma.dailyExceptionLine.createMany({ data: lines.slice(i, i + 2000) });
  }
  return rows.length;
}
