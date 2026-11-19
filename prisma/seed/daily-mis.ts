import type { Prisma } from '../../src/generated/prisma/client';
import {
  addDays,
  computeDailyMisDerived,
  firstDayOfMonth,
  monthOf,
  type IsoDate,
} from '../../src/shared';
import { Rng, scaled, type SeedCalendar } from './context';
import { entryPersonFor } from './data/people';
import { WORKING_PLANTS, type PlantSeed } from './data/plants';
import type { Foundation } from './foundation';

type Row = Prisma.DailyMisCreateManyInput;

/** Status overrides keyed `${plantCode}|${authoredDate}` — reproduce the mockup's queue. */
const PENDING = new Set([
  'HPY-011|2026-10-14',
  'HPY-011|2026-10-15',
  'HPB-017|2026-10-15',
  'BPS-004|2026-10-14',
  'CPC-002|2026-10-15',
  'IOW-025|2026-10-15',
  'BPR-009|2026-10-15',
  'BPC-005|2026-10-15',
  'HPR-018|2026-10-15',
  'HPM-019|2026-10-15',
  'HPW-023|2026-10-15',
  'IOG-024|2026-10-15',
  'IOM-027|2026-10-15',
  'BLT-001|2026-10-15',
  'HPG-022|2026-10-15',
]);
const RETURNED: Record<string, { reason: string; at: string; by: 'PM' }> = {
  'HPB-017|2026-10-14': {
    reason:
      'Physical stock (field 19) does not match the tank dip sheet — please recheck. Also add the reason for 95 minutes of electrical time loss in Remarks.',
    at: '2026-10-15 10:02',
    by: 'PM',
  },
  'BPD-014|2026-10-14': {
    reason: 'Filling accuracy figures (39–42) do not add up to 100 % — please correct.',
    at: '2026-10-15 11:30',
    by: 'PM',
  },
  'ION-028|2026-10-13': {
    reason: 'Bulk receipts do not match the tanker challan for 13-10 — please recheck field 10.',
    at: '2026-10-14 10:15',
    by: 'PM',
  },
};

/** Mockup Daily MIS table rows: physical, bottling (11+13), cyl 14.2, cyl 19, gain/loss, accuracy 0 g. */
const PINS: Record<string, [string, string, number, number, string, string]> = {
  'HPY-011|2026-10-14': ['371.120', '209.880', 14020, 540, '-0.090', '61.90'],
  'HPB-017|2026-10-15': ['288.900', '164.020', 11180, 300, '0.000', '64.80'],
  'HPB-017|2026-10-14': ['301.450', '158.300', 10760, 310, '-0.060', '63.10'],
  'BPS-004|2026-10-14': ['512.660', '301.240', 20410, 1120, '0.210', '58.30'],
  'BPS-004|2026-10-13': ['498.210', '296.800', 20120, 1060, '-0.180', '59.00'],
  'CPC-002|2026-10-15': ['604.250', '344.700', 23050, 1480, '-0.340', '57.20'],
  'CPC-002|2026-10-14': ['611.880', '338.140', 22700, 1420, '-0.150', '58.10'],
  'IOK-021|2026-10-15': ['233.540', '121.900', 8300, 180, '0.040', '66.20'],
  'IOK-021|2026-10-14': ['240.120', '119.640', 8150, 170, '-0.020', '65.40'],
};

/** The mockup's exact HPCL Yediyur 15-10-2026 record (all 60 fields shown in the form). */
const YEDIYUR_15_OCT: Partial<Row> = {
  shiftsOperated: 2,
  otHours: '4.00',
  openingStock: '412.380',
  bulkReceipts: '180.000',
  normalCylinderDespatch: '198.420',
  normalTtLoading: '12.000',
  otCylinderDespatch: '14.260',
  otTtLoading: '0.000',
  cylFilled142: 14200,
  cylFilled19: 560,
  prcnReturn: '0.850',
  physicalStock: '368.430',
  lossCarousel: 15,
  lossEld: 0,
  lossOld: 10,
  lossConveyor: 20,
  lossUpDownStream: 0,
  lossUtility: 5,
  lossPowerEb: 35,
  lossMotorCable: 0,
  lossAutomation: 0,
  lossIndentTruck: 0,
  lossFireDrill: 30,
  lossTraining: 0,
  lossManpower: 0,
  indentsStatus: 2,
  pendingIndentReason: '2 indents awaiting truck placement',
  accuracyZero: '62.40',
  accuracy50: '34.40',
  accuracy100: '2.90',
  accuracyBeyond100: '0.30',
  eldTestedPct: '100.00',
  oldTestedPct: '100.00',
  mrPinLeak: 3,
  mrPinCut: 1,
  mrBodyLeak: 0,
  mrBungLeak: 2,
  mrDptHr: 0,
  mrWeight: 4,
  mrOther: 1,
  sqcDefective: 6,
  testBathBodyLeak: 2,
  testBathBungLeak: 1,
  sqcTime: '11:30',
  sqcRemarks: 'SQC on 40 cylinders, all within limits',
};

