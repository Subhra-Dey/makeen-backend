import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `:id` route parameter — always a UUID (anything else is a 400 before the service runs). */
export class IdParamDto extends createZodDto(z.object({ id: z.uuid() })) {}
