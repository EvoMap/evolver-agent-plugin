import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { sessionStarted } from '../../lib/app/session-start.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';
import { ASSET, memoryPorts, PROMPT } from './memory-ports.js';

test('native session start delivers adopted legacy injections without reporting unconfirmed native turns', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-native-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const fixture = memoryPorts({ now, gone: new Set([4242]) });
  const { ports, requests, scheduled } = fixture;
  const stores = fileStoresOf({ dir, agent: 'testagent' });
  Object.assign(ports, stores, { confirmTurnCompletion: true, turnStatus: () => null });
  writeFileSync(join(dir, 'old-injected-0123456789abcdef.json'), JSON.stringify({
    'sha256:legacy': { sessionId: 'legacy', pid: 4242, turn: 7, injectedAt: now, strategyText: 'Legacy strategy.' },
  }));
  stores.adoptLegacy([{ ledgers: /^old-injected-[0-9a-f]{16}\.json$/ }]);
  await sessionEnded(ports, { sessionId: 'legacy' });

  for (const reason of ['unknown', 'aborted', 'incomplete']) {
    await promptSubmitted(ports, { sessionId: reason, turnId: `${reason}-turn`, prompt: PROMPT, waitMs: 5_000 });
    if (reason === 'aborted') await turnEnded(ports, { sessionId: reason, reason });
    if (reason === 'incomplete') {
      await toolFinished(ports, { sessionId: reason, note: { kind: 'shell', command: 'npm test', callId: 'running-check', running: true } });
      await turnEnded(ports, { sessionId: reason, reason: 'answer', answer: 'Still running.' });
    }
    await sessionEnded(ports, { sessionId: reason });
  }
  await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
  assert.equal(await runBackgroundTasks(ports, scheduled.splice(0)), true);
  const reports = requests.filter(({ path }) => path === '/asset/reuse-result').map(({ body }) => body);
  assert.deepEqual(reports.map(({ asset_id, task_id, outcome, evidence }) => [asset_id, task_id, outcome, evidence.tier, evidence.aborted]), [
    ['sha256:legacy', 'testagent:legacy:7', 'failed', 'none', true],
  ]);
  assert.deepEqual(await ports.candidates.read(), {});
  for (const reason of ['unknown', 'aborted', 'incomplete']) {
    assert.equal((await ports.sessions.read(reason)).injected[ASSET.asset_id].reportedAt, undefined);
  }
  await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
  assert.equal(await runBackgroundTasks(ports, scheduled.splice(0)), true);
  assert.equal(requests.filter(({ path }) => path === '/asset/reuse-result').length, 1);
});

test('native recovery preserves a verified report after a failed local queue', async (t) => {
  for (const scenario of ['owner died without session end', 'session ended', 'adopted cached entry', 'replacement during enqueue']) await t.test(scenario, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'evolver-native-ledger-retry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { ports, requests, scheduled, advance } = memoryPorts({ now: Date.now(), gone: new Set([4242]) });
    Object.assign(ports, fileStoresOf({ dir, agent: 'testagent' }), { confirmTurnCompletion: true, turnStatus: () => null });
    await promptSubmitted(ports, { sessionId: 'cached', turnId: 't1', prompt: PROMPT, waitMs: 5_000 });
    for (const note of [
      { kind: 'shell', command: 'npm test', callId: 'check', running: true },
      { kind: 'shell', command: 'npm test', callId: 'check', exit: 0 },
      { kind: 'answer', text: 'The tests passed.' },
    ]) await toolFinished(ports, { sessionId: 'cached', turnId: 't1', note });
    const enqueue = ports.reports.enqueue;
    ports.reports.enqueue = async () => { throw new Error('local queue unavailable'); };
    await assert.rejects(turnEnded(ports, { sessionId: 'cached', turnId: 't1', reason: 'answer' }), /local queue unavailable/);
    ports.reports.enqueue = enqueue;
    const expected = {
      asset_id: ASSET.asset_id, outcome: 'success', task_id: 'testagent:cached:1',
      reason: 'Injected by Evolver into turn 1; applied: used; last test passed.',
      evidence: { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: false }, source: 'observed', aborted: false, stage: 'immediate' },
    };
    assert.deepEqual((await ports.sessions.read('cached')).injected[ASSET.asset_id].pendingReport, expected);
    if (scenario === 'session ended') await sessionEnded(ports, { sessionId: 'cached' });
    if (scenario === 'adopted cached entry') await ports.sessions.update('cached', (stored) => ({
      ...stored, injected: { ...stored.injected, [ASSET.asset_id]: { ...stored.injected[ASSET.asset_id], adopted: true } },
    }));
    let replaced = false;
    if (scenario === 'replacement during enqueue') ports.reports.enqueue = async (entries) => {
      await enqueue(entries);
      if (replaced || !entries.some(({ report }) => report?.task_id === expected.task_id)) return;
      replaced = true;
      advance(1);
      await ports.sessions.update('cached', () => ({ turn: 0 }));
      await promptSubmitted(ports, { sessionId: 'cached', turnId: 'replacement', prompt: PROMPT, waitMs: 5_000 });
    };

    await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
    assert.equal(await runBackgroundTasks(ports, scheduled.splice(0)), true);
    assert.deepEqual(requests.filter(({ path }) => path === '/asset/reuse-result').map(({ body }) => body), [expected]);
    if (replaced) {
      const current = await ports.sessions.read('cached');
      assert.equal(current.open, true);
      assert.equal(current.turnId, 'replacement');
      assert.equal(current.injected[ASSET.asset_id].reportedAt, undefined);
    }
    await sessionEnded(ports, { sessionId: 'cached' });
    await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
    assert.equal(await runBackgroundTasks(ports, scheduled.splice(0)), true);
    assert.equal(requests.filter(({ path }) => path === '/asset/reuse-result').length, 1);
  });
});
