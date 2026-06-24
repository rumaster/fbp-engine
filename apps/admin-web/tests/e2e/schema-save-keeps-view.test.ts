import { expect, test, type Page } from '@playwright/test';

// Issue #393: после сохранения схемы позиция камеры на канвасе и открытая схема узла
// (тело loop-узла) должны сохраняться. Раньше сохранение запускало полную
// перезагрузку редактора, из-за чего камера сбрасывалась (авто-fitView), а открытое
// тело узла закрывалось до корневого графа.

interface MinimalNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  label?: string;
}

interface MinimalGraph {
  version: 1;
  slug: string;
  schemaType: string;
  nodes: MinimalNode[];
  edges: Array<{ id: string; from: string; fromPort: string; to: string; toPort: string }>;
  variables: Record<string, unknown>;
}

// Корневой граф с одним loop-узлом, в теле которого лежит узел transform «Тело цикла».
function actionGraphWithLoop(): MinimalGraph {
  const body: MinimalGraph = {
    version: 1,
    slug: 'action::loop:loop-1',
    schemaType: 'action',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      { id: 'body-step', type: 'transform', position: { x: 260, y: 120 }, config: {}, label: 'Тело цикла' },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start:exec->end:exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
    ],
    variables: {},
  };
  return {
    version: 1,
    slug: 'action',
    schemaType: 'action',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      {
        id: 'loop-1',
        type: 'loop',
        position: { x: 260, y: 120 },
        config: { mode: 'count', maxIterations: 3, bodyGraph: body },
        label: 'Цикл',
      },
      { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: 'start:exec->end:exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' },
    ],
    variables: {},
  };
}

async function mockApi(page: Page, graph: MinimalGraph): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('adminToken', 'test-token');
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/auth/me') {
      return route.fulfill({
        json: { userId: 'admin', telegramId: '42', username: 'tester', expiresAt: Date.now() + 600_000 },
      });
    }
    if (url.pathname === '/api/games' && request.method() === 'GET') {
      return route.fulfill({ json: { total: 0, items: [] } });
    }
    if (url.pathname === '/api/schemas' && request.method() === 'GET') {
      return route.fulfill({
        json: {
          items: [
            {
              schema_slug: 'action',
              schema_type: 'action',
              game_id: null,
              description: 'action schema',
              graph_json: graph,
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      });
    }
    if (/^\/api\/schemas\/[^/]+\/draft$/.test(url.pathname) && request.method() === 'GET') {
      return route.fulfill({
        json: {
          schema_slug: 'action',
          schema_type: 'action',
          game_id: null,
          description: 'action schema',
          graph_json: graph,
          has_draft: false,
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      });
    }
    // Сохранение черновика: принимаем и подтверждаем.
    if (/^\/api\/schemas\/[^/]+\/draft$/.test(url.pathname) && request.method() === 'PATCH') {
      return route.fulfill({
        json: {
          schema_slug: 'action',
          schema_type: 'action',
          game_id: null,
          description: 'action schema',
          graph_json: graph,
          has_draft: true,
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      });
    }
    // Промоут черновика в рабочую версию: возвращаем тот же целый граф.
    if (/^\/api\/schemas\/[^/]+\/promote$/.test(url.pathname) && request.method() === 'POST') {
      return route.fulfill({
        json: {
          schema_slug: 'action',
          schema_type: 'action',
          game_id: null,
          description: 'action schema',
          graph_json: graph,
          has_draft: false,
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      });
    }

    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

function viewportTransform(page: Page): Promise<string> {
  return page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform);
}

test('сохранение схемы сохраняет позицию камеры и открытую схему узла (issue #393)', async ({ page }) => {
  await mockApi(page, actionGraphWithLoop());

  await page.goto('/#/schemas/action?nodeId=loop-1');

  await expect(page.locator('.react-flow')).toBeVisible();
  const openButton = page.locator('button.node-loop-open', { hasText: 'Открыть' });
  await expect(openButton).toBeVisible();

  // Входим в тело цикла.
  await openButton.click();
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Тело цикла' })).toBeVisible();
  await expect(page.locator('.schema-loop-path')).toBeVisible();

  // Панорамируем камеру перетаскиванием по пустому полотну, фиксируем трансформ.
  const canvas = page.locator('.react-flow__pane');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 8 });
  await page.mouse.up();

  const before = await viewportTransform(page);

  // Сохраняем схему (кнопка-пиктограмма с aria-label «Сохранить»).
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Схема сохранена.')).toBeVisible();

  // Камера осталась на месте: трансформ viewport не изменился.
  const after = await viewportTransform(page);
  expect(after).toBe(before);

  // Открытая схема узла сохранилась: путь и узел тела по-прежнему видны.
  await expect(page.locator('.schema-loop-path')).toBeVisible();
  await expect(page.locator('.schema-loop-path-label')).toContainText('loop-1');
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Тело цикла' })).toBeVisible();
});
