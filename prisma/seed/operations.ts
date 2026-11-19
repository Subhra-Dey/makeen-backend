import type { Prisma } from '../../src/generated/prisma/client';
import {
  EQUIPMENT_TYPES,
  addDays,
  financialYearOf,
  type EquipmentType,
  type IsoDate,
  type LicenceType,
  type RenewalFrequency,
} from '../../src/shared';
import type { Rng, SeedCalendar } from './context';
import { PLANTS, WORKING_PLANTS } from './data/plants';
import type { Foundation } from './foundation';

// ───────────────────────────────────────────── plant details (mockup: HPCL Yediyur)

const YEDIYUR_EQUIPMENT: Record<EquipmentType, [number, string | null]> = {
  PUMPS: [6, '2 standby'],
  COMPRESSOR: [3, null],
  FIRE_ENGINE: [2, '1 under service'],
  WATER_PUMPS: [4, null],
  CAPPING_MACHINE: [2, null],
  VALVE_OPENING_MACHINE: [1, null],
  REPAIR_MACHINE: [1, null],
  PURGING_MACHINE: [1, null],
  PNEUMATIC_TESTING: [2, null],
  HYDROTESTING: [1, null],
  PAINTING_BOOTH: [1, null],
  CYLINDER_RETESTING: [1, null],
  CCTV_CAMERAS: [32, null],
  CHAIN_CONVEYOR: [2, 'Carousel line A / B'],
};

export async function seedPlantDetails(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  f: Foundation,
): Promise<void> {
  const fy = financialYearOf(cal.today);
  const fyStart = Number(fy.slice(0, 4));
  const fyLabel = (y: number): string => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  for (const p of PLANTS) {
    const plantId = f.plantId[p.code];
    const managerId = f.userId[p.manager];
    if (!plantId || !managerId) throw new Error(`Seed refs missing for ${p.code}`);
    const yediyur = p.code === 'HPY-011';
    const k = Math.max(p.scale, 100) / 226;
    await prisma.plantDetail.create({
      data: {
        plantId,
        capacity: yediyur ? '120000.000' : `${Math.round(120000 * k)}.000`,
        production: yediyur
          ? '84600.000'
          : p.status === 'NEW'
            ? null
            : `${Math.round(84600 * k)}.000`,
        updatedById: managerId,
      },
    });
    await prisma.plantEquipment.createMany({
      data: EQUIPMENT_TYPES.map((equipment) => {
        const [quantity, note] = yediyur
          ? YEDIYUR_EQUIPMENT[equipment]
          : [rng.int(1, equipment === 'CCTV_CAMERAS' ? 36 : 6), null];
        return { plantId, equipment, quantity, note };
      }),
    });
    const projected = yediyur
      ? [78000, 82000, 86000]
      : [0, 1, 2].map((i) => Math.round(78000 * k * (1 + i * 0.05)));
    const minimum = yediyur ? [62000, 65000, 68000] : projected.map((v) => Math.round(v * 0.8));
    await prisma.plantYearVolume.createMany({
      data: [0, 1, 2].flatMap((i) => [
        {
          plantId,
          type: 'PROJECTED' as const,
          fy: fyLabel(fyStart - 2 + i),
          volumeMt: `${projected[i] ?? 0}.000`,
        },
        {
          plantId,
          type: 'MINIMUM' as const,
          fy: fyLabel(fyStart - 2 + i),
          volumeMt: `${minimum[i] ?? 0}.000`,
        },
      ]),
    });
    if (yediyur) {
      await prisma.plantActivity.create({
        data: {
          plantId,
          heading: 'Carousel line B commissioned',
          description: `Second 24-point carousel commissioned on ${cal.d('2026-09-12').split('-').reverse().join('-')}.`,
          createdById: managerId,
          createdAt: cal.atAuthored('2026-09-12', '16:00'),
        },
      });
    }
  }
}

// ───────────────────────────────────────────── audits & observations

