import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DRAFTED } from '../../app/work-turns.js';
import { PROMPT, requestsTo, stepHost, until } from './host.js';

const assistant = (text, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason });

test('packed Step fixtures record locally without global npm and keep successive profiles isolated', async t => {
  const outside = mkdtempSync(join(tmpdir(), 'evolver-step-outside-'));
  const previous = { EVOLVER_HOME: process.env.EVOLVER_HOME, EVOMAP_HOME: process.env.EVOMAP_HOME };
  process.env.EVOLVER_HOME = outside;
  process.env.EVOMAP_HOME = outside;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(outside, { recursive: true, force: true });
  });
  for (const name of ['first profile', 'next profile with the same native session id']) await t.test(name, async t => {
    const host = await stepHost(t, { env: { PATH: '' } });
    const ledger = join(host.proxy.env.HOME, '.evomap', 'evolution', 'root_events.jsonl');
    assert.equal(existsSync(ledger), false, 'a fresh profile has no earlier reuse records');
    assert.deepEqual(await host.stores.candidates.read(), {});
    await host.emit('session_start');
    await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
    await host.emit('agent_start');
    await check(host, 0);
    await host.emit('turn_end', { turnIndex: 0, message: assistant('The bounded Redis retries passed the native check.') });
    await host.emit('agent_settled');
    await until(() => requestsTo(host, '/asset/reuse-result').length === 2, 'the Recipe step reports');
    await host.shutdown();
    const events = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter(({ type }) => type === 'value.reuse_hit').map(({ payload }) => payload), [
      { assetId: 'sha256:step1', cycleId: 'native-step-session', platform: 'stepcode', taskId: 'stepcode:native-step-session:1', tier: 'L1', stage: 'immediate' },
      { assetId: 'sha256:step2', cycleId: 'native-step-session', platform: 'stepcode', taskId: 'stepcode:native-step-session:1', tier: 'L1', stage: 'immediate' },
    ]);
    assert.equal(requestsTo(host, '/asset/reuse-result').length, 2, 'local recording does not resend to the Hub');
    assert.equal(existsSync(join(outside, 'evolution', 'root_events.jsonl')), false, 'the inherited ledger home stays untouched');
  });
});

async function check(host, exit, { callId = 'check-1', details = { execution: { status: 'exited', exitCode: exit } } } = {}) {
  const call = { toolName: 'run_command', toolCallId: callId, input: { command: 'node --test' } };
  await host.emit('tool_call', call);
  const result = { ...call, details, isError: false, content: [{ type: 'text', text: exit ? '# fail 1' : '# pass 1\n# fail 0' }] };
  await host.emit('tool_result', result);
  return result;
}

test('a packed Step extension projects the Recipe into this prompt only, without persisting it', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const messages = [{ role: 'user', content: PROMPT, timestamp: 1 }];
  const original = structuredClone(messages);
  const marker = '[Evolution Memory] Recipe: Stabilise flaky redis connection retries';
  const first = await host.emit('context', { messages });
  assert.ok(JSON.stringify(first.messages).includes(marker), 'the first model request receives the Recipe');
  const later = await host.emit('context', { messages });
  assert.ok(JSON.stringify(later.messages).includes(marker), 'later model steps of this prompt retain the Recipe');
  assert.deepEqual(messages, original, 'the native context input stays unchanged');
  assert.deepEqual(host.persisted, [], 'the Recipe is not written into the native session transcript');

  await host.emit('turn_end', { turnIndex: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'Explained the retry policy.' }], stopReason: 'stop' } });
  await host.emit('agent_settled');
  await host.emit('before_agent_start', { prompt: 'Explain a CSS colour.', systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const next = await host.emit('context', { messages: [{ role: 'user', content: 'Explain a CSS colour.', timestamp: 2 }] });
  assert.equal(JSON.stringify(next.messages).includes(marker), false, 'the previous Recipe does not leak into the next prompt');
  assert.deepEqual(host.persisted, []);
});

