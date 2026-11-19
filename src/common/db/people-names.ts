import type { Tx } from '../../prisma/prisma.service';
import type { PersonRef } from '../../shared';

/** Names of many people in one query (id → name). Unknown ids are simply missing. */
export async function namesOf(
  tx: Tx,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => i !== null))];
  if (unique.length === 0) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

export function personRef(names: Map<string, string>, id: string | null): PersonRef | null {
  return id === null ? null : { id, name: names.get(id) ?? '—' };
}

/** ISO business date of a Prisma `@db.Date` value. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const dayOf = (v: string): Date => new Date(`${v}T00:00:00.000Z`);
export const isoDayOrNull = (d: Date | null): string | null => (d ? isoDay(d) : null);
