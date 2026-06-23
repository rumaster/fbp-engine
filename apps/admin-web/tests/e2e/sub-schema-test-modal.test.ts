// E2E для issue #343: при тестировании суб-схемы модалка теста генерирует поля
// ввода по составу start-узла (граничным входам суб-схемы) вместо «голого» JSON,
// а отправляемые на /test значения собираются из этих полей с учётом типов портов.
// Дополнительно проверяем, что тест прогоняет именно черновик суб-схемы (на
// уровне фронтенда — запрос на /test с собранными inputs).
import { expect, test, type Page } from '@playwright/test';

const ISO = '2026-01-01T00:00:00.000Z';

interface BoundaryPort {
  id: string;
  type: string;
  label: string;
}

interface SubSchemaGraph {
  version: 1;
  slug: string;
  subSchemaClass: 'common';
  nodes: Array<{
    id: string;
    type: 'start' | 'end';
    position: { x: number; y: number };
    label: string;
    config: Record<string, unknown>;
  }>;
  edges: Array<unknown>;
  variables: Record<string, unknown>;
}

function boundary(id: string, type: string, label: string): BoundaryPort {
  return { id, type, label };
}

// Суб-схема calc (класс common): на start-узле заданы граничные входы разных
// типов — именно по ним модалка теста должна построить поля ввода.
function calcGraph(): SubSchemaGraph {
  return {
    version: 1,
    slug: 'calc',
    subSchemaClass: 'common',
    nodes: [
      {
        id: 'start',
        type: 'start',
        position: { x: 0, y: 0 },
        label: 'Start',
        config: {
          outputs: [
            boundary('alpha', 'string', 'Первый'),
            boundary('beta', 'number', 'Второй'),
            boundary('flag', 'boolean', 'Флаг'),
          ],
        },
      },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, label: 'End', config: { inputs: [boundary('result', 'string', 'Итог')] } },
    ],
    edges: [],
    variables: {},
  };
}

function record(slug: string, graph: SubSchemaGraph) {
  return { schema_slug: slug, schema_class: 'common', game_id: null, description: '', graph_json: graph, updated_at: ISO };
}

// Перехватываем POST /test, чтобы зафиксировать отправленные inputs и отдать
// детерминированный ответ.
async function mockApi(page: Page, captured: { inputs?: Record<string, unknown> }): Promise<void> {
  const calc = record('calc', calcGraph());

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
      return route.fulfill({ json: { items: [calc] } });
    }
    const draftMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/draft$/);
    if (draftMatch) {
      if (request.method() === 'GET') {
        return route.fulfill({ json: { ...calc, has_draft: false } });
      }
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as { graphJson?: unknown };
        return route.fulfill({ json: { ...calc, graph_json: body.graphJson ?? calc.graph_json, has_draft: true } });
      }
    }
    if (url.pathname === '/api/schemas/calc/test' && request.method() === 'POST') {
      const body = request.postDataJSON() as { inputs?: Record<string, unknown> };
      captured.inputs = body.inputs;
      return route.fulfill({
        json: { outputs: { result: 'ok' }, durationMs: 5, costMillicents: 0, llmLog: [] },
      });
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

test('модалка теста суб-схемы строит поля по start-узлу и шлёт типизированные inputs (issue #343)', async ({ page }) => {
  const captured: { inputs?: Record<string, unknown> } = {};
  await mockApi(page, captured);
  await page.goto('/#/schemas/calc');

  // Открываем модалку теста.
  await page.getByRole('button', { name: 'Тест' }).click();
  await expect(page.getByText('Тест схемы calc')).toBeVisible();

  // Поля сгенерированы по граничным входам start-узла суб-схемы, а не «голый» JSON.
  const form = page.locator('.schema-test-form');
  await expect(form.getByText('Первый · string')).toBeVisible();
  await expect(form.getByText('Второй · number')).toBeVisible();
  await expect(form.getByText('Флаг · boolean')).toBeVisible();
  // Расширенный режим выключен: textarea с Inputs JSON не отрисована.
  await expect(form.locator('textarea')).toHaveCount(0);

  await page.screenshot({ path: '../../docs/screenshots/sub-schema-test-modal.png', fullPage: false });

  // Заполняем поля и запускаем тест.
  await form.locator('input').nth(0).fill('hello');
  await form.locator('input').nth(1).fill('42');
  await form.locator('input').nth(2).fill('да');
  await page.getByRole('button', { name: 'Запустить' }).click();

  // Результат отрисован, а отправленные inputs приведены к типам портов.
  await expect(page.getByText('Outputs')).toBeVisible();
  expect(captured.inputs).toEqual({ alpha: 'hello', beta: 42, flag: true });
});
