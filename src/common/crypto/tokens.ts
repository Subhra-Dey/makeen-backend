import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 256-bit random opaque token, URL-safe (refresh tokens, CSRF tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex — how refresh tokens are stored (never in clear). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** HMAC-SHA256 hex with a server pepper — how OTPs are stored (SEC-7). */
export function hmacHex(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison (same length required; different lengths → false). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 6-digit OTP from a CSPRNG (uniform, leading zeros kept). */
export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
