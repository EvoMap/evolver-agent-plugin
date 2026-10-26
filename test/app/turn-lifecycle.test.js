import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted, openTurnOf } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { sessionStarted } from '../../lib/app/session-start.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { closeUnfinishedTurn, turnEnded } from '../../lib/app/turn-end.js';
import { ASSET, PROMPT, memoryPorts } from './memory-ports.js';

const WAIT = { waitMs: 5_000 };

async function verifiedTurn(ports, sessionId, { prompt = PROMPT, exit = 0 } = {}) {
  const opened = await promptSubmitted(ports, { sessionId, prompt, ...WAIT });
  await toolFinished(ports, { sessionId, note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId, note: { kind: 'shell', command: 'npm test', exit, output: exit ? '1 test failed' : 'ℹ pass 3\nℹ fail 0' } });
  return opened;
}

const end = (ports, sessionId, extra = {}) => turnEnded(ports, { sessionId, reason: 'answer', answer: 'Fixed.', projectDir: '/proj', ...extra });

test('a recalled strategy ends with the spec line, and its turn end reports it with the turn\'s check', async () => {
  const { ports, queued, scheduled } = memoryPorts();
  const { injection } = await verifiedTurn(ports, 's1');
  assert.match(injection, /^\[Evolution Memory\] Fix flaky Redis connection retries/);
  assert.ok(injection.endsWith('Apply them where they fit.'));
  const ended = await end(ports, 's1');
  assert.equal(ended.reports.length, 1);
  assert.equal(ended.reports[0].task_id, 'testagent:s1:1');
  assert.equal(ended.reports[0].outcome, 'success');
  assert.deepEqual(ended.reports[0].evidence, { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: false }, aborted: false, stage: 'immediate' });
  assert.deepEqual(queued.map(({ report }) => report.task_id), ['testagent:s1:1']);
  assert.ok(scheduled.includes('drain'));
});

test('a verified turn becomes the candidate; a correction drops it before revising the reports', async () => {
  const { ports, queued } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1', { model: 'model-x' });
  assert.equal((await ports.candidates.read()).s1.turn, 1);
  await promptSubmitted(ports, { sessionId: 's1', prompt: '还是报错', ...WAIT });
  assert.equal((await ports.candidates.read()).s1, undefined);
  const correction = queued.find(({ report }) => report.task_id.endsWith(':correction')).report;
  assert.equal(correction.outcome, 'failed');
});

test('a question is no correction, and the candidate stays', async () => {
  const { ports } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: '这样不对吧？', ...WAIT });
  assert.ok((await ports.candidates.read()).s1);
});

test('a failed, interrupted, errored or unverified turn leaves no candidate', async () => {
  for (const [reason, exit] of [['answer', 1], ['aborted', 0], ['error', 0]]) {
    const { ports } = memoryPorts();
    await verifiedTurn(ports, 's1', { exit });
    await end(ports, 's1', { reason });
    assert.equal((await ports.candidates.read()).s1, undefined, `${reason}/${exit}`);
  }
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'explain the retry policy', ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'cat lib/redis.js', exit: 0 } });
  await end(ports, 's1');
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a plugin command turn recalls nothing, keeps the last reuses for labelling and is no candidate', async () => {
  const { ports, queued } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1');
  const command = await promptSubmitted(ports, { sessionId: 's1', prompt: '/evolver-evolve', isCommand: true, ...WAIT });
  assert.equal(command.injection, '');
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'thanks, works now', ...WAIT });
  assert.equal(queued.find(({ report }) => report.task_id.endsWith(':correction')).report.outcome, 'success');
});

test('an aborted turn reports its injection as failed, with no check', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  const [report] = (await end(ports, 's1', { reason: 'aborted' })).reports;
  assert.equal(report.outcome, 'failed');
  assert.equal(report.evidence.tier, 'none');
  assert.equal(report.evidence.aborted, true);
});

test('a check still running at turn end counts as not run; a later note with its call id settles it', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', running: true, callId: 'c1' } });
  assert.deepEqual((await end(ports, 's1')).record.checks, []);
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', running: true, callId: 'c2' } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 1, callId: 'c2' } });
  const { record } = await end(ports, 's1');
  assert.deepEqual(record.checks, [{ command: 'npm test', failed: true }]);
  assert.deepEqual(record.commands, ['npm test']);
});

test('an agent-reported turn counts as exposure only', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  const recordOf = () => ({ checks: [{ command: 'npm test', failed: false }], commands: ['npm test'], paths: [], edits: [], answer: '' });
  const [report] = (await end(ports, 's1', { recordOf, source: 'agent_reported' })).reports;
  assert.equal(report.evidence.tier, 'none');
  assert.equal(report.evidence.reported_by, 'agent');
  assert.match(report.reason, /as the agent reported it\.$/);
});

test('session end reports what is left as aborted, closes the candidate and keeps the turn counter for a resume', async () => {
  const { ports, queued, scheduled } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'now add a redis connection pool for the retries', ...WAIT });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  assert.equal((await ports.candidates.read()).s1.closed, true);
  assert.ok(scheduled.includes('distill'));
  assert.equal((await promptSubmitted(ports, { sessionId: 's1', prompt: 'resume', ...WAIT })).turn, 3);
  assert.ok(queued.every(({ report }) => report.task_id !== 'testagent:s1:1' || report.evidence.stage !== 'immediate' || report.outcome === 'success'));
});

test('a session start reports a killed session\'s injections as aborted; a live one keeps its own', async () => {
  const gone = new Set();
  const { ports, queued } = memoryPorts({ owner: 999, gone });
  await promptSubmitted(ports, { sessionId: 'dead', prompt: PROMPT, ...WAIT });
  await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
  assert.equal(queued.length, 0);
  gone.add(999);
  await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
  assert.deepEqual(queued.map(({ report }) => [report.asset_id, report.task_id, report.evidence.aborted]), [[ASSET.asset_id, 'testagent:dead:1', true]]);
  await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
  assert.equal(queued.length, 1);
});

test('an asset already injected into the session is not injected again', async () => {
  const { ports } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1');
  assert.equal((await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT })).injection, '');
});

test('the open turn keeps its strategy for a host whose injection lasts one model call', async () => {
  const { ports } = memoryPorts();
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, turnId: 't1', ...WAIT });
  assert.deepEqual(await openTurnOf(ports, 's1'), { turn: 1, turnId: 't1', strategy: injection });
  await end(ports, 's1');
  assert.equal(await openTurnOf(ports, 's1'), null);
});

test('a turn left open waits out its settle time, then closes as an error', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  const before = ports.clock.now();
  await closeUnfinishedTurn(ports, { sessionId: 's1', settleMs: 3_000, as: 'error', projectDir: '/proj' });
  assert.ok(ports.clock.now() - before >= 3_000);
  assert.equal(await openTurnOf(ports, 's1'), null);
});
