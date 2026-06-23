import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AdminDataService } from '../src/admin/admin-data.service';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { Neo4jOntologyConflictError, type Neo4jService } from '../src/database/neo4j.service';

function makeDatabase(): DatabaseService {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as DatabaseService;
}

// Мок сервиса эмбеддингов (issue #156). Возвращает фиксированный вектор на
// каждую фразу, чтобы проверить семантические запросы без обращения к OpenAI.
function makeEmbeddings(embed = vi.fn(async (inputs: string[]) => inputs.map(() => [0.1, 0.2]))) {
  return {
    service: { embed, isEnabled: () => true } as unknown as import('../src/embedding/embedding.service').EmbeddingService,
    embed,
  };
}

function makeTransactionDatabase(query: ReturnType<typeof vi.fn>) {
  const transaction = vi.fn(async (work: (client: { query: typeof query }) => Promise<unknown>) => work({ query }));
  return {
    database: { query, transaction } as unknown as DatabaseService,
    transaction,
  };
}

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

type Neo4jMock = {
  getGameOntology: ReturnType<typeof vi.fn>;
  getGameCommunities: ReturnType<typeof vi.fn>;
  verifyOntologyConcept: ReturnType<typeof vi.fn>;
  verifyOntologyRelation: ReturnType<typeof vi.fn>;
  createOntologyConcept: ReturnType<typeof vi.fn>;
  updateOntologyConcept: ReturnType<typeof vi.fn>;
  deleteOntologyConcept: ReturnType<typeof vi.fn>;
  createOntologyRelation: ReturnType<typeof vi.fn>;
  updateOntologyRelation: ReturnType<typeof vi.fn>;
  deleteOntologyRelation: ReturnType<typeof vi.fn>;
  exportGameOntology: ReturnType<typeof vi.fn>;
  importGameOntology: ReturnType<typeof vi.fn>;
};

function makeNeo4j(overrides: Partial<Neo4jMock> = {}): Neo4jMock & Neo4jService {
  const service: Neo4jMock = {
    getGameOntology: vi.fn().mockResolvedValue({ concepts: [], relations: [] }),
    getGameCommunities: vi.fn().mockResolvedValue([]),
    verifyOntologyConcept: vi.fn().mockResolvedValue(null),
    verifyOntologyRelation: vi.fn().mockResolvedValue(null),
    createOntologyConcept: vi.fn().mockResolvedValue({}),
    updateOntologyConcept: vi.fn().mockResolvedValue(null),
    deleteOntologyConcept: vi.fn().mockResolvedValue(null),
    createOntologyRelation: vi.fn().mockResolvedValue({}),
    updateOntologyRelation: vi.fn().mockResolvedValue(null),
    deleteOntologyRelation: vi.fn().mockResolvedValue(null),
    exportGameOntology: vi.fn().mockResolvedValue({ concepts: [], relations: [] }),
    importGameOntology: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
  };
  return { ...service, ...overrides } as Neo4jMock & Neo4jService;
}

