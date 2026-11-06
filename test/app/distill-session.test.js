import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { runCommand } from '../../lib/app/commands/index.js';
import { MIN_WAKE_DELAY_MS, armDistillWakeUp, distillDue, distillSession, postAgentGene } from '../../lib/app/distill-session.js';
import { adoptStrategy, promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { TASKS } from '../../lib/app/ports.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { EPISODE_QUIET_MS, IDLE_DISTILL_MS, RETRY_BASE_MS, UNDISTILLED_LEFTOVER_TTL_MS, nextDueAt } from '../../lib/distill/range.js';
import { memoryPorts } from './memory-ports.js';
import { DRAFTED, IR, changeTurn, fixTurn, modelAnswering, turnOf } from './work-turns.js';

const PROJECT = {
  root: '/proj',
  head: 'f'.repeat(40),
  diff: 'diff --git a/lib/redis.js b/lib/redis.js\n--- a/lib/redis.js\n+++ b/lib/redis.js\n@@ -1 +1 @@\n-export const options = {};\n+export const options = { maxRetriesPerRequest: null };\n',
};
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));
const distills = (requests) => requests.filter((request) => request.path === '/conversation/distill');

async function fixedSession(options = {}) {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, ...options });
  await fixTurn(made.ports, 's1');
  return made;
}

async function threeTurnSession(options = {}) {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, ...options });
  for (const index of [1, 2, 3]) await changeTurn(made.ports, 's1', index);
  return made;
}

async function endedAndDistilled(made) {
  await sessionEnded(made.ports, { sessionId: 's1', projectDir: '/proj' });
  return distillDue(made.ports);
}

test('a session-end distillation posts each IR in the contract\'s shape, keeps the Proxy\'s draft and the record for calibration', async () => {
  const made = await fixedSession({ model: modelAnswering(IR) });
  const [outcome] = await endedAndDistilled(made);
  assert.equal(outcome.status, 'drafted');
  assert.equal((await made.ports.candidates.read()).s1, undefined);
  assert.equal((await made.ports.drafts.read())[0].title, IR.title);
  const [{ body }] = distills(made.requests);
  assert.deepEqual(Object.keys(body), ['platform', 'session_id', 'trigger', 'ir_version', 'ir', 'record', 'user_prompt', 'final_answer', 'execution', 'project', 'project_dir', 'persist', 'publish', 'distill_usage']);
  assert.deepEqual([body.platform, body.session_id, body.trigger, body.ir_version, body.persist, body.publish, body.project_dir], ['testagent', 'testagent:s1', 'session_end', 'session-gene-ir-v1', true, false, '/proj']);
  assert.deepEqual(body.ir, IR);
  assert.deepEqual(body.record.slice(0, 9), [
    { kind: 'turn', text: 'Turn 1' },
    { kind: 'prompt', text: 'fix the flaky redis retries' },
    { kind: 'check', text: 'npm test', exit: 1 },
    { kind: 'output', text: 'ℹ tests 3' }, { kind: 'output', text: 'ℹ pass 2' }, { kind: 'output', text: 'ℹ fail 1' },
    { kind: 'output', text: 'MaxRetriesPerRequestError: Reached the max retries per request limit' },
    { kind: 'edit', text: 'lib/redis.js' },
    { kind: 'check', text: 'npm test 2>&1 | tail -5' },
  ]);
  assert.deepEqual(body.record.slice(9).map(({ kind }) => kind), ['answer', 'diff', 'diff', 'diff', 'diff', 'diff', 'diff']);
  assert.deepEqual(body.execution.trace, [{ command: 'npm test', exit: 1, source: 'observed' }, { command: 'npm test 2>&1 | tail -5', ok: true, source: 'observed' }]);
  assert.deepEqual([body.user_prompt, body.final_answer, body.project, body.distill_usage], ['fix the flaky redis retries', 'Fixed the retries.', PROJECT, { inputTokens: 10, outputTokens: 5 }]);
  const [kept] = await made.ports.corpus.read();
  assert.deepEqual([kept.gate.passed, kept.kind, kept.record], [true, 'fix', body.record]);
});

