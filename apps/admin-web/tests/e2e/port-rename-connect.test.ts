import { expect, test, type Page } from '@playwright/test';

// Issue #394: после добавления/переименования порта узла (например, выход `count`
// у variable_read) из этого выхода нельзя начать тянуть ребро, и существующие рёбра
// к нему не отрисовываются. Причина — ReactFlow не перемеряет позиции хэндлов, если
// габариты узла не изменились (переименование порта высоту не меняет). Лечится
// вызовом useUpdateNodeInternals при смене состава портов.

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

// Схема с variable_read (выход `value`:any, который мы переименуем в `count`:number)
// и variable_write (вход `count`:number), куда тянем ребро после переименования.
function actionGraphWithVariables(): MinimalGraph {
  return {
    version: 1,
    slug: 'action',
    schemaType: 'action',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: -360 }, config: {}, label: 'Start' },
      { id: 'end', type: 'end', position: { x: 560, y: -360 }, config: {}, label: 'End' },
      {
        id: 'vr',
        type: 'variable_read',
        position: { x: 0, y: 220 },
        config: { outputs: [{ name: 'value', type: 'any' }] },
        label: 'Variable read',
      },
      {
        id: 'vw',
        type: 'variable_write',
        position: { x: 560, y: 220 },
        config: { inputs: [{ name: 'count', type: 'number' }] },
        label: 'Variable write',
      },
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

test('issue #394: после переименования выхода из него можно тянуть ребро', async ({ page }) => {
  await mockApi(page, actionGraphWithVariables());

  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();
  // Ждём, пока стартовый fitView впишет все узлы, и выделяем variable_read кликом —
  // в панели свойств откроется редактор его выходов.
  const vrNode = page.locator('.react-flow__node[data-id="vr"]');
  await expect(vrNode).toBeVisible();
  await page.waitForTimeout(300);
  await vrNode.click();

  const nameInput = page.locator('.schema-port-name-input').first();
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveValue('value');

  // Переименовываем выход value → count (высота узла не меняется — именно этот случай
  // ломал перетаскивание ребра до фикса) и переключаем тип на number.
  await nameInput.fill('count');
  await nameInput.blur();
  const typeSelect = page.locator('.schema-port-table.outputs select').first();
  await typeSelect.selectOption('number');
  await page.waitForTimeout(200);

  // Узлы крупные — после измерения вписываем граф кнопкой fit-view, чтобы оба
  // хэндла попали в видимую область канваса.
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(300);

  // Изначально ребро-данных между vr и vw отсутствует.
  const dataEdges = page.locator('.react-flow__edge.schema-edge-data');
  await expect(dataEdges).toHaveCount(0);

  // Тянем ребро из выхода count узла vr во вход count узла vw.
  const sourceHandle = page.locator('.react-flow__node[data-id="vr"] .react-flow__handle.source[data-handleid="count"]');
  const targetHandle = page.locator('.react-flow__node[data-id="vw"] .react-flow__handle.target[data-handleid="count"]');
  await expect(sourceHandle).toBeVisible();
  await expect(targetHandle).toBeVisible();

  await page.screenshot({ path: 'test-results/port-rename-before-drag.png', fullPage: true });
  const from = await sourceHandle.boundingBox();
  const to = await targetHandle.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  if (!from || !to) return;

  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = to.y + to.height / 2;

  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / 10, fromY + ((toY - fromY) * i) / 10, { steps: 2 });
  }
  await page.mouse.move(toX, toY, { steps: 3 });
  await page.mouse.up();

  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/port-rename-after-drag.png', fullPage: true });

  // Ребро создано и отрисовано — без фикса хэндл count не зарегистрирован и
  // соединение не образуется.
  await expect(dataEdges).toHaveCount(1);
});
