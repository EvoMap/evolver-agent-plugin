import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { readState, updateState } from '../../lib/runtime/store/file-lock.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function stores(agent = 'cursor') {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-stores-'));
  dirs.push(dir);
  return { dir, stores: fileStoresOf({ dir, agent }) };
}

test('every file carries the agent name, so two agents in one directory never meet', async () => {
  const { dir, stores: cursor } = stores('cursor');
  const antigravity = fileStoresOf({ dir, agent: 'antigravity' });
  await cursor.sessions.update('s1', () => ({ turn: 1, pid: 1 }));
  await antigravity.sessions.update('s1', () => ({ turn: 5, pid: 2 }));
  await cursor.candidates.update(() => ({ s1: { at: 1 } }));
  await cursor.reports.enqueue([{ report: { task_id: 't', asset_id: 'a' }, sessionId: 's1' }]);
  assert.equal((await cursor.sessions.read('s1')).turn, 1);
  assert.equal((await antigravity.sessions.read('s1')).turn, 5);
  assert.ok(readdirSync(dir).filter((name) => !name.endsWith('.lock')).every((name) => /^(cursor|antigravity)-/.test(name)));
  const seen = [];
  await antigravity.sessions.updateEach((session, sessionId) => { seen.push([sessionId, session.turn]); });
  assert.deepEqual(seen, [['s1', 5]]);
});

test('the outbox takes queued reports and keeps what each delivery attempt settled', async () => {
  const { stores: cursor } = stores();
  await cursor.reports.enqueue([{ report: { task_id: 't1', asset_id: 'a' }, sessionId: 's1' }]);
  const delivered = await cursor.outbox.drain(async (due) =>
    Object.fromEntries(Object.entries(due).map(([key, entry]) => [key, { ...entry, attempts: 1, sentAt: 5 }])));
  assert.equal(delivered, true);
  const seen = [];
  await cursor.outbox.drain(async (due) => { seen.push(...Object.values(due)); return due; });
  assert.equal(seen[0].sentAt, 5);
});

test('an unreadable or invalid draft table is preserved and never passed to an update as empty', async t => {
  for (const failure of ['EBUSY', 'EACCES', 'invalid-json', 'wrong-shape']) {
    const { dir, stores: cursor } = stores();
    const target = join(dir, 'cursor-distill-drafts.json');
    const original = failure === 'invalid-json' ? '[unfinished' : failure === 'wrong-shape' ? '{}' : '[{"title":"keep this draft"}]';
    writeFileSync(target, original);
    const originalRead = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === target && ['EBUSY', 'EACCES'].includes(failure)) throw Object.assign(new Error('fixture read denial'), { code: failure });
      return originalRead(file, ...args);
    });
    let mutated = false;
    await assert.rejects(cursor.drafts.update(drafts => { mutated = true; return [...drafts, { title: 'new draft' }]; }), failure);
    assert.equal(mutated, false, failure);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(target, 'utf8'), original, failure);
    assert.equal(existsSync(`${target}.lock`), false, failure);
  }
  const { stores: cursor } = stores();
  assert.deepEqual(await cursor.drafts.read(), [], 'an absent table is still a fresh store');
  await cursor.drafts.update(() => [{ title: 'first draft' }]);
  assert.deepEqual(await cursor.drafts.read(), [{ title: 'first draft' }]);
});

test('a failed draft replacement preserves the previous file, releases its lock and removes its temporary file', async t => {
  const { dir, stores: cursor } = stores();
  const target = join(dir, 'cursor-distill-drafts.json');
  await cursor.drafts.update(() => [{ title: 'keep this draft' }]);
  const before = fs.readFileSync(target, 'utf8');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target) throw Object.assign(new Error('fixture replacement denial'), { code: 'EPERM' });
    return rename(from, to);
  });
  await assert.rejects(cursor.drafts.update(drafts => [...drafts, { title: 'new draft' }]), { code: 'EPERM' });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['cursor-distill-drafts.json']);
  await cursor.drafts.update(drafts => [...drafts, { title: 'retry succeeded' }]);
  assert.deepEqual(await cursor.drafts.read(), [{ title: 'keep this draft' }, { title: 'retry succeeded' }]);
});

