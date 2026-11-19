import { randomBytes } from 'node:crypto';
import { decryptAadhaar, encryptAadhaar, normaliseAadhaar } from './aadhaar';
import { hashPassword, verifyPassword } from './password';
import { generatePlantKey } from './plant-key';

describe('password hashing (SEC-1)', () => {
  const pepper = 'test-pepper-value';

  it('hashes with Argon2id ≥ 19 MiB / t=2 / p=1 and verifies', async () => {
    const hash = await hashPassword('Correct-Horse-9', pepper);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(verifyPassword(hash, 'Correct-Horse-9', pepper)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password', pepper)).resolves.toBe(false);
  });

  it('needs the server pepper — a stolen hash alone does not verify', async () => {
    const hash = await hashPassword('Correct-Horse-9', pepper);
    await expect(verifyPassword(hash, 'Correct-Horse-9', 'other-pepper')).resolves.toBe(false);
  });

  it('never throws on a malformed hash', async () => {
    await expect(verifyPassword('not-a-hash', 'x', pepper)).resolves.toBe(false);
  });
});

describe('Aadhaar encryption (SEC-12)', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips and keeps only the last 4 in clear', () => {
    const e = encryptAadhaar('2345 6789 4821', key, 'k1');
    expect(e.last4).toBe('4821');
    expect(e.enc.toString('utf8')).not.toContain('234567894821');
    expect(decryptAadhaar(e.enc, key, 'k1')).toBe('234567894821');
  });

  it('uses a fresh IV every time', () => {
    const a = encryptAadhaar('234567894821', key, 'k1');
    const b = encryptAadhaar('234567894821', key, 'k1');
    expect(a.enc.equals(b.enc)).toBe(false);
  });

  it('fails on tampering, wrong key or wrong key id', () => {
    const e = encryptAadhaar('234567894821', key, 'k1');
    const tampered = Buffer.from(e.enc);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decryptAadhaar(tampered, key, 'k1')).toThrow();
    expect(() => decryptAadhaar(e.enc, randomBytes(32).toString('base64'), 'k1')).toThrow();
    expect(() => decryptAadhaar(e.enc, key, 'k2')).toThrow();
  });

  it('accepts only 12 digits', () => {
    expect(() => normaliseAadhaar('1234')).toThrow(RangeError);
  });
});

describe('plant key (D-35)', () => {
  it('has the PK-XXXXXX format', () => {
    for (let i = 0; i < 20; i++) expect(generatePlantKey()).toMatch(/^PK-[0-9A-F]{6}$/);
  });
});
