import { expect, test, type Page, type Route } from '@playwright/test';

type SchemaType = 'action' | 'hint' | 'illustration' | 'support';
const SCHEMA_TYPES: SchemaType[] = ['action', 'hint', 'illustration', 'support'];

// Воспроизведение падения интерфейса (React error #185) при рамочном выделении,
// когда выделение «доходит до второго узла» (issue #230).
test('рамочное выделение Shift+drag по нескольким узлам не роняет интерфейс', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  await mockAdminApi(page);
  await page.goto('/#/schemas/action');
  await expect(page.locator('.react-flow')).toBeVisible();
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3);

  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');

  // Рамочное выделение по Shift+drag через всё полотно, чтобы захватить все узлы.
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  // Несколько промежуточных шагов — рамка постепенно «дотягивается» до второго узла.
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + (box.width - 16) * (i / 10), box.y + (box.height - 16) * (i / 10));
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');

  await page.waitForTimeout(400);

  // Не должно появиться рамки ошибки интерфейса.
  await expect(page.getByText('Ошибка интерфейса')).toHaveCount(0);
  const maxDepth = errors.filter((e) => /Maximum update depth|Minified React error #185|error #185/i.test(e));
  expect(maxDepth, `Ошибки React #185:\n${maxDepth.join('\n')}`).toHaveLength(0);
  // Выделилось несколько узлов.
  await expect(page.getByText(/выбрано: [2-3] узл/)).toBeVisible();
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
