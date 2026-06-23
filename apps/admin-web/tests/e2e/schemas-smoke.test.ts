import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

type SchemaType = 'action' | 'hint' | 'illustration' | 'support';

interface SchemaRecord {
  schema_slug: SchemaType;
  schema_type: SchemaType;
  // Привязка к игре (issue #234). null — глобальная (базовая/поддержка) схема.
  game_id: string | null;
  description: string;
  graph_json: SchemaGraph;
  updated_at: string;
}

// Игры для селектбокса области схем (issue #234).
const GAMES = [
  { game_id: 'game-alpha', name: 'Альфа' },
  { game_id: 'game-beta', name: 'Бета' },
];

interface SchemaGraph {
  version: 1;
  slug: SchemaType;
  schemaType: SchemaType;
  nodes: Array<{
    id: string;
    type: 'start' | 'end' | 'llm_request';
    position: { x: number; y: number };
    config: Record<string, unknown>;
    label: string;
  }>;
  edges: Array<{
    id: string;
    from: string;
    fromPort: string;
    to: string;
    toPort: string;
  }>;
  variables: Record<string, unknown>;
}

const SCHEMA_TYPES: SchemaType[] = ['action', 'hint', 'illustration', 'support'];

test('редактор схем открывает action, переключает вкладки, сохраняет и запускает test modal', async ({ page }) => {
  const records = await mockAdminApi(page);

  await page.goto('/#/schemas/action');

  await expect(page.getByRole('button', { name: 'Действие' })).toHaveClass(/button-active/);
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Start' })).toBeVisible();

  // Кнопки действий тулбара — пиктограммы без подписи, чтобы помещаться в один
  // ряд (issue #264): иконка отрисована, текст скрыт, ярлык доступен в aria-label.
  const saveButton = page.getByRole('button', { name: 'Сохранить' });
  await expect(saveButton).toHaveClass(/button-icon/);
  await expect(saveButton.locator('svg')).toBeVisible();
  await expect(saveButton).toHaveText('');

  // В базовом режиме (без выбранной игры) показаны три пер-игровых типа схем,
  // вкладка «Поддержка» скрыта — она доступна через селектбокс области (issue #234).
  for (const label of ['Действие', 'Подсказка', 'Иллюстрация']) {
    await page.getByRole('button', { name: label }).click();
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.locator('.blueprint-node').filter({ hasText: 'Start' })).toBeVisible();
  }

  // Недоступные блоки палитры больше не скрываются, а показываются disabled с
  // объяснением (issue #248). Переключаемся на «Поддержку» через селектбокс —
  // «State write» виден, но помечен disabled и несёт tooltip-причину.
  await page.locator('.schema-game-select select').selectOption('__support__');
  await expect(page.getByRole('button', { name: 'Поддержка' })).toHaveClass(/button-active/);
  const palette = page.locator('.node-palette');
  const stateWriteDisabled = palette.locator('.node-palette-button--disabled').filter({ hasText: 'State write' });
  await expect(stateWriteDisabled).toBeVisible();
  await expect(stateWriteDisabled).toHaveAttribute('aria-disabled', 'true');
  await expect(stateWriteDisabled).toHaveAttribute('title', /.+/);

  // Возвращаемся к базовой области — открывается «Действие», тот же блок доступен.
  await page.locator('.schema-game-select select').selectOption('__base__');
  await expect(page.getByRole('button', { name: 'Действие' }).first()).toHaveClass(/button-active/);
  const stateWriteAction = palette.locator('.node-palette-button').filter({ hasText: 'State write' });
  await expect(stateWriteAction).toBeVisible();
  await expect(stateWriteAction).not.toHaveClass(/node-palette-button--disabled/);

  await page.locator('.blueprint-node').filter({ hasText: 'Start' }).click();
  await expect(page.locator('.schema-config')).toContainText('start');

  // Правка описания делает черновик «грязным»: индикатор статуса слева от «Обновить»
  // загорается, а мета-поле «Состояние» показывает «есть правки» (issue #286, треб. #6).
  await page.locator('.schema-palette .editor-label.compact input').fill('действие — черновик');
  await expect(page.locator('.schema-draft-status')).toHaveClass(/schema-draft-status--has-draft/);
  await expect(page.locator('.schema-meta-list')).toContainText('есть правки');

  // Сохранение: сначала PATCH черновика, затем POST промоута черновика в рабочую версию.
  const saveResponse = page.waitForResponse(
    (response) =>
      /\/api\/schemas\/action\/promote$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect((await saveResponse).ok()).toBe(true);
  expect(records.get('action')?.graph_json.slug).toBe('action');
  await expect(page.locator('.schema-meta-list')).toContainText('02.01.26');
  // После промоута черновик совпадает с рабочей версией — индикатор гаснет.
  await expect(page.locator('.schema-draft-status')).not.toHaveClass(/schema-draft-status--has-draft/);

  await page.getByRole('button', { name: 'Тест' }).click();
  await expect(page.getByText('Тест схемы action')).toBeVisible();

  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.getByText('Outputs')).toBeVisible();
  await expect(page.locator('.json-box').last()).toContainText('"ok": true');
});

