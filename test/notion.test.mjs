import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { NotionStore } from '../dist/notion.js';

const token = 'ntn_mock_only';
const database = '10000000-0000-4000-8000-000000000001';
const source = '10000000-0000-4000-8000-000000000002';
const column = 'Portable Context v1';
const env = {
  PORTABLE_CONTEXT_NOTION_TOKEN: token,
  PORTABLE_CONTEXT_NOTION_DATABASE_ID: database.replaceAll('-', ''),
};
const tea = { subject: 'Alex Chen', content: 'Green tea', scope: 'Drinks', source: 'Fictional tasting', time: '2026-01-15' };
const correction = { content: 'Oolong tea', source: 'Fictional second tasting', time: '2026-01-16' };

function mockNotion({ beforeCreate, afterCreate, requestStatus } = {}) {
  const pages = [];
  const cursors = [];
  const fetchMock = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    assert.equal(init.headers['Notion-Version'], '2025-09-03');
    assert.equal(init.redirect, 'error');
    const path = url.replace('https://api.notion.com/v1/', '');
    if (path === 'databases/' + database) {
      assert.equal(init.method, 'GET');
      return Response.json({ object: 'database', data_sources: [{ id: source }] });
    }
    if (path === 'data_sources/' + source) {
      assert.equal(init.method, 'GET');
      return Response.json({
        object: 'data_source',
        properties: { Name: { type: 'title' }, [column]: { type: 'rich_text' } },
      });
    }
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    if (path === 'pages') {
      assert.deepEqual(body.parent, { type: 'data_source_id', data_source_id: source });
      const items = value => value.map(item => {
        assert.equal(item.type, 'text');
        assert.ok(item.text.content.length <= 2000);
        return { ...item, plain_text: item.text.content };
      });
      const page = {
        object: 'page', id: randomUUID(),
        properties: {
          Name: { type: 'title', title: items(body.properties.Name.title) },
          [column]: { type: 'rich_text', rich_text: items(body.properties[column].rich_text) },
        },
      };
      await beforeCreate?.();
      pages.push(page);
      await afterCreate?.();
      return Response.json(page);
    }
    assert.equal(path, 'data_sources/' + source + '/query');
    assert.equal(body.page_size, 100);
    cursors.push(body.start_cursor);
    const index = Number(body.start_cursor ?? 0);
    const hasMore = index + 1 < pages.length;
    return Response.json({
      object: 'list', results: pages.slice(index, index + 1),
      has_more: hasMore, next_cursor: hasMore ? String(index + 1) : null,
      request_status: requestStatus,
    });
  };
  return { store: () => new NotionStore(env, fetchMock), pages, cursors };
}

test('Notion mock: missing credentials and invalid IDs are rejected without leaking inputs', () => {
  assert.throws(() => new NotionStore({}), /^Error: NOTION_CONFIG: Set PORTABLE_CONTEXT_NOTION_TOKEN/);
  assert.throws(() => new NotionStore({ ...env, PORTABLE_CONTEXT_NOTION_TOKEN: 'invalid credential' }),
    /^Error: NOTION_CONFIG: Set PORTABLE_CONTEXT_NOTION_TOKEN/);
  assert.throws(() => new NotionStore({ ...env, PORTABLE_CONTEXT_NOTION_DATABASE_ID: 'invalid ID' }),
    /^Error: NOTION_CONFIG: Set PORTABLE_CONTEXT_NOTION_DATABASE_ID/);
});

test('Notion mock: offline errors and 401/403 responses are safe to display', async () => {
  const offline = new NotionStore(env, async () => { throw new Error(token); });
  await assert.rejects(offline.search({}), error =>
    error.message.startsWith('NOTION_UNAVAILABLE:') && !error.message.includes(token));
  for (const [status, code] of [[401, 'NOTION_AUTH'], [403, 'NOTION_ACCESS']]) {
    const store = new NotionStore(env, async () => Response.json({ message: token }, { status }));
    await assert.rejects(store.search({}), error =>
      error.message.startsWith(code + ':') && !error.message.includes(token));
  }
});

test('Notion mock: separately opened stores share paginated history and only search current records', async () => {
  const mock = mockNotion();
  const first = mock.store();
  const second = mock.store();
  const old = await first.write(tea);
  const current = await second.correct({ id: old.id, expectedVersion: 1, ...correction });
  assert.equal(current.version, 2);
  assert.equal(current.rootId, old.id);
  assert.equal(current.replacesId, old.id);
  assert.deepEqual(await first.read({ id: old.id }), {
    ...old, status: 'superseded', replacedById: current.id,
  });
  assert.deepEqual(await first.search({ query: 'Green' }), []);
  assert.deepEqual(await second.search({ query: 'ＯＯＬＯＮＧ', scope: 'drinks' }), [current]);
  assert.ok(mock.cursors.includes('1'));
  await assert.rejects(first.correct({ id: old.id, expectedVersion: 1, ...correction }), /VERSION_CONFLICT/);
  assert.equal(mock.pages.length, 2);

  const result = await first.delete({ id: current.id, expectedVersion: 2 });
  assert.deepEqual(result, { id: current.id, deletedRevisions: 2, retainedInNotion: true });
  assert.deepEqual(await second.search({}), []);
  await assert.rejects(second.read({ id: old.id }), /NOT_FOUND/);
  assert.equal(mock.pages.length, 3);
});

test('Notion mock: concurrent corrections preserve both proposals and report a fork', async () => {
  let creates = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const mock = mockNotion({
    beforeCreate: async () => {
      creates++;
      if (creates === 1) return;
      if (creates === 3) release();
      await ready;
    },
  });
  const first = mock.store();
  const second = mock.store();
  const old = await first.write(tea);
  const edit = { id: old.id, expectedVersion: 1, ...correction };
  const results = await Promise.allSettled([
    first.correct(edit),
    second.correct({ ...edit, content: 'Black tea' }),
  ]);
  assert.ok(results.every(result => result.status === 'rejected' && /VERSION_CONFLICT/.test(result.reason.message)));
  assert.equal(mock.pages.length, 3);
  await assert.rejects(first.search({}), /VERSION_CONFLICT/);
});

test('Notion mock: a lost write response asks the caller to inspect the saved revision', async () => {
  const mock = mockNotion({ afterCreate: () => { throw new Error(token); } });
  const store = mock.store();
  await assert.rejects(store.write(tea), error =>
    error.message.startsWith('NOTION_WRITE_UNCERTAIN:') && !error.message.includes(token));
  const [saved] = await store.search({});
  assert.equal(saved.content, tea.content);
  assert.equal(mock.pages.length, 1);
});

test('Notion mock: Unicode contents round trip across rich text chunks', async () => {
  const mock = mockNotion();
  const store = mock.store();
  const content = 'a' + '茶🍵'.repeat(16_666);
  const saved = await store.write({ ...tea, content });
  assert.ok(mock.pages[0].properties[column].rich_text.length > 1);
  assert.equal((await store.read({ id: saved.id })).content, content);
});

test('Notion mock: a truncated result is rejected instead of returning partial history', async () => {
  const mock = mockNotion({ requestStatus: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' } });
  await assert.rejects(mock.store().search({}), /NOTION_DATA/);
});
