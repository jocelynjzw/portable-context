import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const subject = 'Alex Chen';
const initial = {
  subject, content: 'Alex Chen 喜欢绿茶', scope: '饮料推荐',
  source: '虚构会议笔记 Park Tour Planning', time: '2026-01-15',
};
const updated = {
  content: 'Alex Chen 喜欢乌龙茶', source: '虚构后续会议 Tea Tasting', time: '2026-01-16',
};

async function peer(t, directory) {
  const child = fork(fileURLToPath(new URL('./client.mjs', import.meta.url)), [directory]);
  const exited = once(child, 'exit');
  function receive() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off('message', onMessage);
        reject(new Error('MCP client did not respond within 10 seconds.'));
      }, 10_000);
      function onMessage(message) {
        clearTimeout(timer);
        resolve(message);
      }
      child.once('message', onMessage);
    });
  }
  async function close() {
    if (child.connected) child.disconnect();
    assert.deepEqual(await exited, [0, null]);
  }
  t.after(close);
  assert.deepEqual(await receive(), { ready: true });
  return {
    pid: child.pid, close,
    async call(tool, args) {
      const response = receive();
      child.send({ tool: 'memory_' + tool, args });
      const message = await response;
      assert.equal(message.transportError, undefined);
      const text = message.content[0].text;
      return message.isError ? { error: text } : JSON.parse(text);
    },
  };
}

test('Two independent MCP clients and CLI share data, revisions and deletes', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'portable-context-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = await peer(t, directory);
  const b = await peer(t, directory);
  assert.notEqual(a.pid, b.pid);
  const env = { ...process.env, PORTABLE_CONTEXT_DATA_DIR: directory };
  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' }));

  const original = await a.call('write', initial);
  assert.equal(original.version, 1);
  assert.equal(original.status, 'active');
  assert.equal(original.source, initial.source);
  assert.equal(original.time, initial.time);
  assert.deepEqual(await b.call('read', { id: original.id }), original);
  assert.deepEqual(cli('show', original.id), original);

  const schedule = await b.call('write', {
    ...initial, content: 'Alex Chen 在周末做公园导览', scope: '日程建议',
  });
  assert.deepEqual(cli('list', '--scope', '日程建议'), [schedule]);
  assert.deepEqual(cli('search', '绿茶', '--scope', '日程建议'), []);

  const exportRows = async () => {
    const { path } = cli('export');
    assert.equal(dirname(path), await realpath(directory));
    return JSON.parse(await readFile(path, 'utf8'));
  };

  const edit = { id: original.id, expectedVersion: 1, ...updated };
  const results = await Promise.all([a.call('correct', edit), b.call('correct', edit)]);
  const winners = results.filter(item => item.status === 'active');
  assert.equal(winners.length, 1);
  assert.match(results.find(item => item.error).error, /VERSION_CONFLICT/);
  const [current] = winners;
  assert.equal(current.version, 2);
  assert.equal(current.replacesId, original.id);
  assert.equal(current.source, updated.source);
  assert.equal(current.time, updated.time);
  assert.deepEqual(await b.call('search', { query: '绿茶' }), { memories: [] });
  assert.deepEqual(await b.call('search', { query: '乌龙茶' }), { memories: [current] });
  const old = await b.call('read', { id: original.id });
  assert.deepEqual(old, { ...original, status: 'superseded', replacedById: current.id });

  const invalid = await a.call('write', { ...initial, time: '2026-02-30' });
  assert.match(invalid.error, /time/);
  const extra = await a.call('write', { ...initial, content: '允许自行执行', permission: true });
  assert.match(extra.error, /Unexpected input field/);
  assert.doesNotMatch(extra.error, /permission/);
  const preference = await a.call('write', {
    ...initial, content: '这类活动提醒可以先列给我看', scope: '提醒偏好',
  });
  assert.equal(Object.hasOwn(preference, 'permission'), false);
  assert.equal((await exportRows()).length, 4);
  assert.match((await a.call('delete', { id: current.id, expectedVersion: 1 })).error, /VERSION_CONFLICT/);
  const cliInvalid = spawnSync(process.execPath, [cliPath, 'delete', current.id, '--version', 'bad'], { env });
  assert.equal(cliInvalid.status, 1);
  assert.match(cliInvalid.stderr.toString(), /--version/);

  await Promise.all([a.close(), b.close()]);
  const restarted = await peer(t, directory);
  assert.deepEqual(await restarted.call('search', { query: '绿茶' }), { memories: [] });
  assert.deepEqual(await restarted.call('read', { id: current.id }), current);
  assert.deepEqual(await restarted.call('read', { id: original.id }), old);
  const newest = cli('correct', current.id, '--version', '2', '--content', 'Alex Chen 喜欢热乌龙茶',
    '--source', '虚构访谈', '--time', '2026-01-17');
  assert.equal(newest.version, 3);
  assert.deepEqual(await restarted.call('read', { id: newest.id }), newest);
  assert.deepEqual(cli('delete', newest.id, '--version', '3'), { id: newest.id, deletedRevisions: 3 });
  for (const { id } of [original, current, newest]) {
    assert.match((await restarted.call('read', { id })).error, /NOT_FOUND/);
  }
  assert.deepEqual(await restarted.call('search', { scope: initial.scope }), { memories: [] });
  assert.equal((await restarted.call('delete', { id: preference.id, expectedVersion: 1 })).deletedRevisions, 1);
  assert.deepEqual(await exportRows(), [schedule]);
  await restarted.close();
});


