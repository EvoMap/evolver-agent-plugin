import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import kimi from '../../../hosts/kimi/profile.js';
import { createDriver } from '../../../lib/agent/driver.js';
import { runBackgroundTasks } from '../../../lib/app/background.js';
import { recordReaderOf } from '../../../lib/runtime/records.js';
import { monitorTurn } from '../../../lib/runtime/turn-monitor.js';
import { ASSET, memoryPorts, PROMPT } from '../../app/memory-ports.js';

const loop = (event) => ({ type: 'context.append_loop_event', agentId: 'main', event });
const prompt = (turnId) => ({ type: 'turn.prompt', agentId: 'main', turnId, promptId: `prompt-${turnId}`, origin: { kind: 'user' }, input: [{ type: 'text', text: PROMPT }] });
const passingCheck = (turnId, { background = false } = {}) => [
  loop({ type: 'tool.call', uuid: `check-${turnId}`, toolCallId: `call-${turnId}`, turnId: String(turnId), name: 'Bash', args: { command: 'node --test', ...(background && { run_in_background: true }) } }),
  loop({ type: 'tool.result', parentUuid: `check-${turnId}`, toolCallId: `call-${turnId}`, result: { output: background ? `task_id: task-${turnId}\nstatus: running` : '# pass 1\n# fail 0', durationMs: 1 } }),
];
const answered = (turnId) => [
  { type: 'llm.request', agentId: 'main', modelAlias: 'route-a', model: 'fixture-model', provider: 'openai', thinkingEffort: 'off' },
  loop({ type: 'content.part', uuid: `answer-${turnId}`, stepUuid: `step-${turnId}`, turnId: String(turnId), part: { type: 'text', text: 'The check passes.' } }),
  loop({ type: 'step.end', uuid: `step-${turnId}`, turnId: String(turnId), finishReason: 'end_turn', providerFinishReason: 'completed' }),
  { type: 'turn.ended', agentId: 'main', turnId, reason: 'completed' },
];

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'evolver-kimi-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), project = join(root, 'project');
  const agent = join(home, 'sessions', 'workspace', 'session-fixture', 'agents', 'main');
  mkdirSync(agent, { recursive: true }); mkdirSync(project);
  writeFileSync(join(home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { workspace: { root: project } } }));
  const append = (...records) => appendFileSync(join(agent, 'wire.jsonl'), records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  append({ type: 'metadata', protocol_version: '1.5' });
  const env = { KIMI_CODE_HOME: home };
  const made = memoryPorts(options);
  Object.assign(made.ports, {
    turnStatus: recordReaderOf(kimi.turnEnd.statusRecord, env),
    modelRecord: recordReaderOf(kimi.modelRecord, env),
    confirmTurnCompletion: true,
  });
  made.ports.turnMonitor = (at, onClosed) => monitorTurn(made.ports, at, onClosed, {
    dir: join(root, 'monitors'), sleep: async () => options.whileWatching?.(),
  });
  made.ports.modelForTurn = (sessionId, opened) => kimi.turnEnd.modelOf(made.ports.modelRecord(sessionId, opened.turnId), 'stamp', 'stamp');
  const driver = createDriver({ profile: kimi, ports: made.ports, transcripts: { size: () => 0, readSince: () => '' }, env });
  const base = { session_id: 'session-fixture', cwd: project, client_type: 'kimi_code_cli', is_steer: false };
  const hook = (event, extra = {}) => driver.handle(event, { ...base, hook_event_name: event, ...extra }, { onError: (error) => { throw error; } });
  const sessionId = JSON.stringify([made.ports.turnStatus.scope, 'session-fixture']);
  const session = () => made.ports.sessions.read(sessionId);
  const started = (turnId) => hook('TurnStarted', { turn_id: turnId, prompt: PROMPT, origin_kind: 'user' });
  return { ...made, agent, append, hook, started, session, sessionId };
}

const successes = (queued) => queued.filter(({ report }) => report.asset_id === ASSET.asset_id && report.outcome === 'success');

