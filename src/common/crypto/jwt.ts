import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * Minimal, strict EdDSA (Ed25519) JWT (RFC 7519 / RFC 8037) on Node's built-in crypto
 * (DECISIONS D-60 — replaces `jose`, which is ESM-only and cannot be loaded by Nest's Jest setup).
 *
 * Verification is deliberately narrow: header must be exactly {"alg":"EdDSA","typ":"JWT"},
 * issuer and audience must match, exp is required, iat/nbf may not be in the future.
 */

export interface AccessTokenClaims {
  /** user id */
  sub: string;
  /** session family id */
  sid: string;
  /** users.token_version at issue */
  tv: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
/** Allowed clock skew between API instances, seconds. */
const SKEW_SECONDS = 30;

export class JwtError extends Error {
  constructor(readonly reason: string) {
    super(`invalid token: ${reason}`);
    this.name = 'JwtError';
  }
}

export interface JwtKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function loadJwtKeys(privateB64: string, publicB64: string): JwtKeys {
  return {
    privateKey: createPrivateKey(Buffer.from(privateB64, 'base64').toString('utf8')),
    publicKey: createPublicKey(Buffer.from(publicB64, 'base64').toString('utf8')),
  };
}

export function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp'>,
  ttlSeconds: number,
  key: KeyObject,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: AccessTokenClaims = { ...claims, iat, exp: iat + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(`${HEADER}.${body}`), key).toString('base64url');
  return `${HEADER}.${body}.${signature}`;
}

function isClaims(value: unknown): value is AccessTokenClaims {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['sub'] === 'string' &&
    typeof v['sid'] === 'string' &&
    typeof v['tv'] === 'number' &&
    typeof v['iat'] === 'number' &&
    typeof v['exp'] === 'number' &&
    typeof v['iss'] === 'string' &&
    typeof v['aud'] === 'string'
  );
}

export function verifyAccessToken(
  token: string,
  key: KeyObject,
  expected: { issuer: string; audience: string },
  nowMs: number = Date.now(),
): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');
  const [header, body, signature] = parts as [string, string, string];
  // Exact header match: no alg confusion ("none", HS256 with the public key, kid tricks…).
  if (header !== HEADER) throw new JwtError('unexpected header');
  const ok = verify(
    null,
    Buffer.from(`${header}.${body}`),
    key,
    Buffer.from(signature, 'base64url'),
  );
  if (!ok) throw new JwtError('bad signature');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('bad payload');
  }
  if (!isClaims(claims)) throw new JwtError('missing claims');
  const now = Math.floor(nowMs / 1000);
  if (claims.iss !== expected.issuer) throw new JwtError('issuer');
  if (claims.aud !== expected.audience) throw new JwtError('audience');
  if (claims.exp <= now - SKEW_SECONDS) throw new JwtError('expired');
  if (claims.iat > now + SKEW_SECONDS) throw new JwtError('issued in the future');
  return claims;
}
