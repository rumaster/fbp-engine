// E2E для issue #355: при запуске теста суб-схемы черновика по факту выполнялся
// тест для рабочей версии. Причина — кнопка «Тест» открывала модалку, не зафиксировав
// несохранённые правки редактора как черновик, а сервер прогоняет тест по черновику
// из БД (row.draft_graph_json ?? row.graph_json). Из-за этого удалённый в редакторе
// узел (например, constant-1) всё ещё присутствовал в исполняемой версии.
//
// Проверяем на уровне фронтенда: после удаления узла и нажатия «Тест» сначала уходит
// PATCH /draft с уже отредактированным графом (без удалённого узла), и только потом —
// POST /test.
import { expect, test, type Page, type Route } from '@playwright/test';

const ISO = '2026-01-01T00:00:00.000Z';

interface SubSchemaGraph {
  version: 1;
  slug: string;
  subSchemaClass: 'common';
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    label: string;
    config: Record<string, unknown>;
  }>;
  edges: Array<unknown>;
  variables: Record<string, unknown>;
}

// Рабочая версия суб-схемы narrator: содержит узел constant-1, подающий ключи на
// knowledge_query — ровно как в примере из issue #355.
function workingGraph(): SubSchemaGraph {
  return {
    version: 1,
    slug: 'narrator',
    subSchemaClass: 'common',
    nodes: [
      {
        id: 'start',
        type: 'start',
        position: { x: 0, y: 60 },
        label: 'Start',
        config: { outputs: [{ id: 'action', type: 'string', label: 'action' }] },
      },
      { id: 'end', type: 'end', position: { x: 520, y: 60 }, label: 'End', config: { inputs: [] } },
      { id: 'knowledge-query-1', type: 'knowledge_query', position: { x: 240, y: 60 }, label: 'Knowledge query', config: {} },
      {
        id: 'constant-1',
        type: 'constant',
        position: { x: 120, y: 320 },
        label: 'Constant',
        config: { outputs: [{ name: 'value', type: 'string_array', value: '["Клиент хочет купить Луну"]' }] },
      },
    ],
    edges: [
      { id: 'start:exec->knowledge-query-1:exec', from: 'start', fromPort: 'exec', to: 'knowledge-query-1', toPort: 'exec' },
      { id: 'constant-1:value->knowledge-query-1:keys', from: 'constant-1', fromPort: 'value', to: 'knowledge-query-1', toPort: 'keys' },
      { id: 'knowledge-query-1:exec->end:exec', from: 'knowledge-query-1', fromPort: 'exec', to: 'end', toPort: 'exec' },
    ],
    variables: {},
  };
}

function record(graph: SubSchemaGraph) {
  return { schema_slug: 'narrator', schema_class: 'common', game_id: null, description: '', graph_json: graph, updated_at: ISO };
}

interface Captured {
  order: string[];
  draftGraph?: SubSchemaGraph;
}

async function mockApi(page: Page, captured: Captured): Promise<void> {
  const working = record(workingGraph());

  await page.addInitScript(() => {
    window.localStorage.setItem('adminToken', 'test-token');
  });

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/auth/me') {
      return route.fulfill({ json: { userId: 'admin', telegramId: '42', username: 'tester', expiresAt: 9_999_999_999_999 } });
    }
    if (url.pathname === '/api/games' && request.method() === 'GET') {
      return route.fulfill({ json: { total: 0, items: [] } });
    }
    if (url.pathname === '/api/schemas' && request.method() === 'GET') {
      return route.fulfill({ json: { items: [working] } });
    }
    const draftMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/draft$/);
    if (draftMatch) {
      if (request.method() === 'GET') {
        // Черновика ещё нет — отдаём рабочую версию (с constant-1).
        return route.fulfill({ json: { ...working, has_draft: false } });
      }
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as { graphJson?: SubSchemaGraph };
        captured.order.push('PATCH /draft');
        captured.draftGraph = body.graphJson;
        return route.fulfill({ json: { ...working, graph_json: body.graphJson ?? working.graph_json, has_draft: true } });
      }
    }
    if (url.pathname === '/api/schemas/narrator/test' && request.method() === 'POST') {
      captured.order.push('POST /test');
      return route.fulfill({ json: { outputs: { result: 'ok' }, durationMs: 5, costMillicents: 0, llmLog: [] } });
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

test('тест суб-схемы фиксирует черновик с правками до запуска (issue #355)', async ({ page }) => {
  const captured: Captured = { order: [] };
  await mockApi(page, captured);
  await page.goto('/#/schemas/narrator');
  await expect(page.locator('.react-flow')).toBeVisible();

  // В редактор загрузилась рабочая версия с четырьмя узлами, включая constant-1.
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(4);

  // Удаляем constant-1 — повторяем сценарий из issue: оператор правит черновик.
  await nodes.filter({ hasText: 'Constant' }).click();
  const remove = page.getByRole('button', { name: 'Удалить' }).first();
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(nodes).toHaveCount(3);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Constant' })).toHaveCount(0);

  // Запускаем тест.
  await page.getByRole('button', { name: 'Тест' }).click();
  await expect(page.getByText('Тест схемы narrator')).toBeVisible();
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.getByText('Outputs')).toBeVisible();

  // Черновик зафиксирован ДО запуска теста (PATCH /draft предшествует POST /test).
  expect(captured.order).toEqual(['PATCH /draft', 'POST /test']);
  // И в зафиксированном черновике уже нет удалённого constant-1 — значит сервер
  // прогонит тест по актуальному графу редактора, а не по рабочей версии.
  const draftNodeIds = (captured.draftGraph?.nodes ?? []).map((node) => node.id);
  expect(draftNodeIds).not.toContain('constant-1');
  expect(draftNodeIds).toContain('knowledge-query-1');
});
