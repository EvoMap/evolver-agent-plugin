import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDriver } from '../../lib/agent/driver.js';
import { defineProfile } from '../../lib/agent/profile.js';
import mcpGeneric from '../../hosts/mcp-generic/profile.js';
import { PROMPT, memoryPorts } from '../app/memory-ports.js';

const HOOK_EVENTS = { SessionStart: 'sessionStart', UserPromptSubmit: 'prompt', PreToolUse: 'beforeEdit', PostToolUse: 'toolResult', Stop: 'turnEnd', SessionEnd: 'sessionEnd' };
const evidence = {
  toolNote: (payload) => (payload.tool_name === 'Bash' ? { kind: 'shell', command: payload.tool_input.command, exit: payload.tool_response.exit_code } : null),
  editedFile: (payload) => payload.tool_input?.file_path ?? null,
};
const hookProfile = (extra = {}) => defineProfile({ name: 'testhook', label: 'Test Hook', events: HOOK_EVENTS, evidence, budgets: { prompt: 8_000 }, ...extra });
const noTranscripts = { size: () => 0, readSince: () => '' };
const driverOf = (profile, made = memoryPorts(), transcripts = noTranscripts) => ({ ...made, driver: createDriver({ profile, ports: made.ports, transcripts, lifetime: 'ephemeral' }) });
const base = { session_id: 's1', cwd: '/proj' };

test('a profile missing a difference point fails when it is defined, naming what is wrong', () => {
  assert.throws(() => defineProfile({ name: 'Bad Name', label: 'x', events: { A: 'nope' } }),
    /name must be lower-case.*events must map host events to canonical events.*evidence\.toolNote and evidence\.editedFile or editedFiles are required/);
});

test('a prompt answers the recalled strategy in the hook channel\'s shape', async () => {
  const { driver } = driverOf(hookProfile());
  const answer = await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  assert.equal(answer.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(answer.hookSpecificOutput.additionalContext.endsWith('Apply them where they fit.'));
});

test('a delayed prompt schedules only the generation it opened', async t => {
  const made = memoryPorts();
  made.ports.settings = { recall: false };
  made.ports.confirmTurnCompletion = true;
  made.ports.turnStatus = () => null;
  const { driver } = driverOf(hookProfile({ turnEnd: { statusRecord: { file: () => null, query: 'SELECT 1' } } }), made);
  let release, entered, reads = 0;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  made.ports.project.head = async () => { if (reads++ === 0) { entered(); return held; } return null; };
  const payload = { ...base, turn_id: 'same-turn', prompt: PROMPT };
  const old = driver.handle('UserPromptSubmit', payload);
  t.after(async () => { release(null); await old; });
  await started;
  made.advance(1);
  await made.ports.sessions.update('s1', () => ({ turn: 0 }));
  await driver.handle('UserPromptSubmit', payload);
  const tasks = made.scheduled.filter(task => task.startsWith('turn:'));
  assert.equal(tasks.length, 1);
  release({ root: '/old-project', head: 'old-head' });
  await old;
  assert.deepEqual(made.scheduled.filter(task => task.startsWith('turn:')), tasks);
  assert.equal((await made.ports.sessions.read('s1')).turnHead, null);
});

test('a delayed tool result schedules only the generation that recorded its note', async t => {
  const made = memoryPorts();
  made.ports.settings = { recall: false };
  made.ports.confirmTurnCompletion = true;
  made.ports.turnStatus = () => null;
  const { driver } = driverOf(hookProfile({ turnEnd: { statusRecord: { file: () => null, query: 'SELECT 1' } } }), made);
  const payload = { ...base, turn_id: 'same-turn', prompt: PROMPT };
  await driver.handle('UserPromptSubmit', payload);
  made.scheduled.length = 0;
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const append = made.ports.notes.append;
  made.ports.notes.append = async (...args) => { await append(...args); entered(); await held; };
  const old = driver.handle('PostToolUse', { ...payload, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } });
  t.after(async () => { release(); await old; });
  await started;
  made.advance(1);
  await made.ports.sessions.update('s1', () => ({ turn: 0 }));
  await driver.handle('UserPromptSubmit', payload);
  const tasks = made.scheduled.filter(task => task.startsWith('turn:'));
  assert.equal(tasks.length, 1);
  release();
  await old;
  assert.deepEqual(made.scheduled.filter(task => task.startsWith('turn:')), tasks);
});

