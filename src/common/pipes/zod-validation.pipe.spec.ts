import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { AppZodValidationPipe } from './zod-validation.pipe';

class SampleDto extends createZodDto(z.object({ plantId: z.uuid(), openingStock: z.string() })) {}

describe('AppZodValidationPipe', () => {
  const pipe = new AppZodValidationPipe();
  const meta = { type: 'body' as const, metatype: SampleDto };

  it('strips unknown keys (client cannot send computed values)', () => {
    const out: unknown = pipe.transform(
      {
        plantId: '7f3a2100-0000-4000-8000-000000000001',
        openingStock: '412.380',
        closingBookStock: '999.000',
      },
      meta,
    );
    expect(out).toEqual({
      plantId: '7f3a2100-0000-4000-8000-000000000001',
      openingStock: '412.380',
    });
  });

  it('throws a VALIDATION_FAILED AppError with field paths', () => {
    let caught: unknown;
    try {
      pipe.transform({ plantId: 'nope' }, meta);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'plantId' }),
        expect.objectContaining({ path: 'openingStock' }),
      ]),
    );
  });

  it('leaves non-DTO parameters untouched', () => {
    expect(pipe.transform('raw', { type: 'param' })).toBe('raw');
  });
});