interface ObsTemplate {
  sub: string;
  ref: string;
  particular: string;
  observation: string;
  recommendation: string;
  action: string;
}

const MOCKUP_OBS: (ObsTemplate & {
  code: string;
  target: IsoDate;
  revised: IsoDate | null;
  status: 'PENDING' | 'COMPLIED';
})[] = [
  {
    code: 'OB-0141',
    sub: 'CR-03',
    ref: 'OISD-144/5.6',
    particular: 'Carousel',
    observation: 'Guard missing at head 18',
    recommendation: 'Fit guard',
    action: 'Guard fitted',
    target: '2026-09-22',
    revised: '2026-09-25',
    status: 'COMPLIED',
  },
  {
    code: 'OB-0142',
    sub: 'FS-02',
    ref: 'OISD-144/4.2',
    particular: 'Fire water network',
    observation: 'Hydrant H-14 valve stuck',
    recommendation: 'Replace valve and pressure test',
    action: 'Valve on order, PO raised',
    target: '2026-09-30',
    revised: '2026-10-10',
    status: 'PENDING',
  },
  {
    code: 'OB-0143',
    sub: 'EL-05',
    ref: 'OISD-144/7.1',
    particular: 'Earthing',
    observation: 'Earth pit E-6 resistance 6.2 Ω',
    recommendation: 'Treat pit, retest below 5 Ω',
    action: 'Pit treatment scheduled',
    target: '2026-10-20',
    revised: null,
    status: 'PENDING',
  },
  {
    code: 'OB-0144',
    sub: 'GD-01',
    ref: 'OISD-144/9.3',
    particular: 'Gas detection',
    observation: '2 detectors overdue calibration',
    recommendation: 'Calibrate all detectors',
    action: 'Vendor visit fixed for Nov',
    target: '2026-11-15',
    revised: null,
    status: 'PENDING',
  },
];

const OBS_TEMPLATES: readonly ObsTemplate[] = [
  {
    sub: 'FS-04',
    ref: 'OISD-144/4.5',
    particular: 'Fire water pumps',
    observation: 'Diesel day tank level gauge broken',
    recommendation: 'Replace level gauge',
    action: 'Gauge replaced',
  },
  {
    sub: 'FS-07',
    ref: 'OISD-144/4.9',
    particular: 'Sprinkler system',
    observation: 'Nozzles choked at bay 3',
    recommendation: 'Clean and flush nozzles',
    action: 'Flushing done',
  },
  {
    sub: 'EL-02',
    ref: 'OISD-144/7.3',
    particular: 'Electrical',
    observation: 'Flameproof gland open on motor M-4',
    recommendation: 'Seal gland as per FLP norms',
    action: 'Gland sealed',
  },
  {
    sub: 'MC-01',
    ref: 'OISD-144/6.1',
    particular: 'Mechanical',
    observation: 'Leak at pump P-2 mechanical seal',
    recommendation: 'Replace mechanical seal',
    action: 'Seal replaced',
  },
  {
    sub: 'TL-02',
    ref: 'OISD-144/3.4',
    particular: 'TLD bay',
    observation: 'Earthing clamp worn at bay 2',
    recommendation: 'Replace earthing clamp',
    action: 'Clamp replaced',
  },
  {
    sub: 'HK-01',
    ref: 'OISD-144/2.1',
    particular: 'Housekeeping',
    observation: 'Dry grass near boundary wall',
    recommendation: 'Clear vegetation inside 10 m',
    action: 'Vegetation cleared',
  },
  {
    sub: 'GD-03',
    ref: 'OISD-144/9.5',
    particular: 'Gas detection',
    observation: 'Detector GD-11 alarm set point drifted',
    recommendation: 'Recalibrate GD-11',
    action: 'Recalibrated',
  },
  {
    sub: 'SF-02',
    ref: 'OISD-144/8.2',
    particular: 'Safety equipment',
    observation: 'Two SCBA sets due for hydro test',
    recommendation: 'Hydro test SCBA cylinders',
    action: 'Sent for testing',
  },
  {
    sub: 'DC-01',
    ref: 'OISD-144/1.3',
    particular: 'Documentation',
    observation: 'Permit-to-work register not countersigned',
    recommendation: 'Countersign daily by shift in-charge',
    action: 'Register updated',
  },
  {
    sub: 'ST-01',
    ref: 'OISD-144/5.2',
    particular: 'Storage',
    observation: 'Bullet B-2 roof sprinkler test record missing',
    recommendation: 'Conduct and record test',
    action: 'Test conducted',
  },
];