test('a whole turn through the driver reports its injection with the check the tool hook saw', async () => {
  const { driver, queued } = driverOf(hookProfile());
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  await driver.handle('PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 1 } });
  assert.deepEqual(await driver.handle('Stop', { ...base, last_assistant_message: 'Done.' }), {});
  assert.equal(queued[0].report.outcome, 'failed');
  assert.equal(queued[0].report.evidence.check.passed, false);
});

test('an intercepted command answers in the chat and starts no turn', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(hookProfile({ commands: { entry: 'intercept' } }), made);
  const answer = await driver.handle('UserPromptSubmit', { ...base, prompt: '/evolver-sync --dry-run' });
  assert.equal(answer.hookSpecificOutput.additionalContext, 'ran sync --dry-run in /proj');
  assert.equal(made.sessions.get('s1'), undefined);
});

test('an unknown end reason leaves the turn open; a subagent, an unmapped event or a failure answers empty', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(hookProfile({ turnEnd: { reason: () => 'unknown' } }), made);
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  await driver.handle('Stop', base);
  assert.equal(made.sessions.get('s1').open, true);
  assert.deepEqual(await driver.handle('UserPromptSubmit', { ...base, agent_id: 'sub', prompt: PROMPT }), {});
  assert.deepEqual(await driver.handle('Notification', base), {});
  made.ports.sessions.update = async () => { throw new Error('disk full'); };
  assert.deepEqual(await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT }), {});
});

test('a correction whose draft lock stays held still opens its turn and recalls, and reports the lock', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(hookProfile(), made);
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  await driver.handle('PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } });
  await driver.handle('Stop', { ...base, last_assistant_message: 'Done.' });
  const held = Object.assign(new Error('Timed out waiting for the draft correction lock. Please retry.'), { code: 'ELOCKED' });
  made.ports.draftCorrections.withSession = async () => { throw held; };
  const errors = [];
  const recalls = made.requests.length;

  await driver.handle('UserPromptSubmit', { ...base, prompt: `still failing: ${PROMPT}` }, { onError: (error) => errors.push(error) });
  assert.deepEqual(errors, [held]);
  assert.ok(made.requests.length > recalls);
  const session = made.sessions.get('s1');
  assert.deepEqual([session.turn, session.open], [2, true]);
  assert.match((await made.ports.candidates.read()).s1.turns[0].correction, /^still failing/);
  assert.equal(await made.ports.draftCorrections.has('s1', 1, session.sessionEpoch), true);
});

test('a prompt whose session lifecycle lock stays held still opens its turn and recalls, and reports the lock', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(hookProfile(), made);
  const held = Object.assign(new Error('Timed out waiting for the session lifecycle lock. Please retry.'), { code: 'ELOCKED' });
  made.ports.sessions.withSession = async () => { throw held; };
  const errors = [];

  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT }, { onError: (error) => errors.push(error) });
  assert.deepEqual(errors, [held]);
  assert.ok(made.requests.length > 0);
  const session = made.sessions.get('s1');
  assert.deepEqual([session.turn, session.open], [1, true]);
});

test('a host whose injection lasts one call gets the open turn\'s strategy again, without a second recall', async () => {
  const made = memoryPorts();
  const { driver, requests } = driverOf(hookProfile({ reply: { lifetime: 'call' }, payload: { turnId: (payload) => payload.turn } }), made);
  const first = await driver.handle('UserPromptSubmit', { ...base, turn: 't1', prompt: PROMPT });
  const again = await driver.handle('UserPromptSubmit', { ...base, turn: 't1', prompt: PROMPT });
  assert.deepEqual(again, first);
  assert.equal(requests.filter((request) => request.path === '/asset/fetch').length, 1);
});

