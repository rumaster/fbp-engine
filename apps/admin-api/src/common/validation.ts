import { BadRequestException } from '@nestjs/common';
import { z, type ZodType } from 'zod';

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  return badRequestFromZod(result.error);
}

export function badRequestFromZod(error: z.ZodError): never {
  const details = error.issues.map((issue) => issue.message).join('; ');
  throw new BadRequestException(details || 'Некорректный запрос');
}
