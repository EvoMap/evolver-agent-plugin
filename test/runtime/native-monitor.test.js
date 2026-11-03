import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { monitorNativeTurn } from '../../lib/runtime/native-monitor.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-native-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = { sessionId: 's', turn: 1, projectDir: dir };
  const session = { open: true, turn: 1, native: { turn: 1 }, pid: 123 };
  const ports = { native: {}, sessions: { read: async () => session }, owner: { isGone: () => false } };
  return { at, session, ports, dir };
}

test('a native monitor waits for terminal and pending check records, then exits without touching a later turn', async t => {
  const f = fixture(t);
  let count = 0;
  await monitorNativeTurn(f.ports, f.at, async () => ({ ended: ++count > 1, waiting: count < 3, native: { turnId: '0' } }),
    () => assert.fail('not aborted'), { dir: f.dir, sleep: async () => {} });
  assert.equal(count, 3);
  f.session.turn = 2;
  await monitorNativeTurn(f.ports, f.at, () => assert.fail('stale'), () => assert.fail('stale'), { dir: f.dir });
});

test('owner death checks terminal first and only aborts the matching logical turn; missing identity has a bounded watch', async t => {
  const f = fixture(t);
  f.ports.owner.isGone = () => true;
  const events = [];
  await monitorNativeTurn(f.ports, f.at, async () => { events.push('terminal'); return { ended: true }; },
    () => assert.fail('completed is not aborted'), { dir: f.dir });
  await monitorNativeTurn(f.ports, f.at, async () => { events.push('missing'); return { ended: false }; },
    async closed => { events.push(closed); }, { dir: f.dir });
  assert.deepEqual(events, ['terminal', 'missing', { ...f.at, expectedTurn: 1, expectedPid: 123, reason: 'aborted' }]);
  f.ports.owner.isGone = () => false;
  let now = 0;
  await monitorNativeTurn(f.ports, f.at, async () => ({ waiting: true }), () => assert.fail('no verdict'),
    { dir: f.dir, now: () => now, sleep: async ms => { now += ms; } });
  assert.equal(now, 30_000);
});

test('a permanently oversized native turn stops its monitor without fabricating evidence', async t => {
  const f = fixture(t);
  let reads = 0;
  await monitorNativeTurn(f.ports, f.at, async () => { reads++; return { facts: { status: 'partial', limited: true }, waiting: true, native: { turnId: '0' } }; },
    () => assert.fail('no terminal verdict'), { dir: f.dir, sleep: () => assert.fail('permanent limit is not polled') });
  assert.equal(reads, 1);
  for (const status of ['unreadable', 'unsupported']) {
    await monitorNativeTurn(f.ports, f.at, async () => ({ facts: { status }, waiting: true, native: { turnId: '0' } }),
      () => assert.fail('no terminal verdict'), { dir: f.dir, sleep: () => assert.fail('invalid native history is not polled') });
  }
});

test('session end before native admission performs one final read then stops the unbound monitor', async t => {
  const f = fixture(t);
  Object.assign(f.session, { open: false, native: { turn: 1, turnId: null, sessionEnded: true } });
  let reads = 0, slept = 0, now = 0;
  await monitorNativeTurn(f.ports, f.at, async () => { reads++; return { waiting: true, native: f.session.native }; },
    () => assert.fail('no native evidence is no new verdict'), { dir: f.dir, now: () => now, sleep: async ms => { slept++; now += ms; } });
  assert.equal(reads, 1);
  assert.equal(slept, 0);
});
