import { describe, it, expect, vi } from 'vitest';
import { buildExpertiseBlock } from '../src/botSupport/supportLlm.js';
import { compiledProblemMessage } from '../src/botSupport/messages.js';

// issue #238: legacy-оркестрация экспертизы (parseProblemDetection / parseCompilation /
// runSupportProblemDetection / runSupportCompilation) перенесена в schema engine и
// удалена из supportLlm. Здесь остаются юнит-тесты сохранённых помощников и
// семантического поиска экспертизы.

describe('buildExpertiseBlock (#147)', () => {
  it('возвращает явную пометку, если документов нет', () => {
    expect(buildExpertiseBlock([])).toContain('не найдено');
  });

  it('нумерует документы и включает заголовок и контент', () => {
    const block = buildExpertiseBlock([
      { title: 'Оплата', content: 'Платёж зачисляется в течение 5 минут.' },
      { title: 'Возврат', content: 'Возврат делается на исходный счёт.' },
    ]);
    expect(block).toContain('1. Оплата');
    expect(block).toContain('Платёж зачисляется');
    expect(block).toContain('2. Возврат');
    expect(block.indexOf('Оплата')).toBeLessThan(block.indexOf('Возврат'));
  });
});

describe('compiledProblemMessage (#147)', () => {
  it('помечает служебное сообщение и включает формулировку', () => {
    const msg = compiledProblemMessage('Не зачислилась оплата в игре «бомж»');
    expect(msg).toContain('для СП');
    expect(msg).toContain('Не зачислилась оплата');
  });
});

describe('retrieveSupportExpertise (#147)', () => {
  it('считает эмбеддинги, объединяет результаты по минимальному расстоянию и берёт topK', async () => {
    vi.resetModules();
    const search = vi.fn(async (_embedding: number[]) => []);
    vi.doMock('@tg-games/core/db/repositories/expertise.js', () => ({
      searchExpertiseDocuments: search,
      recordExpertiseSearchQuerySafely: vi.fn(),
    }));
    const { retrieveSupportExpertise } = await import('../src/botSupport/expertiseRetrieval.js');

    // Два запроса дают один и тот же документ с разным расстоянием — берём ближе.
    search
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', content: 'ca', matchedSource: 's1', distance: 0.4, similarity: 0.6 },
      ] as never)
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', content: 'ca', matchedSource: 's2', distance: 0.1, similarity: 0.9 },
        { id: 'b', title: 'B', content: 'cb', matchedSource: 's3', distance: 0.5, similarity: 0.5 },
      ] as never);

    const provider = {
      model: 'text-embedding-3-small',
      async embed(inputs: string[]) {
        return {
          embeddings: inputs.map(() => [0.1, 0.2]),
          model: 'text-embedding-3-small',
          tokens: 0,
        };
      },
    };

    const docs = await retrieveSupportExpertise(provider as never, ['проблема1', 'проблема2'], 2);
    expect(docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(docs[0].distance).toBe(0.1); // выбрано меньшее расстояние для «a»
    expect(search).toHaveBeenCalledTimes(2);
    vi.doUnmock('@tg-games/core/db/repositories/expertise.js');
  });

  it('не обращается к поиску при пустом списке проблем', async () => {
    vi.resetModules();
    const search = vi.fn();
    vi.doMock('@tg-games/core/db/repositories/expertise.js', () => ({ searchExpertiseDocuments: search, recordExpertiseSearchQuerySafely: vi.fn() }));
    const { retrieveSupportExpertise } = await import('../src/botSupport/expertiseRetrieval.js');
    const provider = { model: 'm', embed: vi.fn() };
    const docs = await retrieveSupportExpertise(provider as never, [], 3);
    expect(docs).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    vi.doUnmock('@tg-games/core/db/repositories/expertise.js');
  });
});
