import { generateKeyPairSync, createHmac } from 'node:crypto';
import { JwtError, signAccessToken, verifyAccessToken } from './jwt';
import { hmacHex, randomToken, safeEqual, sha256Hex, sixDigitCode } from './tokens';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const expected = { issuer: 'makeen-fm-api', audience: 'makeen-fm-web' };
const claims = { sub: 'u1', sid: 's1', tv: 3, iss: expected.issuer, aud: expected.audience };
const NOW = Date.UTC(2026, 9, 16, 4, 0, 0);

describe('EdDSA access tokens (SEC-2)', () => {
  it('round-trips the claims sub/sid/tv/iat/exp/iss/aud', () => {
    const t = signAccessToken(claims, 900, privateKey, NOW);
    const c = verifyAccessToken(t, publicKey, expected, NOW + 1000);
    expect(c).toMatchObject({ ...claims, exp: c.iat + 900 });
    expect(JSON.parse(Buffer.from(t.split('.')[0] ?? '', 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      typ: 'JWT',
    });
  });

  it('rejects an expired token (15 minutes + skew)', () => {
    const t = signAccessToken(claims, 900, privateKey, NOW);
    expect(() => verifyAccessToken(t, publicKey, expected, NOW + 931_000)).toThrow(JwtError);
  });

  it('rejects another key, wrong issuer or audience', () => {
    const t = signAccessToken(claims, 900, privateKey, NOW);
    expect(() => verifyAccessToken(t, other.publicKey, expected, NOW)).toThrow(/bad signature/);
    expect(() => verifyAccessToken(t, publicKey, { ...expected, issuer: 'x' }, NOW)).toThrow(
      /issuer/,
    );
    expect(() => verifyAccessToken(t, publicKey, { ...expected, audience: 'x' }, NOW)).toThrow(
      /audience/,
    );
  });

  it('rejects alg confusion: "none" and HS256 signed with the public key', () => {
    const body = Buffer.from(
      JSON.stringify({ ...claims, iat: NOW / 1000, exp: NOW / 1000 + 900 }),
    ).toString('base64url');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${body}.`;
    expect(() => verifyAccessToken(none, publicKey, expected, NOW)).toThrow(JwtError);
    const hsHeader = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const hs = `${hsHeader}.${body}.${createHmac('sha256', pem).update(`${hsHeader}.${body}`).digest('base64url')}`;
    expect(() => verifyAccessToken(hs, publicKey, expected, NOW)).toThrow(/unexpected header/);
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = signAccessToken(claims, 900, privateKey, NOW).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims, sub: 'admin', iat: NOW / 1000, exp: NOW / 1000 + 900 }),
    ).toString('base64url');
    expect(() => verifyAccessToken(`${h}.${forged}.${s}`, publicKey, expected, NOW)).toThrow(
      /bad signature/,
    );
  });
});

describe('token helpers', () => {
  it('makes 256-bit random tokens and stable hashes', () => {
    expect(Buffer.from(randomToken(), 'base64url')).toHaveLength(32);
    expect(randomToken()).not.toBe(randomToken());
    expect(sha256Hex('abc')).toHaveLength(64);
    expect(hmacHex('pepper', '123456')).not.toBe(hmacHex('other', '123456'));
  });
  it('compares in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('produces 6-digit codes with leading zeros', () => {
    for (let i = 0; i < 200; i++) expect(sixDigitCode()).toMatch(/^\d{6}$/);
  });
});
