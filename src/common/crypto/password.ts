import argon2 from 'argon2';

/**
 * Password hashing (SEC-1): Argon2id, memory 19 MiB, 2 iterations, parallelism 1 (OWASP minimum),
 * plus a server-side pepper (PASSWORD_PEPPER) passed as Argon2's secret — a database dump alone
 * cannot be brute-forced offline.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string, pepper: string): Promise<string> {
  return argon2.hash(plain, { ...ARGON2_OPTIONS, secret: Buffer.from(pepper, 'utf8') });
}

export async function verifyPassword(
  hash: string,
  plain: string,
  pepper: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain, { secret: Buffer.from(pepper, 'utf8') });
  } catch {
    return false;
  }
}
