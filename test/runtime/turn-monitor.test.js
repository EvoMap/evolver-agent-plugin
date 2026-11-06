import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import profile from '../../hosts/minimax/profile.js';
import { recordReaderOf } from '../../lib/runtime/records.js';
import { monitorTurn } from '../../lib/runtime/turn-monitor.js';

test('only the matching native aborted/failed turn closes, without the next prompt or a fabricated candidate', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-turn-monitor-'));
  const env = { MINIMAX_DATA_DIR: dir };
  const file = profile.turnEnd.statusRecord.file(env); mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE local_runtime_turn_ingress(session_id TEXT, turn_id TEXT, status TEXT)');
  const insert = db.prepare('INSERT INTO local_runtime_turn_ingress VALUES (?, ?, ?)');
  insert.run('s1', 't1', 'accepted'); insert.run('other', 't1', 'aborted');
  const at = { sessionId: 's1', turnId: 't1', projectDir: dir };
  const ports = { sessions: { read: async () => ({ open: true, turnId: 't1', pid: process.pid }) }, owner: { isGone: () => false }, turnStatus: recordReaderOf(profile.turnEnd.statusRecord, env) };
  for (const [native, reason] of [['aborted', 'aborted'], ['failed', 'error']]) {
    let ticks = 0, closed;
    db.prepare('UPDATE local_runtime_turn_ingress SET status = ? WHERE session_id = ?').run('accepted', 's1');
    await monitorTurn(ports, at, async result => { closed = result; }, { dir: join(dir, 'locks'), sleep: async () => { ticks++; db.prepare('UPDATE local_runtime_turn_ingress SET status = ? WHERE session_id = ?').run(native, 's1'); } });
    assert.equal(ticks, 1);
    assert.deepEqual(closed, { ...at, reason });
  }
  assert.equal(ports.turnStatus("s1' OR 1=1 --", 't1'), null);
  assert.equal(ports.turnStatus('s1', 't2'), null);
});

test('completed, stale, missing or unavailable metadata never invent a terminal verdict', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-monitor-fallback-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = { sessionId: 's', turnId: 't', projectDir: dir };
  for (const [open, turnId, row] of [[true, 't', { status: 'completed' }], [false, 't', { status: 'aborted' }], [true, 'new', { status: 'failed' }], [true, 't', null], [true, 't', { status: 'incompatible' }]]) {
    let now = 0;
    const ports = { sessions: { read: async () => ({ open, turnId }) }, owner: { isGone: () => false }, turnStatus: () => row };
    await monitorTurn(ports, at, () => assert.fail('must not close'), { dir, now: () => now, sleep: async () => { now += 500; } });
    assert.ok(now <= 30_000);
  }
});