interface DayMetrics {
  shifts: number;
  otHours: number; // ×100
  normalCyl: number; // ×1000
  normalTt: number;
  otCyl: number;
  otTt: number;
  receipts: number | null; // null = derive from stock target
  prcn: number;
  gain: number; // ×1000
  losses: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  acc: [number, number, number, number]; // ×100, sums to 10000
  eld: number;
  old: number;
  mr: [number, number, number, number, number, number, number];
  indents: number;
}

function randomDay(p: PlantSeed, rng: Rng): DayMetrics {
  const s = p.scale * 1000;
  const normalCyl = Math.round(s * (0.86 + rng.next() * 0.12));
  const otCyl = rng.chance(0.6) ? Math.round(s * (0.03 + rng.next() * 0.05)) : 0;
  const acc0 = rng.int(5800, 6600);
  const acc100 = rng.int(220, 340);
  const beyond = rng.int(10, 60);
  return {
    shifts: p.scale > 200 ? 3 : 2,
    otHours: otCyl > 0 ? rng.int(2, 6) * 100 : 0,
    normalCyl,
    normalTt: rng.chance(0.7) ? rng.int(8, 24) * 1000 : 0,
    otCyl,
    otTt: 0,
    receipts: null,
    prcn: rng.int(0, 1200),
    gain: rng.int(-350, 250),
    losses: [
      rng.int(0, 30),
      rng.int(0, 10),
      rng.int(0, 15),
      rng.int(0, 25),
      rng.int(0, 10),
      rng.int(0, 10),
      rng.chance(0.4) ? rng.int(5, 45) : 0,
      rng.int(0, 10),
      rng.int(0, 10),
      rng.chance(0.15) ? rng.int(10, 60) : 0,
      rng.chance(0.2) ? rng.int(15, 40) : 0,
      rng.chance(0.1) ? rng.int(10, 30) : 0,
      rng.int(0, 10),
    ],
    acc: [acc0, 10000 - acc0 - acc100 - beyond, acc100, beyond],
    eld: rng.int(9950, 10000),
    old: rng.int(9930, 10000),
    mr: [
      rng.int(0, 4),
      rng.int(0, 2),
      rng.int(0, 2),
      rng.int(0, 3),
      rng.int(0, 1),
      rng.int(0, 4),
      rng.int(0, 2),
    ],
    indents: rng.int(0, 3),
  };
}

/**
 * HPCL Yediyur, authored month September 2026 (30 days, all Approved): fitted so the Monthly MIS
 * Cumulative Daily Summary equals the mockup (items 1–25) exactly.
 */
