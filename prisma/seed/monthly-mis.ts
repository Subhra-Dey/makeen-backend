import type { Prisma } from '../../src/generated/prisma/client';
import {
  CYLINDER_SIZES,
  CYLINDER_STAT_CATEGORIES,
  INVENTORY_ITEMS,
  addDays,
  cumulativeDailySummary,
  firstDayOfMonth,
  lastDayOfMonth,
  monthOf,
  type CylinderSize,
  type CylinderStatCategory,
  type InventoryItem,
  type IsoDate,
  type IsoMonth,
} from '../../src/shared';
import type { Rng, SeedCalendar } from './context';
import { entryPersonFor } from './data/people';
import { WORKING_PLANTS, type PlantSeed } from './data/plants';
import type { Foundation } from './foundation';

/** Mockup: HPCL Yediyur, September 2026, Block B (items 26–69). */
const YEDIYUR_SEP_INPUTS: Partial<Prisma.MonthlyMisCreateManyInput> = {
  ebUnits: '41250.00',
  dgUnits: '1860.00',
  energyCharges: '412800.00',
  electricityBill: '396400.00',
  dieselBill: '118600.00',
  dieselDg: '1240.00',
  dieselFireEngine: '310.00',
  hoursDg: '62.00',
  hoursFireEngine: '18.00',
  bottlingRevenue: '9240000.00',
  bottlingExpenditure: '7115000.00',
  retestingRevenue: '320000.00',
  retestingExpenditure: '245000.00',
  opexPerCylinder: '18.40',
  operatingCostPerMt: '1092.00',
  tenderCostPerMt: '1150.00',
  penaltyIncurred: 'YES',
  penaltyDetails: 'Short supply on 2 indents — Rs. 18,400',
  trainingStaff: 6,
  trainingWorkmen: 14,
  trainingDrivers: 9,
  trainingTotal: 29,
  unitsPerMt: '6.40',
  powerFactor: '0.980',
  contractDemandKva: '250.00',
  maxDemandKva: '212.00',
  solarAvailable: 'YES',
  solarCapacity: '100 kW',
  solarUnits: '11400.00',
  capsUsedPct: '1.20',
  sealsUsedPct: '1.80',
  oRingsReplacedPct: '0.90',
  valvesReplacedPct: '0.40',
  brownSoapKg: '45.00',
  teflonTape: '12.00',
  defectiveMarketReturn: 74,
  cvrCycleDeviation: 'NO',
  warehouseCycleDeviation: 'NO',
  paintSignalRed: '40.00',
  paintPrimer: '25.00',
  paintStencil: '10.00',
  thinner: '30.00',
};

const YEDIYUR_SEP_CYLINDERS: Record<CylinderStatCategory, readonly number[]> = {
  DUE_TESTING: [120, 2840, 310, 14, 22, 9, 2],
  TESTED_DESPATCHED: [110, 2610, 290, 12, 20, 9, 2],
  CLOSING_DUE_TESTING: [10, 230, 20, 2, 2, 0, 0],
  CLOSING_HOT_REPAIR: [4, 86, 9, 1, 0, 0, 0],
  CLOSING_SCRAP: [2, 41, 5, 0, 1, 0, 0],
};

const YEDIYUR_SEP_INVENTORY: Record<InventoryItem, number> = {
  SCRAP_SC_VALVE: 38,
  SCRAP_REGULATOR: 12,
  NEW_SC_VALVE: 1200,
  NEW_REGULATOR: 340,
  NEW_O_RINGS: 8500,
  NEW_TE_SEALS: 22000,
  NEW_SAFETY_CAPS: 9800,
  NEW_NYLON_THREAD: 40,
  NEW_SS_CLIP: 2600,
  NEW_TEFLON_TAPE: 180,
  DPT_ZINC_CHROMATE_PRIMER: 60,
  DPT_SIGNAL_RED: 85,
  DPT_OXFORD_BLUE: 20,
  DPT_WHITE: 18,
  DPT_YELLOW: 12,
  DPT_BLACK: 10,
  DPT_STENCIL: 15,
};

