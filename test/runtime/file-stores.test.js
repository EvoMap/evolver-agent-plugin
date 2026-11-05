import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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

test('a corrupt draft file is preserved for every packaged host', async () => {
  for (const agent of readdirSync(new URL('../../hosts/', import.meta.url))) {
    if (!existsSync(new URL(`../../hosts/${agent}/profile.js`, import.meta.url))) continue;
    const { dir, stores: host } = stores(agent);
    const target = join(dir, `${agent}-distill-drafts.json`);
    writeFileSync(target, '[unfinished');
    await assert.rejects(host.drafts.update(() => assert.fail('mutator must not run')), { code: 'EINVALIDSTATE' });
    assert.equal(fs.readFileSync(target, 'utf8'), '[unfinished', agent);
  }
});

test('a refused state lock preserves drafts and never runs their mutator', async t => {
  const { dir, stores: cursor } = stores();
  const target = join(dir, 'cursor-distill-drafts.json');
  const lock = `${target}.lock`;
  const original = '[{"title":"keep this draft"}]';
  writeFileSync(target, original);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === lock) throw Object.assign(new Error('fixture lock creation denial'), { code: 'EROFS' });
    return write(file, ...args);
  });
  let mutations = 0;
  try {
    await assert.rejects(cursor.drafts.update(drafts => { mutations += 1; return [...drafts, { title: 'new draft' }]; }), { code: 'ELOCKED' });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(mutations, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(readdirSync(dir), ['cursor-distill-drafts.json']);
});

test('a held live state lock preserves drafts and never runs their mutator after waiting', async () => {
  const { dir, stores: cursor } = stores();
  const target = join(dir, 'cursor-distill-drafts.json');
  const lock = `${target}.lock`;
  const original = '[{"title":"keep this draft"}]';
  const held = `${process.pid}:fixture-live-owner`;
  writeFileSync(target, original);
  writeFileSync(lock, held);
  let mutations = 0;
  await assert.rejects(cursor.drafts.update(drafts => { mutations += 1; return [...drafts, { title: 'new draft' }]; }), { code: 'ELOCKED' });
  assert.equal(mutations, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(fs.readFileSync(lock, 'utf8'), held);
});

for (const closeFails of [false, true]) test(`a partial temporary state write preserves drafts and cleans up before a retry${closeFails ? ' even when close also fails' : ''}`, async t => {
  const { dir, stores: cursor } = stores();
  const target = join(dir, 'cursor-distill-drafts.json');
  const previous = [{ title: 'keep this draft' }];
  await cursor.drafts.update(() => previous);
  const original = fs.readFileSync(target, 'utf8');
  const temporary = file => typeof file === 'string' && file.startsWith(target + '.') && file.endsWith('.tmp');
  const descriptors = new Set();
  const open = fs.openSync, write = fs.writeFileSync, close = fs.closeSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const descriptor = open(file, ...args);
    if (temporary(file)) descriptors.add(descriptor);
    return descriptor;
  });
  let failed = false;
  let closeFailed = false;
  const writeFailure = Object.assign(new Error('fixture storage exhausted after a partial write'), { code: 'ENOSPC' });
  if (closeFails) t.mock.method(fs, 'closeSync', descriptor => {
    const owned = descriptors.delete(descriptor);
    const result = close(descriptor);
    if (owned) {
      closeFailed = true;
      throw Object.assign(new Error('fixture close failure after closing the descriptor'), { code: 'EIO' });
    }
    return result;
  });
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (!failed && (temporary(file) || descriptors.has(file))) {
      failed = true;
      write(file, '[{"partial":', ...args.slice(1));
      throw writeFailure;
    }
    return write(file, ...args);
  });
  try {
    await assert.rejects(cursor.drafts.update(drafts => [...drafts, { title: 'new draft' }]), error => {
      assert.equal(error, writeFailure);
      assert.equal(error.code, 'ENOSPC');
      return true;
    });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(failed, true);
  assert.equal(closeFailed, closeFails);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(readdirSync(dir), ['cursor-distill-drafts.json']);
  await cursor.drafts.update(drafts => [...drafts, { title: 'retry succeeded' }]);
  assert.deepEqual(await cursor.drafts.read(), [...previous, { title: 'retry succeeded' }]);
});