test('TurnStarted binds the open turn only for its own prompt and starts the shared turn monitor', async (t) => {
  const f = fixture(t);
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  f.append(prompt(0));
  await f.hook('TurnStarted', { turn_id: 0, prompt: 'another prompt', origin_kind: 'user' });
  assert.equal((await f.session()).turnId, null);
  await f.hook('Stop', { turn_id: 0 });
  assert.deepEqual(f.scheduled.filter((task) => task.startsWith('turn:')), [], 'an unbound turn has nothing to watch');
  await f.started(0);
  assert.equal((await f.session()).turnId, '0', 'native turn zero is a real identity');
  const [task] = f.scheduled.filter((item) => item.startsWith('turn:'));
  assert.deepEqual(JSON.parse(task.slice('turn:'.length)).expectedTurn, { turn: 1, turnId: '0', sessionEpoch: (await f.session()).sessionEpoch });
  await f.hook('Stop', { turn_id: 0 });
  assert.equal(f.scheduled.filter((item) => item.startsWith('turn:')).length, 2, 'a later lifecycle hook watches again');
});

test('the shared turn monitor waits while the log shows the turn running and closes it on the log\'s record', async (t) => {
  let polls = 0;
  const f = fixture(t, { whileWatching: () => { if (++polls === 3) f.append(...answered(0)); } });
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  f.append(prompt(0), ...passingCheck(0));
  await f.started(0);
  assert.equal(f.ports.turnStatus(f.sessionId, '0').status, 'accepted');
  await runBackgroundTasks(f.ports, f.scheduled.splice(0).filter((task) => task.startsWith('turn:')));
  assert.equal(polls, 3);
  assert.equal((await f.session()).open, false);
  assert.equal(successes(f.queued).length, 1);
  assert.deepEqual((await f.ports.candidates.read())[f.sessionId].turns.map(({ turn, answer }) => [turn, answer]), [[1, 'The check passes.']]);
});

test('the next prompt closes an unfinished turn on the session log\'s evidence and its captured route', async (t) => {
  const f = fixture(t);
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  f.append(prompt(0), ...passingCheck(0));
  await f.started(0);
  f.append(...answered(0));
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: `${PROMPT} Next.` }] });
  assert.equal(successes(f.queued).length, 1);
  const range = (await f.ports.candidates.read())[f.sessionId];
  assert.deepEqual(range.turns.map(({ turn, answer }) => [turn, answer]), [[1, 'The check passes.']]);
  assert.deepEqual(range.model, { selection: { alias: 'route-a', model: 'fixture-model', protocol: 'openai', effort: 'off' }, configDigest: 'stamp' });
});

test('a turn whose background check still runs at its end is not verified when the next prompt closes it', async (t) => {
  const f = fixture(t);
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  f.append(prompt(0), ...passingCheck(0, { background: true }));
  mkdirSync(join(f.agent, 'tasks'));
  writeFileSync(join(f.agent, 'tasks', 'task-0.json'), JSON.stringify({ taskId: 'task-0', kind: 'process', parentToolCallId: 'call-0', command: 'node --test', status: 'running' }));
  await f.started(0);
  f.append(...answered(0));
  assert.equal(f.ports.turnStatus(f.sessionId, '0').status, 'pending');
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: `${PROMPT} Next.` }] });
  assert.equal((await f.session()).turn, 2);
  assert.deepEqual(successes(f.queued), []);
  assert.equal((await f.ports.candidates.read())[f.sessionId], undefined);
});

test('a session end closes the open turn as its log ended it, not as aborted', async (t) => {
  const f = fixture(t);
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  f.append(prompt(0), ...passingCheck(0));
  await f.started(0);
  f.append(...answered(0));
  await f.hook('SessionEnd');
  assert.equal(successes(f.queued).length, 1);
  const range = (await f.ports.candidates.read())[f.sessionId];
  assert.equal(range.closed, true);
  assert.deepEqual(range.turns.map(({ turn }) => turn), [1]);
});

test('a session whose Kimi process died is recovered from the session log at the next session start', async (t) => {
  const f = fixture(t, { gone: new Set([4242]) });
  await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  f.append(prompt(0), ...passingCheck(0));
  await f.started(0);
  f.append(...answered(0));
  await f.hook('SessionStart', { session_id: 'another-session' });
  assert.equal(await runBackgroundTasks(f.ports, f.scheduled.splice(0).filter((task) => task === 'recover-turns')), true);
  assert.equal((await f.session()).open, false);
  assert.equal(successes(f.queued).length, 1);
  assert.deepEqual((await f.ports.candidates.read())[f.sessionId].turns.map(({ turn }) => turn), [1]);
});
