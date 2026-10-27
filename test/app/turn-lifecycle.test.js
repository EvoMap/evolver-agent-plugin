import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lastTurnOf, promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { sessionStarted } from '../../lib/app/session-start.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { closeUnfinishedTurn, turnEnded } from '../../lib/app/turn-end.js';
import { AGENT_REPORTED } from '../../lib/app/turn-reports.js';
import { sessionOf as sessionOfStored } from '../../lib/session/state.js';
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

test('the last turn keeps its strategy while open, for a host whose injection lasts one model call', async () => {
  const { ports } = memoryPorts();
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, turnId: 't1', ...WAIT });
  assert.deepEqual(await lastTurnOf(ports, 's1'), { turn: 1, turnId: 't1', strategy: injection });
  await end(ports, 's1');
  assert.deepEqual(await lastTurnOf(ports, 's1'), { turn: 1, turnId: 't1', strategy: '' });
});

test('a turn left open waits out its settle time, then closes as an error', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  const before = ports.clock.now();
  await closeUnfinishedTurn(ports, { sessionId: 's1', settleMs: 3_000, as: 'error', projectDir: '/proj' });
  assert.ok(ports.clock.now() - before >= 3_000);
  assert.equal((await lastTurnOf(ports, 's1')).strategy, '');
});

test('a prompt waits for a turn end that is still writing, even on a host that needs no settle time', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await ports.sessions.update('s1', (stored) => ({ ...stored, open: false, settling: ports.clock.now() }));
  const before = ports.clock.now();
  await closeUnfinishedTurn(ports, { sessionId: 's1', settleMs: 0, projectDir: '/proj' });
  assert.ok(ports.clock.now() - before >= 2_000);
});

test('a turn end that cannot queue its reports leaves the injections unreported for a later end to report', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  const enqueue = ports.reports.enqueue;
  ports.reports.enqueue = async () => { throw new Error('killed'); };
  await assert.rejects(end(ports, 's1'));
  ports.reports.enqueue = enqueue;
  const stored = await ports.sessions.read('s1');
  assert.equal(Object.values(stored.injected)[0].reportedAt, undefined);
});

test('the wait for a turn end still writing runs from when that turn began closing, after a settle wait', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  const start = ports.clock.now();
  const sleep = ports.clock.sleep;
  let closedAt = null;
  ports.clock.sleep = async (ms) => {
    await sleep(ms);
    if (closedAt === null && ports.clock.now() - start >= 2_500) {
      closedAt = ports.clock.now();
      await ports.sessions.update('s1', (stored) => ({ ...stored, open: false, settling: closedAt }));
    }
  };
  await closeUnfinishedTurn(ports, { sessionId: 's1', settleMs: 3_000, projectDir: '/proj' });
  assert.ok(ports.clock.now() >= closedAt + 2_000);
});

test('an injection adopted from a standalone plugin is reported aborted at the next session start, never on a later turn', async () => {
  const { ports, queued } = memoryPorts();
  await ports.sessions.update('old', () => ({ turn: 3, pid: 4242, injected: { 'sha256:adopted': { turn: 3, injectedAt: 1, strategyText: '1. a.', adopted: true } } }));
  await promptSubmitted(ports, { sessionId: 'old', prompt: 'update the readme intro', ...WAIT });
  await toolFinished(ports, { sessionId: 'old', note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ok' } });
  assert.deepEqual((await end(ports, 'old')).reports, []);
  await sessionStarted(ports, { sessionId: 'new', projectDir: '/proj' });
  const [report] = queued.map(({ report }) => report).filter((candidate) => candidate.asset_id === 'sha256:adopted');
  assert.deepEqual([report.task_id, report.outcome, report.evidence.aborted, report.evidence.tier], ['testagent:old:3', 'failed', true, 'none']);
});

test('reporting a running session\'s adopted injection leaves its open turn to its own end', async () => {
  const { ports, queued } = memoryPorts();
  await ports.sessions.update('running', () => ({ turn: 3, pid: 4242, injected: { 'sha256:adopted': { turn: 3, injectedAt: 1, strategyText: '1. a.', adopted: true } } }));
  await promptSubmitted(ports, { sessionId: 'running', prompt: PROMPT, ...WAIT });
  await sessionStarted(ports, { sessionId: 'other', projectDir: '/proj' });
  await toolFinished(ports, { sessionId: 'running', note: { kind: 'edit', paths: ['/proj/a.js'] } });
  await toolFinished(ports, { sessionId: 'running', note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ok' } });
  const ended = await end(ports, 'running');
  assert.deepEqual(ended.reports.map((report) => [report.asset_id, report.task_id]), [[ASSET.asset_id, 'testagent:running:4']]);
  assert.equal(queued.filter(({ report }) => report.asset_id === 'sha256:adopted').length, 1);
});

test('a session end that names an earlier turn is stale even once the later turn has ended', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, turnId: 'g1', ...WAIT });
  await end(ports, 's1', { turnId: 'g1' });
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'and now the readme', turnId: 'g2', ...WAIT });
  await end(ports, 's1', { turnId: 'g2' });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj', turnId: 'g1' });
  assert.equal((await ports.sessions.read('s1')).turnId, 'g2', 'the stale end changed nothing');
});