function randomInputs(p: PlantSeed, rng: Rng): Partial<Prisma.MonthlyMisCreateManyInput> {
  const k = p.scale / 226;
  const money = (base: number): string =>
    (Math.round(base * k * (0.9 + rng.next() * 0.2)) / 1).toFixed(2);
  const staff = rng.int(3, 8);
  const workmen = rng.int(8, 18);
  const drivers = rng.int(4, 12);
  const penalty = rng.chance(0.2);
  const solar = rng.chance(0.4);
  return {
    ebUnits: money(41000),
    dgUnits: money(1800),
    energyCharges: money(410000),
    electricityBill: money(395000),
    dieselBill: money(118000),
    dieselDg: money(1200),
    dieselFireEngine: money(300),
    hoursDg: money(60),
    hoursFireEngine: rng.int(12, 24).toFixed(2),
    bottlingRevenue: money(9200000),
    bottlingExpenditure: money(7100000),
    retestingRevenue: money(320000),
    retestingExpenditure: money(245000),
    opexPerCylinder: (17 + rng.next() * 3).toFixed(2),
    operatingCostPerMt: (1050 + rng.int(0, 90)).toFixed(2),
    tenderCostPerMt: '1150.00',
    penaltyIncurred: penalty ? 'YES' : 'NO',
    penaltyDetails: penalty
      ? `Delayed despatch on ${rng.int(1, 3)} indents — Rs. ${rng.int(5, 25)},000`
      : null,
    trainingStaff: staff,
    trainingWorkmen: workmen,
    trainingDrivers: drivers,
    trainingTotal: staff + workmen + drivers,
    unitsPerMt: (5.8 + rng.next()).toFixed(2),
    powerFactor: (0.95 + rng.next() * 0.04).toFixed(3),
    contractDemandKva: money(250),
    maxDemandKva: money(210),
    solarAvailable: solar ? 'YES' : 'NO',
    solarCapacity: solar ? `${rng.pick([50, 75, 100, 150])} kW` : null,
    solarUnits: solar ? money(11000) : null,
    capsUsedPct: (1 + rng.next()).toFixed(2),
    sealsUsedPct: (1.5 + rng.next()).toFixed(2),
    oRingsReplacedPct: (0.7 + rng.next() * 0.5).toFixed(2),
    valvesReplacedPct: (0.3 + rng.next() * 0.3).toFixed(2),
    brownSoapKg: money(45),
    teflonTape: money(12),
    defectiveMarketReturn: Math.round(74 * k),
    cvrCycleDeviation: rng.chance(0.1) ? 'YES' : 'NO',
    warehouseCycleDeviation: 'NO',
    paintSignalRed: money(40),
    paintPrimer: money(25),
    paintStencil: money(10),
    thinner: money(30),
  };
}

type MonthStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'RETURNED';

/** Authored September 2026 statuses (mockup Monthly MIS table + cards). */
const SEPT_STATUS: Record<string, MonthStatus | 'NONE'> = {
  'HPY-011': 'PENDING',
  'IOK-021': 'PENDING',
  'IOW-025': 'PENDING',
  'HPB-017': 'RETURNED',
  'IOJ-026': 'NONE',
};

/** Mockup "last modified" instants (authored). */
const SEPT_TIMES: Record<string, string> = {
  'HPY-011': '2026-10-05 17:40',
  'IOK-021': '2026-10-15 08:10',
  'BPS-004': '2026-10-08 12:20',
  'CPC-002': '2026-10-07 15:02',
  'HPB-017': '2026-10-10 09:44',
};

