import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { readState, updateState } from '../../lib/runtime/store/file-lock.js';
import { fileStoresOf, rangeReferenceOf } from '../../lib/runtime/store/file-stores.js';
import { lockContenders, until } from '../helpers/lock-contenders.js';

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

test('evidence generations keep turns and epochs apart without changing legacy calls', async () => {
  const { stores: cursor } = stores();
  const first = { sessionEpoch: 10, turn: 1 }, next = { sessionEpoch: 10, turn: 2 }, replacement = { sessionEpoch: 11, turn: 1 };
  const legacyId = JSON.stringify(['s1', first.sessionEpoch, first.turn]);
  await cursor.notes.append('s1', { command: 'first' }, first);
  await cursor.notes.append('s1', { command: 'next' }, next);
  await cursor.notes.append('s1', { command: 'replacement' }, replacement);
  await cursor.notes.append(legacyId, { command: 'legacy collision' });
  await cursor.notes.append('s1', { command: 'legacy' });
  assert.deepEqual(await cursor.notes.read('s1', first), [{ command: 'first' }]);
  assert.deepEqual(await cursor.notes.read('s1', replacement), [{ command: 'replacement' }]);
  assert.deepEqual(await cursor.notes.read(legacyId), [{ command: 'legacy collision' }]);
  assert.deepEqual(await cursor.notes.read('s1'), [{ command: 'legacy' }]);
  await cursor.notes.clear('s1', first);
  assert.deepEqual(await cursor.notes.read('s1', first), []);
  const captured = await cursor.notes.take('s1', next);
  await cursor.notes.append('s1', { command: 'arrived after take' }, next);
  await captured.commit();
  assert.deepEqual(await cursor.notes.read('s1', next), [{ command: 'arrived after take' }]);
  assert.deepEqual(await cursor.notes.read('s1'), [{ command: 'legacy' }]);
  await cursor.baseline.remember('s1', '/generation.js', null, next);
  await cursor.baseline.remember('s1', '/legacy.js');
  assert.deepEqual([...(await cursor.baseline.take('s1', null, next)).before.keys()], ['/generation.js']);
  assert.deepEqual([...(await cursor.baseline.take('s1')).before.keys()], ['/legacy.js']);
});

test('released turn evidence is immediately recoverable alongside newer appends, and pruning keeps it', async () => {
  const { stores: cursor } = stores();
  const scope = { sessionEpoch: 10, turn: 1 };
  await cursor.notes.append('s1', { command: 'first' }, scope);
  const first = await cursor.notes.take('s1', scope);
  await cursor.notes.append('s1', { command: 'arrived after take' }, scope);
  first.release();

  cursor.prune();
  const recovered = await cursor.notes.take('s1', scope);
  assert.deepEqual(recovered.notes, [{ command: 'first' }, { command: 'arrived after take' }]);
  await recovered.commit();
  assert.deepEqual((await cursor.notes.take('s1', scope)).notes, []);
});