test('the record holds every work turn in order: a failed check\'s redacted output tail, the correction, and a diff cut to fit a prompt', async () => {
  const output = [...Array.from({ length: 30 }, (_, index) => `line ${index}`), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'].join('\n');
  const files = Array.from({ length: 40 }, (_, index) => `diff --git a/src/f${index}.js b/src/f${index}.js\n--- a/src/f${index}.js\n+++ b/src/f${index}.js\n@@ -0,0 +1,40 @@\n${'+export const value = 1;\n'.repeat(40)}`);
  const made = memoryPorts({ model: modelAnswering(IR), distillAnswer: DRAFTED, project: { ...PROJECT, diff: files.join('') } });
  await turnOf(made.ports, 's1', { steps: [['note', { kind: 'shell', command: 'npm test', exit: 1, output }]] });
  await turnOf(made.ports, 's1', { prompt: '还是报错', steps: [['edit', '/proj/lib/redis.js'], ['pass', 'npm test']] });
  await endedAndDistilled(made);
  const [{ body }] = distills(made.requests);
  const outputs = body.record.filter(({ kind }) => kind === 'output').map(({ text }) => text);
  assert.deepEqual([outputs.length, outputs[0], outputs.at(-1)], [20, 'line 11', 'Authorization: [redacted]']);
  assert.doesNotMatch(JSON.stringify(body), /abcdefghijklmnop/);
  assert.deepEqual(body.record[body.record.findIndex(({ text }) => text === 'Turn 2') - 1], { kind: 'correction', text: '还是报错' });
  const diffLines = body.record.filter(({ kind }) => kind === 'diff');
  assert.match(diffLines[0].text, /^Diff too long to show whole: 40 files, \+1600 -0\.$/);
  assert.ok(Buffer.byteLength(diffLines.map(({ text }) => text).join('\n')) <= 24 * 1024);
  assert.equal(body.project.diff, files.join(''));
  assert.ok(bytesOf(body) <= 256 * 1024);
});

test('the range\'s diff is taken from the commit its first work turn began on, so a commit made since stays in it', async () => {
  const made = memoryPorts({ heads: ['a'.repeat(40), 'b'.repeat(40)] });
  await changeTurn(made.ports, 's1', 1);
  await changeTurn(made.ports, 's1', 2);
  assert.deepEqual(made.snapshotBases, ['a'.repeat(40), 'a'.repeat(40)]);
});

test('a diff that would push the request past the Proxy\'s 256 KiB body limit is left out as too large', async () => {
  const made = await fixedSession({ model: modelAnswering(IR), project: { ...PROJECT, diff: 'x'.repeat(256 * 1024 - 100) } });
  await endedAndDistilled(made);
  assert.deepEqual(distills(made.requests)[0].body.project, { diff_omitted: 'too_large' });
});

test('the gate decides without a model call whether a session\'s work is distilled, and distilled turns never are again', async () => {
  const rows = [
    ['two work turns', async (ports) => { await changeTurn(ports, 's1', 1); await changeTurn(ports, 's1', 2); }, ['below_threshold'], 0],
    ['three work turns', async (ports) => { for (const index of [1, 2, 3]) await changeTurn(ports, 's1', index); }, ['drafted'], 1],
    ['one fixed error', (ports) => fixTurn(ports, 's1'), ['drafted'], 1],
    ['one fixed error, checked again over the whole file through tail', (ports) => turnOf(ports, 's1', { steps: [
      ['note', { kind: 'shell', command: 'python -m pytest testing/test_rewrite.py::TestIssue::test_number', exit: 1, output: 'E   TypeError: int\n1 failed in 0.21s' }],
      ['edit', '/proj/src/rewrite.py'],
      ['note', { kind: 'shell', command: 'python -m pytest testing/test_rewrite.py -q 2>&1 | tail -3', exit: 0, output: '115 passed, 1 skipped in 1.99s' }],
    ] }), ['drafted'], 1],
    ['an error left unfixed', (ports) => turnOf(ports, 's1', { steps: [['fail', 'npm test'], ['edit', '/proj/a.js'], ['fail', 'npm test']] }), ['below_threshold'], 0],
    ['only reading and answering', (ports) => turnOf(ports, 's1', { prompt: 'explain the retry policy', steps: [['run', 'cat lib/redis.js']] }), [], 0],
  ];
  for (const [name, work, statuses, modelCalls] of rows) {
    let calls = 0;
    const made = memoryPorts({ distillAnswer: DRAFTED, model: modelAnswering(IR, () => { calls += 1; }) });
    await work(made.ports);
    assert.deepEqual((await endedAndDistilled(made)).map(({ status }) => status), statuses, name);
    assert.equal(calls, modelCalls, name);
  }
  const made = await threeTurnSession({ model: modelAnswering(IR) });
  made.advance(IDLE_DISTILL_MS);
  assert.deepEqual((await distillDue(made.ports)).map(({ status }) => status), ['drafted']);
  await changeTurn(made.ports, 's1', 4);
  assert.deepEqual(await endedAndDistilled(made), [{ status: 'below_threshold', reason: 'too_little_work', detail: '1 of 3 work turns and no fixed error' }]);
});

test('a live session is distilled ten minutes after it fixed an error, thirty after other work, and below the threshold waits for more work', async () => {
  const fixed = await fixedSession({ model: modelAnswering(IR) });
  fixed.advance(EPISODE_QUIET_MS - 1);
  assert.deepEqual(await distillDue(fixed.ports), []);
  fixed.advance(1);
  assert.deepEqual((await distillDue(fixed.ports)).map(({ status }) => status), ['drafted']);
  assert.equal(distills(fixed.requests)[0].body.trigger, 'error_episode');

  const worked = await threeTurnSession({ model: modelAnswering(IR) });
  worked.advance(IDLE_DISTILL_MS - 1);
  assert.deepEqual(await distillDue(worked.ports), []);
  worked.advance(1);
  assert.deepEqual((await distillDue(worked.ports)).map(({ status }) => status), ['drafted']);
  assert.equal(distills(worked.requests)[0].body.trigger, 'idle');

  const small = memoryPorts({ model: modelAnswering(IR) });
  await changeTurn(small.ports, 's1');
  small.advance(IDLE_DISTILL_MS);
  assert.deepEqual((await distillDue(small.ports)).map(({ status }) => status), ['below_threshold']);
  small.advance(IDLE_DISTILL_MS);
  assert.deepEqual(await distillDue(small.ports), []);
  assert.equal((await small.ports.outcomes.read()).length, 1);
});

test('/evolver-status names the last distillation\'s outcome, with the Proxy\'s reason and the terms it refused', async () => {
  const refused = { ok: true, status: 'draft', quality: { ok: false, reason: 'too_project_specific', terms: ['invoiceTotal', 'BILLING_URL'] } };
  const rows = [
    ['a Proxy rejection', { model: modelAnswering(IR), distillAnswer: refused }, fixTurn, 'Last distillation: rejected by the Proxy (too_project_specific: invoiceTotal, BILLING_URL), just now.'],
    ['a model skip', { model: modelAnswering({ skip: 'routine edit' }) }, fixTurn, 'Last distillation: declined by the model (routine edit), just now.'],
    ['below the threshold', { model: modelAnswering(IR) }, changeTurn, 'Last distillation: below the threshold, no model call (1 of 3 work turns and no fixed error), just now.'],
  ];
  for (const [name, options, work, line] of rows) {
    const made = memoryPorts(options);
    await work(made.ports, 's1');
    await endedAndDistilled(made);
    const { text } = await runCommand(made.ports, { sessionId: 's1', name: 'evolver-status' });
    assert.ok(text.split('\n').includes(line), `${name}: ${text}`);
  }
});

test('the model\'s answer is read as fenced JSON, an array or one object; up to two IRs go out, one request each, and one that breaks the shape stays here', async () => {
  const second = { ...IR, title: 'Share one Redis client' };
  const tooLong = { ...IR, scope: { ...IR.scope, signals: [...IR.scope.signals.slice(0, 4), 's'.repeat(65)] } };
  const rows = [
    ['fenced', `Here it is:\n\`\`\`json\n${JSON.stringify(IR)}\n\`\`\``, [IR.title], 'drafted'],
    ['an array of three', JSON.stringify([IR, second, { ...IR, title: 'A third' }]), [IR.title, second.title], 'drafted'],
    ['a signal over 64 characters', JSON.stringify(tooLong), [], 'rejected'],
  ];
  for (const [name, answer, titles, status] of rows) {
    const made = await fixedSession({ model: modelAnswering(answer) });
    const [outcome] = await endedAndDistilled(made);
    assert.deepEqual(distills(made.requests).map(({ body }) => body.ir.title), titles, name);
    assert.deepEqual(distills(made.requests).map(({ body }) => Boolean(body.distill_usage)), titles.map((_, index) => index === 0), name);
    assert.equal(outcome.status, status, name);
  }
  const made = await fixedSession({ model: modelAnswering(tooLong) });
  await endedAndDistilled(made);
  assert.deepEqual((await made.ports.outcomes.read()).at(-1), { status: 'rejected', title: IR.title, by: 'plugin', reason: 'ir_invalid', field: 'ir.scope.signals', session: 'testagent:s1', trigger: 'session_end', at: made.ports.clock.now() });
});

test('work turns that join the range while the model answers stay for the next distillation', async () => {
  const made = await fixedSession();
  made.ports.model = modelAnswering(IR, () => changeTurn(made.ports, 's1', 2));
  made.advance(EPISODE_QUIET_MS);
  assert.deepEqual((await distillDue(made.ports)).map(({ status }) => status), ['drafted']);
  assert.deepEqual((await made.ports.candidates.read()).s1.turns.map(({ turn }) => turn), [2]);
});

test('a session still active keeps its work waiting; once it is quiet, a prompt in any session schedules the distillation', async () => {
  const { ports, scheduled, advance } = await threeTurnSession({ model: modelAnswering(IR) });
  const distillsScheduled = () => scheduled.filter((task) => task === TASKS.DISTILL).length;
  advance(IDLE_DISTILL_MS - 1);
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'now explain the build', waitMs: 0 });
  advance(1);
  await promptSubmitted(ports, { sessionId: 's2', prompt: 'explain the build', waitMs: 0 });
  assert.equal(distillsScheduled(), 0);
  advance(IDLE_DISTILL_MS);
  await promptSubmitted(ports, { sessionId: 's2', prompt: 'explain the tests', waitMs: 0 });
  assert.equal(distillsScheduled(), 1);
});