describe('AdminDataService', () => {
  it('не даёт сохранить манифест под другим game_id', async () => {
    const service = new AdminDataService(makeDatabase());

    await expect(service.updateGameManifest('bomj', { id: 'red_hood' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('валидирует group_id при обновлении групп игры', async () => {
    const service = new AdminDataService(makeDatabase());

    await expect(service.updateGameGroups('bomj', ['bad group'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('не вставляет игру, если указана неизвестная группа', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.createGame({ manifest: { id: 'new_game' }, groupIds: ['ghost'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO game_manifests'))).toBe(false);
  });

  it('не обновляет группы, если игра не найдена', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ group_id: 'base' }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.updateGameGroups('missing_game', ['base'])).rejects.toBeInstanceOf(NotFoundException);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE game_groups'))).toBe(false);
  });

  it('фильтрует лог LLM-запросов по сессии, типу и признаку ошибки', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'req-1' }] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    const result = await service.listLlmRequests({
      sessionId: 'sess-1',
      requestKind: 'narrative_generation',
      hasError: true,
      limit: 50,
      offset: 0,
    });

    expect(result).toEqual({ total: 3, items: [{ id: 'req-1' }] });
    const listCall = query.mock.calls[1];
    expect(String(listCall[0])).toContain('FROM llm_request_logs');
    expect(String(listCall[0])).toContain('l.error_text IS NOT NULL');
    expect(listCall[1]).toContain('sess-1');
    expect(listCall[1]).toContain('narrative_generation');
  });

  it('фильтрует лог LLM-запросов без ошибок', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await service.listLlmRequests({ hasError: false, limit: 25, offset: 0 });

    expect(String(query.mock.calls[1][0])).toContain('l.error_text IS NULL');
  });

  it('кидает NotFoundException, если запрос LLM не найден', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.getLlmRequest('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('архивирует прежнюю версию манифеста перед обновлением', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // INSERT в историю
      .mockResolvedValueOnce({ rows: [{ game_id: 'bomj', manifest: { id: 'bomj' } }] }); // UPDATE
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await service.updateGameManifest('bomj', { id: 'bomj', name: 'Новое имя' });

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO game_manifest_history');
    expect(String(query.mock.calls[0][0])).toContain('manifest IS DISTINCT FROM');
    expect(String(query.mock.calls[1][0])).toContain('UPDATE game_manifests');
  });

  it('кидает NotFoundException, если игры нет при обновлении манифеста', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // INSERT в историю ничего не архивирует
      .mockResolvedValueOnce({ rows: [] }); // UPDATE не нашёл игру
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.updateGameManifest('ghost', { id: 'ghost' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('возвращает историю версий манифеста для существующей игры', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] }) // ensureGameExists
      .mockResolvedValueOnce({ rows: [{ id: 'v1' }, { id: 'v2' }] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    const result = await service.listGameManifestHistory('bomj');

    expect(result).toEqual({ items: [{ id: 'v1' }, { id: 'v2' }] });
    expect(String(query.mock.calls[1][0])).toContain('FROM game_manifest_history');
  });

  it('кидает NotFoundException, если версия манифеста не найдена', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.getGameManifestHistoryEntry('bomj', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('экспортирует манифесты в переносимый JSON-формат', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          game_id: 'bomj',
          manifest: { id: 'bomj', name: 'Выживание' },
          sort_order: 1,
          updated_at: '2026-06-05T10:00:00.000Z',
        },
      ],
    });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    const result = await service.exportGameManifests();

    expect(result).toEqual({
      version: 1,
      exportedAt: expect.any(String),
      items: [
        {
          gameId: 'bomj',
          manifest: { id: 'bomj', name: 'Выживание' },
          sortOrder: 1,
          updatedAt: '2026-06-05T10:00:00.000Z',
        },
      ],
    });
    expect(String(query.mock.calls[0][0])).toContain('FROM game_manifests');
  });

  it('импортирует манифесты атомарно и архивирует изменённые версии', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ game_id: 'new_game' }] }) // INSERT новой игры
      .mockResolvedValueOnce({ rows: [] }) // INSERT существующей игры пропущен
      .mockResolvedValueOnce({ rows: [] }) // INSERT в историю
      .mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] }); // UPDATE существующей игры
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    const result = await service.importGameManifests([
      { manifest: { id: 'new_game', name: 'Новая игра' }, sortOrder: 10 },
      { gameId: 'bomj', manifest: { id: 'bomj', name: 'Новое имя' } },
    ]);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 2, created: 1, updated: 1, unchanged: 0 });
    expect(String(query.mock.calls[2][0])).toContain('INSERT INTO game_manifest_history');
    expect(String(query.mock.calls[3][0])).toContain('UPDATE game_manifests');
  });

  it('отклоняет импорт манифеста, если game_id не совпадает с manifest.id', async () => {
    const query = vi.fn();
    const { database, transaction } = makeTransactionDatabase(query);
    const service = new AdminDataService(database);

    await expect(
      service.importGameManifests([{ gameId: 'bomj', manifest: { id: 'red_hood' } }]),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('возвращает список алиасов Azure, отсортированный по алиасу', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ alias: 'dep-a', model: 'gpt-4o' }] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    const result = await service.listAzureModels();

    expect(result).toEqual({ items: [{ alias: 'dep-a', model: 'gpt-4o' }] });
    expect(String(query.mock.calls[0][0])).toContain('FROM azure_models');
    expect(String(query.mock.calls[0][0])).toContain('ORDER BY alias ASC');
  });

  it('добавляет новый алиас Azure', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // проверка существования
      .mockResolvedValueOnce({ rows: [{ alias: 'dep-a', model: 'gpt-4o-mini' }] }); // INSERT
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    const result = await service.createAzureModel('  dep-a ', ' gpt-4o-mini ');

    expect(result).toEqual({ alias: 'dep-a', model: 'gpt-4o-mini' });
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO azure_models');
    expect(query.mock.calls[1][1]).toEqual(['dep-a', 'gpt-4o-mini']);
  });

  it('не добавляет алиас Azure, если он уже существует', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ alias: 'dep-a' }] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.createAzureModel('dep-a', 'gpt-4o')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO azure_models'))).toBe(false);
  });

  it('не добавляет алиас Azure с пустой моделью', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.createAzureModel('dep-a', '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('обновляет каноническую модель алиаса Azure', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ alias: 'dep-a', model: 'gpt-4o' }] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    const result = await service.updateAzureModel('dep-a', 'gpt-4o');

    expect(result).toEqual({ alias: 'dep-a', model: 'gpt-4o' });
    expect(String(query.mock.calls[0][0])).toContain('UPDATE azure_models');
  });

  it('кидает NotFoundException, если алиас Azure не найден при обновлении', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.updateAzureModel('missing', 'gpt-4o')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('удаляет алиас Azure', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ alias: 'dep-a' }] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    const result = await service.deleteAzureModel('dep-a');

    expect(result).toEqual({ alias: 'dep-a' });
    expect(String(query.mock.calls[0][0])).toContain('DELETE FROM azure_models');
  });

  it('кидает NotFoundException, если алиас Azure не найден при удалении', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.deleteAzureModel('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── Глобальные defaults моделей (issue #345) ───────────────────────────────

  it('возвращает глобальные defaults моделей с fallback из env', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ key: 'llm_model_name', value: 'gemini-2.5-flash', updated_at: '2026-01-01T00:00:00Z' }],
    });
    const service = new AdminDataService(
      { query } as unknown as DatabaseService,
      undefined as unknown as ReturnType<typeof makeEmbeddings>['service'],
      makeConfig({
        LLM_PROVIDER: 'GOOGLE',
        LLM_MODEL_NAME: 'gemini-env',
        EMBEDDING_PROVIDER: 'OPENAI',
        EMBEDDING_MODEL: 'text-embedding-env',
      }),
    );

    const result = await service.getModelDefaults();

    expect(result).toMatchObject({
      llm: {
        provider: 'GOOGLE',
        model: 'gemini-2.5-flash',
        envModel: 'gemini-env',
        source: 'database',
      },
      embedding: {
        provider: 'OPENAI',
        model: 'text-embedding-env',
        envModel: 'text-embedding-env',
        source: 'env',
      },
    });
    expect(String(query.mock.calls[0][0])).toContain('FROM model_defaults');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('model_rules'))).toBe(false);
  });

  it('сохраняет глобальные defaults моделей одним upsert', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { key: 'llm_model_name', value: 'gemini-2.5-flash', updated_at: '2026-01-01T00:00:00Z' },
          { key: 'embedding_model', value: 'text-embedding-3-large', updated_at: '2026-01-01T00:00:00Z' },
        ],
      });
    const service = new AdminDataService(
      { query } as unknown as DatabaseService,
      undefined as unknown as ReturnType<typeof makeEmbeddings>['service'],
      makeConfig({
        LLM_PROVIDER: 'GOOGLE',
        LLM_MODEL_NAME: 'gemini-env',
        EMBEDDING_PROVIDER: 'OPENAI',
        EMBEDDING_MODEL: 'text-embedding-env',
      }),
    );

    const result = await service.updateModelDefaults({
      llmModelName: '  gemini-2.5-flash ',
      embeddingModel: ' text-embedding-3-large ',
    });

    expect(result.llm.model).toBe('gemini-2.5-flash');
    expect(result.embedding.model).toBe('text-embedding-3-large');
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO model_defaults');
    expect(query.mock.calls[0][1]).toEqual(['gemini-2.5-flash', 'text-embedding-3-large']);
  });

  it('отклоняет пустые глобальные defaults моделей', async () => {
    const query = vi.fn();
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(
      service.updateModelDefaults({ llmModelName: ' ', embeddingModel: 'text-embedding-3-small' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateModelDefaults({ llmModelName: 'gemini-2.5-flash', embeddingModel: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  // ── Выгрузка/загрузка документов экспертизы (issue #156) ──────────────────

  it('экспортирует документы экспертизы в переносимый JSON-конверт', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'doc-1',
          title: 'Ночлег',
          content: 'Тёплые трубы.',
          embedding_sources: ['где переночевать'],
          tags: ['ночлег', 'тепло'],
          game_id: 'bomj',
          created_at: '2026-06-01T10:00:00.000Z',
          updated_at: '2026-06-02T10:00:00.000Z',
        },
      ],
    });
    const { service: embeddings } = makeEmbeddings();
    const service = new AdminDataService({ query } as unknown as DatabaseService, embeddings);

    const result = await service.exportExpertiseDocuments();

    expect(result).toEqual({
      version: 1,
      exportedAt: expect.any(String),
      items: [
        {
          title: 'Ночлег',
          content: 'Тёплые трубы.',
          embeddingSources: ['где переночевать'],
          tags: ['ночлег', 'тепло'],
          gameId: 'bomj',
          updatedAt: '2026-06-02T10:00:00.000Z',
        },
      ],
    });
    expect(String(query.mock.calls[0][0])).toContain('FROM expertise_documents');
  });

  it('импортирует документ экспертизы: создаёт отсутствующий, пересчитывая эмбеддинги', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // SELECT существующего документа — нет
      .mockResolvedValueOnce({ rows: [{ id: 'doc-new' }] }) // INSERT нового документа
      .mockResolvedValue({ rows: [] }); // INSERT эмбеддинга
    const { database } = makeTransactionDatabase(query);
    const { service: embeddings, embed } = makeEmbeddings();
    const service = new AdminDataService(database, embeddings);

    const result = await service.importExpertiseDocuments([
      { title: 'Еда', content: 'Помойка кормит.', embeddingSources: ['где найти еду'], gameId: null },
    ]);

    expect(result).toEqual({ total: 1, created: 1, updated: 0, unchanged: 0 });
    expect(embed).toHaveBeenCalledWith(['где найти еду']);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('SELECT id FROM expertise_documents'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO expertise_documents'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO expertise_document_embeddings'))).toBe(true);
  });

  it('импортирует документ экспертизы: обновляет существующий и переписывает эмбеддинги', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'doc-1' }] }) // SELECT — документ найден
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // DELETE старых эмбеддингов
      .mockResolvedValue({ rows: [] }); // INSERT нового эмбеддинга
    const { database } = makeTransactionDatabase(query);
    const { service: embeddings } = makeEmbeddings();
    const service = new AdminDataService(database, embeddings);

    const result = await service.importExpertiseDocuments([
      { title: 'Ночлег', content: 'Новый текст.', embeddingSources: ['ночлег'], gameId: null },
    ]);

    expect(result).toEqual({ total: 1, created: 0, updated: 1, unchanged: 0 });
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE expertise_documents'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM expertise_document_embeddings'))).toBe(true);
  });

  it('отвергает импорт с дублирующей парой (заголовок, игра)', async () => {
    const { database } = makeTransactionDatabase(vi.fn().mockResolvedValue({ rows: [] }));
    const { service: embeddings } = makeEmbeddings();
    const service = new AdminDataService(database, embeddings);

    await expect(
      service.importExpertiseDocuments([
        { title: 'Еда', content: 'a', embeddingSources: [], gameId: null },
        { title: 'Еда', content: 'b', embeddingSources: [], gameId: null },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── Аналитика поисковых запросов экспертизы (issue #156) ──────────────────

  it('фильтрует журнал запросов по поддержке и качеству, сортируя по лучшему совпадению', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // COUNT
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'q-1',
            game_id: null,
            query_text: 'где переночевать',
            best_similarity: 0.92,
            result_count: 2,
            retrieved_documents: [{ id: 'doc-1', title: 'Ночлег', similarity: 0.92 }],
            created_at: '2026-06-01T10:00:00.000Z',
            query_distance: null,
            game_name: null,
          },
        ],
      });
    const { service: embeddings, embed } = makeEmbeddings();
    const service = new AdminDataService({ query } as unknown as DatabaseService, embeddings);

    const result = await service.listExpertiseSearchQueries({
      support: true,
      minSimilarity: 0.9,
      limit: 50,
      offset: 0,
    });

    expect(embed).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 'q-1',
      queryText: 'где переночевать',
      bestSimilarity: 0.92,
      resultCount: 2,
      querySimilarity: null,
    });
    const mainSql = String(query.mock.calls[1][0]);
    expect(mainSql).toContain('q.game_id IS NULL');
    expect(mainSql).toContain('COALESCE(q.best_similarity, 0) >=');
    expect(mainSql).toContain('ORDER BY q.best_similarity DESC');
  });

  it('семантический поиск по фразе считает эмбеддинг и сортирует по близости', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // COUNT
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'q-1',
            game_id: 'bomj',
            query_text: 'ночлег у вокзала',
            best_similarity: 0.5,
            result_count: 1,
            retrieved_documents: [],
            created_at: '2026-06-01T10:00:00.000Z',
            query_distance: 0.2,
            game_name: 'Бомж',
          },
        ],
      });
    const { service: embeddings, embed } = makeEmbeddings();
    const service = new AdminDataService({ query } as unknown as DatabaseService, embeddings);

    const result = await service.listExpertiseSearchQueries({
      gameId: 'bomj',
      phrase: 'где переночевать',
      limit: 50,
      offset: 0,
    });

    expect(embed).toHaveBeenCalledWith(['где переночевать']);
    // querySimilarity = 1 - distance
    expect(result.items[0].querySimilarity).toBeCloseTo(0.8);
    expect(result.items[0].gameName).toBe('Бомж');
    const mainSql = String(query.mock.calls[1][0]);
    expect(mainSql).toContain('q.embedding <=>');
    expect(mainSql).toContain('ORDER BY q.embedding <=>');
  });

  // ── Проверка работы поисковых запросов к базе знаний (issue #164) ─────────

  it('проверка поиска: эмбеддит ключ и возвращает каждую фразу-источник с близостью', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          document_id: 'doc-1',
          document_title: 'Ночлег',
          game_id: null,
          source: 'где переночевать',
          distance: 0.1,
        },
        {
          document_id: 'doc-1',
          document_title: 'Ночлег',
          game_id: null,
          source: 'тёплые трубы',
          distance: 0.3,
        },
      ],
    });
    const { service: embeddings, embed } = makeEmbeddings();
    const service = new AdminDataService({ query } as unknown as DatabaseService, embeddings);

    const result = await service.searchExpertiseSources({ query: 'переночевать', limit: 20, support: true });

    expect(embed).toHaveBeenCalledWith(['переночевать']);
    expect(result.embeddingsAvailable).toBe(true);
    expect(result.matches).toEqual([
      { documentId: 'doc-1', documentTitle: 'Ночлег', gameId: null, source: 'где переночевать', distance: 0.1, similarity: 0.9 },
      { documentId: 'doc-1', documentTitle: 'Ночлег', gameId: null, source: 'тёплые трубы', distance: 0.3, similarity: 0.7 },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('FROM expertise_document_embeddings');
    expect(sql).toContain('d.game_id IS NULL');
    expect(sql).toContain('ORDER BY distance ASC');
  });

  it('проверка поиска: область игры добавляет фильтр по game_id', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const { service: embeddings } = makeEmbeddings();
    const service = new AdminDataService({ query } as unknown as DatabaseService, embeddings);

    await service.searchExpertiseSources({ query: 'еда', limit: 5, gameId: 'bomj' });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('d.game_id = $');
    expect(query.mock.calls[0][1]).toContain('bomj');
  });

  it('проверка поиска: без OPENAI_API_KEY не обращается к БД и помечает эмбеддинги недоступными', async () => {
    const query = vi.fn();
    const embed = vi.fn();
    const embeddings = {
      embed,
      isEnabled: () => false,
    } as unknown as import('../src/embedding/embedding.service').EmbeddingService;
    const service = new AdminDataService({ query } as unknown as DatabaseService, embeddings);

    const result = await service.searchExpertiseSources({ query: 'еда', limit: 20 });

    expect(result).toEqual({ query: 'еда', embeddingsAvailable: false, matches: [] });
    expect(embed).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('проверка поиска: пустой запрос не обращается к эмбеддингам и БД', async () => {
    const query = vi.fn();
    const { service: embeddings, embed } = makeEmbeddings();
    const service = new AdminDataService({ query } as unknown as DatabaseService, embeddings);

    const result = await service.searchExpertiseSources({ query: '   ', limit: 20 });

    expect(result).toEqual({ query: '', embeddingsAvailable: true, matches: [] });
    expect(embed).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  // ── Онтология (issue #323) ──────────────────────────────────────────────

  it('онтология: без выбора игры запрос отклоняется', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.getGameOntology('   ')).rejects.toBeInstanceOf(BadRequestException);
    // assertGameExists даже не дошла до запроса каталога.
    expect(query).not.toHaveBeenCalled();
  });

  it('онтология: неизвестная игра отклоняется', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new AdminDataService({ query } as unknown as DatabaseService);

    await expect(service.getGameOntology('ghost')).rejects.toBeInstanceOf(BadRequestException);
    expect(String(query.mock.calls[0][0])).toContain('FROM game_manifests');
  });

  it('онтология: загрузка графа возвращает концепты и связи игры', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({
      getGameOntology: vi.fn().mockResolvedValue({
        concepts: [{ slug: 'teplo' }],
        relations: [{ from_slug: 'nochleg', to_slug: 'teplo' }],
      }),
    });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    const result = await service.getGameOntology('bomj');

    expect(result).toEqual({
      gameId: 'bomj',
      concepts: [{ slug: 'teplo' }],
      relations: [{ from_slug: 'nochleg', to_slug: 'teplo' }],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(neo4j.getGameOntology).toHaveBeenCalledWith('bomj');
  });

  it('онтология: граф отдаёт провенанс (origin, source_document_id) - Graph RAG #328', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({
      getGameOntology: vi.fn().mockResolvedValue({
        concepts: [{ slug: 'teplo', origin: 'extracted', source_document_id: 'doc-1' }],
        relations: [{ from_slug: 'nochleg', to_slug: 'teplo', origin: 'authored', source_document_id: null }],
      }),
    });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    const result = await service.getGameOntology('bomj');

    expect(result.concepts[0]).toMatchObject({ origin: 'extracted', source_document_id: 'doc-1' });
    expect(result.relations[0]).toMatchObject({ origin: 'authored', source_document_id: null });
  });

  it('Graph RAG: сообщества игры читаются из Neo4j (#328/#363)', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({
      getGameCommunities: vi.fn().mockResolvedValue([{ id: 'gc1', title: 'Опасности зимы' }]),
    });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    const result = await service.getGameCommunities('bomj');

    expect(result).toEqual({ gameId: 'bomj', communities: [{ id: 'gc1', title: 'Опасности зимы' }] });
    expect(query).toHaveBeenCalledTimes(1);
    expect(neo4j.getGameCommunities).toHaveBeenCalledWith('bomj');
  });

  it('Graph RAG: верификация концепта помечает extracted -> authored (#328)', async () => {
    const neo4j = makeNeo4j({
      verifyOntologyConcept: vi.fn().mockResolvedValue({ id: 'c1', origin: 'authored' }),
    });
    const service = new AdminDataService(makeDatabase(), undefined, undefined, neo4j);

    const row = await service.verifyOntologyConcept('c1');

    expect(row).toEqual({ id: 'c1', origin: 'authored' });
    expect(neo4j.verifyOntologyConcept).toHaveBeenCalledWith('c1');
  });

  it('Graph RAG: верификация уже подтверждённого концепта отдаёт строку как есть', async () => {
    const neo4j = makeNeo4j({
      verifyOntologyConcept: vi.fn().mockResolvedValue({ id: 'c1', origin: 'authored' }),
    });
    const service = new AdminDataService(makeDatabase(), undefined, undefined, neo4j);

    const row = await service.verifyOntologyConcept('c1');

    expect(row).toEqual({ id: 'c1', origin: 'authored' });
  });

  it('Graph RAG: верификация несуществующего концепта - NotFound', async () => {
    const neo4j = makeNeo4j({ verifyOntologyConcept: vi.fn().mockResolvedValue(null) });
    const service = new AdminDataService(makeDatabase(), undefined, undefined, neo4j);

    await expect(service.verifyOntologyConcept('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('Graph RAG: верификация связи помечает extracted -> authored (#328)', async () => {
    const neo4j = makeNeo4j({
      verifyOntologyRelation: vi.fn().mockResolvedValue({ id: 'r1', origin: 'authored' }),
    });
    const service = new AdminDataService(makeDatabase(), undefined, undefined, neo4j);

    const row = await service.verifyOntologyRelation('r1');

    expect(row).toEqual({ id: 'r1', origin: 'authored' });
    expect(neo4j.verifyOntologyRelation).toHaveBeenCalledWith('r1');
  });

  it('Graph RAG: верификация несуществующей связи - NotFound', async () => {
    const neo4j = makeNeo4j({ verifyOntologyRelation: vi.fn().mockResolvedValue(null) });
    const service = new AdminDataService(makeDatabase(), undefined, undefined, neo4j);

    await expect(service.verifyOntologyRelation('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('онтология: концепт без slug отклоняется', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j();
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    await expect(
      service.createOntologyConcept('bomj', { slug: '', kind: 'object', title: 'Тепло' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(neo4j.createOntologyConcept).not.toHaveBeenCalled();
  });

  it('онтология: дубликат slug превращается в 400', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({
      createOntologyConcept: vi.fn().mockRejectedValue(new Neo4jOntologyConflictError('duplicate')),
    });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    await expect(
      service.createOntologyConcept('bomj', { slug: 'teplo', kind: 'object', title: 'Тепло' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('онтология: обновление несуществующего концепта - NotFound', async () => {
    const neo4j = makeNeo4j({ updateOntologyConcept: vi.fn().mockResolvedValue(null) });
    const service = new AdminDataService(makeDatabase(), undefined, undefined, neo4j);

    await expect(
      service.updateOntologyConcept('missing', { slug: 'teplo', kind: 'object', title: 'Тепло' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('онтология: связь сериализует условие в JSON', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({ createOntologyRelation: vi.fn().mockResolvedValue({ id: 'rel-1' }) });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    await service.createOntologyRelation('bomj', {
      fromSlug: 'nochleg',
      toSlug: 'moroz',
      relation: 'угрожает',
      condition: { season: 'зима' },
    });

    expect(neo4j.createOntologyRelation).toHaveBeenCalledWith('bomj', {
      fromSlug: 'nochleg',
      toSlug: 'moroz',
      relation: 'угрожает',
      weight: 1,
      condition: { season: 'зима' },
      note: '',
    });
  });

  it('онтология: пустое условие связи сохраняется как null', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({ createOntologyRelation: vi.fn().mockResolvedValue({ id: 'rel-1' }) });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    await service.createOntologyRelation('bomj', {
      fromSlug: 'nochleg',
      toSlug: 'teplo',
      relation: 'требует',
    });

    expect((neo4j.createOntologyRelation.mock.calls[0][1] as Record<string, unknown>).condition).toBeNull();
  });

  it('онтология: конфликт обновления связи превращается в 400', async () => {
    const neo4j = makeNeo4j({
      updateOntologyRelation: vi.fn().mockRejectedValue(new Neo4jOntologyConflictError('duplicate')),
    });
    const service = new AdminDataService(makeDatabase(), undefined, undefined, neo4j);

    await expect(
      service.updateOntologyRelation('rel-1', {
        fromSlug: 'nochleg',
        toSlug: 'teplo',
        relation: 'требует',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('онтология: экспорт оборачивает граф в конверт версии 1', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({
      exportGameOntology: vi.fn().mockResolvedValue({
        concepts: [{ slug: 'teplo', kind: 'state', title: 'Тепло', synonyms: null, fact: 'нужно', weight: 2 }],
        relations: [
          {
            from_slug: 'nochleg',
            to_slug: 'teplo',
            relation: 'требует',
            weight: 1,
            condition: null,
            note: '',
          },
        ],
      }),
    });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    const result = await service.exportGameOntology('bomj');

    expect(result.version).toBe(1);
    expect(result.gameId).toBe('bomj');
    expect(result.concepts).toEqual([
      { slug: 'teplo', kind: 'state', title: 'Тепло', synonyms: [], fact: 'нужно', weight: 2 },
    ]);
    expect(result.relations).toEqual([
      { fromSlug: 'nochleg', toSlug: 'teplo', relation: 'требует', weight: 1, condition: null, note: '' },
    ]);
  });

  it('онтология: импорт возвращает сводку вставок и обновлений из Neo4j', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ game_id: 'bomj' }] });
    const neo4j = makeNeo4j({ importGameOntology: vi.fn().mockResolvedValue({ created: 1, updated: 1 }) });
    const service = new AdminDataService({ query } as unknown as DatabaseService, undefined, undefined, neo4j);

    const summary = await service.importGameOntology({
      gameId: 'bomj',
      concepts: [{ slug: 'teplo', kind: 'state', title: 'Тепло' }],
      relations: [{ fromSlug: 'nochleg', toSlug: 'teplo', relation: 'требует' }],
    });

    expect(summary).toEqual({ total: 2, created: 1, updated: 1, unchanged: 0 });
    expect(neo4j.importGameOntology).toHaveBeenCalledWith({
      gameId: 'bomj',
      concepts: [{ slug: 'teplo', kind: 'state', title: 'Тепло', synonyms: [], fact: '', weight: 1 }],
      relations: [{ fromSlug: 'nochleg', toSlug: 'teplo', relation: 'требует', weight: 1, condition: null, note: '' }],
    });
  });
});
