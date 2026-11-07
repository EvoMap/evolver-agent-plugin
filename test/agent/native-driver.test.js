import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import profile from '../../hosts/kimi/profile.js';
import { createDriver } from '../../lib/agent/driver.js';
import { nativeFactsOf } from '../../lib/runtime/native-facts.js';
import { memoryPorts, PROMPT } from '../app/memory-ports.js';

const route = { alias: 'selected', providerId: 'account-b', model: 'upstream-model', protocol: 'openai', endpoint: 'https://example.test/v1', effort: 'off', binding: 'key-binding', configRevision: 'revision' };

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'evolver-native-driver-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, 'project'); mkdirSync(project);
  writeFileSync(join(home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { workspace: { root: project } } }));
  const agent = join(home, 'sessions/workspace/session/agents/main'); mkdirSync(agent, { recursive: true });
  const wire = join(agent, 'wire.jsonl');
  const add = (...records) => appendFileSync(wire, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  add({ type: 'metadata', protocol_version: '1.5' }, { type: 'profile.bind', agentId: 'main', modelAlias: 'selected', thinkingEffort: 'off' });
  const made = memoryPorts(), env = { KIMI_CODE_HOME: home };
  const captured = [];
  made.ports.model = { capture: hint => { captured.push(hint); return { ...route }; } };
  made.ports.native = nativeFactsOf(profile.native, env);
  const driver = createDriver({ profile, ports: made.ports, env, lifetime: 'ephemeral', transcripts: { size: () => 0, readSince: () => '' } });
  const payload = { session_id: 'session', cwd: project, client_type: 'kimi_code_cli' };
  const call = (event, extra = {}) => driver.handle(event, { ...payload, hook_event_name: event, ...extra });
  const id = profile.payload.sessionId(payload, { env, nativeScope: made.ports.native.scope });
  const loop = event => ({ type: 'context.append_loop_event', agentId: 'main', event });
  return { ...made, env, id, call, add, loop, project, agent, captured };
}

