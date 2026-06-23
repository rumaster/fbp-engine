import { expect, test, type Page, type Route } from '@playwright/test';

type SchemaType = 'action' | 'hint' | 'illustration' | 'support';
const SCHEMA_TYPES: SchemaType[] = ['action', 'hint', 'illustration', 'support'];

// Проверка механики выделения и массовых операций (issue #230):
// копирование/вставка/дублирование/удаление узлов через тулбар «Выбор».
test('дублирование выбранного узла добавляет копию на полотно', async ({ page }) => {
  await mockAdminApi(page);
  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3); // start, llm, end

  const llmNode = nodes.filter({ hasText: 'LLM' });
  await expect(llmNode).toBeVisible();
  await llmNode.click();

  // Кнопка дублирования становится активной для копируемого узла.
  const duplicate = page.getByRole('button', { name: 'Дублировать' }).first();
  await expect(duplicate).toBeEnabled();
  await duplicate.click();

  // Появился новый узел — всего четыре.
  await expect(nodes).toHaveCount(4);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'LLM' })).toHaveCount(2);
});

test('копирование и вставка узла через тулбар', async ({ page }) => {
  await mockAdminApi(page);
  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3);

  await nodes.filter({ hasText: 'LLM' }).click();

  const copy = page.getByRole('button', { name: 'Копировать' }).first();
  await expect(copy).toBeEnabled();
  await copy.click();

  const paste = page.getByRole('button', { name: 'Вставить' }).first();
  await expect(paste).toBeEnabled();
  await paste.click();

  await expect(nodes).toHaveCount(4);
});

test('Shift+клик выделяет несколько узлов и групповая панель отражает их число', async ({ page }) => {
  await mockAdminApi(page);
  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3);

  await nodes.filter({ hasText: 'Start' }).click();
  await nodes.filter({ hasText: 'LLM' }).click({ modifiers: ['Shift'] });

  // Подсказка тулбара показывает, что выделено два узла.
  await expect(page.getByText(/выбрано: 2 узл/)).toBeVisible();
  // Групповая панель свойств появляется при выделении нескольких узлов.
  await expect(page.getByText('Выбрано узлов')).toBeVisible();
});

test('удаление выбранного узла через тулбар убирает его с полотна', async ({ page }) => {
  await mockAdminApi(page);
  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3);

  await nodes.filter({ hasText: 'LLM' }).click();

  const remove = page.getByRole('button', { name: 'Удалить' }).first();
  await expect(remove).toBeEnabled();
  await remove.click();

  await expect(nodes).toHaveCount(2);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'LLM' })).toHaveCount(0);
});

interface SchemaRecord {
  schema_slug: SchemaType;
  schema_type: SchemaType;
  schema_class: null;
  game_id: null;
  is_active: boolean;
  description: string;
  graph_json: unknown;
  has_draft?: boolean;
  updated_at: string;
}

async function mockAdminApi(page: Page): Promise<void> {
  const records = new Map<SchemaType, SchemaRecord>(
    SCHEMA_TYPES.map((schemaType) => [schemaType, schemaRecord(schemaType)]),
  );
  const drafts = new Map<SchemaType, unknown>();
  await page.addInitScript(() => {
    window.localStorage.setItem('adminToken', 'test-token');
  });
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/me') {
      return route.fulfill({
        json: { userId: 'admin', telegramId: '42', username: 'tester', expiresAt: Date.now() + 600_000 },
      });
    }
    if (url.pathname === '/api/schemas' && request.method() === 'GET') {
      return route.fulfill({ json: { items: [...records.values()] } });
    }
    const draftMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)\/draft$/);
    if (draftMatch) {
      const slug = draftMatch[1] as SchemaType;
      if (!SCHEMA_TYPES.includes(slug)) {
        return route.fulfill({ status: 404, json: { message: 'schema not found' } });
      }
      const record = records.get(slug)!;
      if (request.method() === 'GET') {
        const draft = drafts.get(slug);
        return route.fulfill({
          json: { ...record, graph_json: draft ?? record.graph_json, has_draft: draft != null },
        });
      }
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as { graphJson?: unknown };
        const draft = body.graphJson ?? record.graph_json;
        drafts.set(slug, draft);
        return route.fulfill({ json: { ...record, graph_json: draft, has_draft: true } });
      }
      if (request.method() === 'DELETE') {
        drafts.delete(slug);
        return route.fulfill({ json: { ...record, graph_json: record.graph_json, has_draft: false } });
      }
    }
    const schemaMatch = url.pathname.match(/^\/api\/schemas\/([^/]+)$/);
    if (schemaMatch) {
      const slug = schemaMatch[1] as SchemaType;
      if (!SCHEMA_TYPES.includes(slug)) {
        return route.fulfill({ status: 404, json: { message: 'schema not found' } });
      }
      if (request.method() === 'GET') {
        return route.fulfill({ json: records.get(slug) });
      }
    }
    return route.fulfill({ status: 404, json: { message: `unmocked ${request.method()} ${url.pathname}` } });
  });
}

function schemaRecord(schemaType: SchemaType): SchemaRecord {
  return {
    schema_slug: schemaType,
    schema_type: schemaType,
    schema_class: null,
    game_id: null,
    is_active: true,
    description: `${schemaType} schema`,
    graph_json: {
      version: 1,
      slug: schemaType,
      schemaType,
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 120 }, config: {}, label: 'Start' },
        { id: 'llm-1', type: 'llm_request', position: { x: 240, y: 60 }, config: {}, label: 'LLM' },
        { id: 'end', type: 'end', position: { x: 520, y: 120 }, config: {}, label: 'End' },
      ],
      edges: [
        { id: 'start:exec->llm-1:exec', from: 'start', fromPort: 'exec', to: 'llm-1', toPort: 'exec' },
        { id: 'llm-1:exec->end:exec', from: 'llm-1', fromPort: 'exec', to: 'end', toPort: 'exec' },
      ],
      variables: {},
    },
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}
