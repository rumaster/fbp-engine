/**
 * Тесты алиасов моделей Azure (issue #120).
 *
 * В Azure OpenAI поле `model` в запросе — это имя deployment (алиас), которое
 * пользователь задаёт сам, поэтому справочник цен MODEL_PRICING не находит по
 * нему модель и стоимость считается нулевой. Таблица azure_models сопоставляет
 * алиас канонической модели; перед расчётом миллицентов алиас резолвится.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAzureModels } from '@tg-games/core/config.js';
import { findModelPricing } from '@tg-games/core/llm/pricing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const queryMock = vi.fn();

vi.mock('@tg-games/core/db/pool.js', () => ({
  getPool: () => ({ query: queryMock }),
  closePool: vi.fn(),
}));

import {
  clearAzureModelCache,
  resolveAzureAlias,
  resolveModelPricing,
} from '@tg-games/core/db/repositories/azureModels.js';

beforeEach(() => {
  queryMock.mockReset();
  clearAzureModelCache();
});

afterEach(() => {
  clearAzureModelCache();
});

describe('parseAzureModels (issue #120)', () => {
  it('разбирает пары alias=model через запятую', () => {
    expect(parseAzureModels('my-gpt4o=gpt-4o,my-mini=gpt-4o-mini')).toEqual({
      'my-gpt4o': 'gpt-4o',
      'my-mini': 'gpt-4o-mini',
    });
  });

  it('обрезает пробелы и отбрасывает пустые и некорректные пары', () => {
    expect(parseAzureModels(' a = gpt-4o , , broken , =x , y= ')).toEqual({
      a: 'gpt-4o',
    });
  });

  it('возвращает пустой объект для пустой строки', () => {
    expect(parseAzureModels('')).toEqual({});
  });
});

describe('resolveAzureAlias (issue #120)', () => {
  it('возвращает каноническую модель по алиасу и кеширует карту', async () => {
    queryMock.mockResolvedValue({ rows: [{ alias: 'my-deploy', model: 'gpt-4o' }] });

    expect(await resolveAzureAlias('my-deploy')).toBe('gpt-4o');
    // Повторный вызов берёт значение из кеша — БД не запрашивается снова.
    expect(await resolveAzureAlias('my-deploy')).toBe('gpt-4o');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('возвращает сам алиас, если он не зарегистрирован', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await resolveAzureAlias('unknown-deploy')).toBe('unknown-deploy');
  });

  it('не роняет резолв при ошибке БД — возвращает алиас', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    expect(await resolveAzureAlias('my-deploy')).toBe('my-deploy');
  });
});

describe('resolveModelPricing (issue #120)', () => {
  it('для Azure определяет цену по канонической модели за алиасом', async () => {
    queryMock.mockResolvedValue({ rows: [{ alias: 'my-deploy', model: 'gpt-4o' }] });

    const pricing = await resolveModelPricing('AZURE', 'my-deploy');
    expect(pricing).toEqual(findModelPricing('gpt-4o'));
    expect(pricing).not.toBeNull();
  });

  it('для не-Azure провайдеров ищет цену напрямую без обращения к БД', async () => {
    const pricing = await resolveModelPricing('OPENAI', 'gpt-4o-mini');
    expect(pricing).toEqual(findModelPricing('gpt-4o-mini'));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('возвращает null, если за алиасом стоит неизвестная справочнику модель', async () => {
    queryMock.mockResolvedValue({ rows: [{ alias: 'my-deploy', model: 'unknown-model' }] });
    expect(await resolveModelPricing('AZURE', 'my-deploy')).toBeNull();
  });
});

describe('схема azure_models (issue #120)', () => {
  it('создаёт таблицу azure_models (alias, model)', () => {
    const schema = readFileSync(join(repoRoot, 'packages/core/src/db/schema.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS azure_models');
    expect(schema).toMatch(/alias\s+VARCHAR\(255\)\s+PRIMARY KEY/);
    expect(schema).toMatch(/model\s+VARCHAR\(255\)\s+NOT NULL/);
  });
});
