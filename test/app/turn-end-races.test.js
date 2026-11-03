import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { closeUnfinishedTurn, turnEnded } from '../../lib/app/turn-end.js';
import { ASSET, PROMPT, memoryPorts } from './memory-ports.js';

const record = { commands: ['npm test'], checks: [{ command: 'npm test', failed: false }], paths: ['retry.js'], edits: ['retry.js'], answer: 'Fixed retries.' };
const finish = ports => turnEnded(ports, { sessionId: 's', turnId: 'first', reason: 'answer', answer: record.answer, recordOf: () => record });

async function heldFirst(options = {}) {
  const made = memoryPorts(options);
  await promptSubmitted(made.ports, { sessionId: 's', turnId: 'first', prompt: PROMPT, waitMs: 500 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), enqueue = made.ports.reports.enqueue;
  let held = false;
  made.ports.reports.enqueue = async entries => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return enqueue(entries);
  };
  const closing = finish(made.ports);
  await entered.promise;
  return { ...made, release, closing };
}

test('a correction past the settle budget invalidates a delayed first finalizer and receives its late reuse correction', async () => {
  for (const endSession of [false, true]) {
    const made = await heldFirst();
    await closeUnfinishedTurn(made.ports, { sessionId: 's' });
    await promptSubmitted(made.ports, { sessionId: 's', turnId: 'second', prompt: 'Still broken, that is incorrect. Fix it.', waitMs: 500 });
    if (endSession) await sessionEnded(made.ports, { sessionId: 's' });
    made.release.resolve(); await made.closing;
    assert.deepEqual(await made.ports.candidates.read(), {});
    assert.equal(made.sessions.get('s').correctedTurn, 1);
    assert.deepEqual(made.sessions.get('s').labelable, []);
    const corrections = made.queued.filter(entry => entry.report.task_id === 'testagent:s:1:correction');
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].report.outcome, 'failed');
  }
});

test('a delayed verified candidate survives an ordinary follow-up without changing that newer turn state', async () => {
  const made = await heldFirst();
  await closeUnfinishedTurn(made.ports, { sessionId: 's' });
  await promptSubmitted(made.ports, { sessionId: 's', turnId: 'second', prompt: 'Now update documentation.', waitMs: 500 });
  const newerSettling = made.ports.clock.now() + 123;
  await made.ports.sessions.update('s', stored => ({ ...stored, settling: newerSettling }));
  made.release.resolve(); await made.closing;
  assert.equal((await made.ports.candidates.read()).s.turn, 1);
  assert.equal(made.sessions.get('s').settling, newerSettling);
  assert.deepEqual(made.sessions.get('s').labelable, []);
});

test('an older finalizer cannot overwrite a newer verified candidate or its reuse labels', async () => {
  const secondAsset = { ...ASSET, asset_id: `sha256:${'b'.repeat(64)}`, signals_match: ['queue'] };
  const made = await heldFirst({ assets: [ASSET, secondAsset] });
  await closeUnfinishedTurn(made.ports, { sessionId: 's' });
  await promptSubmitted(made.ports, { sessionId: 's', turnId: 'second', prompt: 'Fix queue delivery.', waitMs: 500 });
  await toolFinished(made.ports, { sessionId: 's', turnId: 'second', note: { kind: 'edit', paths: ['queue.js'] } });
  await toolFinished(made.ports, { sessionId: 's', turnId: 'second', note: { kind: 'shell', command: 'npm test', exit: 0 } });
  await turnEnded(made.ports, { sessionId: 's', turnId: 'second', reason: 'answer', answer: 'Fixed queue.' });
  const candidate = (await made.ports.candidates.read()).s, labelable = made.sessions.get('s').labelable;
  made.release.resolve(); const old = await made.closing;
  assert.equal(old.isCandidate, false);
  assert.deepEqual((await made.ports.candidates.read()).s, candidate);
  assert.deepEqual(made.sessions.get('s').labelable, labelable);
});

test('a repeated terminal cannot rejudge while the first terminal is still writing', async () => {
  const made = await heldFirst();
  assert.equal(await finish(made.ports), null);
  assert.deepEqual(await made.ports.candidates.read(), {});
  made.release.resolve(); await made.closing;
  assert.equal((await made.ports.candidates.read()).s.turn, 1);
});

test('a correction of a newer turn does not retroactively label an older delayed terminal', async () => {
  const secondAsset = { ...ASSET, asset_id: `sha256:${'b'.repeat(64)}`, signals_match: ['queue'] };
  const made = await heldFirst({ assets: [ASSET, secondAsset] });
  await closeUnfinishedTurn(made.ports, { sessionId: 's' });
  await promptSubmitted(made.ports, { sessionId: 's', turnId: 'second', prompt: 'Fix queue delivery.', waitMs: 500 });
  await turnEnded(made.ports, { sessionId: 's', turnId: 'second', reason: 'answer', answer: 'Fixed queue.', recordOf: () => record });
  await promptSubmitted(made.ports, { sessionId: 's', turnId: 'third', prompt: 'Still broken, that is incorrect. Fix it.', waitMs: 500 });
  made.release.resolve(); await made.closing;
  assert.equal(made.queued.some(entry => entry.report.task_id === 'testagent:s:1:correction'), false);
  assert.equal(made.queued.filter(entry => entry.report.task_id === 'testagent:s:2:correction').length, 1);
});

test('a rejudge forbidden from creating a candidate cannot race a same-turn candidate removal', async () => {
  const made = memoryPorts();
  await promptSubmitted(made.ports, { sessionId: 's', turnId: 'first', prompt: PROMPT, waitMs: 500 });
  await finish(made.ports);
  const update = made.ports.candidates.update;
  let removed = false;
  made.ports.candidates.update = async mutate => {
    if (!removed) { removed = true; await update(() => ({})); }
    return update(mutate);
  };
  await turnEnded(made.ports, { sessionId: 's', turnId: 'first', reason: 'answer', answer: record.answer, recordOf: () => record, allowNewCandidate: false });
  assert.deepEqual(await made.ports.candidates.read(), {});
});
