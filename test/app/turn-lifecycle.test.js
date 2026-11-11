import assert from 'node:assert/strict';
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { TASKS } from '../../lib/app/ports.js';
import { MIN_WAKE_DELAY_MS } from '../../lib/app/distill-session.js';
import { lastTurnOf, promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { sessionStarted } from '../../lib/app/session-start.js';
import { beforeEdit, toolFinished } from '../../lib/app/tool-result.js';
import { closeUnfinishedTurn, turnEnded } from '../../lib/app/turn-end.js';
import { AGENT_REPORTED } from '../../lib/app/turn-reports.js';
import { EPISODE_QUIET_MS } from '../../lib/distill/range.js';
import { sessionOf as sessionOfStored } from '../../lib/session/state.js';
import { contentHashOf, fileStoresOf } from '../../lib/runtime/store/file-stores.js';
import { ASSET, PROMPT, memoryPorts } from './memory-ports.js';
import { fixTurn } from './work-turns.js';

const WAIT = { waitMs: 5_000 };
const nativePassingCheck = JSON.parse(readFileSync(new URL('../fixtures/node-spec-passing-errors.json', import.meta.url), 'utf8'));

async function verifiedTurn(ports, sessionId, { prompt = PROMPT, exit = 0 } = {}) {
  const opened = await promptSubmitted(ports, { sessionId, prompt, ...WAIT });
  await toolFinished(ports, { sessionId, note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId, note: { kind: 'shell', command: 'npm test', exit, output: exit ? '1 test failed' : 'ℹ pass 3\nℹ fail 0' } });
  return opened;
}

const end = (ports, sessionId, extra = {}) => turnEnded(ports, { sessionId, reason: 'answer', answer: 'Fixed.', projectDir: '/proj', ...extra });

test('a report reaches the Hub, and the next batch runs, while the local ledger is still loading', async () => {
  const { ports, requests } = memoryPorts();
  let finishLoading = null;
  let recorded = 0;
  ports.ledger = { load: () => new Promise((resolve) => { finishLoading = resolve; }), record: async () => { recorded += 1; return true; } };
  let outbox = { only: { report: { task_id: 'claude-code:s1:1', asset_id: ASSET.asset_id, outcome: 'success', evidence: { tier: 'L1' } }, sessionId: 's1', queuedAt: 0, attempts: 0 } };
  ports.outbox = {
    some: async (isDue) => Object.values(outbox).some(isDue),
    drain: async (deliver) => { outbox = await deliver(outbox, () => {}); return true; },
  };
  let aside = Promise.resolve();
  ports.scheduler = { ...ports.scheduler, alongside: (work) => { aside = aside.then(work); } };
  assert.equal(await runBackgroundTasks(ports, [TASKS.DRAIN]), true);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/reuse-result']);
  while (!finishLoading) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recorded, 0);
  finishLoading();
  await aside;
  assert.equal(recorded, 1);
});

test('a recalled strategy ends with the spec line, and its turn end reports it with the turn\'s check', async () => {
  const { ports, queued, scheduled } = memoryPorts();
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { ...nativePassingCheck, exit: 1, output: 'ℹ pass 1\nℹ fail 4' } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: nativePassingCheck });
  assert.match(injection, /^\[Evolution Memory\] Fix flaky Redis connection retries/);
  assert.ok(injection.endsWith('Apply them where they fit.'));
  const ended = await end(ports, 's1');
  assert.equal(ended.reports.length, 1);
  assert.equal(ended.reports[0].task_id, 'testagent:s1:1');
  assert.equal(ended.reports[0].outcome, 'success');
  assert.deepEqual(ended.reports[0].evidence, { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, source: 'observed', aborted: false, stage: 'immediate' });
  assert.deepEqual(ended.record.checks.at(-1), { command: nativePassingCheck.command, exit: 0, failed: false });
  const range = (await ports.candidates.read()).s1;
  assert.deepEqual(range.turns[0].steps.at(-1), { kind: 'check', command: nativePassingCheck.command, exit: 0, failed: false });
  assert.equal(ended.isDistillable, true, 'the observed failure, edit and pass leave no failed-check gate');
  assert.deepEqual(queued.map(({ report }) => report.task_id), ['testagent:s1:1']);
  assert.ok(scheduled.includes('drain'));
});