test('область схем: поддержка по умолчанию, выбор игры, gameId в URL и пер-игровое сохранение (issue #234)', async ({ page }) => {
  const records = await mockAdminApi(page);

  // При открытии вкладки «Схемы» без области по умолчанию открыта «Поддержка».
  await page.goto('/#/schemas');
  await expect(page.getByRole('button', { name: 'Поддержка' })).toHaveClass(/button-active/);
  await expect(page).toHaveURL(/#\/schemas\/support/);
  // Селектбокс области стоит на «Поддержке».
  await expect(page.locator('.schema-game-select select')).toHaveValue('__support__');

  // Выбираем игру в селектбоксе — по умолчанию открывается «Действие»,
  // а выбор отражается в пути браузера (gameId), чтобы открыть по ссылке/закладке.
  await page.locator('.schema-game-select select').selectOption('game-alpha');
  await expect(page.getByRole('button', { name: 'Действие' }).first()).toHaveClass(/button-active/);
  await expect(page).toHaveURL(/gameId=game-alpha/);

  // У игры нет своей схемы — показана базовая с предупреждением о наследовании.
  await expect(page.locator('.message-line')).toContainText(/собственной схемы/);
  await expect(page.locator('.schema-meta-list')).toContainText('Альфа');

  // Сохраняем без правок — промоут форкает базовую схему в схему игры (issue #234):
  // gameId передаётся в query запроса промоута.
  const saveResponse = page.waitForResponse(
    (response) =>
      /\/api\/schemas\/action\/promote$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Сохранить' }).click();
  const saved = await saveResponse;
  expect(saved.ok()).toBe(true);
  expect(new URL(saved.url()).searchParams.get('gameId')).toBe('game-alpha');

  // Переключаемся на «Подсказку» в рамках игры — gameId сохраняется в URL.
  await page.getByRole('button', { name: 'Подсказка' }).click();
  await expect(page).toHaveURL(/#\/schemas\/hint\?gameId=game-alpha/);

  // Глобальные базовые схемы не затронуты пер-игровым сохранением.
  expect(records.get('action')?.game_id).toBeNull();
});

test('кнопка «Обновить» сбрасывает черновик до рабочей версии (issue #286)', async ({ page }) => {
  await mockAdminApi(page);
  // Кнопка показывает подтверждение через window.confirm — соглашаемся.
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  const description = page.locator('.schema-palette .editor-label.compact input');
  await expect(description).toHaveValue('action schema');

  // Правим описание — появляется незафиксированный черновик, индикатор загорается.
  await description.fill('временная правка черновика');
  await expect(page.locator('.schema-draft-status')).toHaveClass(/schema-draft-status--has-draft/);
  await expect(page.locator('.schema-meta-list')).toContainText('есть правки');

  // «Обновить» сбрасывает черновик (DELETE) и перезагружает рабочую версию (треб. #3).
  const resetResponse = page.waitForResponse(
    (response) =>
      /\/api\/schemas\/action\/draft$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect((await resetResponse).ok()).toBe(true);

  // Черновик забыт: описание вернулось к рабочей версии, индикатор погас.
  await expect(description).toHaveValue('action schema');
  await expect(page.locator('.schema-draft-status')).not.toHaveClass(/schema-draft-status--has-draft/);
  await expect(page.locator('.schema-meta-list')).toContainText('сохранено');
});

test('область схем открывается из закладки с gameId (issue #234)', async ({ page }) => {
  await mockAdminApi(page);

  // Прямой переход по ссылке с конкретной игрой и типом схемы.
  await page.goto('/#/schemas/hint?gameId=game-beta');
  await expect(page.getByRole('button', { name: 'Подсказка' })).toHaveClass(/button-active/);
  await expect(page.locator('.schema-game-select select')).toHaveValue('game-beta');
  await expect(page.locator('.schema-meta-list')).toContainText('Бета');
});

test('узел добавляется перетаскиванием с палитры на canvas (issue #202)', async ({ page }) => {
  await mockAdminApi(page);

  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  // Изначально на canvas нет узла «Log».
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Log' })).toHaveCount(0);

  const source = page.getByRole('button', { name: 'Log', exact: true });
  await expect(source).toBeVisible();

  // Клик по элементу палитры больше не добавляет узел (issue #202 — только DnD).
  await source.click();
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Log' })).toHaveCount(0);

  // Перетаскиваем узел с палитры в зону canvas через нативные HTML5 DnD-события.
  const target = page.locator('.schema-canvas-dropzone');
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const dropX = box.x + box.width / 2;
  const dropY = box.y + box.height / 2;

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer, clientX: dropX, clientY: dropY });
  await target.dispatchEvent('drop', { dataTransfer, clientX: dropX, clientY: dropY });

  // После сброса появляется новый узел «Log».
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Log' })).toBeVisible();
});

test('подписи портов находятся напротив своих handles', async ({ page }) => {
  const records = await mockAdminApi(page);
  records.set('action', {
    ...schemaRecord('action'),
    graph_json: schemaGraphWithPortLegend(),
  });

  await page.goto('/#/schemas/action');

  const node = page.locator('.blueprint-node').filter({ hasText: 'LLM ports' });
  await expect(node).toBeVisible();
  await expectAlignedPortRows(node, 'input');
  await expectAlignedPortRows(node, 'output');
});

test('порты можно перетаскивать в панели свойств и порядок меняется на схеме (issue #218)', async ({ page }) => {
  const records = await mockAdminApi(page);
  records.set('action', {
    ...schemaRecord('action'),
    graph_json: schemaGraphWithPortLegend(),
  });

  await page.goto('/#/schemas/action');

  const node = page.locator('.blueprint-node').filter({ hasText: 'LLM ports' });
  await expect(node).toBeVisible();
  await expectPortLabels(node, 'input', ['exec', 'query', 'profile']);

  await node.click();
  const rows = page.locator('.schema-port-table.inputs tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(portNameInput(rows, 0)).toHaveValue('query');
  await expect(portNameInput(rows, 1)).toHaveValue('profile');

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await rows.nth(0).locator('.schema-port-drag-button').dispatchEvent('dragstart', { dataTransfer });
  await rows.nth(1).dispatchEvent('dragover', { dataTransfer });
  await rows.nth(1).dispatchEvent('drop', { dataTransfer });
  await rows.nth(0).locator('.schema-port-drag-button').dispatchEvent('dragend', { dataTransfer });

  await expect(portNameInput(rows, 0)).toHaveValue('profile');
  await expect(portNameInput(rows, 1)).toHaveValue('query');
  await expectPortLabels(node, 'input', ['exec', 'profile', 'query']);
});

test('раскрытие окна редактирования промпта вставляет шаблон входящего порта (issue #285)', async ({ page }) => {
  const records = await mockAdminApi(page);
  records.set('action', {
    ...schemaRecord('action'),
    graph_json: schemaGraphWithPortLegend(),
  });

  await page.goto('/#/schemas/action');

  await page.locator('.blueprint-node').filter({ hasText: 'LLM ports' }).click();
  await expect(page.locator('.schema-config')).toContainText('LLM ports');

  // У поля System prompt появилась пиктограмма раскрытия (issue #285).
  const systemPromptField = page.locator('.editor-label').filter({ hasText: 'System prompt' });
  const expandToggle = systemPromptField.locator('.expandable-textarea-toggle');
  await expect(expandToggle).toBeVisible();
  await expandToggle.click();

  // Большое модальное окно затеняет редактор и показывает панель входящих портов.
  const modal = page.locator('.text-editor-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.text-editor-port-button')).toHaveText(['query', 'profile']);

  const area = modal.locator('.text-editor-area');
  await expect(area).toHaveValue('');

  // Клик по кнопке порта вставляет шаблон вида {{имя}} в редактор шаблона.
  await modal.locator('.text-editor-port-button').filter({ hasText: 'query' }).click();
  await expect(area).toHaveValue('{{query}}');
  await modal.locator('.text-editor-port-button').filter({ hasText: 'profile' }).click();
  await expect(area).toHaveValue('{{query}}{{profile}}');

  // Окно закрывается крестиком, возвращая общий редактор; правка сохраняется в поле.
  await modal.getByRole('button', { name: 'Закрыть' }).click();
  await expect(modal).toHaveCount(0);
  await expect(systemPromptField.locator('textarea')).toHaveValue('{{query}}{{profile}}');
});

test('панели редактора схем прокручиваются независимо от окна браузера (issue #207)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  const records = await mockAdminApi(page);
  records.set('action', {
    ...schemaRecord('action'),
    graph_json: schemaGraphWithLongConfig(),
  });

  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  await page.locator('.blueprint-node').filter({ hasText: 'Long LLM' }).click();
  await expect(page.locator('.schema-config')).toContainText('Long LLM');

  const metrics = await page.evaluate(() => {
    const documentScroller = document.scrollingElement ?? document.documentElement;
    const palette = document.querySelector<HTMLElement>('.schema-palette');
    const config = document.querySelector<HTMLElement>('.schema-config');
    const layout = document.querySelector<HTMLElement>('.schemas-layout');
    if (!palette || !config || !layout) throw new Error('schema editor panels not found');

    documentScroller.scrollTop = 9999;
    palette.scrollTop = 9999;
    config.scrollTop = 9999;

    return {
      viewportHeight: window.innerHeight,
      documentScrollTop: documentScroller.scrollTop,
      paletteClientHeight: palette.clientHeight,
      paletteScrollHeight: palette.scrollHeight,
      paletteScrollTop: palette.scrollTop,
      configClientHeight: config.clientHeight,
      configScrollHeight: config.scrollHeight,
      configScrollTop: config.scrollTop,
      layoutBottom: layout.getBoundingClientRect().bottom,
    };
  });

  expect(metrics.layoutBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.documentScrollTop).toBeLessThanOrEqual(8);
  expect(metrics.paletteScrollHeight).toBeGreaterThan(metrics.paletteClientHeight + 40);
  expect(metrics.paletteScrollTop).toBeGreaterThan(40);
  expect(metrics.configScrollHeight).toBeGreaterThan(metrics.configClientHeight + 80);
  expect(metrics.configScrollTop).toBeGreaterThan(80);
});

test('рёбра становятся толще и ярче при наведении и выделении (issue #206)', async ({ page }) => {
  const records = await mockAdminApi(page);
  records.set('action', {
    ...schemaRecord('action'),
    graph_json: schemaGraphWithDataEdge(),
  });

  await page.goto('/#/schemas/action');

  await expectEdgeEmphasis(page, '.schema-edge-exec');
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
  await expectEdgeEmphasis(page, '.schema-edge-data');
});

test('глобальный импорт бандла показывает diff created/updated и применяет сводку (issue #248)', async ({ page }) => {
  await mockAdminApi(page);

  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  // Бандл: action с изменённым графом (→ обновить) и новая схема (→ создать).
  const modifiedAction = schemaGraph('action');
  modifiedAction.nodes[0].label = 'Start (изменён)';
  const bundle = {
    version: 1,
    exportedAt: '2026-02-01T00:00:00.000Z',
    items: [
      { schemaSlug: 'action', schemaType: 'action', gameId: null, graphJson: modifiedAction, description: 'action schema' },
      { schemaSlug: 'newone', schemaType: 'action', gameId: null, graphJson: schemaGraph('action'), description: 'новая' },
    ],
  };

  await page
    .locator('input.file-input')
    .nth(1)
    .setInputFiles({ name: 'bundle.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });

  // Модалка предпросмотра показывает клиентский diff.
  await expect(page.getByText('Импорт бандла схем')).toBeVisible();
  await expect(page.getByText('всего: 2 · создано: 1 · обновлено: 1 · без изменений: 0')).toBeVisible();
  await expect(page.locator('.bundle-action--created')).toHaveText('создать');
  await expect(page.locator('.bundle-action--updated')).toHaveText('обновить');

  await page.screenshot({ path: 'test-results/bundle-import-diff.png', fullPage: true });

  // Применяем импорт — сервер возвращает авторитетную сводку.
  const importResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/schemas/import') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Применить импорт' }).click();
  await expect((await importResponse).ok()).toBe(true);
  await expect(page.getByText(/Импорт схем выполнен/)).toBeVisible();
});

async function mockAdminApi(page: Page): Promise<Map<SchemaType, SchemaRecord>> {
  const records = new Map<SchemaType, SchemaRecord>(
    SCHEMA_TYPES.map((schemaType) => [schemaType, schemaRecord(schemaType)]),
  );
  // Пер-игровые схемы (issue #234): ключ `${slug}:${gameId}`.
  const gameRecords = new Map<string, SchemaRecord>();
  // Черновики схем (issue #286): ключ draftKey(slug, gameId). NULL/отсутствие —
  // черновик совпадает с рабочей версией.
  const drafts = new Map<string, SchemaGraph>();

  await page.addInitScript(() => {
    window.localStorage.setItem('adminToken', 'test-token');
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/auth/me') {
      return route.fulfill({
        json: {
          userId: 'admin',
          telegramId: '42',
          username: 'tester',
          expiresAt: Date.now() + 600_000,
        },
      });
    }

    // Список игр для селектбокса области схем (issue #234).
    if (url.pathname === '/api/games' && request.method() === 'GET') {
      return route.fulfill({ json: { total: GAMES.length, items: GAMES } });
    }

    if (url.pathname === '/api/schemas' && request.method() === 'GET') {
      return route.fulfill({ json: { items: [...records.values(), ...gameRecords.values()] } });
    }

    // Глобальный экспорт всех схем бандлом (issue #248).
    if (url.pathname === '/api/schemas/export' && request.method() === 'GET') {
      return route.fulfill({
        json: {
          version: 1,
          exportedAt: '2026-01-01T00:00:00.000Z',
          items: [...records.values()].map((record) => ({
            schemaSlug: record.schema_slug,
            schemaType: record.schema_type,
            gameId: null,
            graphJson: record.graph_json,
            description: record.description,
          })),
        },
      });
    }

    // Глобальный импорт бандла: возвращаем авторитетную сводку (issue #248).
    if (url.pathname === '/api/schemas/import' && request.method() === 'POST') {
      const body = request.postDataJSON() as { items?: Array<{ schemaSlug?: string }> };
      const total = body.items?.length ?? 0;
      return route.fulfill({ json: { total, created: 1, updated: total - 1, unchanged: 0 } });
    }

    const testMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/test$/);
    if (testMatch && request.method() === 'POST') {
      return route.fulfill({
        json: {
          outputs: { ok: true },
          llmLog: [],
          durationMs: 1,
          costMillicents: 0,
        },
      });
    }

    // Черновики схем (issue #286): GET грузит черновик/рабочую, PATCH сохраняет
    // черновик, DELETE сбрасывает его до рабочей версии.
    const draftMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/draft$/);
    if (draftMatch) {
      const slug = draftMatch[1];
      if (!isSchemaType(slug)) {
        return route.fulfill({ status: 404, json: { message: 'schema not found' } });
      }
      const gameId = url.searchParams.get('gameId');
      const key = draftKey(slug, gameId);
      const own = gameId ? gameRecords.get(`${slug}:${gameId}`) : records.get(slug);
      // Наследование: если у игры нет своей строки — отдаём базовую (game_id: null).
      const record = own ?? records.get(slug)!;

      if (request.method() === 'GET') {
        const draft = drafts.get(key);
        return route.fulfill({
          json: { ...record, graph_json: draft ?? record.graph_json, has_draft: draft != null },
        });
      }

      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as { graphJson?: SchemaGraph; gameId?: unknown };
        const draft = body.graphJson ?? record.graph_json;
        drafts.set(key, draft);
        return route.fulfill({
          json: { ...record, game_id: gameId ?? record.game_id, graph_json: draft, has_draft: true },
        });
      }

      if (request.method() === 'DELETE') {
        drafts.delete(key);
        return route.fulfill({ json: { ...record, graph_json: record.graph_json, has_draft: false } });
      }
    }

    // Промоут черновика в рабочую версию (issue #286): копирует draft в working,
    // у наследующей игры — форкает базовую схему в собственную (issue #234).
    const promoteMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/promote$/);
    if (promoteMatch && request.method() === 'POST') {
      const slug = promoteMatch[1];
      if (!isSchemaType(slug)) {
        return route.fulfill({ status: 404, json: { message: 'schema not found' } });
      }
      return promoteSchema(route, slug, url.searchParams.get('gameId'), records, gameRecords, drafts);
    }

    const schemaMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)$/);
    if (schemaMatch) {
      const slug = schemaMatch[1];
      if (!isSchemaType(slug)) {
        return route.fulfill({ status: 404, json: { message: 'schema not found' } });
      }
      const gameId = url.searchParams.get('gameId');

      if (request.method() === 'GET') {
        if (gameId) {
          // Пер-игровая схема, если есть; иначе глобальный fallback (game_id: null).
          const own = gameRecords.get(`${slug}:${gameId}`);
          return route.fulfill({ json: own ?? records.get(slug) });
        }
        return route.fulfill({ json: records.get(slug) });
      }

      if (request.method() === 'PATCH') {
        return saveSchema(route, slug, records, gameRecords);
      }
    }

    return route.fulfill({
      status: 404,
      json: { message: `unmocked ${request.method()} ${url.pathname}` },
    });
  });

  return records;
}