function yediyurSeptember(rng: Rng): DayMetrics[] {
  const n = 30;
  const normalCyl = rng.fitTotal(n, 5_952_600, 6000);
  const otCyl = rng.fitTotal(n, 427_800, 4000);
  const gain = rng.fitTotal(n, -2840, 150);
  const mech = rng.fitTotal(n, 1320, 15);
  const elec = rng.fitTotal(n, 945, 12);
  const indent = rng.fitTotal(n, 120, 4);
  const misc = rng.fitTotal(n, 540, 10);
  const acc0 = rng.fitTotal(n, 6180 * n, 120);
  const delta = rng.zeroSum(n, 15);
  const eps = rng.zeroSum(n, 15);
  const eld = rng.fitTotal(n, 9980 * n, 20);
  const old = rng.fitTotal(n, 9960 * n, 30);
  const mr = rng.fitTotal(n, 318, 4);
  const split = (total: number, parts: number): number[] => {
    const out = Array.from({ length: parts }, () => 0);
    for (let i = 0; i < total; i++) {
      const k = rng.int(0, parts - 1);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  return Array.from({ length: n }, (_, i): DayMetrics => {
    const a0 = acc0[i] ?? 0;
    const a50 = 9690 - a0 + (delta[i] ?? 0);
    const a100 = 270 + (eps[i] ?? 0);
    const m = split(Math.max(0, mech[i] ?? 0), 6);
    const e = split(Math.max(0, elec[i] ?? 0), 3);
    const x = split(Math.max(0, misc[i] ?? 0), 3);
    const r = split(Math.max(0, mr[i] ?? 0), 7);
    return {
      shifts: 2,
      otHours: 0, // set by fixOtHours (exactly 96 h)
      normalCyl: normalCyl[i] ?? 0,
      normalTt: 12_000,
      otCyl: otCyl[i] ?? 0,
      otTt: 0,
      receipts: 180_000,
      prcn: rng.int(300, 1100),
      gain: gain[i] ?? 0,
      losses: [
        m[0] ?? 0,
        m[1] ?? 0,
        m[2] ?? 0,
        m[3] ?? 0,
        m[4] ?? 0,
        m[5] ?? 0,
        e[0] ?? 0,
        e[1] ?? 0,
        e[2] ?? 0,
        indent[i] ?? 0,
        x[0] ?? 0,
        x[1] ?? 0,
        x[2] ?? 0,
      ],
      acc: [a0, a50, a100, 10000 - a0 - a50 - a100],
      eld: eld[i] ?? 0,
      old: old[i] ?? 0,
      mr: [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0, r[4] ?? 0, r[5] ?? 0, r[6] ?? 0],
      indents: rng.int(0, 3),
    };
  });
}

function fixOtHours(days: DayMetrics[]): void {
  // Exactly 96 h over 30 days: 24 days × 3 h + 6 days × 4 h.
  days.forEach((d, i) => {
    d.otHours = i % 5 === 0 ? 400 : 300;
  });
}

export interface DailySeedResult {
  rows: number;
  startDate: IsoDate;
}

export async function seedDailyMis(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  f: Foundation,
): Promise<DailySeedResult> {
  const today = cal.today;
  const monthM1 = monthOf(addDays(firstDayOfMonth(monthOf(today)), -1));
  const monthM2 = monthOf(addDays(firstDayOfMonth(monthM1), -1));
  const start = firstDayOfMonth(monthM2);
  const rows: Row[] = [];
  const revisions: Prisma.DailyMisRevisionCreateManyInput[] = [];

  for (const plant of WORKING_PLANTS) {
    const plantId = f.plantId[plant.code];
    const entered = f.userId[entryPersonFor(plant.code)];
    const manager = f.userId[plant.manager];
    if (!plantId || !entered || !manager) throw new Error(`Seed refs missing for ${plant.code}`);
    const isYediyur = plant.code === 'HPY-011';
    const sept = isYediyur ? yediyurSeptember(rng) : [];
    if (isYediyur) fixOtHours(sept);
    let opening = isYediyur ? 1_520_000 : Math.round(plant.scale * 2200);

    for (let date = start; date < today; date = addDays(date, 1)) {
      const authored = addDays(date, -cal.offset);
      const key = `${plant.code}|${authored}`;
      // A few genuinely missed days (Not initiated), never on pinned / fitted days.
      if (!isYediyur && !PINS[key] && !PENDING.has(key) && !RETURNED[key] && rng.chance(0.015))
        continue;
      if (plant.code === 'ION-028' && authored === '2026-10-15') continue; // only Drafts that day

      const inSept = isYediyur && monthOf(date) === monthM1;
      const m = inSept
        ? (sept[Number(date.slice(8)) - 1] ?? randomDay(plant, rng))
        : randomDay(plant, rng);
      const despatch = m.normalCyl + m.normalTt + m.otCyl + m.otTt;
      const target = isYediyur
        ? monthOf(date) === monthM2
          ? 1_650_000
          : 400_000
        : Math.round(plant.scale * 2200);
      let receipts =
        m.receipts ??
        Math.max(
          0,
          Math.round(
            despatch - m.prcn + (target - opening) * 0.3 + (rng.next() - 0.5) * plant.scale * 60,
          ),
        );
      receipts = Math.round(receipts / 10) * 10;
      let closing = opening + receipts - despatch + m.prcn;
      let physical = closing + m.gain;

      const pin = PINS[key];
      let cyl142 = Math.round(((m.normalCyl + m.otCyl) / 14.2) * 0.93);
      let cyl19 = Math.round(((m.normalCyl + m.otCyl) / 19) * 0.035);
      const acc = [...m.acc];
      if (pin) {
        const [phys, bottling, c142, c19, gain, acc0] = pin;
        const bott = Math.round(Number(bottling) * 1000);
        m.otCyl = Math.round(bott * 0.065);
        m.normalCyl = bott - m.otCyl;
        physical = Math.round(Number(phys) * 1000);
        m.gain = Math.round(Number(gain) * 1000);
        closing = physical - m.gain;
        const desp = m.normalCyl + m.normalTt + m.otCyl + m.otTt;
        receipts = closing - opening + desp - m.prcn;
        if (receipts < 0) {
          receipts = 0;
          opening = closing + desp - m.prcn;
        }
        cyl142 = c142;
        cyl19 = c19;
        const a0 = Math.round(Number(acc0) * 100);
        acc[1] = (acc[1] ?? 0) + (acc[0] ?? 0) - a0;
        acc[0] = a0;
      }

      let values: Partial<Row> = {
        shiftsOperated: m.shifts,
        otHours: scaled.two(m.otHours),
        openingStock: scaled.mt(opening),
        bulkReceipts: scaled.mt(receipts),
        normalCylinderDespatch: scaled.mt(m.normalCyl),
        normalTtLoading: scaled.mt(m.normalTt),
        otCylinderDespatch: scaled.mt(m.otCyl),
        otTtLoading: scaled.mt(m.otTt),
        cylFilled142: cyl142,
        cylFilled19: cyl19,
        prcnReturn: scaled.mt(m.prcn),
        physicalStock: scaled.mt(physical),
        lossCarousel: m.losses[0],
        lossEld: m.losses[1],
        lossOld: m.losses[2],
        lossConveyor: m.losses[3],
        lossUpDownStream: m.losses[4],
        lossUtility: m.losses[5],
        lossPowerEb: m.losses[6],
        lossMotorCable: m.losses[7],
        lossAutomation: m.losses[8],
        lossIndentTruck: m.losses[9],
        lossFireDrill: m.losses[10],
        lossTraining: m.losses[11],
        lossManpower: m.losses[12],
        indentsStatus: m.indents,
        pendingIndentReason:
          m.indents > 0 ? `${m.indents} indent(s) awaiting truck placement` : null,
        accuracyZero: scaled.pct(acc[0] ?? 0),
        accuracy50: scaled.pct(acc[1] ?? 0),
        accuracy100: scaled.pct(acc[2] ?? 0),
        accuracyBeyond100: scaled.pct(acc[3] ?? 0),
        eldTestedPct: scaled.pct(m.eld),
        oldTestedPct: scaled.pct(m.old),
        mrPinLeak: m.mr[0],
        mrPinCut: m.mr[1],
        mrBodyLeak: m.mr[2],
        mrBungLeak: m.mr[3],
        mrDptHr: m.mr[4],
        mrWeight: m.mr[5],
        mrOther: m.mr[6],
        sqcDefective: rng.int(0, 8),
        testBathBodyLeak: rng.int(0, 3),
        testBathBungLeak: rng.int(0, 2),
        sqcTime: `${String(rng.int(10, 15)).padStart(2, '0')}:${rng.pick(['00', '15', '30', '45'])}`,
        sqcRemarks: 'SQC done, all within limits',
      };
      if (isYediyur && authored === '2026-10-15') values = { ...YEDIYUR_15_OCT };

      const derived = computeDailyMisDerived(
        values as Parameters<typeof computeDailyMisDerived>[0],
      );
      opening = Math.round(Number(values.physicalStock) * 1000);

      const createdAt = cal.at(
        date,
        `${rng.int(20, 23)}:${String(rng.int(0, 59)).padStart(2, '0')}`,
      );
      const returned = RETURNED[key];
      const status = PENDING.has(key) ? 'PENDING' : returned ? 'RETURNED' : 'APPROVED';
      const approvedAt =
        status === 'APPROVED'
          ? cal.at(addDays(date, 1), `${rng.int(9, 10)}:${String(rng.int(0, 59)).padStart(2, '0')}`)
          : null;
      const id = crypto.randomUUID();
      const returnedAt = returned
        ? cal.atAuthored(...(returned.at.split(' ') as [IsoDate, string]))
        : null;
      // The entry person re-saves 38 minutes after the Return (mockup save history v2).
      const resavedAt = returnedAt ? new Date(returnedAt.getTime() + 38 * 60_000) : null;
      const row: Row = {
        id,
        plantId,
        reportDate: cal.date(date),
        status,
        enteredById: entered,
        lastModifiedById: entered,
        ...values,
        ...derived,
        submittedAt: createdAt,
        approvedById: approvedAt ? manager : null,
        approvedAt,
        returnedById: returned ? manager : null,
        returnedAt,
        returnReason: returned?.reason ?? null,
        version: returned ? 2 : 1,
        createdAt,
        updatedAt: resavedAt ?? approvedAt ?? createdAt,
      };
      rows.push(row);
      const snapshot = { ...values, ...derived } as Prisma.InputJsonValue;
      revisions.push({
        dailyMisId: id,
        plantId,
        version: 1,
        status: returned ? 'PENDING' : status,
        snapshot,
        savedById: entered,
        savedAt: createdAt,
      });
      if (resavedAt) {
        revisions.push({
          dailyMisId: id,
          plantId,
          version: 2,
          status: 'RETURNED',
          snapshot,
          savedById: entered,
          savedAt: resavedAt,
        });
      }
    }
  }

  // Today's Drafts and Nagpur's two Drafts for yesterday (DMIS-T0: both Drafts are shown).
  const draft = (code: string, date: IsoDate, hhmm: string, values: Partial<Row>): void => {
    const plantId = f.plantId[code];
    const entered = f.userId[entryPersonFor(code)];
    if (!plantId || !entered) throw new Error(`Seed refs missing for ${code}`);
    const derived = computeDailyMisDerived(values as Parameters<typeof computeDailyMisDerived>[0]);
    const createdAt = cal.at(date, hhmm);
    const id = crypto.randomUUID();
    rows.push({
      id,
      plantId,
      reportDate: cal.date(date),
      status: 'DRAFT',
      enteredById: entered,
      lastModifiedById: entered,
      ...values,
      ...derived,
      createdAt,
      updatedAt: createdAt,
    });
    revisions.push({
      dailyMisId: id,
      plantId,
      version: 1,
      status: 'DRAFT',
      snapshot: { ...values, ...derived } as Prisma.InputJsonValue,
      savedById: entered,
      savedAt: createdAt,
    });
  };
  draft('HPY-011', today, '11:20', { shiftsOperated: 2 });
  draft('ION-028', cal.rel(-1), '18:02', {});
  draft('ION-028', cal.rel(-1), '19:44', {
    // 404.150 + 245.000 − 247.600 + 1.460 = 403.010 → loss −0.210 (mockup row)
    shiftsOperated: 3,
    otHours: '2.00',
    openingStock: '404.150',
    bulkReceipts: '245.000',
    normalCylinderDespatch: '216.540',
    normalTtLoading: '16.000',
    otCylinderDespatch: '15.060',
    otTtLoading: '0.000',
    cylFilled142: 15600,
    cylFilled19: 700,
    prcnReturn: '1.460',
    physicalStock: '402.800',
    accuracyZero: '60.70',
  });

  for (let i = 0; i < rows.length; i += 500)
    await prisma.dailyMis.createMany({ data: rows.slice(i, i + 500) });
  for (let i = 0; i < revisions.length; i += 500) {
    await prisma.dailyMisRevision.createMany({ data: revisions.slice(i, i + 500) });
  }
  return { rows: rows.length, startDate: start };
}