test('a slow host record cannot take the next turn\'s notes when the host names no turn ids', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 1, output: '# fail 1' } });
  let entered, finishRead;
  const reading = new Promise(resolve => { entered = resolve; });
  const observed = new Promise(resolve => { finishRead = resolve; });
  const closing = end(ports, 's1', { recordOf: () => { entered(); return observed; } });
  await reading;
  // The driver waits for settling, but a slow old hook must not hold the person's next prompt forever.
  await closeUnfinishedTurn(ports, { sessionId: 's1' });
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'verify the repaired retry policy', ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 0, output: '# pass 1\n# fail 0' } });
  finishRead(null);
  const previous = await closing;
  assert.equal(previous.record.checks[0]?.failed, true);
  assert.equal(previous.reports[0].outcome, 'failed');
  const next = await end(ports, 's1');
  assert.equal(next.record.checks[0]?.failed, false);
});

test('a slow host record cannot take the next turn\'s edit baseline when the host names no turn ids', async () => {
  const { ports, retained } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await beforeEdit(ports, { sessionId: 's1', file: '/proj/old.js' });
  let entered, finishRead;
  const reading = new Promise(resolve => { entered = resolve; });
  const observed = new Promise(resolve => { finishRead = resolve; });
  const closing = end(ports, 's1', { recordOf: () => { entered(); return observed; } });
  await reading;
  await closeUnfinishedTurn(ports, { sessionId: 's1' });
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'repair the next file', ...WAIT });
  await beforeEdit(ports, { sessionId: 's1', file: '/proj/new.js' });
  finishRead(null);
  await closing;
  assert.deepEqual([...retained[0].editedBefore.keys()], ['/proj/old.js']);
  await end(ports, 's1');
  assert.deepEqual([...retained[1].editedBefore.keys()], ['/proj/new.js']);
});

test('a delayed close keeps its observed record without taking the next turn\'s evidence', async () => {
  const { ports, retained } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  let entered, finishClose;
  const closingStore = new Promise(resolve => { entered = resolve; });
  const stored = new Promise(resolve => { finishClose = resolve; });
  const update = ports.sessions.update;
  let held = false;
  ports.sessions.update = async (...args) => {
    const result = await update(...args);
    if (!held && result?.settling) { held = true; entered(); await stored; }
    return result;
  };
  const original = { edits: [], commands: ['npm test'], checks: [{ command: 'npm test', exit: 1, failed: true }] };
  const closing = end(ports, 's1', { recordOf: () => original });
  await closingStore;
  await closeUnfinishedTurn(ports, { sessionId: 's1' });
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'verify the next file', ...WAIT });
  await beforeEdit(ports, { sessionId: 's1', file: '/proj/current.js' });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 0, output: '# pass 1\n# fail 0' } });
  finishClose();
  assert.equal((await closing).record.checks[0].failed, true);
  assert.deepEqual([...retained[0].editedBefore.keys()], []);
  assert.equal((await end(ports, 's1')).record.checks[0]?.failed, false);
  assert.deepEqual([...retained[1].editedBefore.keys()], ['/proj/current.js']);
});

test('captured evidence of a replaced epoch stays recoverable only by its origin', async (t) => {
  for (const failedRead of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'evolver-replaced-evidence-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { ports, advance } = memoryPorts();
    const stores = fileStoresOf({ dir, agent: 'testagent' });
    ports.notes = stores.notes;
    ports.baseline = stores.baseline;
    await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
    await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 1 } });
    await beforeEdit(ports, { sessionId: 's1', file: '/proj/old.js' });
    const origin = await ports.sessions.read('s1');
    const closing = end(ports, 's1', { recordOf: async () => {
      advance(1);
      await ports.sessions.update('s1', () => ({ turn: 0 }));
      await promptSubmitted(ports, { sessionId: 's1', prompt: 'a different session', ...WAIT });
      if (failedRead) throw new Error('host record unavailable');
      return null;
    } });
    if (failedRead) await assert.rejects(closing, /host record unavailable/);
    else assert.equal(await closing, null);
    // Let durable claims reach their recovery age without making the test wait a minute.
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), new Date(0), new Date(0));
    const current = await ports.sessions.read('s1');
    const notes = await ports.notes.take('s1', current);
    const baseline = await ports.baseline.take('s1', null, current);
    assert.deepEqual(notes.notes, []);
    assert.equal(baseline.before.size, 0);
    await notes.commit(); await baseline.commit();
    const previousNotes = await ports.notes.take('s1', origin);
    const previousBaseline = await ports.baseline.take('s1', null, origin);
    assert.deepEqual(previousNotes.notes.map(note => note.command), ['npm test']);
    assert.deepEqual([...previousBaseline.before.keys()], ['/proj/old.js']);
    await previousNotes.commit(); await previousBaseline.commit();
  }
});