async function saveSchema(
  route: Route,
  slug: SchemaType,
  records: Map<SchemaType, SchemaRecord>,
  gameRecords: Map<string, SchemaRecord>,
): Promise<void> {
  const payload = route.request().postDataJSON() as {
    description?: unknown;
    graphJson?: SchemaGraph;
    gameId?: unknown;
  };
  const gameId = typeof payload.gameId === 'string' && payload.gameId ? payload.gameId : null;
  const current = gameId
    ? gameRecords.get(`${slug}:${gameId}`) ?? schemaRecord(slug, gameId)
    : records.get(slug) ?? schemaRecord(slug);
  const next: SchemaRecord = {
    ...current,
    game_id: gameId,
    description: typeof payload.description === 'string' ? payload.description : '',
    graph_json: payload.graphJson ?? current.graph_json,
    updated_at: new Date('2026-01-02T03:04:05.000Z').toISOString(),
  };
  if (gameId) {
    gameRecords.set(`${slug}:${gameId}`, next);
  } else {
    records.set(slug, next);
  }

  return route.fulfill({ json: next });
}

function draftKey(slug: string, gameId: string | null): string {
  return `${slug}:${gameId ?? '__base__'}`;
}

async function promoteSchema(
  route: Route,
  slug: SchemaType,
  gameId: string | null,
  records: Map<SchemaType, SchemaRecord>,
  gameRecords: Map<string, SchemaRecord>,
  drafts: Map<string, SchemaGraph>,
): Promise<void> {
  const key = draftKey(slug, gameId);
  const draft = drafts.get(key);
  const committedAt = new Date('2026-01-02T03:04:05.000Z').toISOString();

  if (draft) {
    // Черновик есть — копируем его в рабочую версию и очищаем черновик.
    if (gameId) {
      const cur = gameRecords.get(`${slug}:${gameId}`) ?? schemaRecord(slug, gameId);
      const next: SchemaRecord = { ...cur, game_id: gameId, graph_json: draft, updated_at: committedAt };
      gameRecords.set(`${slug}:${gameId}`, next);
      drafts.delete(key);
      return route.fulfill({ json: next });
    }
    const cur = records.get(slug)!;
    const next: SchemaRecord = { ...cur, graph_json: draft, updated_at: committedAt };
    records.set(slug, next);
    drafts.delete(key);
    return route.fulfill({ json: next });
  }

  // Черновика нет: у наследующей игры сохранение форкает базовую схему (issue #234).
  if (gameId && !gameRecords.has(`${slug}:${gameId}`)) {
    const base = records.get(slug)!;
    const next: SchemaRecord = { ...base, game_id: gameId, updated_at: committedAt };
    gameRecords.set(`${slug}:${gameId}`, next);
    return route.fulfill({ json: next });
  }

  const record = gameId ? gameRecords.get(`${slug}:${gameId}`) ?? records.get(slug)! : records.get(slug)!;
  return route.fulfill({ json: { ...record } });
}

