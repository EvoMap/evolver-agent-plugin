import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { readState } from '../../lib/runtime/store/file-lock.js';
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
  const run = () => new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', script]).on('close', resolve));
  await Promise.all([run(), run(), run(), run()]);
  assert.equal(readState(target, {}).count, 100);
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

test('a recorded draft correction survives reopening and pruning the source session', async () => {
  const { dir, stores: first } = stores();
  await first.sessions.update('s1', () => ({ turn: 2, sessionEpoch: 10 }));
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