/** plant, type, frequency, authored FY start/end, totals: complied/pending/overdue. */
const AUDITS: readonly [
  string,
  'ISA' | 'OISD' | 'MEIPL',
  'MONTHS_3' | 'MONTHS_12' | 'YEARS_5',
  IsoDate,
  IsoDate,
  number,
  number,
  number,
][] = [
  ['HPB-017', 'OISD', 'MONTHS_12', '2026-05-05', '2026-05-07', 11, 5, 2],
  ['HPY-011', 'ISA', 'MONTHS_3', '2026-08-12', '2026-08-13', 10, 4, 0],
  ['BPS-004', 'MEIPL', 'MONTHS_3', '2026-07-20', '2026-07-21', 9, 2, 1],
  ['CPC-002', 'ISA', 'YEARS_5', '2026-06-02', '2026-06-04', 8, 4, 2],
  ['IOK-021', 'OISD', 'MONTHS_12', '2025-11-11', '2025-11-13', 3, 2, 1],
];

export async function seedAudits(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  f: Foundation,
): Promise<number> {
  let seq = 159; // OB-0141…0158 belong to the HPCL Barhi audit (mockup)
  let count = 0;
  for (const [code, auditType, frequency, start, end, complied, pending, overdue] of AUDITS) {
    const plantId = f.plantId[code];
    const plant = PLANTS.find((p) => p.code === code);
    const creator = plant ? f.userId[plant.manager] : undefined;
    if (!plantId || !creator) throw new Error(`Seed refs missing for audit ${code}`);
    const total = complied + pending + overdue;
    const audit = await prisma.audit.create({
      data: {
        plantId,
        auditType,
        frequency,
        fy: financialYearOf(cal.d(start)),
        totalRecommendations: total,
        startDate: cal.date(cal.d(start)),
        endDate: cal.date(cal.d(end)),
        createdById: creator,
        createdAt: cal.atAuthored(end, '17:00'),
      },
    });
    const isBarhi = code === 'HPB-017';
    const obs: {
      status: 'PENDING' | 'COMPLIED';
      target: IsoDate;
      revised: IsoDate | null;
      t: ObsTemplate;
      code: string;
    }[] = [];
    if (isBarhi)
      for (const m of MOCKUP_OBS)
        obs.push({
          status: m.status,
          target: cal.d(m.target),
          revised: m.revised ? cal.d(m.revised) : null,
          t: m,
          code: m.code,
        });
    let barhiSeq = 145;
    const nextCode = (): string => `OB-${String(isBarhi ? barhiSeq++ : seq++).padStart(4, '0')}`;
    const want = { COMPLIED: complied, PENDING: pending, OVERDUE: overdue };
    const have = {
      COMPLIED: obs.filter((o) => o.status === 'COMPLIED').length,
      PENDING: obs.filter((o) => o.status === 'PENDING' && (o.revised ?? o.target) >= cal.today)
        .length,
      OVERDUE: obs.filter((o) => o.status === 'PENDING' && (o.revised ?? o.target) < cal.today)
        .length,
    };
    for (const kind of ['COMPLIED', 'PENDING', 'OVERDUE'] as const) {
      for (let i = have[kind]; i < want[kind]; i++) {
        const t = rng.pick(OBS_TEMPLATES);
        const target =
          kind === 'COMPLIED'
            ? cal.rel(-rng.int(20, 120))
            : kind === 'OVERDUE'
              ? cal.rel(-rng.int(2, 25))
              : cal.rel(rng.int(i === 0 ? 3 : 10, 60));
        obs.push({
          status: kind === 'COMPLIED' ? 'COMPLIED' : 'PENDING',
          target,
          revised: null,
          t,
          code: nextCode(),
        });
      }
    }
    await prisma.auditObservation.createMany({
      data: obs.map((o) => ({
        auditId: audit.id,
        plantId,
        observationCode: o.code,
        subGroupCode: o.t.sub,
        checklistRef: o.t.ref,
        particular: o.t.particular,
        observation: o.t.observation,
        recommendation: o.t.recommendation,
        actionPlan: o.t.action,
        targetDate: cal.date(o.target),
        revisedTargetDate: o.revised ? cal.date(o.revised) : null,
        status: o.status,
      })),
    });
    count += obs.length;
  }
  return count;
}