test('a failed host record cannot resurrect its notes and edit baseline into the next turn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-failed-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ports, retained } = memoryPorts();
  const stores = fileStoresOf({ dir, agent: 'testagent' });
  ports.notes = stores.notes;
  ports.baseline = stores.baseline;
  const oldFile = join(dir, 'old.js');
  const currentFile = join(dir, 'current.js');
  writeFileSync(oldFile, 'before');
  const originalHash = contentHashOf(oldFile);
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'node --test old.test.js', exit: 1 } });
  await beforeEdit(ports, { sessionId: 's1', file: oldFile });
  writeFileSync(oldFile, 'after');
  const origin = await ports.sessions.read('s1');
  await assert.rejects(end(ports, 's1', { recordOf: async () => { throw new Error('host record unavailable'); } }), /host record unavailable/);
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'verify the next file', ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'node --test current.test.js', exit: 0 } });
  await beforeEdit(ports, { sessionId: 's1', file: currentFile });
  for (const name of readdirSync(dir)) if (name.endsWith('.taking')) utimesSync(join(dir, name), new Date(0), new Date(0));
  const next = await end(ports, 's1');
  assert.deepEqual(next.record.commands, ['node --test current.test.js']);
  assert.deepEqual([...retained[0].editedBefore.keys()], [currentFile]);
  const previousNotes = await ports.notes.take('s1', origin);
  const previousBaseline = await ports.baseline.take('s1', null, origin);
  assert.deepEqual(previousNotes.notes.map(note => note.command), ['node --test old.test.js']);
  assert.equal(previousBaseline.before.get(oldFile), originalHash);
  assert.notEqual(originalHash, contentHashOf(oldFile));
  await previousNotes.commit(); await previousBaseline.commit();
});

test('printing a check command does not verify a turn or raise its reuse evidence', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: {
    kind: 'shell', command: 'echo "npm test"', exit: 0, output: 'npm test', label: 'Run tests',
  } });
  const { record, reports } = await end(ports, 's1');
  assert.deepEqual(record.checks, []);
  assert.equal(reports[0].evidence.tier, 'none');
  assert.equal(reports[0].evidence.check, undefined);
});

test('a successful shell wrapper does not verify a turn when its check may have been skipped', async () => {
  const { ports } = memoryPorts();
  const command = 'true || npm test';
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command, exit: 0 } });
  const { record, reports } = await end(ports, 's1');
  assert.deepEqual(record.checks, [{ command, exit: null, failed: null }]);
  assert.equal(reports[0].evidence.tier, 'none');
  assert.equal(reports[0].evidence.check, undefined);
});

test('a redirect target named like a check does not verify a turn', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'echo >&npm test', exit: 0 } });
  const { record, reports } = await end(ports, 's1');
  assert.deepEqual(record.checks, []);
  assert.equal(reports[0].evidence.tier, 'none');
});

test('a work turn joins the session\'s range; a correction stays with it as its last word and revises the reports', async () => {
  const { ports, queued } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1', { model: 'model-x' });
  await promptSubmitted(ports, { sessionId: 's1', prompt: '还是报错', ...WAIT });
  assert.deepEqual((await ports.candidates.read()).s1.turns.map(({ turn, correction }) => [turn, correction]), [[1, '还是报错']]);
  const correction = queued.find(({ report }) => report.task_id.endsWith(':correction')).report;
  assert.equal(correction.outcome, 'failed');
});

test('a question is no correction', async () => {
  const { ports } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: '这样不对吧？', ...WAIT });
  assert.equal((await ports.candidates.read()).s1.turns[0].correction, undefined);
});

test('a turn that only reads or answers joins no range; one that ran a check does, whether it passed or not', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'explain the retry policy', ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'cat lib/redis.js', exit: 0 } });
  await end(ports, 's1');
  assert.equal((await ports.candidates.read()).s1, undefined);
  await verifiedTurn(ports, 's1', { exit: 1 });
  await end(ports, 's1', { reason: 'aborted' });
  assert.deepEqual((await ports.candidates.read()).s1.turns.map(({ turn }) => turn), [2]);
});

