import { expect, test, type Page } from '@playwright/test';

// Issue #395: двойной клик по узлу с внутренней схемой (loop, graph_rag) открывает
// этот узел на канвасе так же, как кнопка «Открыть» в панели узла. Сценарий:
// открываем схему с loop-узлом, дважды кликаем по нему → показывается тело цикла и
// путь с кнопкой «Назад».

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

test('двойной клик по loop-узлу открывает его тело на канвасе', async ({ page }) => {
  await mockApi(page, actionGraphWithLoop());

  await page.goto('/#/schemas/action?nodeId=loop-1');

  // Канвас отрисован, loop-узел виден.
  await expect(page.locator('.react-flow')).toBeVisible();
  const loopNode = page.locator('.blueprint-node').filter({ hasText: 'Цикл' });
  await expect(loopNode).toBeVisible();

  // Двойной клик по узлу — на канвасе появляется тело цикла (узел «Тело цикла»).
  await loopNode.dblclick();
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Тело цикла' })).toBeVisible();

  // Над канвасом — путь из id открытых циклов и кнопка «Назад».
  const path = page.locator('.schema-loop-path');
  await expect(path).toBeVisible();
  await expect(path.locator('.schema-loop-path-label')).toContainText('loop-1');
  const backButton = path.locator('button', { hasText: 'Назад' });
  await expect(backButton).toBeVisible();

  await page.screenshot({ path: '../../docs/screenshots/node-doubleclick-open.png', fullPage: false });

  // «Назад» возвращает в корневой граф: путь исчезает, снова виден узел «Цикл».
  await backButton.click();
  await expect(page.locator('.schema-loop-path')).toHaveCount(0);
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Цикл' })).toBeVisible();
});