test('a note that raced past the open-turn check is still kept out of the next turn', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, turnId: 'g2', ...WAIT });
  await ports.notes.append('s1', { kind: 'shell', command: 'npm test', exit: 1, turnId: 'g1' });
  await toolFinished(ports, { sessionId: 's1', turnId: 'g2', note: { kind: 'shell', command: 'npm run lint', exit: 0 } });
  const { record } = await end(ports, 's1', { turnId: 'g2' });
  assert.deepEqual(record.checks, [{ command: 'npm run lint', failed: false }]);
});

test('a session end naming a turn id the session never opened (an intercepted command) still ends it', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, turnId: 'g1', ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/a.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ok' } });
  await end(ports, 's1', { turnId: 'g1' });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj', turnId: 'g2' });
  assert.equal((await ports.candidates.read()).s1.closed, true);
});

test('a turn judged again keeps its candidate\'s stamp and claim; an agent\'s repeated report changes nothing', async () => {
  const { ports } = memoryPorts();
  const record = (failed) => () => ({ checks: [{ command: 'npm test', failed }], commands: ['npm test'], paths: ['/proj/a.js'], edits: ['/proj/a.js'], answer: 'Fixed.' });
  await promptSubmitted(ports, { sessionId: 'host', prompt: PROMPT, turnId: 't1', ...WAIT });
  await end(ports, 'host', { turnId: 't1', recordOf: record(false) });
  await ports.candidates.update((pending) => ({ ...pending, host: { ...pending.host, claimedBy: 99 } }));
  const { at } = (await ports.candidates.read()).host;
  await ports.clock.sleep(5);
  await end(ports, 'host', { turnId: 't1', recordOf: record(false) });
  assert.deepEqual([(await ports.candidates.read()).host.at, (await ports.candidates.read()).host.claimedBy], [at, 99]);

  await promptSubmitted(ports, { sessionId: 'agent', prompt: PROMPT, turnId: 'r1', ...WAIT });
  await end(ports, 'agent', { turnId: 'r1', recordOf: record(false), source: AGENT_REPORTED });
  const first = (await ports.candidates.read()).agent;
  assert.equal(await end(ports, 'agent', { turnId: 'r1', recordOf: record(true), source: AGENT_REPORTED }), null);
  assert.deepEqual((await ports.candidates.read()).agent, first);
});

test('a correction that slips in while a re-judge reads its record still drops the candidate', async () => {
  const { ports } = memoryPorts();
  const verified = { checks: [{ command: 'npm test', failed: false }], commands: ['npm test'], paths: ['/proj/a.js'], edits: ['/proj/a.js'], answer: 'Fixed.' };
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, turnId: 't1', ...WAIT });
  await end(ports, 's1', { turnId: 't1', recordOf: () => verified });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const rejudged = end(ports, 's1', { turnId: 't1', recordOf: async () => { await held; return verified; } });
  await new Promise((resolve) => setImmediate(resolve));
  await promptSubmitted(ports, { sessionId: 's1', prompt: '还是报错', turnId: 't2', ...WAIT });
  release();
  await rejudged;
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a turn nobody typed carries on the task of the last one, so its candidate still says what it was for', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: '', ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/a.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ok' } });
  await end(ports, 's1');
  assert.deepEqual([(await ports.candidates.read()).s1.turn, (await ports.candidates.read()).s1.prompt], [2, PROMPT]);
});

test('a strategy shown before any step carried it is offered by no later recall of the session, and not reported', async () => {
  const { ports, queued } = memoryPorts();
  const { late } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, waitMs: 0, keepLate: true });
  const landed = await late;
  assert.equal(await landed.show(), true);
  await end(ports, 's1');
  assert.deepEqual(queued, []);
  const again = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, waitMs: 0, keepLate: true });
  assert.equal(await again.late, null);
  await end(ports, 's1');
  assert.equal(await landed.show(), false, 'its turn is over');
});

test('a prompt that cleans down to nothing (a bare link) is its own task, not the last turn\'s', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'https://example.com/issue/42', ...WAIT });
  assert.equal(sessionOfStored(await ports.sessions.read('s1')).prompt, '');
});