test('unknown legacy claim order survives repeated release and reclaims without changing note bytes', async () => {
  const { dir, stores: cursor } = stores();
  const scope = { sessionEpoch: 10, turn: 1 };
  for (const command of ['first', 'last']) {
    await cursor.notes.append('s1', { command }, scope);
    (await cursor.notes.take('s1', scope)).release();
  }
  const originals = readdirSync(dir).filter(name => name.endsWith('.taking')).map(name => fs.readFileSync(join(dir, name), 'utf8')).sort();
  for (const name of readdirSync(dir)) fs.renameSync(join(dir, name), join(dir, name.replace(/\.order-\d+/, '')));
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = await cursor.notes.take('s1', scope);
    assert.equal(taken.ordered, false);
    assert.deepEqual(taken.notes.map(({ command }) => command).sort(), ['first', 'last']);
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.taking')).map(name => fs.readFileSync(join(dir, name), 'utf8')).sort(), originals);
    if (attempt === 2) await taken.commit(); else taken.release();
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('a mixed legacy and numbered claim cannot silently acquire a trusted order', async () => {
  const { dir, stores: cursor } = stores();
  const scope = { sessionEpoch: 10, turn: 1 };
  await cursor.notes.append('s1', { command: 'first' }, scope);
  (await cursor.notes.take('s1', scope)).release();
  await cursor.notes.append('s1', { command: 'last' }, scope);
  (await cursor.notes.take('s1', scope)).release();
  const [name] = readdirSync(dir).filter(name => name.endsWith('.taking'));
  fs.renameSync(join(dir, name), join(dir, name.replace(/\.order-\d+/, '')));
  const taken = await cursor.notes.take('s1', scope);
  assert.equal(taken.ordered, false);
  assert.deepEqual(taken.notes.map(({ command }) => command).sort(), ['first', 'last']);
  await taken.commit();
});

test('baseline recovery preserves the first pre-edit hash through repeated claim rotations', async () => {
  const { dir, stores: cursor } = stores();
  const scope = { sessionEpoch: 10, turn: 1 }, file = join(dir, 'edited.js');
  writeFileSync(file, 'original');
  await cursor.baseline.remember('s1', file, null, scope);
  const first = await cursor.baseline.take('s1', null, scope);
  const before = first.before.get(file);
  for (const name of readdirSync(dir).filter(name => name.endsWith('.taking'))) fs.utimesSync(join(dir, name), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  writeFileSync(file, 'modified');
  await cursor.baseline.remember('s1', file, null, scope);
  for (let attempt = 0; attempt < 2; attempt++) {
    const taken = await cursor.baseline.take('s1', null, scope);
    assert.equal(taken.ordered, true);
    assert.equal(taken.before.get(file), before);
    if (attempt === 1) await taken.commit();
    else for (const name of readdirSync(dir).filter(name => name.endsWith('.taking'))) fs.utimesSync(join(dir, name), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  }
});

test('legacy baseline chunks with unknown order do not invent a first pre-edit hash', async () => {
  const { dir, stores: cursor } = stores();
  const scope = { sessionEpoch: 10, turn: 1 };
  for (const content of ['original', 'modified']) {
    const file = join(dir, 'edited.js');
    writeFileSync(file, content);
    await cursor.baseline.remember('s1', file, null, scope);
    await cursor.baseline.take('s1', null, scope);
    for (const name of readdirSync(dir).filter(name => name.endsWith('.taking'))) fs.utimesSync(join(dir, name), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  }
  for (const name of readdirSync(dir).filter(name => name.endsWith('.taking'))) fs.renameSync(join(dir, name), join(dir, name.replace(/\.order-\d+/, '')));
  const taken = await cursor.baseline.take('s1', null, scope);
  assert.equal(taken.ordered, false);
  assert.equal(taken.before.size, 0);
  await taken.commit();
});

test('two processes serialize claim numbering while an earlier reader keeps its chunk', async t => {
  const { dir } = stores();
  const target = join(dir, 'queue.jsonl');
  const runtime = new URL('../../lib/runtime/store/file-lock.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { appendStateLine, takeStateLines } from ${JSON.stringify(runtime)};
    const [dir, target, role] = process.argv.slice(1);
    const marker = name => join(dir, name);
    const wait = name => {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(marker(name))) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for ' + name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    };
    let taken;
    if (role === 'A') {
      appendStateLine(target, { command: 'first' });
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (from === target && to.endsWith('.taking')) { fs.writeFileSync(marker('A-paused'), ''); wait('A-resume'); }
        return rename(from, to);
      };
      taken = takeStateLines(target);
      fs.writeFileSync(marker('A-ready'), '');
    } else {
      assert.throws(() => takeStateLines(target), { code: 'ELOCKED' });
      fs.writeFileSync(marker('B-blocked'), '');
      wait('A-ready');
      appendStateLine(target, { command: 'last' });
      taken = takeStateLines(target);
      fs.writeFileSync(marker('B-ready'), '');
    }
    wait('release');
    taken.release();
  `;
  const { run, results } = lockContenders(t, dir, script, [dir, target], ['A-resume', 'release']);
  run('A');
  await until(() => existsSync(join(dir, 'A-paused')));
  run('B');
  await until(() => existsSync(join(dir, 'B-blocked')));
  writeFileSync(join(dir, 'A-resume'), '');
  await until(() => existsSync(join(dir, 'B-ready')));
  writeFileSync(join(dir, 'release'), '');
  for (const { code, stderr } of await results()) assert.equal(code, 0, stderr);
  const { takeStateLines } = await import('../../lib/runtime/store/file-lock.js');
  const taken = takeStateLines(target);
  assert.equal(taken.ordered, true);
  assert.deepEqual(taken.lines, [{ command: 'first' }, { command: 'last' }]);
  taken.commit();
});

test('pruning expires generation evidence and its claims without touching report claims', async () => {
  const { dir, stores: cursor } = stores();
  const scope = { sessionEpoch: 10, turn: 1 };
  await cursor.notes.append('s1', { command: 'retained evidence' }, scope);
  await cursor.baseline.remember('s1', '/old.js', null, scope);
  await cursor.notes.take('s1', scope);
  await cursor.baseline.take('s1', null, scope);
  writeFileSync(join(dir, 'cursor-turn-generation-0123456789abcdef.jsonl.order-unknown.123.0123456789ab.taking'), 'legacy ambiguity');
  writeFileSync(join(dir, 'cursor-edits-generation-0123456789abcdef.jsonl.123.0123456789ab.taking'), 'legacy claim');
  const reportClaim = join(dir, 'cursor-reports-queue.jsonl.123.0123456789ab.taking');
  writeFileSync(reportClaim, 'keep report');
  for (const name of readdirSync(dir)) fs.utimesSync(join(dir, name), new Date(0), new Date(0));
  cursor.prune();
  assert.deepEqual(readdirSync(dir), ['cursor-reports-queue.jsonl.123.0123456789ab.taking']);
  assert.equal(fs.readFileSync(reportClaim, 'utf8'), 'keep report');
});

test('ranges stay out of the pending file an earlier version claims from, and its leftovers move over once', async () => {
  const { dir, stores: cursor } = stores();
  writeFileSync(join(dir, 'cursor-distill-pending.json'), JSON.stringify({ old: { prompt: 'p', at: 1 } }));
  await cursor.candidates.update((ranges) => ({ ...ranges, s1: { turns: [], at: 2 } }));
  assert.deepEqual([Object.keys(readState(join(dir, 'cursor-distill-ranges.json'), {})).sort(), readState(join(dir, 'cursor-distill-pending.json'), {})],
    [['old', 's1'], {}]);
});

test('range references distinguish a reused turn number from a different session epoch', () => {
  const range = { at: 10, changedAt: 11, turns: [{ turn: 1, sessionEpoch: 12 }] };
  const replacement = { ...range, turns: [{ turn: 1, sessionEpoch: 13 }] };
  assert.notEqual(rangeReferenceOf('s1', range), rangeReferenceOf('s1', replacement));
});

test('one corrupt session file is preserved and reported without stopping the update of the others', async () => {
  const { dir, stores: cursor } = stores();
  await cursor.sessions.update('good', () => ({ turn: 1 }));
  await cursor.sessions.update('bad', () => ({ turn: 1 }));
  const corrupt = readdirSync(dir).map((name) => join(dir, name)).find((file) => fs.readFileSync(file, 'utf8').includes('"bad"'));
  writeFileSync(corrupt, '{unfinished');
  await assert.rejects(cursor.sessions.updateEach((stored) => ({ ...stored, turn: 2 })), { code: 'EINVALIDSTATE' });
  assert.equal((await cursor.sessions.read('good')).turn, 2);
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{unfinished');
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

test('a report queued as the outbox holder finishes is delivered, though its own drain found the outbox taken', async () => {
  const { stores: cursor } = stores();
  const queued = (taskId) => ({ report: { task_id: taskId, asset_id: 'a' }, sessionId: 's1' });
  await cursor.reports.enqueue([queued('first')]);
  const delivered = [];
  let lateDrain = null;
  await cursor.outbox.drain(async (due) => {
    const unsent = Object.entries(due).filter(([, entry]) => !entry.sentAt);
    delivered.push(...unsent.map(([, entry]) => entry.report.task_id));
    if (unsent.length === 0 && lateDrain === null) {
      await cursor.reports.enqueue([queued('late')]);
      lateDrain = await cursor.outbox.drain(async (other) => other);
    }
    return Object.fromEntries(unsent.map(([key, entry]) => [key, { ...entry, sentAt: 5 }]));
  });
  assert.equal(lateDrain, false, 'the late report\'s own drain left it to the holder');
  assert.deepEqual(delivered, ['first', 'late']);
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

test('transient sharing denial while creating a state lock retries before calling the mutator', t => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const { dir } = stores();
    const target = join(dir, 'counter.json'), lock = `${target}.lock`;
    const write = fs.writeFileSync;
    let attempts = 0;
    let mutations = 0;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === lock) {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('sharing violation'), { code });
      }
      return write(file, ...args);
    });
    try {
      updateState(target, {}, state => {
        mutations += 1;
        assert.ok(existsSync(lock));
        return { count: (state.count ?? 0) + 1 };
      });
      assert.equal(attempts, 2, code);
      assert.equal(mutations, 1, code);
      assert.equal(readState(target, {}).count, 1, code);
      assert.equal(existsSync(lock), false, code);
    } finally {
      t.mock.restoreAll();
    }
  }
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

test('a recorded draft correction survives reopening and pruning the source session while its draft is saved', async () => {
  const { dir, stores: first } = stores();
  await first.sessions.update('s1', () => ({ turn: 2, sessionEpoch: 10 }));
  await first.drafts.update(() => [{ id: 'd1', sessionId: 's1', sourceCandidate: { at: 1, turn: 2, sessionEpoch: 10 } }]);
  await first.draftCorrections.mark('s1', 2, 10);
  await first.draftCorrections.mark('s1', 2, 10);
  first.prune(Date.now() + 31 * 24 * 60 * 60 * 1000);

  const reopened = fileStoresOf({ dir, agent: 'cursor' });
  assert.deepEqual(await reopened.sessions.read('s1'), {});
  assert.equal(await reopened.draftCorrections.has('s1', 2, 10), true);
  assert.equal(await reopened.draftCorrections.has('s1', 2, 20), false);
  assert.equal(await reopened.draftCorrections.has('s1', 1, 10), false);
  assert.equal(await reopened.draftCorrections.has('s2', 2, 10), false);
});

test('a draft correction no saved draft refers to is pruned once it is as old as a session file may get', async () => {
  const { dir, stores: cursor } = stores();
  const day = 24 * 60 * 60 * 1000;
  await cursor.drafts.update(() => [{ id: 'd1', sessionId: 's1', sourceCandidate: { at: 1, turn: 2 } }]);
  await cursor.draftCorrections.mark('s1', 2, undefined);
  await cursor.draftCorrections.mark('s1', 3, 10);
  await cursor.draftCorrections.mark('s2', 1, 10);

  cursor.prune(Date.now() + 20 * day);
  assert.equal(await cursor.draftCorrections.has('s1', 3, 10), true);
  await cursor.draftCorrections.withSession('s3', () => cursor.prune(Date.now() + 31 * day));
  assert.equal(await cursor.draftCorrections.has('s1', 2, undefined), true);
  assert.equal(await cursor.draftCorrections.has('s1', 3, 10), false);
  assert.equal(await cursor.draftCorrections.has('s2', 1, 10), false);
  assert.equal(readdirSync(join(dir, 'cursor-distill-corrections')).length, 1);
});

test('a saved range draft retains correction markers for each of its source turns', async () => {
  const { stores: cursor } = stores();
  const turns = [{ turn: 1, sessionEpoch: 10 }, { turn: 2, sessionEpoch: 10 }];
  await cursor.drafts.update(() => [{ id: 'draft', sessionId: 's1', sourceRange: { turns } }]);
  for (const { turn, sessionEpoch } of turns) await cursor.draftCorrections.mark('s1', turn, sessionEpoch);
  cursor.prune(Date.now() + 31 * 24 * 60 * 60 * 1000);
  for (const { turn, sessionEpoch } of turns) assert.equal(await cursor.draftCorrections.has('s1', turn, sessionEpoch), true);
});

test('a publish gate in another process waits for the source session correction', async (t) => {
  const { dir, stores: parent } = stores();
  const module = new URL('../../lib/runtime/store/file-stores.js', import.meta.url).href;
  const script = `import { once } from 'node:events';
import { fileStoresOf } from ${JSON.stringify(module)};
const { draftCorrections } = fileStoresOf({ dir: ${JSON.stringify(dir)}, agent: 'cursor' });
await draftCorrections.withSession('s1', async () => {
  const release = once(process, 'message');
  process.send('locked');
  await release;
  await draftCorrections.mark('s1', 2, 10);
});
process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill());
  const exited = once(child, 'exit');
  const locked = once(child, 'message');
  const [ready] = await Promise.race([locked, exited]);
  assert.equal(ready, 'locked');

  let checked = false;
  const publication = parent.draftCorrections.withSession('s1', async () => {
    checked = true;
    return parent.draftCorrections.has('s1', 2, 10);
  });
  assert.equal(checked, false);
  child.send('release');
  assert.equal(await publication, true);
  assert.deepEqual(await exited, [0, null]);
});

test('a session lifecycle lock that stays held refuses with ELOCKED, so a prompt can open without it', async () => {
  const { stores: cursor } = stores();
  let release;
  const holder = cursor.sessions.withSession('s1', () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(cursor.sessions.withSession('s1', () => assert.fail('work must not run')), { code: 'ELOCKED' });
  assert.equal(await cursor.sessions.withSession('s2', () => 'other session'), 'other session');
  release();
  await holder;
});

test('a correction lock that stays held refuses with ELOCKED, so a hook reports it', async () => {
  const { stores: cursor } = stores();
  let release;
  const holder = cursor.draftCorrections.withSession('s1', () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(cursor.draftCorrections.withSession('s1', () => assert.fail('work must not run')), { code: 'ELOCKED' });
  release();
  await holder;
});