function schemaRecord(schemaType: SchemaType, gameId: string | null = null): SchemaRecord {
  return {
    schema_slug: schemaType,
    schema_type: schemaType,
    game_id: gameId,
    description: `${schemaType} schema`,
    graph_json: schemaGraph(schemaType),
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function schemaGraph(schemaType: SchemaType): SchemaGraph {
  return {
    version: 1,
    slug: schemaType,
    schemaType,
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [{ id: 'start:exec->end:exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' }],
    variables: {},
  };
}

function schemaGraphWithPortLegend(): SchemaGraph {
  return {
    ...schemaGraph('action'),
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      {
        id: 'llm-ports',
        type: 'llm_request',
        position: { x: 260, y: 80 },
        config: {
          inputs: [
            { name: 'query', type: 'string' },
            { name: 'profile', type: 'object' },
          ],
          outputs: [
            { name: 'hints', type: 'string_array' },
            { name: 'debug', type: 'object' },
          ],
        },
        label: 'LLM ports',
      },
      { id: 'end', type: 'end', position: { x: 620, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start:exec->llm-ports:exec', from: 'start', fromPort: 'exec', to: 'llm-ports', toPort: 'exec' },
      { id: 'llm-ports:exec->end:exec', from: 'llm-ports', fromPort: 'exec', to: 'end', toPort: 'exec' },
    ],
  };
}

function schemaGraphWithLongConfig(): SchemaGraph {
  return {
    ...schemaGraph('action'),
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      {
        id: 'llm-long',
        type: 'llm_request',
        position: { x: 260, y: 80 },
        config: {
          systemPrompt: 'System prompt\n'.repeat(12),
          userPrompt: 'User prompt\n'.repeat(18),
          retryPrompt: 'Retry prompt\n'.repeat(8),
          jsonMode: true,
          inputs: Array.from({ length: 10 }, (_, index) => ({
            name: `input_${index + 1}`,
            type: 'string',
            description: `Input ${index + 1}`,
          })),
          outputs: Array.from({ length: 10 }, (_, index) => ({
            name: `output_${index + 1}`,
            type: 'string',
            jsonPath: `value_${index + 1}`,
          })),
          modelParams: { temperature: 0.2, maxTokens: 1200 },
        },
        label: 'Long LLM',
      },
      { id: 'end', type: 'end', position: { x: 620, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start:exec->llm-long:exec', from: 'start', fromPort: 'exec', to: 'llm-long', toPort: 'exec' },
      { id: 'llm-long:exec->end:exec', from: 'llm-long', fromPort: 'exec', to: 'end', toPort: 'exec' },
    ],
  };
}

function schemaGraphWithDataEdge(): SchemaGraph {
  return {
    ...schemaGraph('action'),
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 140 }, config: {}, label: 'Start' },
      {
        id: 'llm-a',
        type: 'llm_request',
        position: { x: 270, y: 40 },
        config: {
          inputs: [{ name: 'action', type: 'string' }],
          outputs: [{ name: 'answer', type: 'string' }],
        },
        label: 'LLM A',
      },
      {
        id: 'llm-b',
        type: 'llm_request',
        position: { x: 570, y: 170 },
        config: {
          inputs: [{ name: 'query', type: 'string' }],
          outputs: [{ name: 'result', type: 'string' }],
        },
        label: 'LLM B',
      },
      { id: 'end', type: 'end', position: { x: 900, y: 140 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start-exec', from: 'start', fromPort: 'exec', to: 'llm-a', toPort: 'exec' },
      { id: 'answer-data', from: 'llm-a', fromPort: 'answer', to: 'llm-b', toPort: 'query' },
      { id: 'llm-b-exec', from: 'llm-b', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'result-end', from: 'llm-b', fromPort: 'result', to: 'end', toPort: 'narrative' },
    ],
  };
}

async function expectAlignedPortRows(node: Locator, side: 'input' | 'output'): Promise<void> {
  const rows = node.locator(`.blueprint-ports.${side} .blueprint-port-row`);
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const rowBox = await row.boundingBox();
    const handleBox = await row.locator('.blueprint-handle').boundingBox();
    expect(rowBox).not.toBeNull();
    expect(handleBox).not.toBeNull();
    if (!rowBox || !handleBox) return;

    const rowCenterY = rowBox.y + rowBox.height / 2;
    const handleCenterY = handleBox.y + handleBox.height / 2;
    expect(Math.abs(rowCenterY - handleCenterY)).toBeLessThanOrEqual(3);
  }
}

function portNameInput(rows: Locator, index: number): Locator {
  return rows.nth(index).locator('.schema-port-name-input');
}

async function expectPortLabels(node: Locator, side: 'input' | 'output', labels: string[]): Promise<void> {
  await expect(node.locator(`.blueprint-ports.${side} .blueprint-port-label`)).toHaveText(labels);
}

async function expectEdgeEmphasis(page: Page, edgeClass: string): Promise<void> {
  const edge = page.locator(`.react-flow__edge${edgeClass}`).first();
  const path = edge.locator('.react-flow__edge-path').first();
  await expect(path).toBeVisible();

  const normal = await edgePaint(path);
  await edge.hover({ force: true });
  await expectEdgePaintToBeEmphasized(path, normal);

  await page.mouse.move(0, 0);
  await edge.click({ force: true });
  await expect(edge).toHaveClass(/selected/);
  await expectEdgePaintToBeEmphasized(path, normal);
}

async function expectEdgePaintToBeEmphasized(
  path: Locator,
  normal: { strokeWidth: number; luminance: number },
): Promise<void> {
  await expect.poll(async () => (await edgePaint(path)).strokeWidth).toBeGreaterThan(normal.strokeWidth);
  await expect.poll(async () => (await edgePaint(path)).luminance).toBeGreaterThan(normal.luminance);
}

async function edgePaint(path: Locator): Promise<{ strokeWidth: number; luminance: number }> {
  return path.evaluate((element) => {
    const style = getComputedStyle(element);
    const channels = style.stroke.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
    return {
      strokeWidth: Number.parseFloat(style.strokeWidth),
      luminance: channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722,
    };
  });
}

function isSchemaType(value: string): value is SchemaType {
  return SCHEMA_TYPES.includes(value as SchemaType);
}