test('a host without a session-start event starts a session when its owner changes, and says the engine notice once', async () => {
  const made = memoryPorts();
  made.ports.engine.takeUnannounced = async () => ({ status: 'started', version: '2.0.46', at: 1 });
  const { driver } = driverOf(hookProfile({ sessionStart: 'owner-change' }), made);
  const answer = await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  assert.match(answer.hookSpecificOutput.additionalContext, /^\[Evolver\] The Evolver Proxy was not running/);
  assert.ok(made.scheduled.includes('distill'));
});

test('a host that keeps a transcript hands the turn record over from it', async () => {
  const transcript = '{"cmd":"npm test","exit":0}\n';
  const transcripts = { size: () => 7, readSince: (file, offset) => (offset === 7 ? transcript : '') };
  const profile = hookProfile({
    evidence: {
      ...evidence,
      turnStart: (payload, context) => context.transcriptSize(),
      turnRecord: (payload, context) => {
        const lines = context.transcriptSince(context.turnStart).trim().split('\n').map((line) => JSON.parse(line));
        return { checks: lines.map((line) => ({ command: line.cmd, failed: line.exit !== 0 })), commands: lines.map((line) => line.cmd), paths: ['a.js'], edits: ['a.js'], answer: '' };
      },
    },
  });
  const { driver, ports } = driverOf(profile, memoryPorts(), transcripts);
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT, transcript_path: '/t.jsonl' });
  await driver.handle('Stop', { ...base, transcript_path: '/t.jsonl', last_assistant_message: 'Fixed.' });
  assert.deepEqual((await ports.candidates.read()).s1.turns[0].steps, [{ kind: 'edit', path: 'a.js' }, { kind: 'check', command: 'npm test', exit: null, failed: false }]);
});

test('the MCP profile turns tool calls into a turn whose report is agent-reported and asks for a Gene', async () => {
  const made = memoryPorts({ distillAnswer: null });
  const { driver, queued } = driverOf(mcpGeneric, made);
  const recalled = await driver.handle('evolver_recall', { session_id: 'm1', turn_id: 't1', task: PROMPT });
  assert.match(recalled.content[0].text, /Apply them where they fit\.\n\nturn_id: t1 /);
  const checks = [{ command: 'npm test', exit: 1 }, { command: 'npm test', exit: 0 }];
  const reported = await driver.handle('evolver_report', { session_id: 'm1', turn_id: 't1', outcome: 'success', summary: 'Fixed the retries.', checks, files: ['lib/redis.js'] });
  assert.match(reported.content[0].text, /call evolver_distill with written_for "v2-[A-Za-z0-9_-]{43}"[\s\S]*prompt session-gene-ir-v1/);
  assert.equal(queued[0].report.evidence.reported_by, 'agent');
  assert.equal(queued[0].report.evidence.tier, 'none');
  const status = await driver.handle('evolver_status', { session_id: 'm1' });
  assert.equal(JSON.parse(status.content[0].text).distillation.session_turns_waiting, 1);
});

test('a successful compound command reported through MCP does not make the session\'s work distillable', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(mcpGeneric, made);
  await driver.handle('evolver_recall', { session_id: 'm1', turn_id: 't1', task: PROMPT });
  const checks = [{ command: 'npm test', exit: 1 }, { command: 'true || npm test', exit: 0 }];
  const reported = await driver.handle('evolver_report', { session_id: 'm1', turn_id: 't1', outcome: 'success', summary: 'Fixed the retries.', checks, files: ['lib/redis.js'] });
  assert.equal(reported.content[0].text, 'Reported.');
});

test('a session start answers the engine notice once, and a session end schedules distillation', async () => {
  const made = memoryPorts();
  made.ports.engine.takeUnannounced = async () => ({ status: 'install_failed', error: 'npm missing', at: 1 });
  const { driver } = driverOf(hookProfile(), made);
  const answer = await driver.handle('SessionStart', base);
  assert.match(answer.hookSpecificOutput.additionalContext, /^\[Evolver\] Installing Evolver failed \(npm missing\)/);
  assert.deepEqual(await driver.handle('SessionEnd', base), {});
  assert.ok(made.scheduled.includes('distill'));
});

