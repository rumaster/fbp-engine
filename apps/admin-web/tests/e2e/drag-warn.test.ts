import { expect, test, type Page, type Route } from '@playwright/test';

type SchemaType = 'action' | 'hint' | 'illustration' | 'support';
const SCHEMA_TYPES: SchemaType[] = ['action', 'hint', 'illustration', 'support'];

// Воспроизведение issue #215: при перетаскивании блока ReactFlow ругается, что узел
// «не инициализирован» (reactflow.dev/error#015), и зацикливает измерения, что в
// production-сборке всплывает как «Minified React error #185» (Maximum update depth).
test('перетаскивание узла не вызывает предупреждений ReactFlow и React-ошибок', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || msg.type() === 'warning') {
      if (
        text.includes('error#015') ||
        text.includes('not initialized') ||
        text.includes('React error #185') ||
        text.includes('Maximum update depth')
      ) {
        problems.push(`${msg.type()}: ${text}`);
      }
    }
  });

  await mockAdminApi(page);
  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();

  const node = page.locator('.react-flow__node').filter({ hasText: 'Start' });
  await expect(node).toBeVisible();
  await node.click();

  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(box.x + 20 + i * 12, box.y + 12 + i * 7, { steps: 3 });
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  console.log('Problems:', JSON.stringify(problems, null, 2));
  expect(problems, problems.join('\n')).toEqual([]);
});

interface SchemaRecord {
  schema_slug: SchemaType;
  schema_type: SchemaType;
  description: string;
  graph_json: unknown;
  updated_at: string;
}

async function mockAdminApi(page: Page): Promise<void> {
  const records = new Map<SchemaType, SchemaRecord>(
    SCHEMA_TYPES.map((schemaType) => [schemaType, schemaRecord(schemaType)]),
  );
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
      edges: [{ id: 'start:exec->end:exec', from: 'start', fromPort: 'exec', to: 'end', toPort: 'exec' }],
      variables: {},
    },
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}
