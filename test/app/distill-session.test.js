import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { runCommand } from '../../lib/app/commands/index.js';
import { MIN_WAKE_DELAY_MS, armDistillWakeUp, distillDue, distillSession, postAgentGene } from '../../lib/app/distill-session.js';
import { adoptStrategy, promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { TASKS } from '../../lib/app/ports.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { IDLE_DISTILL_MS, RETRY_BASE_MS, UNDISTILLED_LEFTOVER_TTL_MS, nextDueAt } from '../../lib/distill/candidate.js';
import { memoryPorts } from './memory-ports.js';

const GENE = { title: 'Stabilise Redis retries', summary: 'Flaky Redis-backed tests stop failing once retries are unbounded and the client is shared.', strategy: ['Set maxRetriesPerRequest to null', 'Share one client', 'Close it in teardown'] };
const DRAFTED = {
  ok: true, status: 'draft', publishable: false, distill_id: 'd'.repeat(16), quality: { ok: true, score: 6, threshold: 5 }, signals: ['redis'],
  gene: { type: 'Gene', asset_id: 'sha256:' + 'g'.repeat(64), summary: GENE.summary },
  capsule: { type: 'Capsule', asset_id: 'sha256:' + 'c'.repeat(64), summary: GENE.summary },
};

const PROJECT = { root: '/proj', head: 'f'.repeat(40), diff: 'diff --git a/lib/redis.js b/lib/redis.js\n' };

const modelAnswering = (answer, onCall = () => {}) => ({
  complete: async () => {
    await onCall();
    return { answer: JSON.stringify(answer), usage: { inputTokens: 10, outputTokens: 5 } };
  },
});

async function withCandidate(options = {}) {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, ...options });
  const { ports } = made;
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'fix the flaky redis retries', waitMs: 1_000 });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ok' } });
  await turnEnded(ports, { sessionId: 's1', reason: 'answer', answer: 'Fixed the retries.', model: 'model-x', projectDir: '/proj' });
  return made;
}

test('a session-end distillation the Proxy answers as a draft is kept as a draft and settles the candidate', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillDue(ports);
  assert.equal(outcome.status, 'drafted');
  assert.equal((await ports.candidates.read()).s1, undefined);
  assert.equal((await ports.drafts.read())[0].title, GENE.title);
  const { body } = requests.find((request) => request.path === '/conversation/distill');
  assert.deepEqual([body.platform, body.trigger, body.session_id, body.persist, body.publish], ['testagent', 'session_end', 'testagent:s1', true, false]);
  assert.deepEqual(body.execution, { trace: [{ command: 'npm test', exit: 0, source: 'observed' }] });
  assert.deepEqual(body.project, PROJECT);
  assert.deepEqual(body.distill_usage, { inputTokens: 10, outputTokens: 5 });
});

test('a diff that would push the distillation past the Proxy\'s 256 KiB body limit is left out and marked truncated', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE), project: { ...PROJECT, diff: 'x'.repeat(256 * 1024 - 100) } });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await distillDue(ports);
  const { body } = requests.find((request) => request.path === '/conversation/distill');
  assert.deepEqual(body.project, { diff_omitted: 'too_large' });
});

test('a live session\'s candidate is distilled once the session has been quiet long enough, with trigger idle', async () => {
  const { ports, requests, advance } = await withCandidate({ model: modelAnswering(GENE) });
  advance(IDLE_DISTILL_MS - 1);
  assert.deepEqual(await distillDue(ports), []);
  assert.ok((await ports.candidates.read()).s1);
  advance(1);
  assert.deepEqual((await distillDue(ports)).map((outcome) => outcome.status), ['drafted']);
  assert.equal(requests.find((request) => request.path === '/conversation/distill').body.trigger, 'idle');
});

test('a session still active keeps its candidate waiting; once it is quiet, a prompt in any session schedules the distillation', async () => {
  const { ports, scheduled, advance } = await withCandidate({ model: modelAnswering(GENE) });
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
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE, async () => {
    completions += 1;
    started.resolve();
    await finish.promise;
  }) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const background = distillDue(ports);
  await started.promise;
  const explicit = distillSession(ports, { sessionId: 's1' });
  await new Promise(setImmediate);
  finish.resolve();
  const [outcomes, answer] = await Promise.all([background, explicit]);
  assert.equal(completions, 1);
  assert.equal(requests.filter(({ path }) => path === '/conversation/distill').length, 1);
  assert.equal(outcomes[0].status, 'drafted');
  assert.equal(answer.status, 'busy');
  assert.equal((await ports.drafts.read()).length, 1);
});

test('with no model outside the conversation, a leftover waits a day for an agent\'s Gene, then is dropped', async () => {
  const { ports } = await withCandidate();
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.ok((await ports.candidates.read()).s1);
  await ports.clock.sleep(UNDISTILLED_LEFTOVER_TTL_MS + 1);
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a person who turned distillation off keeps the leftover from the background, and still distills it on demand', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  ports.settings = { recall: true, autoDistill: false };
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.ok((await ports.candidates.read()).s1);
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'drafted');
});