test('over MCP, a report asks for a Gene only once the session\'s work turns pass the threshold', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(mcpGeneric, made);
  const answers = [];
  for (const turn of ['t1', 't2', 't3']) {
    await driver.handle('evolver_recall', { session_id: 'm1', turn_id: turn, task: `${PROMPT}, step ${turn}` });
    const reported = await driver.handle('evolver_report', { session_id: 'm1', turn_id: turn, outcome: 'success', summary: 'Done.', checks: [{ command: 'npm test', exit: 0 }], files: [`${turn}.js`] });
    answers.push(reported.content[0].text);
  }
  assert.deepEqual(answers.map((answer) => /evolver_distill/.test(answer)), [false, false, true]);
});

test('a host whose strategy lands at a tool result answers the prompt without it and the turn\'s first tool result with it', async () => {
  const { driver, queued } = driverOf(hookProfile({ reply: { strategyAt: 'tool-result' } }));
  assert.deepEqual(await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT }), {});
  const bash = { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } };
  const first = await driver.handle('PostToolUse', bash);
  assert.equal(first.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(first.hookSpecificOutput.additionalContext.endsWith('Apply them where they fit.'));
  assert.deepEqual(await driver.handle('PostToolUse', bash), {});
  await driver.handle('Stop', { ...base, last_assistant_message: 'Done.' });
  assert.equal(queued[0].report.outcome, 'success');
});

test('by default the strategy rides the prompt, and a tool result answers nothing', async () => {
  const { driver } = driverOf(hookProfile());
  assert.equal(hookProfile().reply.strategyAt, 'prompt');
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  assert.deepEqual(await driver.handle('PostToolUse', { ...base, tool_name: 'Read', tool_input: {} }), {});
  assert.throws(() => hookProfile({ reply: { strategyAt: 'step' } }), /reply\.strategyAt must be one of prompt, tool-result/);
});

test('a host whose prompt answer reaches no model may not rely on it for a session-start notice or a late recall', () => {
  const late = (answer) => answer;
  assert.throws(() => hookProfile({ reply: { strategyAt: 'tool-result' }, sessionStart: 'owner-change' }), /'tool-result' takes neither sessionStart 'owner-change' nor reply\.late/);
  assert.throws(() => hookProfile({ reply: { strategyAt: 'tool-result', late } }), /'tool-result' takes neither/);
  assert.doesNotThrow(() => hookProfile({ reply: { late }, sessionStart: 'owner-change' }));
});

test('a tool result of another turn than the open one is handed no strategy', async () => {
  const profile = hookProfile({ reply: { strategyAt: 'tool-result' }, payload: { turnId: (payload) => payload.turn ?? null } });
  const { driver } = driverOf(profile);
  await driver.handle('UserPromptSubmit', { ...base, turn: 't2', prompt: PROMPT });
  assert.deepEqual(await driver.handle('PostToolUse', { ...base, turn: 't1', tool_name: 'Read', tool_input: {} }), {});
  assert.ok((await driver.handle('PostToolUse', { ...base, turn: 't2', tool_name: 'Read', tool_input: {} })).hookSpecificOutput);
});

test('a session end waits for an open turn\'s end only as long as the host\'s session-end budget leaves', async () => {
  const made = memoryPorts();
  const profile = hookProfile({ turnEnd: { unclosed: { settleMs: 60_000, as: 'aborted' } }, budgets: { prompt: 8_000, sessionEnd: 1_500 } });
  const { driver, queued } = driverOf(profile, made);
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  const { sleep } = made.ports.clock;
  let waited = 0;
  made.ports.clock.sleep = (ms) => {
    waited += ms;
    return sleep(ms);
  };
  assert.deepEqual(await driver.handle('SessionEnd', base), {});
  assert.ok(waited <= 1_000, `it leaves the hook time to write (waited ${waited} ms)`);
  assert.equal(queued[0].report.evidence.aborted, true);
});

const LATE_EVENTS = { SessionStart: 'sessionStart', UserPromptSubmit: 'prompt', PostToolUse: 'toolResult', Stop: 'toolResult', SessionEnd: 'sessionEnd' };
const lateProfile = () => hookProfile({
  events: LATE_EVENTS,
  payload: { turnId: (payload) => payload.turn_id ?? null },
  reply: { lateAtToolResult: (hostEvent) => hostEvent === 'PostToolUse' },
});

