/**
 * Seed context: deterministic randomness and dates relative to SEED_TODAY.
 * The demo world is authored for 16-10-2026 (the mockup's "today"). Every date is shifted by
 * (SEED_TODAY − 2026-10-16) days, so `SEED_TODAY=now` produces the same world around today.
 */
import { addDays, daysBetween, isIsoDate, istToday, type IsoDate } from '../../src/shared';

export const AUTHORED_TODAY: IsoDate = '2026-10-16';

export function resolveSeedToday(raw: string | undefined): IsoDate {
  if (raw === undefined || raw === '' || raw === 'now')
    return raw === 'now' ? istToday() : AUTHORED_TODAY;
  if (!isIsoDate(raw)) throw new Error(`SEED_TODAY must be yyyy-mm-dd or "now", got "${raw}"`);
  return raw;
}

/** mulberry32 — tiny, fast, deterministic PRNG. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** n integers with |x| ≤ maxAbs that sum to exactly 0. */
  zeroSum(n: number, maxAbs: number): number[] {
    const out = Array.from({ length: n }, () => 0);
    for (let i = 0; i + 1 < n; i += 2) {
      const d = this.int(-maxAbs, maxAbs);
      out[i] = d;
      out[i + 1] = -d;
    }
    // shuffle so pairs are not adjacent
    for (let i = n - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] ?? 0, out[i] ?? 0];
    }
    return out;
  }
  /** n integers summing exactly to `total`, each within ±maxAbs of the mean. */
  fitTotal(n: number, total: number, maxAbs: number): number[] {
    const base = Math.trunc(total / n);
    let rest = total - base * n;
    const out = this.zeroSum(n, maxAbs).map((x) => x + base);
    for (let i = 0; rest !== 0; i = (i + 1) % n) {
      const step = rest > 0 ? 1 : -1;
      out[i] = (out[i] ?? 0) + step;
      rest -= step;
    }
    return out;
  }
}

/** Seed-time calendar: shifts authored dates to the chosen SEED_TODAY. */
export class SeedCalendar {
  readonly offset: number;
  constructor(readonly today: IsoDate) {
    this.offset = daysBetween(AUTHORED_TODAY, today);
  }
  /** Authored business date (as in the mockup) → shifted business date. */
  d(authored: IsoDate): IsoDate {
    return addDays(authored, this.offset);
  }
  /** Days relative to today. */
  rel(days: number): IsoDate {
    return addDays(this.today, days);
  }
  /** Business date → Prisma @db.Date value. */
  date(iso: IsoDate): Date {
    return new Date(`${iso}T00:00:00.000Z`);
  }
  /** IST wall-clock time on a business date → instant. */
  at(iso: IsoDate, hhmm: string): Date {
    const [h = '0', m = '0'] = hhmm.split(':');
    const out = new Date(`${iso}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00.000+05:30`);
    if (Number.isNaN(out.getTime())) throw new RangeError(`Bad seed time ${iso} ${hhmm}`);
    return out;
  }
  /** Authored IST instant (dd as in mockup) → shifted instant. */
  atAuthored(authored: IsoDate, hhmm: string): Date {
    return this.at(this.d(authored), hhmm);
  }
}

export const scaled = {
  /** 3-decimal scaled int → decimal string. */
  mt: (v: number): string => (v / 1000).toFixed(3),
  pct: (v: number): string => (v / 100).toFixed(2),
  two: (v: number): string => (v / 100).toFixed(2),
};