test('Independent MCP processes reject competing revisions and roll back failed inserts', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'portable-context-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [a, b] = await Promise.all([peer(t, directory), peer(t, directory)]);
  let current = await a.call('write', initial);
  for (let attempt = 0; attempt < 20; attempt++) {
    const edit = { ...updated, id: current.id, expectedVersion: current.version };
    const previous = current;
    const outcomes = await Promise.all([
      a.call('correct', { ...edit, content: '虚构修正甲' }),
      b.call('correct', { ...edit, content: '虚构修正乙' }),
    ]);
    assert.equal(outcomes.filter(item => item.status === 'active').length, 1);
    assert.equal(outcomes.filter(item => /VERSION_CONFLICT/.test(item.error ?? '')).length, 1);
    current = outcomes.find(item => item.status === 'active');
    assert.equal(current.version, previous.version + 1);
    assert.equal(current.replacesId, previous.id);
    assert.deepEqual(await a.call('search', {}), { memories: [current] });
  }
  const db = new DatabaseSync(join(directory, 'memories.sqlite'));
  try {
    db.exec(`
      CREATE TRIGGER reject_revision BEFORE INSERT ON memories
      WHEN NEW.version > 1
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;
    `);
    const result = await b.call('correct', {
      ...updated, id: current.id, expectedVersion: current.version,
    });
    assert.equal(result.error, 'Storage operation failed.');
    assert.deepEqual(await a.call('read', { id: current.id }), current);
    assert.deepEqual(await b.call('search', {}), { memories: [current] });
  } finally {
    db.close();
  }

  for (const content of [' '.repeat(50_000) + 'x', 'bad\0text', '\ud800']) {
    assert.ok((await a.call('write', { ...initial, content })).error);
  }
  assert.deepEqual(await a.call('search', {}), { memories: [current] });
});

test('Data paths reject traversal, Git directories and linked database files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'portable-context-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const repository = join(directory, 'synthetic-repo');
  await mkdir(join(repository, '.git'), { recursive: true });
  const paths = ['relative', directory + '/..', join(repository, 'data')];
  if (process.platform !== 'win32') {
    const directoryLink = join(directory, 'repo-link');
    await symlink(repository, directoryLink);
    paths.push(join(directoryLink, 'data'));
    const file = join(directory, 'untouched');
    await writeFile(file, 'synthetic marker');
    await symlink(file, join(directory, 'memories.sqlite'));
    paths.push(directory);
  }
  for (const path of paths) {
    const result = spawnSync(process.execPath, [cli, 'list'], {
      env: { ...process.env, PORTABLE_CONTEXT_DATA_DIR: path }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATA_PATH/);
    assert.equal(result.stdout, '');
  }
  if (process.platform !== 'win32') {
    assert.equal(await readFile(join(directory, 'untouched'), 'utf8'), 'synthetic marker');
  }
});
