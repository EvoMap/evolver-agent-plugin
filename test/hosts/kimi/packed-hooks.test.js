import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';

import { endTree } from '../../../lib/runtime/process/spawn.js';
import { pack } from '../../../scripts/pack.mjs';
import { PROMPT } from '../../app/memory-ports.js';
import { closeProxyWhenSettled, fakeProxy } from '../../helpers/fake-proxy.js';

async function run(command, args, { env, cwd, input = '', shell = false, timeoutMs }) {
  const child = spawn(command, args, { env, cwd, shell, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  return new Promise((resolve, reject) => {
    const timer = timeoutMs ? setTimeout(() => {
      if (child.pid) endTree(child.pid);
      reject(new Error(command + ' exceeded its native hook budget'));
    }, timeoutMs) : undefined;
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function until(check) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = check(); if (result) return result;
    if (Date.now() >= deadline) throw new Error('Packed Kimi hook work did not settle');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function fixture(t, clientType = 'kimi_code_cli') {
  const proxy = await fakeProxy();
  let teardown = async () => {};
  const plugin = mkdtempSync(join(tmpdir(), "evolver Kimi user's gói "));
  t.after(async () => {
    try { await teardown(); }
    finally {
      rmSync(plugin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await closeProxyWhenSettled(proxy);
    }
  });
  pack('kimi', plugin);
  const home = join(proxy.env.HOME, 'native'), project = join(proxy.env.HOME, "project user's tiếng Việt");
  const agent = join(home, 'sessions', 'workspace_fixture', 'session-fixture', 'agents', 'main'), state = join(home, 'evolver');
  mkdirSync(agent, { recursive: true }); mkdirSync(project);
  writeFileSync(join(home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { workspace_fixture: { root: project, name: 'fixture', created_at: 1, last_opened_at: 1 } }, deleted_workspace_ids: [] }));
  const config = 'default_model = "route-a"\n[providers.account-a]\ntype = "openai"\nbase_url = "https://fixture.invalid/v1"\napi_key = "fixture-not-a-real-key"\n[models.route-a]\nprovider = "account-a"\nmodel = "fixture-model"\nmax_context_size = 32768\ncapabilities = ["tool_use"]\n';
  writeFileSync(join(home, 'config.toml'), config);
  const wire = join(agent, 'wire.jsonl');
  const append = (...records) => appendFileSync(wire, records.map(record => JSON.stringify(record) + '\n').join(''));
  append({ type: 'metadata', protocol_version: '1.5' }, { type: 'profile.bind', agentId: 'main', modelAlias: 'route-a', thinkingEffort: 'off' });
  const system = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const env = { ...system, HOME: proxy.env.HOME, USERPROFILE: proxy.env.HOME, KIMI_CODE_HOME: home, EVOMAP_PROXY_PORT: proxy.env.EVOMAP_PROXY_PORT, EVOLVER_AUTO_DISTILL: 'off', PATH: [dirname(process.execPath), process.env.PATH].join(delimiter) };
  const manifest = JSON.parse(readFileSync(join(plugin, 'kimi.plugin.json'), 'utf8'));
  const base = { session_id: 'session-fixture', cwd: project, client_type: clientType, is_steer: false };
  const hook = async (event, extra = {}, overrideEnv = {}) => {
    const handler = manifest.hooks.find(item => item.event === event); assert.ok(handler);
    const started = Date.now();
    // Kimi executes each plugin hook with the plugin root as cwd, while payload.cwd names the user's project.
    const result = await run(handler.command, [], { env: { ...env, ...overrideEnv }, cwd: plugin, shell: true, timeoutMs: handler.timeout * 1000, input: JSON.stringify({ ...base, hook_event_name: event, ...extra }) });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - started < handler.timeout * 1000, `${event} exceeded its native hook budget`);
    return JSON.parse(result.stdout);
  };
  const command = (...args) => run(process.execPath, [join(plugin, 'bin', 'command.mjs'), 'kimi', ...args], { env, cwd: project });
  const read = (name, fallback = {}) => existsSync(join(state, name)) ? JSON.parse(readFileSync(join(state, name), 'utf8')) : fallback;
  teardown = async () => {
    append({ type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'cancelled' });
    await hook('SessionEnd');
    // Delivery acknowledgement precedes lock release; owned detached workers use this HOME as their cwd.
    await until(() => !existsSync(join(state, 'kimi-outbox.lock'))
      && (!existsSync(join(state, 'kimi-turn-monitors')) || readdirSync(join(state, 'kimi-turn-monitors')).length === 0));
  };
  return { proxy, plugin, home, project, state, wire, append, hook, command, read, config };
}

test('packed CLI prompt hooks return Kimi message context, ignore unsupported clients and retain terminal preferences', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.hook('SessionStart'), {});
  const ignored = f.proxy.requests.length;
  assert.deepEqual(await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }], client_type: 'kimi_code_vscode' }), {});
  assert.deepEqual(await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }], is_steer: true }), {});
  assert.deepEqual(await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] }, { EVOLVER_HEADLESS: '1' }), {});
  assert.equal(f.proxy.requests.length, ignored);
  const answer = await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] });
  assert.match(answer.message, /maxRetriesPerRequest/);
  assert.equal(answer.decision, undefined, 'v1 never intercepts or blocks the native prompt');
  assert.equal(answer.hookSpecificOutput, undefined, 'Kimi consumes its own message response schema');
  f.append({ type: 'turn.prompt', agentId: 'main', turnId: 0, promptId: 'first-prompt', origin: { kind: 'user' }, input: [{ type: 'text', text: PROMPT }] });
  await f.hook('TurnStarted', { turn_id: 0, prompt_id: 'first-prompt', prompt: PROMPT, origin_kind: 'user' });
  f.append({ type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'cancelled' });
  await f.hook('Notification');
  const off = await f.command('evolver-config', 'recall', 'off');
  assert.equal(off.code, 0, off.stderr); assert.match(off.stdout, /off/);
  assert.equal(f.read('kimi-settings.json').recall, false);
  const recalls = f.proxy.requests.filter(item => item.path === '/asset/fetch').length;
  assert.deepEqual(await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] }), {});
  assert.equal(f.proxy.requests.filter(item => item.path === '/asset/fetch').length, recalls);
  f.append({ type: 'turn.prompt', agentId: 'main', turnId: 1, promptId: 'second-prompt', origin: { kind: 'user' }, input: [{ type: 'text', text: PROMPT }] });
  await f.hook('TurnStarted', { turn_id: 1, prompt_id: 'second-prompt', prompt: PROMPT, origin_kind: 'user' });
  f.append({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled' });
  await f.hook('Notification');
  assert.equal(readFileSync(join(f.home, 'config.toml'), 'utf8'), f.config);
  assert.equal(f.proxy.requests.some(item => item.path === '/asset/submit'), false);
});

