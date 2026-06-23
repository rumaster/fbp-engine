/**
 * Тесты репозитория документов экспертизы (issue #154).
 *
 * Проверяют, что scope-фильтр в searchExpertiseDocuments формирует правильное
 * условие WHERE (поддержка — game_id IS NULL, игра — game_id = $n) и что
 * create/update пробрасывают game_id. Запросы перехватываются мок-пулом.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();

vi.mock('@tg-games/core/db/pool.js', () => ({
  getPool: () => ({
    query: queryMock,
    connect: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
  }),
  closePool: vi.fn(),
}));

import {
  searchExpertiseDocuments,
  createExpertiseDocument,
  updateExpertiseDocument,
  listExpertiseDocuments,
  recordExpertiseSearchQuery,
  recordExpertiseSearchQuerySafely,
  seedGameExpertiseDocuments,
} from '@tg-games/core/db/repositories/expertise.js';
import type { GameExpertiseSeedDocument } from '@tg-games/core/db/repositories/expertise.js';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQueryMock.mockReset();
  clientQueryMock.mockResolvedValue({ rows: [{ id: 'doc-1' }] });
  releaseMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('searchExpertiseDocuments scope (#154)', () => {
  it('по умолчанию (поддержка) фильтрует по game_id IS NULL', async () => {
    await searchExpertiseDocuments([0.1, 0.2], 3);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('d.game_id IS NULL');
    expect(sql).not.toContain('d.game_id = $');
    expect(params).toEqual(['[0.1,0.2]', 3]);
  });

  it('явный support: true фильтрует по game_id IS NULL', async () => {
    await searchExpertiseDocuments([0.1], 2, { support: true });
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('d.game_id IS NULL');
  });

  it('scope игры фильтрует по game_id = $n и добавляет параметр', async () => {
    await searchExpertiseDocuments([0.1, 0.2], 2, { gameId: 'bomj' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('d.game_id = $3');
    expect(params).toEqual(['[0.1,0.2]', 2, 'bomj']);
  });

  it('не обращается к БД при пустом векторе или нулевом лимите', async () => {
    expect(await searchExpertiseDocuments([], 3, { gameId: 'bomj' })).toEqual([]);
    expect(await searchExpertiseDocuments([0.1], 0, { gameId: 'bomj' })).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('searchExpertiseDocuments tags (#321)', () => {
  it('без тэгов не добавляет фильтр по tags', async () => {
    await searchExpertiseDocuments([0.1, 0.2], 3, { gameId: 'bomj' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).not.toContain('d.tags');
    expect(params).toEqual(['[0.1,0.2]', 3, 'bomj']);
  });

  it('с тэгами добавляет условие пересечения и параметр-массив', async () => {
    await searchExpertiseDocuments([0.1, 0.2], 3, { gameId: 'bomj' }, ['еда', 'ночлег']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('d.tags && $4::text[]');
    expect(params).toEqual(['[0.1,0.2]', 3, 'bomj', ['еда', 'ночлег']]);
  });

  it('тримминг и отбрасывание пустых тэгов; пустой набор фильтр не добавляет', async () => {
    await searchExpertiseDocuments([0.1], 2, { support: true }, ['  ', '']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).not.toContain('d.tags');
    expect(params).toEqual(['[0.1]', 2]);
  });

  it('тэги работают и в области поддержки (game_id IS NULL)', async () => {
    await searchExpertiseDocuments([0.1], 2, { support: true }, ['оплата']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('d.game_id IS NULL');
    expect(sql).toContain('d.tags && $3::text[]');
    expect(params).toEqual(['[0.1]', 2, ['оплата']]);
  });
});

describe('create/update пробрасывают game_id (#154)', () => {
  it('createExpertiseDocument по умолчанию пишет game_id = null', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          title: 't',
          content: 'c',
          embedding_sources: [],
          game_id: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ],
    });
    const doc = await createExpertiseDocument({ title: 't', content: 'c', embeddingSources: [] });
    const [, params] = queryMock.mock.calls[0];
    expect(params[4]).toBeNull();
    expect(doc.gameId).toBeNull();
  });

  it('createExpertiseDocument пишет переданный game_id', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          title: 't',
          content: 'c',
          embedding_sources: [],
          game_id: 'bomj',
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ],
    });
    const doc = await createExpertiseDocument({
      title: 't',
      content: 'c',
      embeddingSources: [],
      gameId: 'bomj',
    });
    const [, params] = queryMock.mock.calls[0];
    expect(params[4]).toBe('bomj');
    expect(doc.gameId).toBe('bomj');
  });

  it('updateExpertiseDocument пишет game_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await updateExpertiseDocument('1', {
      title: 't',
      content: 'c',
      embeddingSources: [],
      gameId: 'bomj',
    });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('game_id = $6');
    expect(params[5]).toBe('bomj');
  });

  it('listExpertiseDocuments выбирает колонку game_id', async () => {
    await listExpertiseDocuments();
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('game_id');
  });
});

describe('recordExpertiseSearchQuery (#156)', () => {
  const retrieved = [
    { id: 'a', title: 'A', matchedSource: 's1', distance: 0.1, similarity: 0.9, content: 'ca' },
    { id: 'b', title: 'B', matchedSource: 's2', distance: 0.4, similarity: 0.6, content: 'cb' },
  ];

  it('пишет запрос с эмбеддингом, лучшим сходством и числом результатов', async () => {
    await recordExpertiseSearchQuery({
      queryText: 'где переночевать',
      embedding: [0.1, 0.2],
      gameId: 'bomj',
      retrieved: retrieved as never,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO expertise_search_queries');
    expect(params[0]).toBe('bomj');
    expect(params[1]).toBe('где переночевать');
    expect(params[2]).toBe('[0.1,0.2]');
    // Лучшее сходство — максимум по найденным документам.
    expect(params[3]).toBeCloseTo(0.9);
    expect(params[4]).toBe(2);
    expect(String(params[5])).toContain('"id":"a"');
  });

  it('для пустой выдачи пишет null-сходство, нулевой счётчик и null-документы', async () => {
    await recordExpertiseSearchQuery({
      queryText: 'неизвестный запрос',
      embedding: [0.3],
      gameId: null,
      retrieved: [],
    });
    const [, params] = queryMock.mock.calls[0];
    expect(params[0]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(0);
    expect(params[5]).toBeNull();
  });

  it('не обращается к БД при пустом эмбеддинге', async () => {
    await recordExpertiseSearchQuery({
      queryText: 'q',
      embedding: [],
      gameId: 'bomj',
      retrieved: [],
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('recordExpertiseSearchQuerySafely проглатывает ошибку записи', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordExpertiseSearchQuerySafely({
        queryText: 'q',
        embedding: [0.1],
        gameId: null,
        retrieved: [],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('seedGameExpertiseDocuments (#154)', () => {
  const docs: GameExpertiseSeedDocument[] = [
    { title: 'Ночлег', content: 'Тёплые трубы.', embeddingSources: ['где переночевать', 'ночлег'] },
    { title: 'Еда', content: 'Помойка кормит.', embeddingSources: ['где найти еду'] },
  ];

  function embeddingProvider() {
    return {
      model: 'text-embedding-3-small',
      embed: vi.fn(async (inputs: string[]) => ({
        embeddings: inputs.map(() => [0.1, 0.2]),
      })),
    };
  }

  it('без провайдера эмбеддингов ничего не делает', async () => {
    const inserted = await seedGameExpertiseDocuments(null, 'bomj', docs);
    expect(inserted).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('вставляет недостающие документы с эмбеддингами', async () => {
    // Уже заведён только «Ночлег» — он пропускается, добавляется «Еда».
    queryMock.mockResolvedValueOnce({ rows: [{ title: 'Ночлег' }] });
    const provider = embeddingProvider();
    const inserted = await seedGameExpertiseDocuments(provider, 'bomj', docs);

    expect(inserted).toBe(1);
    // Эмбеддинги считаются только для недостающего документа («Еда»).
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith(['где найти еду']);

    // Транзакция: BEGIN, INSERT документа, INSERT эмбеддинга, COMMIT.
    const sqls = clientQueryMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('INSERT INTO expertise_documents'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO expertise_document_embeddings'))).toBe(true);
    expect(sqls).toContain('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('идемпотентен: если все документы уже есть — ничего не вставляет', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ title: 'Ночлег' }, { title: 'Еда' }] });
    const provider = embeddingProvider();
    const inserted = await seedGameExpertiseDocuments(provider, 'bomj', docs);
    expect(inserted).toBe(0);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(clientQueryMock).not.toHaveBeenCalled();
  });
});
