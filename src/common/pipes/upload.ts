import { HttpStatus } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ApiBodyOptions } from '@nestjs/swagger';
import { AppError, ErrorCode } from '../errors/app-error';
import { UPLOAD_MAX_BYTES } from '../../modules/attachments/file-type';
import type { IncomingFile } from '../../modules/attachments/attachments.service';

/** Multipart `file` field, ≤ 10 MB, one file (record uploads). */
export const SingleUpload = () =>
  FileInterceptor('file', {
    limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 2, parts: 3 },
  });

/** OpenAPI body for a single `file` upload. */
export const UPLOAD_BODY: ApiBodyOptions = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: { type: 'string', format: 'binary', description: 'PDF, JPG, PNG or XLSX, ≤ 10 MB' },
    },
  },
};

export function requireFile(file: IncomingFile | undefined): IncomingFile {
  if (!file)
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_FAILED,
      'Choose a file to upload.',
      [{ path: 'file', message: 'Choose a file to upload.' }],
    );
  return file;
}
