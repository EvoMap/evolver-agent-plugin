import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { runCommand } from '../../lib/app/commands/index.js';
import { distillLeftovers, distillSession, postAgentGene } from '../../lib/app/distill-session.js';
import { adoptStrategy, promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { TASKS } from '../../lib/app/ports.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { UNDISTILLED_LEFTOVER_TTL_MS } from '../../lib/distill/candidate.js';
import { memoryPorts } from './memory-ports.js';

const GENE = { title: 'Stabilise Redis retries', summary: 'Flaky Redis-backed tests stop failing once retries are unbounded and the client is shared.', strategy: ['Set maxRetriesPerRequest to null', 'Share one client', 'Close it in teardown'] };
const DRAFTED = {
  ok: true, status: 'draft', publishable: false, distill_id: 'd'.repeat(16), quality: { ok: true, score: 6, threshold: 5 }, signals: ['redis'],
  gene: { type: 'Gene', asset_id: 'sha256:' + 'g'.repeat(64), summary: GENE.summary },
  capsule: { type: 'Capsule', asset_id: 'sha256:' + 'c'.repeat(64), summary: GENE.summary },
};

const modelAnswering = (answer, onCall = () => {}) => ({
  complete: async () => {
    await onCall();
    return { answer: JSON.stringify(answer), usage: { inputTokens: 10, outputTokens: 5 } };
  },
});

async function withCandidate(options = {}) {
  const made = memoryPorts({ distillAnswer: DRAFTED, ...options });
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
  const [outcome] = await distillLeftovers(ports);
  assert.equal(outcome.status, 'drafted');
  assert.equal((await ports.candidates.read()).s1, undefined);
  assert.equal((await ports.drafts.read())[0].title, GENE.title);
  const { body } = requests.find((request) => request.path === '/conversation/distill');
  assert.deepEqual([body.platform, body.trigger, body.session_id, body.persist, body.publish], ['testagent', 'session_end', 'testagent:s1', true, false]);
  assert.deepEqual(body.execution, { trace: [{ command: 'npm test', exit: 0 }] });
  assert.deepEqual(body.distill_usage, { inputTokens: 10, outputTokens: 5 });
});

test('a live session keeps its candidate; only an ended one is a leftover', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  assert.deepEqual(await distillLeftovers(ports), []);
  assert.ok((await ports.candidates.read()).s1);
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

test('the model may decline, which settles the candidate without calling the Proxy', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering({ skip: 'routine edit' }) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillLeftovers(ports);
  assert.deepEqual([outcome.status, outcome.reason], ['declined', 'routine edit']);
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a candidate dropped by a correction while the model answers is not posted', async () => {
  const made = await withCandidate();
  const { ports, requests } = made;
  ports.model = modelAnswering(GENE, () => ports.candidates.update(({ s1, ...rest }) => rest));
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillLeftovers(ports);
  assert.equal(outcome.status, 'dropped');
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
});

test('a failing headless model keeps the candidate, and three failed tries give it up', async () => {
  const { ports } = await withCandidate({ model: { complete: async () => { throw new Error('Authentication required'); } } });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  for (let attempt = 1; attempt <= 3; attempt += 1) assert.equal((await distillLeftovers(ports))[0].status, 'model_failed');
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('with no headless model, distilling now hands the agent the prompt, and its Gene becomes a draft', async () => {
  const { ports } = await withCandidate();
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
