import { randomBytes } from 'node:crypto';

/** Plant key shown after create (PLT-C12, D-35): `PK-` + 6 uppercase hex chars from a CSPRNG. */
export function generatePlantKey(): string {
  return `PK-${randomBytes(3).toString('hex').toUpperCase()}`;
}
