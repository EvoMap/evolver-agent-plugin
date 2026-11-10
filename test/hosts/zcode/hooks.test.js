import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { pack } from '../../../scripts/pack.mjs';
import profile from '../../../hosts/zcode/profile.js';
import { createDriver } from '../../../lib/agent/driver.js';
import { promptSubmitted } from '../../../lib/app/prompt.js';
import { turnEnded } from '../../../lib/app/turn-end.js';
import { modelRunnerOf } from '../../../lib/runtime/model-executor.js';
import { PROMPT, RECIPE, RECIPE_STEPS, memoryPorts } from '../../app/memory-ports.js';
import { IR } from '../../app/work-turns.js';
import { closeProxyWhenSettled, fakeProxy } from '../../helpers/fake-proxy.js';

async function fixture(t) {
  const proxy = await fakeProxy({ recipes: [RECIPE], stepAssets: RECIPE_STEPS, distillAnswer: {
    ok: true, status: 'draft', distill_id: 'zcode-private-draft', quality: { ok: true },
    gene: { asset_id: 'gene_fixture' }, capsule: { asset_id: 'capsule_fixture', summary: 'Verify retries in isolation.' },
    publishable: false,
  } });
  const home = proxy.env.HOME;
  const plugin = join(home, 'packed plugin');
  const state = join(home, 'plugin data');
  const dbDir = join(home, '.zcode', 'cli', 'db');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000');
  t.after(async () => {
    db.close();
    await closeProxyWhenSettled(proxy);
  });
  db.exec('CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, completed_at INTEGER, PRIMARY KEY (session_id, turn_id))');
  db.exec('ALTER TABLE turn_usage ADD COLUMN user_message_id TEXT');
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE model_usage (session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT, query_source TEXT, status TEXT)');
  const providerFile = join(home, 'provider.json');
  const builtinFile = join(home, 'builtin.json');
  writeFileSync(builtinFile, JSON.stringify({ schemaVersion: 1, revision: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: 'unrelated-account' }] },
    modelConfigRules: { modelRules: [], modelApiRules: [] },
  } }));
  writeFileSync(providerFile, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: 'test-account', providerName: 'Fixture', config: {
      group: 'standard-personal', access: { type: 'api-key', apiKey: 'fixture-private-value' },
      api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:2345/v1' }, personalModelIds: ['model-a'],
    } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  } }));
  pack('zcode', plugin);
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks;
  const cli = join(home, 'standalone CLI', 'zcode.cjs');
  const env = { ...proxy.env, LOCALAPPDATA: home, ZCODE_PLUGIN_DATA: state, ZCODE_DATA_BASE_DIR: home, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerFile,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile, ZCODE_CLI_PATH: cli, EVOLVER_AUTO_DISTILL: 'off' };
  const entry = async (name, args, input) => {
    const child = spawn(process.execPath, [join(plugin, 'bin', name), ...args], { env, cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(input);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr);
    return stdout;
  };
  async function hook(event, extra = {}) {
    const handler = hooks[event][0].hooks[0];
    assert.equal(handler.type, 'process');
    assert.equal(handler.command, 'node');
    const args = handler.args.map(arg => arg.replace('${ZCODE_PLUGIN_ROOT}', plugin));
    assert.equal(args[0].replaceAll('\\', '/'), join(plugin, 'bin', 'hook.mjs').replaceAll('\\', '/'));
    return JSON.parse(await entry('hook.mjs', args.slice(1), JSON.stringify({ sessionId: 's1', turnId: 't1', cwd: home, hookEventName: event, ...extra })));
  }
  const read = (name, empty) => {
    try { return JSON.parse(readFileSync(join(state, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return empty; throw error; }
  };
  const session = () => {
    const name = readdirSync(state).find(file => /^zcode-session-.*\.json$/.test(file));
    return read(name, {});
  };
  const status = (turnId, value) => db.prepare('INSERT OR REPLACE INTO turn_usage VALUES (?, ?, ?, ?, ?)')
    .run('s1', turnId, value, value === 'running' ? null : Date.now(), `msg-${turnId}`);
  const selection = { providerId: 'test-account', modelId: 'model-a', options: { reasoningLevel: 'enabled' } };
  const route = (turnId) => {
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(`msg-${turnId}`, 's1', JSON.stringify({ modelSelection: selection }));
    db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('s1', turnId, selection.providerId, selection.modelId, 'enabled', 'main_turn', 'completed');
    db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('s1', turnId, 'other-account', 'title-model', null, 'title', 'completed');
  };
  return { proxy, hook, read, session, status, selection, route, home, env, providerFile, entry };
}

function appServer(f, file = f.env.ZCODE_CLI_PATH) {
  const record = join(f.home, 'fixture-request.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const cwd = process.cwd();
    require('node:readline').createInterface({ input: process.stdin }).once('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      assert.equal(method, 'workspace/generateText');
      assert.deepEqual(params.tools, []);
      assert.equal(fs.realpathSync(params.workspace.workspacePath), cwd);
      assert.equal(process.env.EVOLVER_HEADLESS, '1');
      assert.equal(process.env.ZCODE_PLUGIN_DATA, undefined);
      assert.equal(process.env.ZCODE_CLI_PATH, undefined);
      assert.ok(fs.existsSync(path.join(cwd, '.evolver-headless')));
      assert.equal(fs.readFileSync(path.join(cwd, '.env'), 'utf8'), '');
      const config = JSON.parse(fs.readFileSync(path.join(cwd, '.zcode/cli/config.json')));
      assert.ok(!config.plugins.enabled && !config.hooks.enabled && !config.mcp.enabled);
      const source = JSON.parse(fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE));
      const builtin = JSON.parse(fs.readFileSync(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE));
      assert.deepEqual(builtin.config.providerConfigRules.providerRules, []);
      const [rule] = source.config.providerConfigRules.providerRules;
      assert.equal(source.config.providerConfigRules.providerRules.length, 1);
      assert.equal(rule.providerId, 'test-account');
      assert.equal(rule.config.access.apiKey, 'fixture-private-value');
      assert.deepEqual(params.selection, source.config.defaultModelSelection);
      const child = params.prompt === 'cancel' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']) : null;
      fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd, pid: process.pid, child: child?.pid, selection: params.selection }));
      if (child) return;
      const text = ${JSON.stringify(JSON.stringify(IR))};
      const reply = JSON.stringify({ id, result: { selection: params.selection, finishReason: 'stop', text } });
      process.stdout.write(reply.slice(0, 12));
      setImmediate(() => process.stdout.write(reply.slice(12) + '\\n'));
    });
  `);
  return record;
}

async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  assert.fail('ZCode turn did not settle');
}

const shell = (turnId, toolCallId, exitCode, command = 'node --test') => ({
  turnId, toolCallId, toolName: 'Bash', toolInput: { command },
  toolResponse: { status: exitCode === 0 ? 'completed' : 'failed', exitCode, interrupted: false, timedOut: false, cancelled: false },
});

const ranges = (f) => f.read('zcode-distill-ranges.json', {});
const reports = (f) => f.proxy.requests.filter(request => request.path === '/asset/reuse-result');

test('packed ZCode prompt hook injects a Recipe in step order and skips duplicate prompt delivery', async t => {
  const f = await fixture(t);
  f.status('t1', 'running');
  const first = await f.hook('UserPromptSubmit', { prompt: PROMPT });
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(first.hookSpecificOutput.additionalContext, /Unbound redis retries[\s\S]+Close the redis client/);
  assert.deepEqual(await f.hook('UserPromptSubmit', { prompt: PROMPT }), {});
  assert.equal(f.proxy.requests.filter(request => request.path === '/recipe/search').length, 1);
  f.status('t1', 'cancelled');
  await until(() => f.session().open === false && !f.session().settling);
});

test('only matching native turn and tool IDs count towards a verified turn', async t => {
  const f = await fixture(t);
  await delay(2_000);
  f.status('t1', 'running');
  await f.hook('UserPromptSubmit', { prompt: PROMPT });
  const check = shell('t1', 'check', 0);
  for (const item of [shell('t1', 'info', 0, 'node --version'), shell('t1', 'cwd', 0, 'git status'), check]) {
    await f.hook('PreToolUse', item);
    await f.hook('PostToolUse', item);
  }
  await f.hook('PostToolUse', check);
  await f.hook('PostToolUse', shell('stale-turn', 'check', 7));
  await f.hook('PostToolUse', shell(undefined, 'check', 7));
  await f.hook('Stop', { last_assistant_message: 'The test passed after the repair.' });
  assert.deepEqual(ranges(f), {});
  f.route('t1');
  f.status('t1', 'completed');
  await until(() => Boolean(ranges(f).s1) && !f.session().settling);
  const range = ranges(f).s1;
  assert.equal(range.turns.length, 1);
  assert.deepEqual(range.turns[0].steps, [
    { kind: 'command', command: 'node --version' },
    { kind: 'command', command: 'git status' },
    { kind: 'check', command: 'node --test', exit: 0, failed: false },
  ]);
  assert.deepEqual(range.model?.selection, f.selection);
  assert.equal(range.pid, f.session().pid);
  assert.doesNotMatch(JSON.stringify(range), /fixture-private-value/);
  await until(() => reports(f).length === 2);
  assert.ok(reports(f).every(request => request.body.outcome === 'success' && request.body.evidence.check.passed));

  const marker = appServer(f);
  assert.equal(existsSync(join(f.home, 'Programs', 'ZCode')), false);
  const originalConfig = readFileSync(f.providerFile, 'utf8');
  writeFileSync(f.providerFile, originalConfig.replace('fixture-private-value', 'fixture-rotated-value'));
  assert.match(await f.entry('command.mjs', ['zcode', 'evolver-distill']), /blocked \(route_changed\)/);
  assert.equal(existsSync(marker), false);
  assert.equal(f.proxy.requests.some(({ path }) => path === '/conversation/distill'), false);

  writeFileSync(f.providerFile, originalConfig);
  assert.match(await f.entry('command.mjs', ['zcode', 'evolver-distill']), /into a draft/);
  const request = JSON.parse(readFileSync(marker, 'utf8'));
  assert.deepEqual(request.selection, f.selection);
  assert.equal(existsSync(request.cwd), false);
  assert.equal(f.read('zcode-distill-drafts.json', [])[0]?.publishable, false);
  assert.equal(f.proxy.requests.filter(({ path }) => path === '/conversation/distill').length, 1);
  const { ir_version, ir, publish } = f.proxy.requests.find(({ path }) => path === '/conversation/distill').body;
  assert.deepEqual([ir_version, ir, publish], ['session-gene-ir-v1', IR, false]);
  assert.equal(f.proxy.requests.some(({ path }) => path === '/asset/submit'), false);
});

test('cancelled background completion removes its temporary profile and process tree', async t => {
  const f = await fixture(t);
  const marker = appServer(f);
  const runner = modelRunnerOf(profile.model, f.env);
  await delay(2_000);
  const configDigest = runner.configStamp().split(':').at(-1);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const completed = assert.rejects(runner.complete({ configDigest, selection: f.selection }, 'cancel', controller.signal), { name: 'AbortError' });
  await until(() => existsSync(marker));
  const { cwd, pid, child } = JSON.parse(readFileSync(marker, 'utf8'));
  assert.ok(child && existsSync(cwd));
  controller.abort();
  await completed;
  assert.equal(existsSync(cwd), false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  if (process.platform === 'win32') assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
});

test('Desktop runs its bundled CLI when no explicit CLI path is configured', async (t) => {
  const f = await fixture(t);
  const file = join(f.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
  const marker = appServer(f, file);
  const runner = modelRunnerOf(profile.model, f.env);
  const model = { configDigest: null, selection: f.selection };
  await assert.rejects(runner.complete(model, 'blocked'), { code: 'MODEL_UNAVAILABLE', reason: 'unsafe_runtime' });
  assert.equal(existsSync(marker), false);

  delete f.env.ZCODE_CLI_PATH;
  const desktop = modelRunnerOf(profile.model, f.env);
  await delay(2_000);
  model.configDigest = desktop.configStamp().split(':').at(-1);
  const { answer } = await desktop.complete(model, 'verify fixture');
  assert.deepEqual(JSON.parse(answer), IR);
  const request = JSON.parse(readFileSync(marker, 'utf8'));
  assert.deepEqual(request.selection, f.selection);
  assert.equal(existsSync(request.cwd), false);
});

test('native cancellation after a test pass closes the turn without reuse reports or candidates', async t => {
  const f = await fixture(t);
  f.status('t1', 'running');
  await f.hook('UserPromptSubmit', { prompt: PROMPT });
  for (const item of [shell('t1', 'info', 0, 'node --version'), shell('t1', 'cwd', 0, 'git status'), shell('t1', 'check', 0)]) {
    await f.hook('PreToolUse', item);
    await f.hook('PostToolUse', item);
  }
  // A Stop callback can run before the host continues and the user presses Stop.
  await f.hook('Stop', { responseText: 'The test passed after the repair.' });
  assert.equal(f.session().open, true);
  f.status('t1', 'cancelled');
  await until(() => !f.session().open && !f.session().settling);
  assert.deepEqual(ranges(f), {});
  assert.deepEqual(reports(f), []);
  assert.deepEqual(f.read('zcode-reports-outbox.json', {}), {});
  assert.deepEqual(f.session().labelable, []);
  assert.equal(f.read('zcode-distill-drafts.json', []).length, 0);
  f.status('t2', 'running');
  await f.hook('UserPromptSubmit', { turnId: 't2', prompt: 'Thanks, it looks good.' });
  assert.deepEqual(reports(f), []);
  f.status('t2', 'cancelled');
  await until(() => !f.session().open && !f.session().settling);
});

test('a later unfinished check cannot promote an earlier pass on a completed turn', async t => {
  const f = await fixture(t);
  f.status('t1', 'running');
  await f.hook('UserPromptSubmit', { prompt: PROMPT });
  for (const item of [shell('t1', 'info', 0, 'node --version'), shell('t1', 'cwd', 0, 'git status'), shell('t1', 'check', 0)]) {
    await f.hook('PreToolUse', item);
    await f.hook('PostToolUse', item);
  }
  await f.hook('PreToolUse', shell('t1', 'pending-check', 0, 'npm test'));
  await f.hook('Stop', { responseText: 'The test passed after the repair.' });
  f.status('t1', 'completed');
  await until(() => !f.session().open && !f.session().settling);
  assert.deepEqual(ranges(f), {});
  assert.deepEqual(reports(f), []);
});

test('a check result and Stop re-arm native status observation for a long turn', async () => {
  const { ports, scheduled } = memoryPorts();
  ports.confirmTurnCompletion = true;
  ports.turnStatus = () => null;
  const driver = createDriver({ profile, ports, lifetime: 'ephemeral' });
  const base = { sessionId: 's1', turnId: 't1', cwd: process.cwd() };
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  const { turn, turnId, sessionEpoch } = await ports.sessions.read('s1');
  const task = `turn:${JSON.stringify({ sessionId: 's1', projectDir: base.cwd, turnId: 't1', expectedTurn: { turn, turnId, sessionEpoch } })}`;
  assert.ok(scheduled.includes(task));
  scheduled.length = 0;
  await driver.handle('PostToolUse', { ...base, ...shell('old', 'old-check', 0) });
  await driver.handle('PreToolUse', { ...base, ...shell('t1', 'check', 0) });
  assert.deepEqual(scheduled, []);
  await driver.handle('PostToolUse', { ...base, ...shell('t1', 'check', 0) });
  await driver.handle('Stop', { ...base, responseText: 'The check finished.' });
  assert.deepEqual(scheduled, [task, task]);
});

test('a captured range keeps its route when a later turn changes account or has no proven route', async () => {
  const { ports, advance } = memoryPorts();
  ports.confirmTurnCompletion = true;
  ports.settings = { recall: false };
  const route = {
    configDigest: 'digest-a',
    selection: { providerId: 'account-a', modelId: 'model-a', options: { reasoningLevel: 'low' } },
  };
  const record = { edits: [], commands: ['node --test'], checks: [{ command: 'node --test', exit: 0, failed: false }], answer: 'The test passed.' };
  const sessionId = 's1';
  for (const model of [route, route, { ...route, selection: { ...route.selection, providerId: 'account-b' } }, { unavailable: 'route_changed' }]) {
    advance(10);
    const turnId = `t${ports.clock.now()}`;
    ports.modelForTurn = () => model;
    await promptSubmitted(ports, { sessionId, turnId, prompt: PROMPT });
    await turnEnded(ports, { sessionId, turnId, reason: 'answer', recordOf: () => record });
  }
  const range = (await ports.candidates.read()).s1;
  assert.deepEqual(range.model, route);
  assert.deepEqual(range.turns.map(({ turn }) => turn), [1, 2]);
});