test('a process shutting down stops a leftover\'s model call without counting a try, and gives the claim back', async () => {
  const stopping = new AbortController();
  const waitsForever = { complete: (model, prompt, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  const { ports } = await withCandidate({ model: waitsForever });
  ports.scheduler = { ...ports.scheduler, signal: stopping.signal };
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const running = distillDue(ports);
  await new Promise((resolve) => setImmediate(resolve));
  stopping.abort();
  assert.deepEqual((await running).map((outcome) => outcome.status), ['stopped']);
  const { s1 } = await ports.candidates.read();
  assert.deepEqual([s1.attempts, s1.claimedBy ?? null], [0, null]);
});

test('the model may decline, which settles the candidate without calling the Proxy', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering({ skip: 'routine edit' }) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillDue(ports);
  assert.deepEqual([outcome.status, outcome.reason], ['declined', 'routine edit']);
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a candidate dropped by a correction while the model answers is not posted', async () => {
  const made = await withCandidate();
  const { ports, requests } = made;
  ports.model = modelAnswering(GENE, () => ports.candidates.update(({ s1, ...rest }) => rest));
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillDue(ports);
  assert.equal(outcome.status, 'dropped');
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
});

test('a failing headless model keeps the candidate, tries again only after a doubling wait, and three failed tries give it up', async () => {
  const { ports, advance } = await withCandidate({ model: { complete: async () => { throw new Error('Authentication required'); } } });
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

test('the next wake-up is when the earliest candidate no live process holds comes due', () => {
  const NOW = 10 * IDLE_DISTILL_MS;
  const LIVE = 1;
  const DEAD = 2;
  const isGone = (pid) => pid === DEAD;
  const rows = [
    ['quiet once its session has been idle long enough', { s1: { at: NOW - 5_000, activeAt: NOW - 1_000, pid: LIVE } }, NOW - 1_000 + IDLE_DISTILL_MS],
    ['a retry later than the quiet deadline', { s1: { at: NOW - 1_000, pid: LIVE, retryAt: NOW + IDLE_DISTILL_MS } }, NOW + IDLE_DISTILL_MS],
    ['claimed by a live process, which settles it', { s1: { at: NOW - 1_000, pid: LIVE, claimedBy: LIVE } }, null],
    ['over and waiting out its retry', { s1: { at: NOW - 1_000, pid: DEAD, retryAt: NOW + RETRY_BASE_MS } }, NOW + RETRY_BASE_MS],
    ['the earliest of several', { later: { at: NOW - 1_000, pid: LIVE }, sooner: { at: NOW - 2_000, pid: LIVE } }, NOW - 2_000 + IDLE_DISTILL_MS],
    ['one due already, as due now', { due: { at: NOW - IDLE_DISTILL_MS, pid: LIVE }, later: { at: NOW - 1_000, pid: LIVE } }, NOW],
    ['no candidates', {}, null],
  ];
  for (const [name, pending, expected] of rows) assert.equal(nextDueAt(pending, { now: NOW, isGone }), expected, name);
});

test('a wake-up keeps a candidate\'s own time when it is still to come, and waits a minute for one already due', async () => {
  const { ports, wakeUps } = memoryPorts({ model: { complete: async () => ({ answer: '' }) } });
  const now = ports.clock.now();
  await ports.candidates.update(() => ({ soon: { at: now + 10_000 - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  await ports.candidates.update(() => ({ due: { at: now - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  assert.deepEqual(wakeUps.map(({ at }) => at), [now + 10_000, now + MIN_WAKE_DELAY_MS]);
});

test('with no headless model, distilling now hands the agent the prompt, and its Gene becomes a draft', async () => {
  const { ports } = await withCandidate({ distillAnswer: { ...DRAFTED, publishable: true, publish_receipt: { receiptId: 'proxy-issued-receipt' } } });
  const asked = await distillSession(ports, { sessionId: 's1' });
  assert.equal(asked.status, 'no_model');
  assert.match(asked.agentGene.prompt, /Turn it into one reusable Gene/);
  assert.ok((await ports.candidates.read()).s1);
  const posted = await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(GENE), writtenFor: asked.agentGene.writtenFor });
  assert.equal(posted.status, 'drafted');
  const listed = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts' });
  assert.match(listed.text, /Stabilise Redis retries/);
  const published = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.match(published.text, /^Submitted "Stabilise Redis retries"/);
  assert.equal((await ports.drafts.read()).length, 0);
});

test('a draft write failure releases the claim so the same process can retry', async () => {
  const { ports } = await withCandidate();
  const asked = await distillSession(ports, { sessionId: 's1' });
  const submission = { sessionId: 's1', text: JSON.stringify(GENE), writtenFor: asked.agentGene.writtenFor };
  const updateDrafts = ports.drafts.update;
  ports.drafts.update = async () => { throw new Error('disk full'); };

  await assert.rejects(postAgentGene(ports, submission), /disk full/);
  ports.drafts.update = updateDrafts;

  assert.equal((await postAgentGene(ports, submission)).status, 'drafted');
  assert.equal((await ports.drafts.read()).length, 1);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a Gene written for a candidate since replaced is not sent', async () => {
  const { ports, requests } = await withCandidate();
  assert.equal((await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(GENE), writtenFor: 1 })).status, 'dropped');
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
});

test('every command answers from the plugin; evolve is the one prompt for the agent', async () => {
  const { ports } = memoryPorts();
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-sync', args: '--dry-run "two words"' })).text, 'ran sync --dry-run two words');
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-evolve' })).forAgent, true);
  assert.match((await runCommand(ports, { sessionId: 's1', name: 'evolver-status' })).text, /No distillation candidate in this session/);
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