test('native driver captures the route and waits for both the terminal and an earlier background check', async t => {
  const f = fixture(t);
  const reply = await f.call('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  assert.match(reply.message, /Evolution Memory/);
  assert.deepEqual(f.captured[0], { alias: 'selected', effort: 'off' });
  assert.deepEqual(f.sessions.get(f.id).native.model, route);
  const job = f.scheduled.find(task => task.startsWith('native:'));
  assert.equal(JSON.parse(job.slice('native:'.length)).sessionEpoch, f.sessions.get(f.id).sessionEpoch);
  f.add({ type: 'turn.prompt', agentId: 'main', turnId: 0, promptId: 'prompt-a', origin: { kind: 'user' } });
  await f.call('TurnStarted', { turn_id: 0, origin_kind: 'user' });
  assert.equal(f.sessions.get(f.id).turnId, '0');
  await f.call('PreToolUse', { tool_name: 'Edit', tool_call_id: 'edit', tool_input: { path: 'a.js' } });
  f.add(
    f.loop({ type: 'tool.call', uuid: 'edit-call', turnId: 0, toolCallId: 'edit', name: 'Edit', args: { path: 'a.js' } }),
    f.loop({ type: 'tool.result', parentUuid: 'edit-call', toolCallId: 'edit', result: { output: '', durationMs: 2 } }),
    f.loop({ type: 'tool.call', uuid: 'lint-call', turnId: 0, toolCallId: 'lint', name: 'Bash', args: { command: 'npm run lint', run_in_background: true } }),
    f.loop({ type: 'tool.result', parentUuid: 'lint-call', toolCallId: 'lint', result: { output: 'task_id: lint-task\nstatus: running', durationMs: 2 } }),
    f.loop({ type: 'tool.call', uuid: 'check-call', turnId: 0, toolCallId: 'check', name: 'Bash', args: { command: 'npm test' } }),
    f.loop({ type: 'tool.result', parentUuid: 'check-call', toolCallId: 'check', result: { output: '# pass 1\n# fail 0', durationMs: 2 } }),
    { type: 'llm.request', agentId: 'main', modelAlias: 'selected', thinkingEffort: 'off', model: 'upstream-model', provider: 'openai' },
    f.loop({ type: 'content.part', uuid: 'answer', turnId: 0, stepUuid: 'final', part: { type: 'text', text: 'Fixed retries.' } }),
    f.loop({ type: 'step.end', uuid: 'final', turnId: 0, finishReason: 'end_turn', providerFinishReason: 'completed' }),
  );
  assert.deepEqual(await f.call('Stop'), {});
  assert.equal(f.sessions.get(f.id).open, true);
  assert.equal(f.queued.length, 0);
  f.add({ type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' });
  await f.call('Notification');
  assert.equal(f.sessions.get(f.id).open, false);
  assert.equal(f.sessions.get(f.id).native.pending, true);
  assert.deepEqual(await f.ports.candidates.read(), {});

  const tasks = join(f.agent, 'tasks');
  mkdirSync(tasks);
  writeFileSync(join(tasks, 'lint-task.json'), JSON.stringify({ taskId: 'lint-task', kind: 'process', parentToolCallId: 'lint', command: 'npm run lint', status: 'completed', exitCode: 0 }));
  await f.call('Notification');
  assert.equal(f.sessions.get(f.id).native.pending, false);
  const candidate = (await f.ports.candidates.read())[f.id];
  assert.deepEqual(candidate.model, route);
  assert.deepEqual(candidate.turns.map(({ turn, sessionEpoch }) => [turn, sessionEpoch]), [[1, f.sessions.get(f.id).sessionEpoch]]);
  assert.deepEqual(candidate.turns[0].steps.filter(({ kind }) => kind === 'check').map(({ command, exit, failed }) => ({ command, exit, failed })),
    [{ command: 'npm run lint', exit: 0, failed: false }, { command: 'npm test', exit: null, failed: false }]);
  assert.ok(f.retained[0].editedBefore.has(join(f.project, 'a.js')));
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].report.task_id.includes(f.env.KIMI_CODE_HOME), false, 'native profile paths stay out of Hub task identifiers');
  await f.call('Stop');
  assert.equal(f.queued.length, 1);
  await f.call('UserPromptSubmit', { prompt: [{ type: 'text', text: 'Now update docs.' }] });
  await f.call('Stop', { turn_id: 0 });
  assert.equal(f.sessions.get(f.id).open, true);
  assert.equal(f.sessions.get(f.id).turn, 2);
});

test('recall that outlives its session does not attach an old model binding to a recreated turn', async t => {
  const f = fixture(t);
  const requested = Promise.withResolvers(), resume = Promise.withResolvers();
  const request = f.ports.proxy.request;
  f.ports.proxy.request = async (...args) => {
    if (args[1] === '/recipe/search') {
      requested.resolve();
      await resume.promise;
    }
    return request(...args);
  };
  const prompt = f.call('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  await requested.promise;
  try {
    await f.ports.sessions.update(f.id, stored => ({ ...stored, sessionEpoch: stored.sessionEpoch + 1 }));
  } finally { resume.resolve(); }
  await prompt;
  assert.equal(f.sessions.get(f.id).native, undefined);
  assert.equal(f.scheduled.some(task => task.startsWith('native:')), false);
});

test('an explicit native session start leaves owner discovery to the first prompt', async t => {
  const f = fixture(t);
  const current = f.ports.owner.current;
  let probes = 0;
  f.ports.owner.current = () => { probes++; return current(); };
  assert.deepEqual(await f.call('SessionStart'), {});
  assert.equal(probes, 0);
  assert.ok(f.scheduled.includes('drain'));
  await f.call('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  assert.ok(probes > 0);
  assert.equal(f.sessions.get(f.id).pid, current());
});