for (const [client, clientType] of [
  ['CLI', 'kimi_code_cli'],
  ['Desktop', 'kimi_code_desktop'],
]) test(`packed ${client} hooks wait for the session log's terminal before confirming turn zero or queuing reuse`, async t => {
  const f = await fixture(t, clientType);
  await f.hook('SessionStart');
  assert.match((await f.hook('UserPromptSubmit', { prompt: [{ type: 'text', text: PROMPT }] })).message, /maxRetriesPerRequest/);
  f.append({ type: 'turn.prompt', agentId: 'main', turnId: 0, promptId: 'prompt-zero', origin: { kind: 'user' }, input: [{ type: 'text', text: PROMPT }] });
  await f.hook('TurnStarted', { turn_id: 0, prompt_id: 'prompt-zero', prompt: PROMPT, origin_kind: 'user' });
  const file = join(f.project, 'fixture.js'); writeFileSync(file, 'export const retries = 1;\n');
  const edit = { tool_call_id: 'edit-call', tool_name: 'Edit', tool_input: { path: file } };
  await f.hook('PreToolUse', edit);
  writeFileSync(file, 'export const retries = null;\n');
  f.append(
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.call', uuid: 'edit-uuid', toolCallId: 'edit-call', turnId: '0', name: 'Edit', args: { path: file } } },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.result', parentUuid: 'edit-uuid', toolCallId: 'edit-call', result: { output: 'Applied edit', durationMs: 1, isError: false } } },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.call', uuid: 'check-uuid', toolCallId: 'check-call', turnId: '0', name: 'Bash', args: { command: 'node --test' } } },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.result', parentUuid: 'check-uuid', toolCallId: 'check-call', result: { output: '# pass 1\n# fail 0', durationMs: 1, isError: false } } },
  );
  assert.deepEqual(await f.hook('Stop', { turn_id: 0 }), {});
  assert.deepEqual(f.read('kimi-distill-ranges.json'), {});
  assert.equal(f.proxy.requests.some(item => item.path === '/asset/reuse-result'), false);
  f.append(
    { type: 'llm.request', agentId: 'main', modelAlias: 'route-a', model: 'fixture-model', provider: 'openai', thinkingEffort: 'off' },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', uuid: 'answer-part', stepUuid: 'final-step', turnId: '0', part: { type: 'text', text: 'The repair passes the check.' } } },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'step.end', uuid: 'final-step', turnId: '0', finishReason: 'end_turn', providerFinishReason: 'completed' } },
    { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' },
  );
  await f.hook('Notification', { turn_id: 0 });
  const candidate = await until(() => Object.values(f.read('kimi-distill-ranges.json'))[0]);
  assert.deepEqual(candidate.turns.map(({ turn }) => turn), [1], 'native turn zero is the first internal turn');
  assert.deepEqual(candidate.model.selection, { alias: 'route-a', model: 'fixture-model', protocol: 'openai', effort: 'off' });
  assert.match(candidate.model.configDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(candidate).includes('fixture-not-a-real-key'), false);
  await until(() => f.proxy.requests.find(item => item.path === '/asset/reuse-result'));
  await f.hook('Notification'); await f.hook('SessionEnd');
  assert.equal(Object.keys(f.read('kimi-distill-ranges.json')).length, 1, 'manual distillation stays available with automatic completion off');
  assert.equal(f.proxy.requests.filter(item => item.path === '/asset/reuse-result').length, 1);
  assert.equal(f.proxy.requests.some(item => item.path === '/conversation/distill' || item.path === '/asset/submit'), false);
});
