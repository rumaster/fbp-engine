// E2E для issue #347: модалка теста схемы показывает «Лог узлов» — отчёт по
// КАЖДОМУ узлу, через который прошёл поток, и по КАЖДОМУ pure-узлу (данные),
// к которому был запрос. Проверяем рендер таблицы по ответу /test с nodeTrace,
// бейдж «данные» у pure-узла, отметку упавшего узла и снимок для PR.
import { expect, test, type Page } from '@playwright/test';

const ISO = '2026-01-01T00:00:00.000Z';

// Минимальная action-схема: start → end (поток), transform — pure-узел (данные).
function actionGraph() {
  return {
    version: 1,
    slug: 'action',
    schemaType: 'action',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      {
        id: 'transform',
        type: 'transform',
        position: { x: 260, y: 120 },
        config: { code: 'return input.value * 2;', output: 'result' },
        label: 'Transform',
      },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start->end', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
      { id: 'val', from: 'start', fromPort: 'value', to: 'transform', toPort: 'value' },
      { id: 'res', from: 'transform', fromPort: 'result', to: 'end', toPort: 'result' },
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

// Детерминированный nodeTrace в ответе /test: start/end прошли по потоку,
// transform подтянут как зависимость данных, последний узел — упал.
function traceResponse() {
  return {
    outputs: { result: 10 },
    llmLog: [],
    durationMs: 7,
    costMillicents: 0,
    nodeTrace: [
      { order: 1, nodeId: 'start', nodeType: 'start', via: 'flow', durationMs: 1, outputKeys: ['value'], outputs: { value: 5 }, inputs: {}, schemaSlug: 'action', depth: 0, failed: false },
      { order: 2, nodeId: 'transform', nodeType: 'transform', via: 'data', durationMs: 2, outputKeys: ['result'], outputs: { result: 10 }, inputs: { value: 5 }, schemaSlug: 'action', depth: 0, failed: false },
      { order: 3, nodeId: 'end', nodeType: 'end', via: 'flow', durationMs: 1, outputKeys: ['result'], outputs: { result: 10 }, inputs: { result: 10 }, schemaSlug: 'action', depth: 0, failed: false },
    ],
  };
}

async function mockApi(page: Page): Promise<void> {
  const record = actionRecord();

  await page.addInitScript(() => {
    window.localStorage.setItem('adminToken', 'test-token');
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
      return route.fulfill({ json: traceResponse() });
    }
    if (url.pathname === '/api/schemas/action' && request.method() === 'GET') {
      return route.fulfill({ json: record });
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

test('модалка теста показывает Лог узлов по потоку и pure-зависимостям (issue #347)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/schemas/action');

  await page.getByRole('button', { name: 'Тест' }).click();
  await expect(page.getByText('Тест схемы action')).toBeVisible();

  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.getByText('Outputs', { exact: true })).toBeVisible();

  // Отчёт по узлам отрисован: заголовок «Лог узлов · 3» и строка на каждый узел.
  const report = page.locator('.schema-test-node-trace');
  await expect(report.locator('.subhead').first()).toContainText('Лог узлов · 3');
  const rows = report.locator('table tbody tr');
  await expect(rows).toHaveCount(3);

  // start/end прошли по потоку, transform — как запрос данных (бейдж «данные»).
  await expect(rows.nth(0)).toContainText('start');
  await expect(rows.nth(0)).toContainText('поток');
  await expect(rows.nth(1)).toContainText('transform');
  await expect(rows.nth(1).locator('.badge-data')).toHaveText('данные');
  await expect(rows.nth(2)).toContainText('end');
  await expect(rows.nth(2)).toContainText('поток');

  // Снимок самого отчёта по узлам для PR (issue #347).
  await report.scrollIntoViewIfNeeded();
  await report.screenshot({ path: '../../docs/screenshots/schema-test-node-trace.png' });
});