test('an explicit distillation cannot duplicate its process\'s running background distillation', async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let completions = 0;
  const made = await fixedSession({ model: modelAnswering(IR, async () => {
    completions += 1;
    started.resolve();
    await finish.promise;
  }) });
  await sessionEnded(made.ports, { sessionId: 's1', projectDir: '/proj' });
  const background = distillDue(made.ports);
  await started.promise;
  const explicit = distillSession(made.ports, { sessionId: 's1' });
  await new Promise(setImmediate);
  finish.resolve();
  const [outcomes, answer] = await Promise.all([background, explicit]);
  assert.equal(completions, 1);
  assert.equal(distills(made.requests).length, 1);
  assert.deepEqual([outcomes[0].status, answer.status], ['drafted', 'busy']);
  assert.equal((await made.ports.drafts.read()).length, 1);
});

test('with no model outside the conversation, a leftover waits a day for an agent\'s Gene, then is dropped', async () => {
  const { ports } = await fixedSession();
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.ok((await ports.candidates.read()).s1);
  await ports.clock.sleep(UNDISTILLED_LEFTOVER_TTL_MS + 1);
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a person who turned distillation off keeps the work from the background, and distills even one verified turn on demand', async () => {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, model: modelAnswering(IR) });
  await changeTurn(made.ports, 's1');
  made.ports.settings = { recall: true, autoDistill: false };
  await sessionEnded(made.ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(made.ports, [TASKS.DISTILL]);
  assert.ok((await made.ports.candidates.read()).s1);
  assert.equal((await distillSession(made.ports, { sessionId: 's1' })).status, 'drafted');
});

test('a process shutting down stops a leftover\'s model call without counting a try, and gives the claim back', async () => {
  const stopping = new AbortController();
  const waitsForever = { complete: (model, prompt, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  const { ports } = await fixedSession({ model: waitsForever });
  ports.scheduler = { ...ports.scheduler, signal: stopping.signal };
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const running = distillDue(ports);
  await new Promise((resolve) => setImmediate(resolve));
  stopping.abort();
  assert.deepEqual((await running).map((outcome) => outcome.status), ['stopped']);
  const { s1 } = await ports.candidates.read();
  assert.deepEqual([s1.attempts, s1.claimedBy ?? null], [0, null]);
});

test('the model may decline, which settles the session\'s work without calling the Proxy', async () => {
  const made = await fixedSession({ model: modelAnswering({ skip: 'routine edit' }) });
  const [outcome] = await endedAndDistilled(made);
  assert.deepEqual([outcome.status, outcome.reason], ['declined', 'routine edit']);
  assert.deepEqual(distills(made.requests), []);
  assert.equal((await made.ports.candidates.read()).s1, undefined);
});

test('a failing headless model keeps the work, tries again only after a doubling wait, and three failed tries give it up', async () => {
  const { ports, advance } = await fixedSession({ model: { complete: async () => { throw new Error('Authentication required'); } } });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  assert.equal((await distillDue(ports))[0].status, 'model_failed');
  advance(RETRY_BASE_MS - 1);
  assert.deepEqual(await distillDue(ports), [], 'the first retry waits its delay');
  advance(1);
  assert.equal((await distillDue(ports))[0].status, 'model_failed');
  advance(RETRY_BASE_MS);
  assert.deepEqual(await distillDue(ports), [], 'the second wait is twice as long');
  advance(RETRY_BASE_MS);
  assert.equal((await distillDue(ports))[0].status, 'model_failed');
  assert.equal((await ports.candidates.read()).s1, undefined);
});

const pass = (command = 'npm test') => ({ kind: 'check', command, exit: 0, failed: false });
const turnWith = (turn, steps) => ({ turn, prompt: 'p', steps, answer: '', at: 1 });
const FIXED = [turnWith(1, [{ ...pass(), exit: 1, failed: true }, { kind: 'edit', path: 'a.js' }, pass()])];
const SMALL = [turnWith(1, [{ kind: 'edit', path: 'a.js' }, pass()])];

test('the next wake-up is when the earliest range no live process holds comes due', () => {
  const NOW = 10 * IDLE_DISTILL_MS;
  const LIVE = 1;
  const DEAD = 2;
  const isGone = (pid) => pid === DEAD;
  const range = (fields, turns = SMALL) => ({ turns, at: NOW - 5_000, ...fields });
  const rows = [
    ['quiet once its session has been idle long enough', { s1: range({ activeAt: NOW - 1_000, pid: LIVE }) }, NOW - 1_000 + IDLE_DISTILL_MS],
    ['sooner after a fixed error', { s1: range({ activeAt: NOW - 1_000, pid: LIVE }, FIXED) }, NOW - 1_000 + EPISODE_QUIET_MS],
    ['below the threshold, waiting for more work', { s1: range({ activeAt: NOW - 1_000, pid: LIVE, held: true }) }, null],
    ['a retry later than the quiet deadline', { s1: range({ activeAt: NOW - 1_000, pid: LIVE, retryAt: NOW + IDLE_DISTILL_MS }) }, NOW + IDLE_DISTILL_MS],
    ['claimed by a live process, which settles it', { s1: range({ activeAt: NOW - 1_000, pid: LIVE, claimedBy: LIVE }) }, null],
    ['over and waiting out its retry', { s1: range({ activeAt: NOW - 1_000, pid: DEAD, retryAt: NOW + RETRY_BASE_MS }) }, NOW + RETRY_BASE_MS],
    ['one due already, as due now', { due: range({ activeAt: NOW - IDLE_DISTILL_MS, pid: LIVE }), later: range({ activeAt: NOW - 1_000, pid: LIVE }) }, NOW],
    ['none', {}, null],
  ];
  for (const [name, pending, expected] of rows) assert.equal(nextDueAt(pending, { now: NOW, isGone }), expected, name);
});

test('a wake-up keeps a range\'s own time when it is still to come, and waits a minute for one already due', async () => {
  const { ports, wakeUps } = memoryPorts({ model: { complete: async () => ({ answer: '' }) } });
  const now = ports.clock.now();
  await ports.candidates.update(() => ({ soon: { turns: SMALL, at: now, activeAt: now + 10_000 - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  await ports.candidates.update(() => ({ due: { turns: SMALL, at: now, activeAt: now - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  assert.deepEqual(wakeUps.map(({ at }) => at), [now + 10_000, now + MIN_WAKE_DELAY_MS]);
});

test('with no headless model, distilling now hands the agent the IR prompt, and its IR becomes a draft', async () => {
  const { ports } = await fixedSession({ distillAnswer: { ...DRAFTED, publishable: true, publish_receipt: { receiptId: 'proxy-issued-receipt' } } });
  const asked = await distillSession(ports, { sessionId: 's1' });
  assert.equal(asked.status, 'no_model');
  assert.match(asked.agentGene.prompt, /^Evolver distillation, prompt session-gene-ir-v1\.[\s\S]*## Kind: fix[\s\S]*\nR3 check \(exit 1\): npm test\n/);
  assert.ok((await ports.candidates.read()).s1);
  const posted = await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify([IR]), writtenFor: asked.agentGene.writtenFor });
  assert.equal(posted.status, 'drafted');
  const listed = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts' });
  assert.match(listed.text, /Stabilise Redis retries/);
  const published = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.match(published.text, /^Submitted "Stabilise Redis retries"/);
  assert.equal((await ports.drafts.read()).length, 0);
});

test('a draft write failure releases the claim so the same process can retry', async () => {
  const { ports } = await fixedSession({ distillAnswer: DRAFTED });
  const asked = await distillSession(ports, { sessionId: 's1' });
  const submission = { sessionId: 's1', text: JSON.stringify(IR), writtenFor: asked.agentGene.writtenFor };
  const updateDrafts = ports.drafts.update;
  ports.drafts.update = async () => { throw new Error('disk full'); };

  await assert.rejects(postAgentGene(ports, submission), /disk full/);
  ports.drafts.update = updateDrafts;

  assert.equal((await postAgentGene(ports, submission)).status, 'drafted');
  assert.equal((await ports.drafts.read()).length, 1);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('an IR written for the session\'s work as it was before another turn joined it is not sent', async () => {
  const { ports, requests } = await fixedSession();
  const asked = await distillSession(ports, { sessionId: 's1' });
  await changeTurn(ports, 's1', 2);
  assert.equal((await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(IR), writtenFor: asked.agentGene.writtenFor })).status, 'dropped');
  assert.deepEqual(distills(requests), []);
});

test('every command answers from the plugin; evolve is the one prompt for the agent', async () => {
  const { ports } = memoryPorts();
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-sync', args: '--dry-run "two words"' })).text, 'ran sync --dry-run two words');
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-evolve' })).forAgent, true);
  assert.match((await runCommand(ports, { sessionId: 's1', name: 'evolver-status' })).text, /No work turn of this session waits to be distilled\.\nNo distillation has run yet\./);
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-nope' })).ok, false);
});

test('a plugin command runs the engine in the session\'s project directory', async () => {
  const { ports } = memoryPorts();
  assert.equal((await runCommand(ports, { sessionId: 's1', projectDir: '/proj', name: 'evolver-run', args: '--dry-run' })).text, 'ran run --dry-run in /proj');
});

test('a searched strategy is only offered; adopted during a turn it is that turn\'s, between turns the next one\'s', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'explain the build', waitMs: 1_000 });
  const searched = await runCommand(ports, { sessionId: 's1', name: 'evolver-search', args: 'flaky redis connection retries in tests' });
  assert.equal(Object.keys((await ports.sessions.read('s1')).injected).length, 0);
  await adoptStrategy(ports, { sessionId: 's1', strategy: searched.strategy });
  const { reports } = await turnEnded(ports, { sessionId: 's1', reason: 'answer', answer: 'ok', projectDir: '/p' });
  assert.deepEqual(reports.map((report) => report.task_id), ['testagent:s1:1']);
});

test('a command run can be stopped: its signal reaches the evolver CLI', async () => {
  const { ports } = memoryPorts();
  let seen = null;
  ports.cli = { run: async (args, { signal }) => { seen = signal; return { ok: true, text: 'ran' }; } };
  const controller = new AbortController();
  await runCommand(ports, { sessionId: 's1', name: 'evolver-run', args: '--loop', signal: controller.signal });
  assert.equal(seen, controller.signal);
});