// ───────────────────────────────────────────── licences

const ITEMS: Record<LicenceType, readonly string[]> = {
  STATUTORY: [
    'PESO storage licence',
    'Factory licence',
    'Fire NOC',
    'Pollution CTO',
    'Legal metrology stamping',
    'Trade licence',
  ],
  SAFETY_CALIBRATION: ['Safety relief valve calibration', 'Pressure gauge calibration'],
  ELECTRICAL_CALIBRATION: ['Earth pit resistance test', 'ELCB / RCCB trip test'],
  MAINTENANCE_CALIBRATION: ['Weighing scale calibration', 'Gas detector calibration'],
};

const FREQ_DAYS: Record<RenewalFrequency, number> = {
  MONTHLY: 30,
  QUARTERLY: 91,
  HALF_YEARLY: 182,
  YEARLY: 365,
  NA: 0,
};
const DEFAULT_FREQ: Record<string, RenewalFrequency> = {
  'PESO storage licence': 'YEARLY',
  'Factory licence': 'YEARLY',
  'Fire NOC': 'YEARLY',
  'Pollution CTO': 'YEARLY',
  'Legal metrology stamping': 'YEARLY',
  'Trade licence': 'YEARLY',
  'Safety relief valve calibration': 'YEARLY',
  'Pressure gauge calibration': 'HALF_YEARLY',
  'Earth pit resistance test': 'QUARTERLY',
  'ELCB / RCCB trip test': 'MONTHLY',
  'Weighing scale calibration': 'QUARTERLY',
  'Gas detector calibration': 'HALF_YEARLY',
};

/** Exact rows from the mockup + extra Due rows (authored dates): start, end, freq, remind, docRef. */
const FIXED: Record<
  string,
  [IsoDate | null, IsoDate | null, RenewalFrequency, number, string | null]
> = {
  'BPK-012|Factory licence': ['2025-01-01', '2025-12-31', 'YEARLY', 30, 'FAC/JH/2291'],
  'IOM-027|Fire NOC': ['2025-10-15', '2026-10-14', 'YEARLY', 30, 'FIRE/BR/774'],
  'BPK-012|PESO storage licence': ['2021-11-15', '2026-11-14', 'YEARLY', 30, 'PESO/ST/88'],
  'HPY-011|Safety relief valve calibration': [
    '2025-11-01',
    '2026-10-31',
    'YEARLY',
    30,
    'SRV/KA/112',
  ],
  'HPY-011|Pollution CTO': ['2025-04-01', '2030-03-31', 'YEARLY', 30, 'KSPCB/CTO/4410'],
  'CPC-002|Pressure gauge calibration': ['2026-07-01', '2026-12-31', 'HALF_YEARLY', 30, 'PG/TN/09'],
  'IOK-021|Legal metrology stamping': [null, null, 'YEARLY', 30, 'LM/CG/551'],
  'BPS-004|Trade licence': [null, null, 'NA', 0, null],
  'HPB-017|Earth pit resistance test': ['2026-07-15', '2026-10-14', 'QUARTERLY', 15, 'EPT/JH/32'],
  'HPY-011|Weighing scale calibration': ['2026-07-20', '2026-10-19', 'QUARTERLY', 15, 'WS/KA/08'],
  'IOW-025|ELCB / RCCB trip test': ['2026-10-01', '2026-10-31', 'MONTHLY', 7, 'EL/MP/14'],
  'BPS-004|Gas detector calibration': ['2026-09-01', '2027-02-28', 'HALF_YEARLY', 30, 'GD/GJ/27'],
  'CPC-002|Fire NOC': ['2025-11-06', '2026-11-05', 'YEARLY', 30, 'FIRE/TN/318'],
  'HPM-019|Pollution CTO': ['2025-11-11', '2026-11-10', 'YEARLY', 30, 'BSPCB/CTO/221'],
  'IOG-024|Gas detector calibration': ['2026-04-26', '2026-10-25', 'HALF_YEARLY', 15, 'GD/UP/41'],
  'HPC-020|Trade licence': [null, null, 'NA', 0, null],
  'IOJ-026|Trade licence': [null, null, 'NA', 0, null],
  'HPG-022|Legal metrology stamping': [null, null, 'YEARLY', 30, null],
  'BLT-001|Trade licence': [null, null, 'NA', 0, null],
};

