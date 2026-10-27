import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ASSET, deadPid, fakeLlm, projectDirectory, reportsOf, requestsTo, startDsh, startProxy, stateFile, until,
} from './host.js';

const OLD_SESSION = 'session-7a1c0b2e-0000-4000-8000-000000000001';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// What @evomap/dsh-evolver 0.3.1 (f7b4cde) leaves in ~/.evolver/state: unprefixed files, a ledger per session named
// by the first 16 hex digits of its id's sha256, and dsh's own turn numbers in task ids.
function standaloneLeftovers(stateDir, projectDir, pid) {
  mkdirSync(stateDir, { recursive: true });
  const now = Date.now();
  const write = (name, value) => writeFileSync(join(stateDir, name), JSON.stringify(value));
  write(`injected-${sha256(OLD_SESSION).slice(0, 16)}.json`, {
    [ASSET.asset_id]: { turn: 3, injectedAt: now - 1_000, strategyText: '[Evolution Memory] Fix flaky Redis connection retries', sessionId: OLD_SESSION, pid },
    'sha256:reported': { turn: 2, injectedAt: now - 5_000, strategyText: '1. a.', sessionId: OLD_SESSION, pid, reportedAt: now - 4_000 },
  });
  const unsent = { asset_id: 'sha256:reported', outcome: 'success', task_id: `dsh:${OLD_SESSION}:2`, reason: 'Injected by Evolver into dsh turn 2; last test passed.', evidence: { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: false }, aborted: false, stage: 'immediate' } };
  write('reports-outbox.json', { [`${unsent.task_id}\0${unsent.asset_id}`]: { report: unsent, sessionId: OLD_SESSION, queuedAt: now - 3_000, attempts: 1 } });
  writeFileSync(join(projectDir, 'redis.js'), 'kept');
  write('retention-pending.json', [{
    sessionId: OLD_SESSION,
    projectDir,
    reuses: [{ assetId: 'sha256:reported', applied: 'used', taskId: `dsh:${OLD_SESSION}:2` }],
    files: [{ path: join(projectDir, 'redis.js'), before: sha256('before'), after: sha256('kept') }],
    atMs: now - 2_000,
  }]);
  write('distill-pending.json', {
    [OLD_SESSION]: {
      prompt: 'fix the flaky redis connection retries in our tests',
      commands: ['npm test 2>&1 | tail -5'],
      paths: ['lib/redis.js'],
      checks: [{ command: 'npm test 2>&1 | tail -5', failed: false }],
      answer: 'Set maxRetriesPerRequest to null; the suite passes.',
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
      turn: 2,
      pid,
      attempts: 0,
      at: now - 2_500,
      closed: true,
    },
  });
}

test('what the standalone plugin left is adopted at the first session start: reports, retention, injections and its candidate', async (t) => {
  const proxy = await startProxy(t);
  const projectDir = projectDirectory();
  standaloneLeftovers(proxy.stateDir, projectDir, deadPid());
  const llm = fakeLlm();
  const dsh = await startDsh({ llm });
  await dsh.createAgent({ cwd: projectDir });

  await until(() => reportsOf(proxy).length === 3, 'the three leftover reports');
  const byTask = Object.fromEntries(reportsOf(proxy).map((report) => [report.task_id, report]));
  assert.equal(byTask[`dsh:${OLD_SESSION}:2`].outcome, 'success', 'the undelivered report goes out as it was queued');
  assert.deepEqual(byTask[`dsh:${OLD_SESSION}:2:retention`].evidence, { tier: 'L2', applied: 'used', stage: 'retention' });
  assert.equal(byTask[`dsh:${OLD_SESSION}:2:retention`].outcome, 'success');
  assert.equal(byTask[`dsh:${OLD_SESSION}:3`].asset_id, ASSET.asset_id);
  assert.equal(byTask[`dsh:${OLD_SESSION}:3`].evidence.aborted, true, 'an injection no turn end reported is reported aborted');

  await until(() => requestsTo(proxy, '/conversation/distill').length === 1, 'the leftover candidate\'s distillation');
  assert.equal(requestsTo(proxy, '/conversation/distill')[0].body.session_id, `dsh:${OLD_SESSION}`);
  assert.deepEqual([llm.calls[0].provider, llm.calls[0].model], ['deepseek-official', 'deepseek-flash']);

  for (const name of ['reports-outbox.json', 'retention-pending.json', 'distill-pending.json', `injected-${sha256(OLD_SESSION).slice(0, 16)}.json`]) {
    assert.equal(existsSync(join(proxy.stateDir, name)), false, `${name} is adopted`);
  }
  assert.ok(stateFile(proxy, 'dsh-legacy-adopted.json', null));
});
