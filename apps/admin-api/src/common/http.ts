import { BadRequestException } from '@nestjs/common';

export interface PageQuery {
  limit: number;
  offset: number;
}

export function parsePageQuery(rawLimit?: string, rawOffset?: string): PageQuery {
  const limit = Math.min(Math.max(Number(rawLimit ?? 25), 1), 100);
  const offset = Math.max(Number(rawOffset ?? 0), 0);
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
    throw new BadRequestException('Некорректные limit/offset');
  }
  return { limit, offset };
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Преобразует строковый query-флаг в булево значение. Пустое/отсутствующее
 * значение трактуется как «фильтр не задан» (undefined).
 */
export function parseBooleanFlag(value: unknown): boolean | undefined {
  const normalized = optionalString(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}
