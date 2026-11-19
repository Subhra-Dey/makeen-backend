import {
  DAILY_MIS_VALUE_FIELDS,
  deriveDailyMis,
  type DailyMisDerived,
  type DailyMisValueKey,
  type DailyMisValues,
  type FieldDef,
} from '../../shared';

const DECIMAL_KINDS = new Set(['mt', 'percent', 'hours', 'rupees', 'litres', 'units', 'ratio']);
const INT_KINDS = new Set(['count', 'minutes']);
const FIELDS = DAILY_MIS_VALUE_FIELDS as readonly FieldDef<DailyMisValueKey>[];

function isDecimalLike(v: unknown): v is { toFixed: (dp: number) => string } {
  return v !== null && typeof v === 'object' && typeof Reflect.get(v, 'toFixed') === 'function';
}

/** A stored row (or a revision snapshot) → the shared value shape. */
export function valuesFromRecord(record: object): DailyMisValues {
  const out = {} as Record<DailyMisValueKey, string | number | null>;
  for (const f of FIELDS) {
    const raw: unknown = Reflect.get(record, f.key);
    if (DECIMAL_KINDS.has(f.kind) && isDecimalLike(raw)) out[f.key] = raw.toFixed(f.decimals);
    else if (typeof raw === 'number')
      out[f.key] = INT_KINDS.has(f.kind) ? raw : raw.toFixed(f.decimals);
    else if (typeof raw === 'string')
      out[f.key] = INT_KINDS.has(f.kind) && /^\d+$/.test(raw) ? Number(raw) : raw;
    else out[f.key] = null;
  }
  return out;
}

/** Shared values → column data, with the system sums computed here and nowhere else. */
export function recordData(values: DailyMisValues): {
  data: Record<string, string | number | null>;
  derived: DailyMisDerived;
} {
  const data: Record<string, string | number | null> = {};
  for (const f of FIELDS) {
    const v = values[f.key];
    // “No. of shifts operated” is a 0–3 dropdown in the form and a small integer in the table.
    data[f.key] = f.kind === 'select' && v !== null ? Number(v) : v;
  }
  const derived = deriveDailyMis(values);
  return { data: { ...data, ...derived }, derived };
}

/** Every value key present (null when absent) — a save always writes all 48 typed fields. */
export function completeValues(partial: Partial<DailyMisValues>): DailyMisValues {
  const out = {} as Record<DailyMisValueKey, string | number | null>;
  for (const f of FIELDS) out[f.key] = partial[f.key] ?? null;
  return out;
}
