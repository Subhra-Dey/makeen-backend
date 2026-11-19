/**
 * Upload file types by CONTENT (magic bytes), never by name or the browser's Content-Type
 * (SEC uploads, UXV-12): PDF, JPG, PNG, XLSX, at most 10 MB.
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export type UploadMime =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The file's real type, or null when it is not one we accept. */
export function detectUploadType(buf: Buffer): UploadMime | null {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(PNG)) return 'image/png';
  // XLSX = ZIP whose (uncompressed) entry names include the workbook part.
  if (buf.readUInt32LE(0) === 0x04034b50 && buf.includes('xl/workbook.xml', 0, 'latin1'))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return null;
}

const EXTENSION: Record<UploadMime, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

/**
 * A safe display name: no folders, no control or quote characters, at most 255 characters, and
 * an extension that matches the real type (so a renamed file cannot pose as another type).
 */
export function safeFileName(original: string, mime: UploadMime): string {
  let base = '';
  for (const ch of original.split(/[\\/]/).pop() ?? '') {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && !'"<>|*?:'.includes(ch)) base += ch;
  }
  base = base.trim();
  const ext = EXTENSION[mime];
  const stem = base.replace(/\.[^.]*$/, '').slice(0, 255 - ext.length) || 'file';
  return `${stem}${ext}`;
}