export async function seedLicences(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  f: Foundation,
): Promise<number> {
  const itemId: Record<string, string> = {};
  for (const [type, titles] of Object.entries(ITEMS) as [LicenceType, readonly string[]][]) {
    for (const title of titles) {
      const item = await prisma.licenceItem.create({ data: { licenceType: type, title } });
      itemId[title] = item.id;
    }
  }
  let count = 0;
  for (const plant of WORKING_PLANTS) {
    const plantId = f.plantId[plant.code];
    const pm = f.userId[plant.manager];
    if (!plantId || !pm) throw new Error(`Seed refs missing for ${plant.code}`);
    for (const [type, titles] of Object.entries(ITEMS) as [LicenceType, readonly string[]][]) {
      for (const title of titles) {
        const fixed = FIXED[`${plant.code}|${title}`];
        const frequency = fixed?.[2] ?? DEFAULT_FREQ[title] ?? 'YEARLY';
        const remind =
          fixed?.[3] ?? (frequency === 'MONTHLY' ? 5 : frequency === 'QUARTERLY' ? 15 : 30);
        let start: IsoDate | null;
        let end: IsoDate | null;
        if (fixed) {
          start = fixed[0] ? cal.d(fixed[0]) : null;
          end = fixed[1] ? cal.d(fixed[1]) : null;
        } else {
          // Active: started a while ago, ends comfortably after the remind window.
          const period = FREQ_DAYS[frequency];
          start = cal.rel(-rng.int(5, Math.max(6, Math.floor(period * 0.4))));
          end = addDays(start, period - 1);
          if (end <= addDays(cal.today, remind)) end = addDays(cal.today, remind + rng.int(10, 40));
        }
        const remindUsers = [
          pm,
          ...(fixed && end && end <= addDays(cal.today, remind) ? [f.adminId] : []),
        ];
        const category =
          type === 'STATUTORY' || type === 'SAFETY_CALIBRATION' ? 'STATUTORY' : 'INTERNAL';
        await prisma.licence.create({
          data: {
            plantId,
            category,
            licenceType: type,
            itemId: itemId[title] ?? '',
            docRef:
              fixed?.[4] ?? `${title.slice(0, 3).toUpperCase()}/${plant.code}/${rng.int(10, 999)}`,
            notes:
              title === 'PESO storage licence' && plant.code === 'BPK-012'
                ? 'Renewal application filed 02-10-2026'
                : null,
            startDate: start ? cal.date(start) : null,
            endDate: end ? cal.date(end) : null,
            frequency,
            remindBeforeDays: remind,
            createdById: pm,
            remindUsers: {
              create: [...new Set(remindUsers)].map((userId) => ({ userId, plantId })),
            },
          },
        });
        count += 1;
      }
    }
  }
  return count;
}
