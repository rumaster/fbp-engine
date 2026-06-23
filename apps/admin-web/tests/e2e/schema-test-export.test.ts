// E2E для issue #379: окно теста схемы экспортирует результат запуска в Markdown,
// показывает подготовленный текст оператору и копирует его в системный clipboard.
import { expect, test, type Page } from '@playwright/test';

const ISO = '2026-01-01T00:00:00.000Z';

function actionGraph() {
  return {
    version: 1,
    slug: 'action',
    schemaType: 'action',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      {
        id: 'llm-1',
        type: 'llm_request',
        position: { x: 260, y: 120 },
        config: { prompt: 'Ответь на действие игрока' },
        label: 'LLM',
      },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start->llm', from: 'start', fromPort: 'exec', to: 'llm-1', toPort: 'exec' },
      { id: 'llm->end', from: 'llm-1', fromPort: 'exec', to: 'end', toPort: 'exec' },
    ],
  };
}

function actionRecord() {
  return {
    schema_slug: 'action',
    schema_type: 'action',
    game_id: null,
    description: 'action schema',
    graph_json: actionGraph(),
    updated_at: ISO,
  };
}

function testResponse() {
  return {
    outputs: { result: 'Игрок осмотрел комнату.' },
    durationMs: 42,
    costMillicents: 123,
    nodeTrace: [
      {
        order: 1,
        nodeId: 'start',
        nodeType: 'start',
        via: 'flow',
        durationMs: 1,
        outputKeys: ['action'],
        outputs: { action: 'Осмотреться' },
        schemaSlug: 'action',
        depth: 0,
        failed: false,
      },
      {
        order: 2,
        nodeId: 'llm-1',
        nodeType: 'llm_request',
        via: 'flow',
        durationMs: 39,
        outputKeys: ['result'],
        outputs: { result: 'Игрок осмотрел комнату.' },
        schemaSlug: 'action',
        depth: 0,
        failed: false,
      },
    ],
    llmLog: [
      {
        nodeId: 'llm-1',
        kind: 'llm_request',
        requestText: 'Действие: Осмотреться',
        responseText: 'Игрок осмотрел комнату.',
      },
    ],
  };
}

async function mockApi(page: Page): Promise<void> {
  const record = actionRecord();

  await page.addInitScript(() => {
    window.localStorage.setItem('adminToken', 'test-token');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { __copiedMarkdown?: string }).__copiedMarkdown = text;
        },
      },
    });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/auth/me') {
      return route.fulfill({ json: { userId: 'admin', telegramId: '42', username: 'tester', expiresAt: 9_999_999_999_999 } });
    }
    if (url.pathname === '/api/games' && request.method() === 'GET') {
      return route.fulfill({ json: { total: 0, items: [] } });
    }
    if (url.pathname === '/api/schemas' && request.method() === 'GET') {
      return route.fulfill({ json: { items: [record] } });
    }
    const draftMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/draft$/);
    if (draftMatch && request.method() === 'GET') {
      return route.fulfill({ json: { ...record, has_draft: false } });
    }
    if (url.pathname === '/api/schemas/action/test' && request.method() === 'POST') {
      return route.fulfill({ json: testResponse() });
    }
    if (url.pathname === '/api/schemas/action' && request.method() === 'GET') {
      return route.fulfill({ json: record });
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

test('модалка теста экспортирует результат в Markdown и копирует его (issue #379)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/schemas/action');

  await page.getByRole('button', { name: 'Тест' }).click();
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.getByText('Outputs', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Экспорт MD' }).click();
  await expect(page.getByText('Экспорт результата теста')).toBeVisible();
  await page.locator('.modal').last().screenshot({ path: '../../docs/screenshots/schema-test-export-md.png' });

  const textarea = page.getByLabel('Markdown отчёта');
  const markdown = await textarea.inputValue();
  expect(markdown).toContain('# Результат теста: action');
  expect(markdown).toContain('- Схема: action');
  expect(markdown).toContain('## Контекст выполнения');
  expect(markdown).toContain('Без игры');
  expect(markdown).toContain('## Начальные параметры запуска теста');
  expect(markdown).toContain('"action": "Осмотреться"');
  expect(markdown).toContain('## Duration');
  expect(markdown).toContain('42 ms');
  expect(markdown).toContain('## Outputs');
  expect(markdown).toContain('"result": "Игрок осмотрел комнату."');
  expect(markdown).toContain('## Лог узлов (2)');
  expect(markdown).toContain('| 1 | start |');
  expect(markdown).toContain('## Данные по узлам (2)');
  expect(markdown).toContain('### 2. llm-1');
  expect(markdown).toContain('## LLM log (1)');
  expect(markdown).toContain('Действие: Осмотреться');

  await page.locator('.schema-test-export-actions').getByRole('button', { name: 'Копировать' }).click();
  await expect(page.getByText('Скопировано')).toBeVisible();
  const copied = await page.evaluate(() => (window as Window & { __copiedMarkdown?: string }).__copiedMarkdown);
  expect(copied).toBe(markdown);
});