test('a fixed error in a session left open is distilled with no further event: woken once it is quiet, again for a failed try\'s retry', async () => {
  const { ports, wakeUps, advance } = memoryPorts({ model: { complete: async () => { throw new Error('model offline'); } } });
  await fixTurn(ports, 's1');
  const { activeAt } = (await ports.candidates.read()).s1;
  assert.deepEqual(wakeUps, [{ at: activeAt + EPISODE_QUIET_MS, tasks: ['distill'] }]);
  advance(activeAt + EPISODE_QUIET_MS - ports.clock.now());
  await runBackgroundTasks(ports, wakeUps[0].tasks);
  const { retryAt, attempts } = (await ports.candidates.read()).s1;
  assert.equal(attempts, 1);
  assert.deepEqual(wakeUps.slice(1), [{ at: retryAt, tasks: ['distill'] }]);
});

test('a range that comes due while another is distilled is woken for shortly after, not left to the next event', async () => {
  let duringModel = () => {};
  const { ports, wakeUps, advance } = memoryPorts({ model: { complete: async () => { duringModel(); throw new Error('model offline'); } } });
  await fixTurn(ports, 's1');
  advance(EPISODE_QUIET_MS / 2);
  await fixTurn(ports, 's2');
  advance(EPISODE_QUIET_MS / 2);
  duringModel = () => advance(EPISODE_QUIET_MS / 2);
  await runBackgroundTasks(ports, ['distill']);
  const pending = await ports.candidates.read();
  assert.deepEqual([pending.s1.attempts, pending.s2.attempts], [1, 0]);
  assert.deepEqual(wakeUps.at(-1), { at: ports.clock.now() + MIN_WAKE_DELAY_MS, tasks: ['distill'] });
});

test('a trial Gene the Proxy withheld from a turn is reported as its control under the withholding\'s id, once the turn ran a check, even after its own end could not queue it', async () => {
  const later = [
    ['the next turn end', async (ports) => {
      await promptSubmitted(ports, { sessionId: 's1', prompt: 'and explain why the retries were flaky', ...WAIT });
      await end(ports, 's1');
    }],
    ['the session end', (ports) => sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' })],
  ];
  for (const [name, after] of later) {
    const { ports, queued } = memoryPorts({ assets: [] });
    const answered = ports.proxy.request;
    let withheld = { asset_id: 'sha256:trial', withheld_id: 'wh-1' };
    ports.proxy.request = async (method, path, body) => (path === '/asset/fetch' && !body?.asset_ids ? { ok: true, data: { assets: [], trial_withheld: withheld } } : answered(method, path, body));
    await verifiedTurn(ports, 's1');
    const enqueue = ports.reports.enqueue;
    ports.reports.enqueue = async () => { throw new Error('killed'); };
    await assert.rejects(end(ports, 's1'));
    ports.reports.enqueue = enqueue;
    await after(ports);
    withheld = { asset_id: 'sha256:trial' };
    await verifiedTurn(ports, 's1');
    await end(ports, 's1');
    assert.deepEqual(queued.filter(({ path }) => path), [
      { report: { asset_id: 'sha256:trial', withheld_id: 'wh-1', task_id: 'testagent:s1:1', passed: true, platform: 'testagent' }, sessionId: 's1', path: '/asset/trial-control' },
    ], name);
  }
});

test('a turn end clears only the pending controls it queued, never one another end left meanwhile', async () => {
  const { ports } = memoryPorts({ assets: [] });
  const other = { report: { asset_id: 'sha256:other', withheld_id: 'wh-other', task_id: 'testagent:s1:9', passed: false, platform: 'testagent' }, sessionId: 's1', path: '/asset/trial-control' };
  await verifiedTurn(ports, 's1');
  const enqueue = ports.reports.enqueue;
  ports.reports.enqueue = async (entries) => {
    await ports.sessions.update('s1', (stored) => ({ ...stored, pendingControls: [...(stored.pendingControls ?? []), other] }));
    return enqueue(entries);
  };
  await end(ports, 's1');
  assert.deepEqual((await ports.sessions.read('s1')).pendingControls, [other]);
});

test('a plugin command turn recalls nothing, keeps the last reuses for labelling and is no work turn', async () => {
  const { ports, queued } = memoryPorts();
  await verifiedTurn(ports, 's1');
  await end(ports, 's1');
  const command = await promptSubmitted(ports, { sessionId: 's1', prompt: '/evolver-evolve', isCommand: true, ...WAIT });
  assert.equal(command.injection, '');
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'thanks, works now', ...WAIT });
  assert.equal(queued.find(({ report }) => report.task_id.endsWith(':correction')).report.outcome, 'success');
});

