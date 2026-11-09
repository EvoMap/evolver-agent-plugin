import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import profile from '../../hosts/minimax/profile.js';
import zcode from '../../hosts/zcode/profile.js';
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

test('an available ZCode status table can record cancellation after more than 30 seconds without a row', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-zcode-status-'));
  const env = { ZCODE_SESSION_DB_PATH: join(dir, 'db.sqlite') };
  const file = zcode.turnEnd.statusRecord.file(env);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, completed_at INTEGER)');
  const at = { sessionId: 's1', turnId: 't1', projectDir: dir };
  const ports = {
    sessions: { read: async () => ({ open: true, turnId: 't1', turn: 1, sessionEpoch: 1 }) },
    owner: { isGone: () => false },
    turnStatus: recordReaderOf(zcode.turnEnd.statusRecord, env),
    confirmTurnCompletion: true,
  };
  let now = 0, reason;
  await monitorTurn(ports, at, result => { reason = result.reason; }, {
    dir: join(dir, 'locks'), now: () => now, sleep: async () => {
      now += 500;
      if (now === 45_000) db.prepare('INSERT INTO turn_usage VALUES (?, ?, ?, ?)').run('s1', 't1', 'cancelled', now);
    },
  });
  assert.equal(reason, 'aborted');
  assert.equal(now, 45_000);
});

test('a native turn gets bounded time for its final record after the owner exits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-zcode-owner-exit-'));
  const env = { ZCODE_SESSION_DB_PATH: join(dir, 'db.sqlite') };
  const db = new DatabaseSync(zcode.turnEnd.statusRecord.file(env));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, completed_at INTEGER)');

  const ownerExitAt = 5 * 60_000 - 500;
  for (const status of ['cancelled', null]) {
    const turnId = status ?? 'no-terminal-row';
    db.prepare("INSERT INTO turn_usage VALUES ('s1', ?, 'running', NULL)").run(turnId);
    const at = { sessionId: 's1', turnId, projectDir: dir };
    const opened = { open: true, turnId, turn: 1, sessionEpoch: 1 };
    let now = 0, closed;
    const ports = {
      sessions: { read: async () => opened },
      owner: { isGone: () => now >= ownerExitAt },
      turnStatus: recordReaderOf(zcode.turnEnd.statusRecord, env),
      confirmTurnCompletion: true,
    };
    await monitorTurn(ports, at, result => { closed = result; }, {
      dir: join(dir, 'locks'), now: () => now, sleep: async () => {
        now = now === 0 ? ownerExitAt : now + 500;
        if (status && now === ownerExitAt + 5_000) {
          db.prepare("UPDATE turn_usage SET status = ?, completed_at = ? WHERE session_id = 's1' AND turn_id = ?").run(status, now, turnId);
        }
      },
    });
    assert.deepEqual(closed, status ? { sessionId: 's1', turnId, reason: 'aborted', expectedTurn: opened } : undefined);
    assert.equal(now, ownerExitAt + (status ? 5_000 : 30_000));
  }
});

test('an owner exit preserves the pending native completion window without extending missing metadata', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-pending-owner-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [status, completesAt, expectedEnd] of [
    ['pending', 45_000, 45_000],
    ['pending', null, 5 * 60_000],
    [null, null, 30_000],
  ]) {
    const at = { sessionId: 's1', turnId: 't1', projectDir: dir };
    const opened = { open: true, turnId: 't1', turn: 1, sessionEpoch: 1 };
    let now = 0, closed;
    const ports = {
      sessions: { read: async () => opened },
      owner: { isGone: () => true },
      turnStatus: () => completesAt !== null && now >= completesAt ? { status: 'completed' } : status && { status },
      confirmTurnCompletion: true,
    };
    await monitorTurn(ports, at, result => { closed = result; }, {
      dir, now: () => now, sleep: async () => { now += 500; },
    });
    assert.equal(now, expectedEnd);
    assert.deepEqual(closed, completesAt === null ? undefined : {
      sessionId: 's1', turnId: 't1', reason: 'answer', expectedTurn: opened,
    });
  }
});
