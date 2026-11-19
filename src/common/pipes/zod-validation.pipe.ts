import { HttpStatus } from '@nestjs/common';
import { createZodValidationPipe } from 'nestjs-zod';
import { ZodError } from 'zod';
import { AppError, ErrorCode } from '../errors/app-error';

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Converts a Zod failure into our `VALIDATION_FAILED` envelope with per-field paths. */
export function toValidationError(error: unknown): AppError {
  const details: ValidationIssue[] =
    error instanceof ZodError
      ? error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        }))
      : [];
  return new AppError(
    HttpStatus.BAD_REQUEST,
    ErrorCode.VALIDATION_FAILED,
    'Some fields are not valid.',
    details,
  );
}

/**
 * Global validation pipe (nestjs-zod, SEC-13). Validates every `createZodDto` body/query/param.
 * `z.object` strips unknown keys, so clients can never smuggle extra fields
 * (e.g. computed totals or statuses) through to services.
 */
export const AppZodValidationPipe = createZodValidationPipe({
  createValidationException: toValidationError,
});