// hookProfile's 8 s prompt budget leaves a recall at most the default 6 s ceiling.
const WAIT_CEILING_MS = 6_000;

function heldProxy(made) {
  const request = made.ports.proxy.request;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const timeouts = [];
  made.ports.proxy.request = async (method, path, body, options = {}) => {
    timeouts.push(options.timeoutMs ?? 0);
    if (options.timeoutMs > 0 && options.timeoutMs <= WAIT_CEILING_MS) throw new Error('timed out with the wait');
    await held;
    return request(method, path, body, options);
  };
  return { timeouts, release: () => { release(); made.ports.proxy.request = request; } };
}

test('a recall that misses the prompt is scheduled in the background and reaches the model at the next tool result, not at Stop', async () => {
  const made = memoryPorts();
  const proxy = heldProxy(made);
  const { driver, scheduled } = driverOf(lateProfile(), made);
  const turn = { ...base, turn_id: 't1' };
  const answer = await driver.handle('UserPromptSubmit', { ...turn, prompt: PROMPT });
  assert.equal(answer.hookSpecificOutput?.additionalContext, undefined, 'nothing landed in time');
  const task = scheduled.find((entry) => entry.startsWith('recall:'));
  assert.ok(task, 'the missed recall goes to the background');
  assert.ok(proxy.timeouts.every((timeoutMs) => timeoutMs > WAIT_CEILING_MS), 'a request cut at the wait would settle the recall empty and never defer it');
  const scheduledTurn = JSON.parse(task.slice('recall:'.length));
  assert.equal(scheduledTurn.turn, 1);
  assert.ok(Number.isFinite(scheduledTurn.sessionEpoch));
  assert.equal('prompt' in scheduledTurn, false, 'the task names the turn; the worker reads its prompt from the session');
  assert.equal(task.includes(PROMPT.slice(0, 12)), false);

  proxy.release();
  const { runBackgroundTasks } = await import('../../lib/app/background.js');
  assert.equal(await runBackgroundTasks(made.ports, [task]), true);

  const atStop = await driver.handle('Stop', { ...turn });
  assert.deepEqual(atStop, {}, 'Stop drops added context in this host, so it must not take the strategy');
  const atTool = await driver.handle('PostToolUse', { ...turn, tool_name: 'Write', tool_input: { file_path: '/proj/a.js' } });
  assert.equal(atTool.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(atTool.hookSpecificOutput.additionalContext, /Evolution Memory/);
  const session = await made.ports.sessions.read(base.session_id);
  assert.ok(Object.keys(session.injected).length > 0, 'the strategy is booked for this turn\'s reuse report');
  assert.deepEqual(await driver.handle('PostToolUse', { ...turn, tool_name: 'Write', tool_input: { file_path: '/proj/b.js' } }), {}, 'only one tool result takes it');
});

test('a background recall that lands after its turn closed leaves nothing waiting', async () => {
  const made = memoryPorts();
  const proxy = heldProxy(made);
  const { driver, scheduled } = driverOf(lateProfile(), made);
  await driver.handle('UserPromptSubmit', { ...base, turn_id: 't1', prompt: PROMPT });
  const task = scheduled.find((entry) => entry.startsWith('recall:'));
  await driver.handle('UserPromptSubmit', { ...base, turn_id: 't2', prompt: 'Now add a second retry policy to the uploader client' });
  proxy.release();
  const { runBackgroundTasks } = await import('../../lib/app/background.js');
  await runBackgroundTasks(made.ports, [task]);
  assert.equal((await made.ports.sessions.read(base.session_id)).waiting ?? null, null);
});

test('reply.lateAtToolResult refuses a host that already delivers at the tool result or answers late', () => {
  const lateAtToolResult = () => true;
  assert.throws(() => hookProfile({ reply: { strategyAt: 'tool-result', lateAtToolResult } }), /lateAtToolResult takes neither/);
  assert.throws(() => hookProfile({ reply: { late: (answer) => answer, lateAtToolResult } }), /lateAtToolResult takes neither/);
});
