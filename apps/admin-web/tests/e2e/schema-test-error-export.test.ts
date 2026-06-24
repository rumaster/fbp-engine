// E2E для issue #400: когда запуск теста схемы падает с ошибкой, окно теста всё
// равно даёт кнопку «Экспорт MD». Отчёт содержит текст ошибки, упавший узел и лог
// узлов, что успели отработать, — и копируется в системный clipboard.
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
        id: 'state-inventory',
        type: 'llm_request',
        position: { x: 260, y: 120 },
        config: { prompt: 'Обнови инвентарь' },
        label: 'Инвентарь',
      },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start->inv', from: 'start', fromPort: 'exec', to: 'state-inventory', toPort: 'exec' },
      { id: 'inv->end', from: 'state-inventory', fromPort: 'exec', to: 'end', toPort: 'exec' },
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

// Ответ-ошибка test-run: NestJS кладёт сообщение, упавший узел и nodeTrace под
// message; nodeTrace показывает, что start успел отработать до сбоя в инвентаре.
function errorResponse() {
  return {
    statusCode: 400,
    message: {
      message: "Unexpected identifier 'inventory'",
      nodeId: 'state-inventory',
      nodeType: 'llm_request',
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
          nodeId: 'state-inventory',
          nodeType: 'llm_request',
          via: 'flow',
          durationMs: 3,
          outputKeys: [],
          outputs: {},
          // Входы упавшего узла (issue #406): в лог теста попадает то, с чем узел
          // исполнялся, — оператор может воспроизвести сбой.
          inputs: { action: 'Осмотреться' },
          schemaSlug: 'action',
          depth: 0,
          failed: true,
        },
      ],
    },
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
      return route.fulfill({ status: 400, json: errorResponse() });
    }
    if (url.pathname === '/api/schemas/action' && request.method() === 'GET') {
      return route.fulfill({ json: record });
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

test('модалка теста экспортирует отчёт об ошибке в Markdown и копирует его (issue #400)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/schemas/action');

  await page.getByRole('button', { name: 'Тест' }).click();
  await page.getByRole('button', { name: 'Запустить' }).click();

  // Ошибка теста и упавший узел показаны, появилась кнопка экспорта.
  await expect(page.getByText("Unexpected identifier 'inventory'")).toBeVisible();
  await expect(page.getByText('state-inventory', { exact: false }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Экспорт MD' }).click();
  await expect(page.getByText('Экспорт результата теста')).toBeVisible();
  await page.locator('.modal').last().screenshot({ path: '../../docs/screenshots/schema-test-error-export-md.png' });

  const textarea = page.getByLabel('Markdown отчёта');
  const markdown = await textarea.inputValue();
  expect(markdown).toContain('# Ошибка теста: action');
  expect(markdown).toContain('- Схема: action');
  expect(markdown).toContain('## Контекст выполнения');
  expect(markdown).toContain('## Начальные параметры запуска теста');
  expect(markdown).toContain('## Ошибка');
  expect(markdown).toContain("Unexpected identifier 'inventory'");
  expect(markdown).toContain('## Узел с ошибкой');
  expect(markdown).toContain('state-inventory');
  expect(markdown).toContain('## Лог узлов (2)');
  expect(markdown).toContain('| 1 | start |');
  expect(markdown).toContain('## Данные по узлам (2)');
  expect(markdown).toContain('### 2. state-inventory');
  // Входы упавшего узла попали в экспорт (issue #406): отдельный раздел с пометкой.
  expect(markdown).toContain('#### Входы (узел упал)');
  expect(markdown).toContain('"action": "Осмотреться"');

  await page.locator('.schema-test-export-actions').getByRole('button', { name: 'Копировать' }).click();
  await expect(page.getByText('Скопировано')).toBeVisible();
  const copied = await page.evaluate(() => (window as Window & { __copiedMarkdown?: string }).__copiedMarkdown);
  expect(copied).toBe(markdown);
});
