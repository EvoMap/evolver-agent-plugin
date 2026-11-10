import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { promptSubmitted } from '../../lib/app/prompt.js';
import { sessionStarted } from '../../lib/app/session-start.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { ASSET, memoryPorts, PROMPT } from './memory-ports.js';

test('session start recovers matching terminal native turns when the store becomes readable', async () => {
  const { ports, queued, scheduled, snapshotBases } = memoryPorts({ gone: new Set([4242]) });
  ports.confirmTurnCompletion = true;
  const statuses = new Map();
  ports.turnStatus = (sessionId, turnId) => statuses.get(`${sessionId}:${turnId}`);

  const open = async (sessionId) => {
    const turnId = `${sessionId}-turn`;
    await promptSubmitted(ports, { sessionId, turnId, prompt: PROMPT, waitMs: 5_000 });
    for (const note of [
      { kind: 'shell', command: 'npm test', callId: 'check', running: true },
      { kind: 'shell', command: 'npm test', callId: 'check', exit: 0 },
      { kind: 'answer', text: 'The tests passed.' },
    ]) {
      await toolFinished(ports, { sessionId, turnId, note });
    }
  };
  await open('complete');
  await open('cancel');
  await open('still-open');
  await open('live');
  await ports.sessions.update('live', (stored) => ({ ...stored, pid: 5000 }));

  const restart = async (isClean = true) => {
    await sessionStarted(ports, { sessionId: 'new-session', projectDir: '/other-project' });
    assert.equal(await runBackgroundTasks(ports, scheduled.splice(0)), isClean);
  };
  await restart();
  assert.equal((await ports.sessions.read('complete')).open, true);
  assert.deepEqual(queued, []);

  statuses.set('complete:complete-turn', { status: 'completed' });
  statuses.set('cancel:cancel-turn', { status: 'aborted' });
  statuses.set('still-open:another-turn', { status: 'completed' });
  statuses.set('live:live-turn', { status: 'completed' });
  const readEach = ports.sessions.readEach;
  ports.sessions.readEach = async (visit) => {
    await readEach(visit);
    throw new Error('An unrelated session could not be read');
  };
  await restart(false);
  ports.sessions.readEach = readEach;
  await restart();
  assert.equal((await ports.sessions.read('complete')).open, false);
  assert.equal((await ports.sessions.read('cancel')).open, false);
  assert.equal((await ports.sessions.read('still-open')).open, true);
  assert.equal((await ports.sessions.read('live')).open, true);
  assert.deepEqual(queued.map(({ report }) => [report.asset_id, report.task_id, report.outcome]), [
    [ASSET.asset_id, 'testagent:complete:1', 'success'],
  ]);
  const ranges = await ports.candidates.read();
  assert.deepEqual(Object.keys(ranges), ['complete']);
  assert.equal(ranges.complete.projectDir, null);
  assert.equal(ranges.complete.project, null);
  assert.deepEqual(snapshotBases, []);
});
