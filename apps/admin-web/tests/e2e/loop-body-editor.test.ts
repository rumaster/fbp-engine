import { expect, test, type Page } from '@playwright/test';

// Issue #337: визуальный редактор тела loop-узла. Сценарий: открываем схему с
// loop-узлом, в панели узла жмём «Открыть» → на канвасе показывается тело цикла,
// над канвасом — путь из id циклов и кнопка «Назад». «Назад» возвращает в корень.

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

// Корневой граф с одним loop-узлом, в теле которого лежит узел transform «Тело».
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

    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

test('loop-узел: «Открыть» показывает тело на канвасе, «Назад» возвращает в корень', async ({ page }) => {
  await mockApi(page, actionGraphWithLoop());

  await page.goto('/#/schemas/action?nodeId=loop-1');

  // Канвас отрисован, loop-узел выделен по nodeId.
  await expect(page.locator('.react-flow')).toBeVisible();
  const loopNode = page.locator('.blueprint-node').filter({ hasText: 'Цикл' });
  await expect(loopNode).toBeVisible();

  // В панели свойств узла есть кнопка «Открыть», а секции «Body graph» больше нет.
  const openButton = page.locator('button.node-loop-open', { hasText: 'Открыть' });
  await expect(openButton).toBeVisible();
  await expect(page.getByText('Body graph')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/loop-panel-open-button.png', fullPage: true });

  // Клик «Открыть» — на канвасе появляется тело цикла (узел «Тело цикла»).
  await openButton.click();
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Тело цикла' })).toBeVisible();

  // Над канвасом — путь из id открытых циклов и кнопка «Назад».
  const path = page.locator('.schema-loop-path');
  await expect(path).toBeVisible();
  await expect(path.locator('.schema-loop-path-label')).toContainText('loop-1');
  const backButton = path.locator('button', { hasText: 'Назад' });
  await expect(backButton).toBeVisible();

  await page.screenshot({ path: 'test-results/loop-body-open.png', fullPage: true });

  // «Назад» возвращает в корневой граф: путь исчезает, снова виден узел «Цикл».
  await backButton.click();
  await expect(page.locator('.schema-loop-path')).toHaveCount(0);
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Цикл' })).toBeVisible();
});