export async function seedMonthlyMis(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  f: Foundation,
): Promise<number> {
  const m0: IsoMonth = monthOf(cal.today);
  const m1: IsoMonth = monthOf(addDays(firstDayOfMonth(m0), -1));
  const m2: IsoMonth = monthOf(addDays(firstDayOfMonth(m1), -1));
  let count = 0;

  for (const plant of WORKING_PLANTS) {
    const plantId = f.plantId[plant.code];
    const entered = f.userId[entryPersonFor(plant.code)];
    const manager = f.userId[plant.manager];
    if (!plantId || !entered || !manager) throw new Error(`Seed refs missing for ${plant.code}`);

    for (const month of [m2, m1]) {
      const sept = month === m1;
      const status: MonthStatus | 'NONE' = sept
        ? (SEPT_STATUS[plant.code] ?? 'APPROVED')
        : plant.code === 'IOJ-026'
          ? 'NONE'
          : 'APPROVED';
      if (status === 'NONE') continue;
      const yediyur = sept && plant.code === 'HPY-011';
      const inputs = yediyur ? YEDIYUR_SEP_INPUTS : randomInputs(plant, rng);
      const firstOfNext = addDays(lastDayOfMonth(month), 1);
      const authoredTime = sept ? SEPT_TIMES[plant.code] : undefined;
      const lastModified = authoredTime
        ? cal.atAuthored(...(authoredTime.split(' ') as [IsoDate, string]))
        : cal.at(
            addDays(firstOfNext, rng.int(3, 8)),
            `${rng.int(10, 17)}:${String(rng.int(0, 59)).padStart(2, '0')}`,
          );
      const approvedAt =
        status === 'APPROVED' ? new Date(lastModified.getTime() + 20 * 3_600_000) : null;

      let summarySnapshot: Prisma.InputJsonValue | undefined;
      if (status === 'APPROVED') {
        const approved = await prisma.dailyMis.findMany({
          where: {
            plantId,
            status: 'APPROVED',
            reportDate: {
              gte: cal.date(firstDayOfMonth(month)),
              lte: cal.date(lastDayOfMonth(month)),
            },
          },
        });
        summarySnapshot = {
          ...cumulativeDailySummary(
            approved.map((r) =>
              Object.fromEntries(
                Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)]),
              ),
            ),
          ),
          approvedDays: approved.length,
        };
      }

      await prisma.monthlyMis.create({
        data: {
          plantId,
          month: cal.date(firstDayOfMonth(month)),
          status,
          enteredById: entered,
          lastModifiedById: entered,
          ...inputs,
          cvrCycleCountDate: cal.date(addDays(firstOfNext, -3)),
          warehouseCycleCountDate: cal.date(addDays(firstOfNext, -6)),
          remarks: null,
          ...(summarySnapshot === undefined ? {} : { summarySnapshot }),
          submittedAt: lastModified,
          approvedById: approvedAt ? manager : null,
          approvedAt,
          returnedById: status === 'RETURNED' ? manager : null,
          returnedAt: status === 'RETURNED' ? lastModified : null,
          returnReason:
            status === 'RETURNED'
              ? 'Diesel consumed (31, 32) does not match the diesel bill — please recheck.'
              : null,
          createdAt: new Date(lastModified.getTime() - 2 * 3_600_000),
          updatedAt: lastModified,
          cylinderStats: {
            create: CYLINDER_STAT_CATEGORIES.flatMap((category) =>
              CYLINDER_SIZES.map((size: CylinderSize, i) => ({
                category,
                size,
                quantity: yediyur
                  ? (YEDIYUR_SEP_CYLINDERS[category][i] ?? 0)
                  : rng.int(0, size === 'KG14_2' ? 2600 : 120),
              })),
            ),
          },
          inventoryItems: {
            create: INVENTORY_ITEMS.map((item) => ({
              item,
              quantity: (yediyur
                ? YEDIYUR_SEP_INVENTORY[item]
                : rng.int(5, item.startsWith('NEW_') ? 9000 : 90)
              ).toFixed(2),
            })),
          },
        },
      });
      count += 1;
    }
  }

  // Current month: HPCL Yediyur started a Draft today (mockup: Oct 2026 Draft).
  const yid = f.plantId['HPY-011'];
  const asha = f.userId['MEI-00733'];
  if (yid && asha) {
    const at = cal.at(cal.today, '10:05');
    await prisma.monthlyMis.create({
      data: {
        plantId: yid,
        month: cal.date(firstDayOfMonth(m0)),
        status: 'DRAFT',
        enteredById: asha,
        lastModifiedById: asha,
        createdAt: at,
        updatedAt: at,
      },
    });
    count += 1;
  }
  return count;
}
