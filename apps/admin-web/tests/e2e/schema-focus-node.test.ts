import { expect, test, type Page } from '@playwright/test';

// Репродукция issue #303: при переходе из журнала схем по ссылке «узел» редактор
// падал с React error #185 (Maximum update depth exceeded) в setNodes ReactFlow.
// Сценарий: открытие #/schemas/action?nodeId=transform-4 — фокус на узле графа.

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

function actionGraphWithTransform(): MinimalGraph {
  return {
    version: 1,
    slug: 'action',
    schemaType: 'action',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
      { id: 'transform-4', type: 'transform', position: { x: 260, y: 320 }, config: {}, label: 'Transform' },
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
    // Черновик схемы: возвращаем граф с узлом transform-4.
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

test('переход из журнала с nodeId не вызывает React error #185', async ({ page }) => {
  const reactErrors: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' && /Minified React error #185|Maximum update depth/.test(t)) {
      reactErrors.push(t);
    }
  });
  page.on('pageerror', (err) => {
    if (/Minified React error #185|Maximum update depth/.test(err.message)) {
      reactErrors.push(err.message);
    }
  });

  await mockApi(page, actionGraphWithTransform());

  await page.goto('/#/schemas/action?nodeId=transform-4');

  // Узел и редактор должны отрисоваться без падения.
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.locator('.blueprint-node').filter({ hasText: 'Transform' })).toBeVisible();

  // Даём времени отработать эффектам фокуса/таймауту FlowFocusController.
  await page.waitForTimeout(1500);

  // Редактор не должен показывать экран ErrorBoundary.
  await expect(page.locator('.react-flow')).toBeVisible();
  expect(reactErrors, `React #185 errors: ${reactErrors.join('\n')}`).toHaveLength(0);

  // Сфокусированный узел должен оказаться выделенным (issue #288): FlowFocusController
  // выделяет его после fitView, поэтому панель свойств показывает transform-4.
  await expect(
    page.locator('.blueprint-node').filter({ hasText: 'Transform' }),
  ).toHaveClass(/selected/);
});