test('a transient replacement denial retries while readers can still see the previous drafts', async t => {
  const { dir, stores: cursor } = stores();
  const target = join(dir, 'cursor-distill-drafts.json');
  const previous = [{ title: 'keep this draft' }];
  await cursor.drafts.update(() => previous);
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target) {
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), previous);
      if (++attempts === 1) throw Object.assign(new Error('fixture sharing denial'), { code: 'EBUSY' });
    }
    return rename(from, to);
  });
  await cursor.drafts.update(drafts => [...drafts, { title: 'new draft' }]);
  assert.equal(attempts, 2);
  assert.deepEqual(await cursor.drafts.read(), [...previous, { title: 'new draft' }]);
  assert.deepEqual(readdirSync(dir), ['cursor-distill-drafts.json']);
});

test('retention takes only an earlier session\'s entries in the same project, with each file\'s hash now', async () => {
  const { dir, stores: cursor } = stores();
  const file = join(dir, 'edited.js');
  writeFileSync(file, 'after');
  await cursor.retention.remember({ sessionId: 'old', projectDir: '/p', reuses: [{ assetId: 'a', applied: 'used', taskId: 't' }], editedBefore: new Map([[file, 'absent']]) });
  assert.deepEqual((await cursor.retention.takeDue({ sessionId: 'old', projectDir: '/p' })).due, []);
  const { due, commit } = await cursor.retention.takeDue({ sessionId: 'new', projectDir: '/p' });
  await commit();
  assert.equal(due.length, 1);
  assert.equal(due[0].files[0].now, due[0].files[0].after);
});

test('parallel processes updating one state file through the lock lose no update', async () => {
  const { dir } = stores();
  const target = join(dir, 'cursor-counter.json');
  const lock = new URL('../../lib/runtime/store/file-lock.js', import.meta.url).href;
  const script = `import { updateState } from ${JSON.stringify(lock)};
for (let i = 0; i < 25; i += 1) updateState(${JSON.stringify(target)}, {}, (state) => ({ count: (state.count ?? 0) + 1 }));`;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0], results.map(result => result.stderr).join('\n'));
  assert.equal(readState(target, {}).count, 100);
});

test('transient sharing denial retries admission before mutating; failed admission never writes unlocked', t => {
  const { dir } = stores();
  const target = join(dir, 'counter.json');
  const originalWrite = fs.writeFileSync;
  let denied = false;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === `${target}.lock` && !denied) { denied = true; throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); }
    return originalWrite(file, ...args);
  });
  updateState(target, {}, state => { assert.equal(existsSync(`${target}.lock`), true); return { count: (state.count ?? 0) + 1 }; });
  assert.equal(readState(target, {}).count, 1);
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === `${target}.lock`) throw Object.assign(new Error('unavailable volume'), { code: 'EROFS' });
    return originalWrite(file, ...args);
  });
  assert.throws(() => updateState(target, {}, () => assert.fail('no lock was held')), { code: 'ELOCKED' });
  assert.equal(readState(target, {}).count, 1);
});

test('transient sharing denial while releasing a state lock leaves no orphaned lock', t => {
  for (const operation of ['readFileSync', 'rmSync']) {
    const { dir } = stores();
    const target = join(dir, 'counter.json'), lock = `${target}.lock`;
    const original = fs[operation];
    let denied = false;
    t.mock.method(fs, operation, (file, ...args) => {
      if (file === lock && !denied) { denied = true; throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); }
      return original(file, ...args);
    });
    updateState(target, {}, state => ({ count: (state.count ?? 0) + 1 }));
    assert.equal(denied, true);
    assert.equal(existsSync(lock), false, operation);
    updateState(target, {}, state => ({ count: state.count + 1 }));
    assert.equal(readState(target, {}).count, 2);
    t.mock.restoreAll();
  }
});

test('a session file outlives the outbox: a session resumed within a month still counts its turns on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-prune-'));
  dirs.push(dir);
  const stores = fileStoresOf({ dir, agent: 'testagent' });
  await stores.sessions.update('s1', () => ({ turn: 9 }));
  const day = 24 * 60 * 60 * 1000;
  stores.prune(Date.now() + 20 * day);
  assert.equal((await stores.sessions.read('s1')).turn, 9);
  stores.prune(Date.now() + 31 * day);
  assert.deepEqual(await stores.sessions.read('s1'), {});
});
