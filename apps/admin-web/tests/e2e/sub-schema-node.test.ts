// E2E для issue #315: выбор суб-схемы в узле sub_schema подтягивает её граничные
// порты, а редактор граничных портов узлов start/end выровнен по стандарту прочих
// узлов (DnD-сортировка, колонки Name/Type/Description). Мок API минимальный —
// только то, что нужно редактору суб-схемы.
import { expect, test, type Locator, type Page } from '@playwright/test';

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
    type: 'start' | 'end' | 'sub_schema';
    position: { x: number; y: number };
    label: string;
    config: Record<string, unknown>;
  }>;
  edges: Array<unknown>;
  variables: Record<string, unknown>;
}

// Библиотечная суб-схема helper (класс common): её граничные порты заданы на узлах
// start (вход суб-схемы) и end (выход). Именно их снимок должен появиться на узле
// sub_schema потребителя при выборе helper.
function helperGraph(): SubSchemaGraph {
  return {
    version: 1,
    slug: 'helper',
    subSchemaClass: 'common',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, label: 'Start', config: { outputs: [boundary('question', 'string', 'Вопрос')] } },
      { id: 'end', type: 'end', position: { x: 400, y: 0 }, label: 'End', config: { inputs: [boundary('answer', 'string', 'Ответ')] } },
    ],
    edges: [],
    variables: {},
  };
}

// Потребитель calc (класс common): узлы start/end с несколькими граничными портами
// (для проверки DnD-редактора) и пустой узел sub_schema без выбранной суб-схемы.
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
        config: { outputs: [boundary('alpha', 'string', 'Первый'), boundary('beta', 'number', 'Второй')] },
      },
      { id: 'sub', type: 'sub_schema', position: { x: 250, y: 0 }, label: 'Под-схема', config: { schemaSlug: '', ports: { inputs: [], outputs: [] } } },
      { id: 'end', type: 'end', position: { x: 500, y: 0 }, label: 'End', config: { inputs: [boundary('result', 'string', 'Итог')] } },
    ],
    edges: [],
    variables: {},
  };
}

function boundary(id: string, type: string, label: string): BoundaryPort {
  return { id, type, label };
}

function record(slug: string, graph: SubSchemaGraph) {
  return { schema_slug: slug, schema_class: 'common', game_id: null, description: '', graph_json: graph, updated_at: ISO };
}

async function mockApi(page: Page): Promise<void> {
  const calc = record('calc', calcGraph());
  const helper = record('helper', helperGraph());

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
      return route.fulfill({ json: { items: [calc, helper] } });
    }
    const draftMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/draft$/);
    if (draftMatch) {
      const slug = draftMatch[1];
      const rec = slug === 'helper' ? helper : calc;
      if (request.method() === 'GET') {
        return route.fulfill({ json: { ...rec, has_draft: false } });
      }
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as { graphJson?: unknown };
        return route.fulfill({ json: { ...rec, graph_json: body.graphJson ?? rec.graph_json, has_draft: true } });
      }
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

function portNameInput(rows: Locator, index: number): Locator {
  return rows.nth(index).locator('.schema-port-name-input');
}

test('выбор суб-схемы в узле sub_schema подтягивает граничные порты (issue #315)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/schemas/calc');

  const subNode = page.locator('.blueprint-node').filter({ hasText: 'Под-схема' });
  await expect(subNode).toBeVisible();
  // До выбора суб-схемы у узла только служебный exec-порт, без data-портов суб-схемы.
  await expect(subNode.locator('.blueprint-ports.input .blueprint-port-label')).toHaveText(['exec']);
  await expect(subNode.locator('.blueprint-ports.output .blueprint-port-label')).toHaveText(['exec']);

  await subNode.click();
  // Выбираем библиотечную суб-схему helper в селекторе.
  await page.getByLabel('Суб-схема').selectOption('helper');

  // Появляется подсказка с граничными портами и сами порты на узле (issue #315).
  await expect(page.getByText('Порты: входы — question; выходы — answer.')).toBeVisible();
  await expect(subNode.locator('.blueprint-ports.input .blueprint-port-label')).toHaveText(['exec', 'Вопрос']);
  await expect(subNode.locator('.blueprint-ports.output .blueprint-port-label')).toHaveText(['exec', 'Ответ']);

  await page.screenshot({ path: '../../docs/screenshots/sub-schema-selector.png', fullPage: false });
});

test('редактор граничных портов: колонки Name/Type/Description и DnD-сортировка (issue #315)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/schemas/calc');

  const startNode = page.locator('.blueprint-node').filter({ hasText: 'Start' });
  await expect(startNode).toBeVisible();
  await startNode.click();

  const table = page.locator('.schema-port-table.inputs');
  await expect(table.locator('thead th')).toHaveText(['', 'Name', 'Type', 'Description', '']);

  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(portNameInput(rows, 0)).toHaveValue('alpha');
  await expect(portNameInput(rows, 1)).toHaveValue('beta');

  await page.screenshot({ path: '../../docs/screenshots/sub-schema-ports-editor.png', fullPage: false });

  // DnD: перетаскиваем первую строку под вторую — порядок меняется.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await rows.nth(0).locator('.schema-port-drag-button').dispatchEvent('dragstart', { dataTransfer });
  await rows.nth(1).dispatchEvent('dragover', { dataTransfer });
  await rows.nth(1).dispatchEvent('drop', { dataTransfer });
  await rows.nth(0).locator('.schema-port-drag-button').dispatchEvent('dragend', { dataTransfer });

  await expect(portNameInput(rows, 0)).toHaveValue('beta');
  await expect(portNameInput(rows, 1)).toHaveValue('alpha');
});
