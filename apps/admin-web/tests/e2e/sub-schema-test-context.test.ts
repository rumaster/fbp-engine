// E2E для issue #351: в окне теста суб-схемы можно задать контекст выполнения.
// Для общей (common) суб-схемы выбирается класс «Поддержка» или «Игра», а при
// контексте «Игра» — конкретная игра. Выбранный контекст уходит на /test как поля
// `context` и (для игры) `gameId`.
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

// Общая (common) суб-схема calc с одним строковым входом — детали полей ввода тут
// не важны, проверяем именно блок контекста выполнения.
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
        config: { outputs: [boundary('alpha', 'string', 'Первый')] },
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

async function mockApi(page: Page, captured: { body?: Record<string, unknown> }): Promise<void> {
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
      return route.fulfill({ json: { total: 1, items: [{ game_id: 'game-1', name: 'Игра один' }] } });
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
      captured.body = request.postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        json: { outputs: { result: 'ok' }, durationMs: 5, costMillicents: 0, llmLog: [] },
      });
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

test('контекст «игра» суб-схемы отправляет context и gameId на /test (issue #351)', async ({ page }) => {
  const captured: { body?: Record<string, unknown> } = {};
  await mockApi(page, captured);
  await page.goto('/#/schemas/calc');

  await page.getByRole('button', { name: 'Тест' }).click();
  await expect(page.getByText('Тест схемы calc')).toBeVisible();

  // Блок контекста выполнения присутствует с выбором класса для common-суб-схемы.
  const form = page.locator('.schema-test-form');
  const contextSelect = form.locator('.schema-test-context select').first();
  await expect(contextSelect).toBeVisible();

  // По умолчанию контекст «Поддержка» — селектора игры нет.
  await expect(form.locator('.schema-test-context select')).toHaveCount(1);

  // Переключаем на «Игра»: появляется выбор игры.
  await contextSelect.selectOption('game');
  const gameSelect = form.locator('.schema-test-context select').nth(1);
  await expect(gameSelect).toBeVisible();
  await gameSelect.selectOption('game-1');

  await page.screenshot({ path: '../../docs/screenshots/sub-schema-test-context.png', fullPage: false });

  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.getByText('Outputs')).toBeVisible();

  expect(captured.body?.context).toBe('game');
  expect(captured.body?.gameId).toBe('game-1');
});

test('контекст «поддержка» суб-схемы отправляет context без gameId (issue #351)', async ({ page }) => {
  const captured: { body?: Record<string, unknown> } = {};
  await mockApi(page, captured);
  await page.goto('/#/schemas/calc');

  await page.getByRole('button', { name: 'Тест' }).click();
  await expect(page.getByText('Тест схемы calc')).toBeVisible();

  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.getByText('Outputs')).toBeVisible();

  expect(captured.body?.context).toBe('support');
  expect(captured.body?.gameId).toBeUndefined();
});