test('an aborted turn reports its injection as failed, without trusting passing output from an unfinished check', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { ...nativePassingCheck, exit: null, running: true, callId: 'unfinished-check' } });
  const ended = await end(ports, 's1', { reason: 'aborted' });
  const [report] = ended.reports;
  assert.equal(report.outcome, 'failed');
  assert.equal(report.evidence.tier, 'none');
  assert.equal(report.evidence.aborted, true);
  assert.deepEqual(ended.record.checks, []);
  assert.equal((await ports.candidates.read()).s1, undefined);
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
  assert.deepEqual(record.checks, [{ command: 'npm test', exit: 1, failed: true }]);
  assert.deepEqual(record.commands, ['npm test']);
});

test('an agent-reported turn, under any source but the host\'s own, counts as exposure only', async () => {
  for (const source of [AGENT_REPORTED, 'agent_reported']) {
    const { ports } = memoryPorts();
    await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
    const recordOf = () => ({ checks: [{ command: 'npm test', failed: false }], commands: ['npm test'], paths: [], edits: [], answer: '' });
    const [report] = (await end(ports, 's1', { recordOf, source })).reports;
    assert.deepEqual([report.evidence.tier, report.evidence.reported_by, report.evidence.source], ['none', 'agent', 'reported'], source);
    assert.match(report.reason, /as the agent reported it\.$/);
  }
});

test('session end reports what is left as aborted, closes the range and keeps the turn counter for a resume', async () => {
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
  assert.equal(sessionOfStored(stored).settling, null, 'the next prompt does not wait for an end that failed');
});

