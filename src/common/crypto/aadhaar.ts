import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Aadhaar at rest (SEC-12): AES-256-GCM with a random 96-bit IV. Stored layout:
 *   iv (12 bytes) | auth tag (16 bytes) | ciphertext
 * plus a key id column for rotation and a separate last-4 column, so the API never needs to
 * decrypt to show `XXXX-XXXX-1234`. The full number is never logged or returned.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedAadhaar {
  enc: Buffer;
  keyId: string;
  last4: string;
}

function keyFrom(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new RangeError('Aadhaar key must be 32 bytes (base64)');
  return key;
}

/** Normalise a 12-digit Aadhaar number (spaces/dashes allowed in input). */
export function normaliseAadhaar(value: string): string {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(digits)) throw new RangeError('Aadhaar must be 12 digits');
  return digits;
}

export function encryptAadhaar(value: string, keyB64: string, keyId: string): EncryptedAadhaar {
  const digits = normaliseAadhaar(value);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(keyB64), iv);
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
  return {
    enc: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
    keyId,
    last4: digits.slice(-4),
  };
}

export function decryptAadhaar(enc: Buffer, keyB64: string, keyId: string): string {
  const iv = enc.subarray(0, IV_BYTES);
  const tag = enc.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(keyB64), iv);
  decipher.setAAD(Buffer.from(keyId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(enc.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