test('a native passing check reports its Recipe and keeps a candidate only after the logical turn settles', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const opened = await host.stores.sessions.read('native-step-session');
  assert.ok(opened.turnId && opened.turnId !== 'native-message');
  await check(host, 0);
  await host.emit('turn_end', { turnIndex: 0, message: assistant('', 'toolUse') });
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  await host.emit('turn_end', { turnIndex: 1, message: assistant('Bounded Redis retries and teardown passed the native check.') });
  assert.deepEqual(await host.stores.candidates.read(), {}, 'provider stop alone does not confirm completion');
  await host.emit('agent_settled');
  await until(() => requestsTo(host, '/asset/reuse-result').length === 2, 'the Recipe step reports');
  assert.deepEqual(requestsTo(host, '/asset/reuse-result').map(({ body }) => [body.task_id, body.outcome]), [
    ['stepcode:native-step-session:1', 'success'], ['stepcode:native-step-session:1', 'success'],
  ]);
  const range = (await host.stores.candidates.read())['native-step-session'];
  assert.equal(range.turns.length, 1);
  assert.deepEqual(range.turns[0].steps, [{ kind: 'check', command: 'node --test', exit: 0, failed: false }]);
  assert.deepEqual(range.model.selection, { providerId: 'fixture', modelId: 'fixture-model', variant: 'off' });
  assert.equal((await host.stores.sessions.read('native-step-session')).turnId, opened.turnId);
});

test('native exit 1 stays failed even when the tool result is not marked as an error', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 1);
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The native retry test is still failing; no repair has been verified.') });
  await host.emit('agent_settled');
  await until(() => requestsTo(host, '/asset/reuse-result').length === 2, 'the failed Recipe step reports');
  assert.deepEqual(requestsTo(host, '/asset/reuse-result').map(({ body }) => [body.outcome, body.evidence.check.passed]), [
    ['failed', false], ['failed', false],
  ]);
  const range = (await host.stores.candidates.read())['native-step-session'];
  assert.equal(range.turns[0].steps[0].exit, 1);
  assert.equal(range.turns[0].steps[0].failed, true);
  await host.commands.get('evolver-distill').handler('', host.ctx);
  assert.deepEqual(host.completion.calls, [], 'an unsuccessful check does not reach the private model');
  assert.deepEqual(await host.stores.drafts.read(), []);
  assert.deepEqual(requestsTo(host, '/conversation/distill'), []);
  assert.ok(host.notices.some(({ text }) => /last check failed/.test(text)));
});

test('Esc after a passing check and provider stop suppresses reports and candidates at settle', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 0);
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The native check passed before the user cancelled.') });
  host.abort();
  assert.equal(host.ctx.signal.aborted, true);
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
  assert.deepEqual(host.completion.calls, []);
  assert.equal((await host.stores.sessions.read('native-step-session')).open, false);
});

test('a native background command after a pass leaves the whole turn unverified', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 0);
  const background = { toolName: 'run_command', toolCallId: 'background-1', input: { command: 'node fixture-hold.cjs', run_in_background: true } };
  await host.emit('tool_call', background);
  await host.emit('tool_result', { ...background, details: { execution: { status: 'running' } }, isError: false,
    content: [{ type: 'text', text: 'Background command is still running.' }] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The test passed; the background command is still running.') });
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.drafts.read(), []);
});

