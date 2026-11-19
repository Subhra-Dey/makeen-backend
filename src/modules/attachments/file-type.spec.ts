import { contentDisposition } from '../../common/export/report-file';
import { detectUploadType, safeFileName } from './file-type';

const pad = (head: number[] | string): Buffer =>
  Buffer.concat([
    typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head),
    Buffer.alloc(32),
  ]);

describe('upload file type (magic bytes)', () => {
  it('knows PDF, JPG, PNG and XLSX by content', () => {
    expect(detectUploadType(pad('%PDF-1.7'))).toBe('application/pdf');
    expect(detectUploadType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectUploadType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    const xlsx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('....[Content_Types].xml....xl/workbook.xml....', 'latin1'),
    ]);
    expect(detectUploadType(xlsx)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('refuses everything else: a plain ZIP, HTML, an EXE, tiny files', () => {
    expect(detectUploadType(pad([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBeNull();
    expect(detectUploadType(pad('<html><script>'))).toBeNull();
    expect(detectUploadType(pad('MZ\x90\x00'))).toBeNull();
    expect(detectUploadType(Buffer.from('%PDF'))).toBeNull();
  });

  it('a safe name has no folders or odd characters and the extension of the real type', () => {
    expect(safeFileName('C:\\fake\\..\\sqc "report".exe', 'application/pdf')).toBe(
      'sqc report.pdf',
    );
    expect(safeFileName('../../etc/passwd', 'image/png')).toBe('passwd.png');
    expect(safeFileName('', 'image/jpeg')).toBe('file.jpg');
    expect(safeFileName(`${'a'.repeat(400)}.pdf`, 'application/pdf')).toHaveLength(255);
  });

  it('Content-Disposition is attachment, ASCII-safe, with the exact UTF-8 name when needed', () => {
    expect(contentDisposition('sqc.pdf')).toBe('attachment; filename="sqc.pdf"');
    expect(contentDisposition('रिपोर्ट "1".pdf')).toBe(
      `attachment; filename="_______ _1_.pdf"; filename*=UTF-8''${encodeURIComponent('रिपोर्ट "1".pdf')}`,
    );
  });
});