test('a turn whose work tree cannot be read still joins the range, without its project', async () => {
  for (const project of [{ snapshot: async () => { throw new Error('git failed'); } }, undefined]) {
    const { ports } = memoryPorts();
    ports.project = project;
    await verifiedTurn(ports, 's1');
    await end(ports, 's1');
    assert.equal((await ports.candidates.read()).s1.project, null);
    assert.equal(sessionOfStored(await ports.sessions.read('s1')).settling, null);
  }
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
  assert.deepEqual(record.checks, [{ command: 'npm run lint', exit: 0, failed: false }]);
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

test('a turn judged again keeps its range\'s stamp and claim; an agent\'s repeated report changes nothing', async () => {
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

test('a turn judged again after its session ended starts the distillation its range is due for', async () => {
  const { ports, scheduled } = memoryPorts({ model: {} });
  const verified = () => ({ checks: [{ command: 'npm test', failed: false }], commands: ['npm test'], paths: ['/proj/a.js'], edits: ['/proj/a.js'], answer: 'Fixed.' });
  await promptSubmitted(ports, { sessionId: 'host', prompt: PROMPT, turnId: 't1', ...WAIT });
  await end(ports, 'host', { turnId: 't1', recordOf: verified });
  await sessionEnded(ports, { sessionId: 'host', projectDir: '/proj' });
  scheduled.length = 0;
  await end(ports, 'host', { turnId: 't1', recordOf: verified });
  assert.deepEqual(scheduled, ['distill']);
});

test('a correction that slips in while a re-judge reads its record stays with the turn', async () => {
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
  assert.equal((await ports.candidates.read()).s1.turns[0].correction, '还是报错');
});

test('a turn nobody typed carries on the task of the last one, so its work still says what it was for', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await end(ports, 's1');
  await promptSubmitted(ports, { sessionId: 's1', prompt: '', ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/a.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ok' } });
  await end(ports, 's1');
  assert.deepEqual((await ports.candidates.read()).s1.turns.map(({ turn, prompt }) => [turn, prompt]), [[2, PROMPT]]);
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

test('a host\'s own turn number keeps the count at least there, so a session resumed without its state repeats no task id', async () => {
  const { ports } = memoryPorts();
  const resumed = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, hostTurn: 4, ...WAIT });
  assert.equal(resumed.turn, 4);
  assert.equal((await promptSubmitted(ports, { sessionId: 's1', prompt: 'and the readme', hostTurn: 2, ...WAIT })).turn, 5, 'never back');
});

const NATIVE_ROUTE = { configDigest: 'digest-a', selection: { providerId: 'account-a', modelId: 'model-a' } };
const NATIVE_PASS = { edits: [], commands: ['npm test'], checks: [{ command: 'npm test', exit: 0, failed: false }], answer: 'Fixed.' };

test('a closing native turn cannot report injections or controls from a replacement session epoch', async () => {
  const { ports, queued, advance } = memoryPorts();
  ports.confirmTurnCompletion = true;
  ports.modelForTurn = () => NATIVE_ROUTE;
  await promptSubmitted(ports, { sessionId: 's1', turnId: 'old', prompt: PROMPT, ...WAIT });
  const old = await ports.sessions.read('s1');
  const ended = await end(ports, 's1', { turnId: 'old', recordOf: async () => {
    advance(1);
    await ports.sessions.update('s1', () => ({ turn: 0 }));
    await promptSubmitted(ports, { sessionId: 's1', turnId: 'new', prompt: PROMPT, ...WAIT });
    await ports.sessions.update('s1', (current) => ({
      ...current, pendingControls: [{ sessionId: 's1', report: { withheld_id: 'new-control' } }],
    }));
    return NATIVE_PASS;
  } });
  const current = await ports.sessions.read('s1');
  assert.notEqual(current.sessionEpoch, old.sessionEpoch);
  assert.equal(current.turn, old.turn);
  assert.equal(current.open, true);
  assert.deepEqual(queued, []);
  assert.deepEqual(ended?.reports ?? [], []);
  assert.equal(current.injected[ASSET.asset_id].reportedAt, undefined);
  assert.equal(current.pendingControls.length, 1);
  assert.deepEqual(await ports.candidates.read(), {});
});

test('a delayed native project snapshot cannot replace a newer epoch range', async () => {
  const { ports, advance } = memoryPorts();
  ports.confirmTurnCompletion = true;
  ports.modelForTurn = () => NATIVE_ROUTE;
  ports.settings = { recall: false };
  await promptSubmitted(ports, { sessionId: 's1', turnId: 'old', prompt: 'Old project' });
  const old = await ports.sessions.read('s1');
  const newRoute = { configDigest: 'digest-b', selection: { providerId: 'account-b', modelId: 'model-b' } };
  ports.project.snapshot = async () => {
    advance(1);
    await ports.sessions.update('s1', () => ({ turn: 0 }));
    await promptSubmitted(ports, { sessionId: 's1', turnId: 'new', prompt: 'New project' });
    await end(ports, 's1', { turnId: 'new', model: newRoute, projectDir: null, recordOf: () => NATIVE_PASS });
    return { root: '/old', head: 'old-head' };
  };
  await end(ports, 's1', { turnId: 'old', recordOf: () => NATIVE_PASS });
  const range = (await ports.candidates.read()).s1;
  assert.notEqual(range.sessionEpoch, old.sessionEpoch);
  assert.deepEqual(range.model, newRoute);
  assert.deepEqual(range.turns.map(({ prompt }) => prompt), ['New project']);
});

test('an unverified native turn stays unreported and its injections do not borrow a later pass', async () => {
  const second = { ...ASSET, asset_id: 'sha256:' + 'b'.repeat(64), signals_match: ['next-fixture'] };
  const { ports, queued } = memoryPorts({ assets: [ASSET, second] });
  ports.confirmTurnCompletion = true;
  await promptSubmitted(ports, { sessionId: 's1', turnId: 't1', prompt: PROMPT, ...WAIT });
  await end(ports, 's1', { turnId: 't1', reason: 'aborted', recordOf: () => NATIVE_PASS });
  assert.deepEqual(queued, []);
  assert.equal((await ports.sessions.read('s1')).injected[ASSET.asset_id].reportedAt, undefined);
  const next = await promptSubmitted(ports, { sessionId: 's1', turnId: 't2', prompt: 'fix the next-fixture retry policy', ...WAIT });
  assert.ok(next.injection);
  await end(ports, 's1', { turnId: 't2', recordOf: () => NATIVE_PASS });
  assert.deepEqual(queued.map(({ report }) => report.asset_id), [second.asset_id]);
  assert.equal((await ports.sessions.read('s1')).injected[ASSET.asset_id].reportedAt, undefined);
});

test('the current native epoch replaces an older range with its own snapshot base', async () => {
  const { ports, advance, snapshotBases } = memoryPorts({ heads: ['old-head', 'new-head'] });
  ports.confirmTurnCompletion = true;
  ports.modelForTurn = () => NATIVE_ROUTE;
  ports.settings = { recall: false };
  await promptSubmitted(ports, { sessionId: 's1', turnId: 'old', prompt: 'Old project', projectDir: '/proj' });
  await end(ports, 's1', { turnId: 'old', recordOf: () => NATIVE_PASS });

  advance(1);
  await ports.sessions.update('s1', () => ({ turn: 0 }));
  await promptSubmitted(ports, { sessionId: 's1', turnId: 'new', prompt: 'New project', projectDir: '/proj' });
  await end(ports, 's1', { turnId: 'new', recordOf: () => NATIVE_PASS });

  const range = (await ports.candidates.read()).s1;
  assert.deepEqual(snapshotBases, ['old-head', 'new-head']);
  assert.deepEqual(range.base, { root: '/proj', head: 'new-head' });
  assert.deepEqual(range.turns.map(({ prompt }) => prompt), ['New project']);
});

for (const read of ['terminal record', 'saved tool notes', 'edit baseline']) {
  test(`redelivering a confirmed native turn recovers from a transient ${read} read failure`, async (t) => {
    const { ports, queued, retained } = memoryPorts();
    const dir = mkdtempSync(join(tmpdir(), 'evolver-native-read-retry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { sessions, candidates, notes, baseline } = fileStoresOf({ dir, agent: 'testagent' });
    Object.assign(ports, { sessions, candidates, notes, baseline, confirmTurnCompletion: true, modelForTurn: () => NATIVE_ROUTE });
    const sessionId = 's1', turnId = 't1';
    await promptSubmitted(ports, { sessionId, turnId, prompt: PROMPT, ...WAIT });
    const expectedTurn = await sessions.read(sessionId);
    let reads = 0;
    const recordOf = read === 'terminal record' ? () => {
      if (++reads === 1) throw new Error('temporary read failure');
      return NATIVE_PASS;
    } : null;
    let editedFile;
    if (!recordOf) {
      editedFile = join(dir, 'fixture.js');
      await baseline.remember(sessionId, editedFile, turnId, expectedTurn);
      const call = { kind: 'shell', command: 'npm test', callId: 'check' };
      await toolFinished(ports, { sessionId, turnId, note: { ...call, running: true } });
      await toolFinished(ports, { sessionId, turnId, note: { ...call, exit: 0 } });
      await toolFinished(ports, { sessionId, turnId, note: { kind: 'answer', text: NATIVE_PASS.answer } });
      const readFile = fs.readFileSync;
      const stem = read === 'saved tool notes' ? 'testagent-turn-' : 'testagent-edits-';
      t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (typeof file === 'string' && file.startsWith(dir) && file.includes(stem) && file.endsWith('.taking') && ++reads === 1) {
          throw Object.assign(new Error('temporary read failure'), { code: 'EACCES' });
        }
        return readFile(file, ...args);
      });
    }
    const deliver = () => turnEnded(ports, { sessionId, turnId, reason: 'answer', expectedTurn, recordOf });
    await assert.rejects(deliver, /temporary read failure/);
    assert.equal((await sessions.read(sessionId)).open, true);
    assert.deepEqual(queued, []);
    assert.deepEqual(await candidates.read(), {});

    const result = await deliver();
    assert.deepEqual(result?.record.checks, NATIVE_PASS.checks);
    assert.equal(await deliver(), null);
    assert.deepEqual(queued.map(({ report }) => [report.task_id, report.outcome]), [['testagent:s1:1', 'success']]);
    const range = (await candidates.read())[sessionId];
    assert.deepEqual(range?.model, NATIVE_ROUTE);
    assert.deepEqual(range?.turns.map(({ turn }) => turn), [1]);
    assert.equal(retained.length, 1);
    if (editedFile) assert.equal(retained[0].editedBefore.has(editedFile), true);
  });
}

test('a native evidence read failure cannot reopen a turn after a newer prompt', async () => {
  const { ports, queued } = memoryPorts();
  ports.confirmTurnCompletion = true;
  await promptSubmitted(ports, { sessionId: 's1', turnId: 'old', prompt: PROMPT, ...WAIT });
  const expectedTurn = await ports.sessions.read('s1');
  await assert.rejects(end(ports, 's1', { turnId: 'old', expectedTurn, recordOf: async () => {
    await promptSubmitted(ports, { sessionId: 's1', turnId: 'new', prompt: 'A new task', ...WAIT });
    throw new Error('temporary read failure');
  } }), /temporary read failure/);

  assert.equal(await end(ports, 's1', { turnId: 'old', expectedTurn, recordOf: () => NATIVE_PASS }), null);
  const current = await ports.sessions.read('s1');
  assert.equal(current.turnId, 'new');
  assert.equal(current.open, true);
  assert.deepEqual(queued, []);
  assert.deepEqual(await ports.candidates.read(), {});
});

test('a verified native report retries with its original evidence and keeps its work after a local queue failure', async (t) => {
  const second = { ...ASSET, asset_id: 'sha256:' + 'b'.repeat(64), signals_match: ['next-fixture'] };
  const { ports, queued, retained } = memoryPorts({ assets: [ASSET, second] });
  const dir = mkdtempSync(join(tmpdir(), 'evolver-native-queue-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { sessions, candidates, notes, baseline } = fileStoresOf({ dir, agent: 'testagent' });
  Object.assign(ports, { sessions, candidates, notes, baseline, modelForTurn: () => NATIVE_ROUTE });
  ports.confirmTurnCompletion = true;
  await promptSubmitted(ports, { sessionId: 's1', turnId: 't1', prompt: PROMPT, ...WAIT });
  const enqueue = ports.reports.enqueue;
  ports.reports.enqueue = async () => { throw new Error('local queue unavailable'); };
  await assert.rejects(end(ports, 's1', { turnId: 't1', recordOf: () => NATIVE_PASS }), /local queue unavailable/);
  ports.reports.enqueue = enqueue;
  const range = (await ports.candidates.read()).s1;
  assert.deepEqual(range?.turns.map(({ turn }) => turn), [1]);
  assert.deepEqual(range.model, NATIVE_ROUTE);
  assert.equal((await sessions.read('s1')).open, false);
  assert.equal(retained.length, 1);

  await promptSubmitted(ports, { sessionId: 's1', turnId: 't2', prompt: 'fix the next-fixture retry policy', ...WAIT });
  await end(ports, 's1', { turnId: 't2', reason: 'aborted', recordOf: () => NATIVE_PASS });
  assert.deepEqual(queued.map(({ report }) => [report.task_id, report.asset_id, report.outcome, report.evidence.check.passed]), [
    ['testagent:s1:1', ASSET.asset_id, 'success', true],
  ]);
  const injected = (await ports.sessions.read('s1')).injected[ASSET.asset_id];
  assert.ok(injected.reportedAt);
  assert.equal(injected.pendingReport, undefined);
  await sessionEnded(ports, { sessionId: 's1' });
  assert.equal(queued.length, 1);
});

test('native fallback close uses the provided turn record after terminal confirmation', async () => {
  const { ports, queued } = memoryPorts();
  ports.confirmTurnCompletion = true;
  ports.turnStatus = () => ({ status: 'completed' });
  await promptSubmitted(ports, { sessionId: 's1', turnId: 't1', prompt: PROMPT, ...WAIT });
  await closeUnfinishedTurn(ports, { sessionId: 's1', recordOf: () => NATIVE_PASS });
  assert.equal((await ports.sessions.read('s1')).open, false);
  assert.deepEqual(queued.map(({ report }) => report.outcome), ['success']);
});

test('native fallback close without a status reader never invents a completion', async () => {
  const { ports, queued } = memoryPorts();
  ports.confirmTurnCompletion = true;
  await promptSubmitted(ports, { sessionId: 's1', turnId: 't1', prompt: PROMPT, ...WAIT });
  await closeUnfinishedTurn(ports, { sessionId: 's1', recordOf: () => NATIVE_PASS });
  assert.equal((await ports.sessions.read('s1')).open, false);
  assert.deepEqual(queued, []);
  assert.deepEqual(await ports.candidates.read(), {});
});