test('a later native extension replacing check arguments cannot verify the original command', async t => {
  const host = await stepHost(t);
  host.api.on('tool_call', event => { event.input.command = 'echo no-check'; });
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const executed = await host.emit('tool_call', {
    toolName: 'run_command', toolCallId: 'replaced-check', input: { command: 'node --test' },
  });
  assert.equal(executed.input.command, 'echo no-check', 'later middleware changed the command actually executed');
  await host.emit('tool_result', { ...executed, details: { execution: { status: 'exited', exitCode: 0 } },
    isError: false, content: [{ type: 'text', text: 'no-check' }] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The echo command exited successfully; no test ran.') });
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
});

test('a result from a different native tool cannot complete a pending shell check', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await host.emit('tool_call', { toolName: 'run_command', toolCallId: 'foreign-check', input: { command: 'node --test' } });
  await host.emit('tool_result', { toolName: 'read_file', toolCallId: 'foreign-check', input: { path: 'fixture.txt' },
    details: { execution: { status: 'exited', exitCode: 0 } }, isError: false,
    content: [{ type: 'text', text: '# pass 1\n# fail 0' }] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The result belongs to a different tool; the test is unverified.') });
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
});

test('a later native extension changing an edit path invalidates the captured baseline', async t => {
  const host = await stepHost(t);
  host.api.on('tool_call', event => {
    if (event.toolName === 'write_file') event.input.path = 'actual-retry.json';
  });
  writeFileSync(join(host.ctx.cwd, 'original-retry.json'), '{"retries":0}');
  writeFileSync(join(host.ctx.cwd, 'actual-retry.json'), '{"retries":0}');
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 0);
  const executed = await host.emit('tool_call', { toolName: 'write_file', toolCallId: 'changed-edit',
    input: { path: 'original-retry.json', content: '{"retries":2}' } });
  assert.equal(executed.input.path, 'actual-retry.json');
  writeFileSync(join(host.ctx.cwd, executed.input.path), executed.input.content);
  await host.emit('tool_result', { ...executed, details: { changed: true }, isError: false,
    content: [{ type: 'text', text: 'File updated.' }] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The actual edit target has no captured pre-edit baseline.') });
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
});

test('a later native extension adding then_run leaves the whole turn unverified without inline result details', async t => {
  const host = await stepHost(t);
  host.api.on('tool_call', event => {
    if (event.toolName === 'write_file') event.input.then_run = 'node --test';
  });
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 0);
  const executed = await host.emit('tool_call', { toolName: 'write_file', toolCallId: 'inline-added',
    input: { path: 'retry.json', content: '{"retries":2}' } });
  assert.equal(executed.input.then_run, 'node --test');
  writeFileSync(join(host.ctx.cwd, executed.input.path), executed.input.content);
  await host.emit('tool_result', { ...executed, details: { changed: true }, isError: false,
    content: [{ type: 'text', text: 'File updated; inline execution metadata unavailable.' }] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The edit added an inline command after the earlier pass.') });
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
});

test('native configuration persists after reload and status commands do not start a model turn', async t => {
  const host = await stepHost(t, { env: { EVOLVER_RECALL: undefined } });
  await host.emit('session_start');
  await host.commands.get('evolver-config').handler('recall off', host.ctx);
  assert.ok(host.notices.some(({ text }) => /Recall: off/.test(text)));
  await host.reload();
  await host.emit('session_start');
  host.notices.length = 0;
  await host.commands.get('evolver-status').handler('', host.ctx);
  assert.ok(host.notices.some(({ text }) => /Recall: off/.test(text)), 'the reloaded extension reads the saved preference');
  await host.commands.get('evolver-drafts').handler('', host.ctx);
  assert.deepEqual(host.completion.calls, []);
  assert.deepEqual(host.persisted, []);
  const session = await host.stores.sessions.read('native-step-session');
  assert.equal(session.turn, 0);
  assert.equal(session.open, false);
});

test('shutdown after a pass without settled or end hooks discards the open turn and ignores late results', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 0);
  const held = { toolName: 'run_command', toolCallId: 'hold-1', input: { command: 'node fixture-hold.cjs' } };
  await host.emit('tool_call', held);
  host.abort();
  await host.shutdown();
  await host.emit('tool_result', { ...held, details: { execution: { status: 'exited', exitCode: 0 } }, isError: false, content: [] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('A late response must not reopen the cancelled turn.') });
  await host.emit('agent_settled');
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
  assert.equal((await host.stores.sessions.read('native-step-session')).open, false);
});

test('an inline then_run after an earlier pass leaves the whole turn unverified', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 0);
  const edit = { toolName: 'write_file', toolCallId: 'edit-1', input: { path: 'retry.json', content: '{"retries":2}', then_run: 'node --test' } };
  await host.emit('tool_call', edit);
  writeFileSync(join(host.ctx.cwd, 'retry.json'), edit.input.content);
  await host.emit('tool_result', { ...edit, details: { thenRun: { execution: { status: 'exited', exitCode: 1 } } },
    isError: false, content: [{ type: 'text', text: '# fail 1' }] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The edit ran an inline test after the earlier pass.') });
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
});

for (const [name, details, paired, isError] of [
  ['missing execution metadata', {}, true, false],
  ['a result without a matching native call', { execution: { status: 'exited', exitCode: 0 } }, false, false],
  ['contradictory error and exit metadata', { execution: { status: 'exited', exitCode: 0 } }, true, true],
]) test(`${name} cannot verify a turn from passing text`, async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const call = { toolName: 'run_command', toolCallId: 'unverified-1', input: { command: 'node --test' } };
  if (paired) await host.emit('tool_call', call);
  await host.emit('tool_result', { ...call, details, isError, content: [{ type: 'text', text: '# pass 1\n# fail 0' }] });
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The output text says passed, but native evidence must decide.') });
  await host.emit('agent_settled');
  await host.shutdown();
  assert.deepEqual(requestsTo(host, '/asset/reuse-result'), []);
  assert.deepEqual(await host.stores.candidates.read(), {});
  assert.deepEqual(await host.stores.drafts.read(), []);
});

test('duplicate native completion notifications do not duplicate the check or its reports', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const result = await check(host, 0);
  await host.emit('tool_execution_end', result);
  await host.emit('tool_result', result);
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The check completed once despite duplicated notifications.') });
  await host.emit('agent_settled');
  await host.emit('agent_settled');
  await until(() => requestsTo(host, '/asset/reuse-result').length === 2, 'the single pair of Recipe reports');
  const range = (await host.stores.candidates.read())['native-step-session'];
  assert.equal(range.turns.length, 1);
  assert.equal(range.turns[0].steps.filter(step => step.kind === 'check').length, 1);
  assert.equal(requestsTo(host, '/asset/reuse-result').length, 2);
});

test('the plugin headless marker registers no native hooks or commands', async t => {
  const host = await stepHost(t, { env: { EVOLVER_HEADLESS: '1' } });
  assert.equal(host.handlers.size, 0);
  assert.equal(host.commands.size, 0);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const messages = [{ role: 'user', content: PROMPT, timestamp: 1 }];
  assert.deepEqual((await host.emit('context', { messages })).messages, messages);
  assert.deepEqual(host.proxy.requests, []);
  assert.deepEqual(host.completion.calls, []);
  assert.deepEqual(host.persisted, []);
});

test('an explicit native distill command creates only a private draft using the captured model', async t => {
  const host = await stepHost(t, { distillAnswer: DRAFTED });
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  await check(host, 0);
  await host.emit('turn_end', { turnIndex: 0, message: assistant('The bounded Redis retry policy passed its native check.') });
  await host.emit('agent_settled');
  await host.commands.get('evolver-distill').handler('bounded Redis retries', host.ctx);
  const drafts = await host.stores.drafts.read();
  assert.equal(drafts.length, 1);
  assert.equal(host.completion.calls.length, 1);
  const call = host.completion.calls[0];
  assert.equal(call.model.provider, 'fixture');
  assert.equal(call.model.id, 'fixture-model');
  assert.equal(call.options.apiKey, 'private-fixture-key');
  assert.deepEqual(call.context.tools, []);
  assert.equal(call.context.messages.length, 1);
  assert.equal(call.context.systemPrompt, undefined);
  assert.equal(requestsTo(host, '/conversation/distill').length, 1);
  assert.deepEqual(requestsTo(host, '/asset/submit'), []);
  assert.deepEqual(host.persisted, [], 'command results do not inject another native agent prompt');
  assert.equal((await host.stores.sessions.read('native-step-session')).turn, 1);
  assert.doesNotMatch(JSON.stringify(drafts), /private-fixture-key|private-account/);
});

test('a search shown only in native UI is not booked as model-visible strategy', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.commands.get('evolver-search').handler(PROMPT, host.ctx);
  assert.ok(host.notices.some(({ text }) => text.includes('[Evolution Memory] Recipe: Stabilise flaky redis connection retries')));
  const session = await host.stores.sessions.read('native-step-session');
  assert.deepEqual(session.injected, {});
  assert.equal(session.turn, 0);
  assert.deepEqual(host.triggered, []);
  assert.deepEqual(host.persisted, []);
  assert.deepEqual(host.completion.calls, []);
});

test('the explicit evolution command forwards one native agent prompt and keeps its command identity', async t => {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.commands.get('evolver-evolve').handler('retry timing', host.ctx);
  assert.equal(host.triggered.length, 1);
  const forwarded = host.triggered[0].content;
  assert.match(forwarded, /^Take a deliberate evolution step/);
  assert.match(forwarded, /Focus on: retry timing/);
  assert.deepEqual(host.completion.calls, [], 'the native host receives a prompt instead of a private SDK completion');
  await host.emit('before_agent_start', { prompt: forwarded, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  assert.equal((await host.stores.sessions.read('native-step-session')).isCommand, true);
  await host.emit('before_agent_start', { prompt: 'Explain a CSS colour.', systemPrompt: 'Base instructions.' });
  assert.equal((await host.stores.sessions.read('native-step-session')).isCommand, false, 'the marker is consumed by its own prompt');
});