test('a temporary descriptor close failure preserves drafts without replacing the target and permits a retry', async t => {
  const { dir, stores: cursor } = stores();
  const target = join(dir, 'cursor-distill-drafts.json');
  const previous = [{ title: 'keep this draft' }];
  await cursor.drafts.update(() => previous);
  const original = fs.readFileSync(target, 'utf8');
  const descriptors = new Set();
  const open = fs.openSync, close = fs.closeSync, rename = fs.renameSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const descriptor = open(file, ...args);
    if (typeof file === 'string' && file.startsWith(target + '.') && file.endsWith('.tmp')) descriptors.add(descriptor);
    return descriptor;
  });
  let failed = false;
  t.mock.method(fs, 'closeSync', descriptor => {
    const owned = descriptors.delete(descriptor);
    const result = close(descriptor);
    if (owned) {
      failed = true;
      throw Object.assign(new Error('fixture close failure after closing the descriptor'), { code: 'EIO' });
    }
    return result;
  });
  let replacements = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target) replacements += 1;
    return rename(from, to);
  });
  try {
    await assert.rejects(cursor.drafts.update(drafts => [...drafts, { title: 'new draft' }]), { code: 'EIO' });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(failed, true);
  assert.equal(replacements, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(readdirSync(dir), ['cursor-distill-drafts.json']);
  await cursor.drafts.update(drafts => [...drafts, { title: 'retry succeeded' }]);
  assert.deepEqual(await cursor.drafts.read(), [...previous, { title: 'retry succeeded' }]);
});

test('a temporary file collision preserves the existing file and releases the state lock', async t => {
  const { dir, stores: cursor } = stores();
  const target = join(dir, 'cursor-distill-drafts.json');
  await cursor.drafts.update(() => [{ title: 'keep this draft' }]);
  const original = fs.readFileSync(target, 'utf8');
  const suffix = '010203040506';
  const collision = `${target}.${process.pid}.${suffix}.tmp`;
  const collisionContents = 'another invocation owns these bytes';
  writeFileSync(collision, collisionContents);
  const random = crypto.randomBytes;
  t.mock.method(crypto, 'randomBytes', (size, ...args) => size === 6 ? Buffer.from(suffix, 'hex') : random(size, ...args));
  try {
    await assert.rejects(cursor.drafts.update(drafts => [...drafts, { title: 'new draft' }]), { code: 'EEXIST' });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(fs.readFileSync(collision, 'utf8'), collisionContents);
  assert.equal(existsSync(`${target}.lock`), false);
  await cursor.drafts.update(drafts => [...drafts, { title: 'retry succeeded' }]);
  assert.deepEqual(await cursor.drafts.read(), [{ title: 'keep this draft' }, { title: 'retry succeeded' }]);
  assert.equal(fs.readFileSync(collision, 'utf8'), collisionContents);
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

test('a report appended after an interrupted queue write survives draining and commit', async () => {
  const { dir, stores: cursor } = stores();
  const earlier = { report: { task_id: 'earlier', asset_id: 'a' }, sessionId: 's1' };
  const next = { report: { task_id: 'next', asset_id: 'a' }, sessionId: 's1' };
  writeFileSync(join(dir, 'cursor-reports-queue.jsonl'), `${JSON.stringify(earlier)}\n{"report":`);
  await cursor.reports.enqueue([next]);
  const delivered = [];
  await cursor.outbox.drain(async (due) => { delivered.push(...Object.values(due).map((entry) => entry.report)); return due; });
  assert.deepEqual(delivered, [earlier.report, next.report]);
  const persisted = [];
  await cursor.outbox.drain(async (due) => { persisted.push(...Object.values(due).map((entry) => entry.report)); return due; });
  assert.deepEqual(persisted, [earlier.report, next.report]);
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

test('transient sharing denial while releasing a state lock leaves no orphaned lock', t => {
  for (const operation of ['readFileSync', 'unlinkSync']) {
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
