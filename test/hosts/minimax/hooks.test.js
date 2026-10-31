import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { PROMPT } from '../../app/memory-ports.js';
import { closeProxyWhenSettled, fakeProxy } from '../../helpers/fake-proxy.js';

const fakeCli = fileURLToPath(new URL('../../fixtures/minimax/fake-mcode.mjs', import.meta.url));
const DRAFT = { ok: true, status: 'draft', distill_id: 'native-hook-draft', quality: { ok: true, score: 6 }, gene: { type: 'Gene', asset_id: `sha256:${'1'.repeat(64)}` }, capsule: { type: 'Capsule', asset_id: `sha256:${'2'.repeat(64)}` } };

async function run(command, args, { env, cwd, input = '', shell = false }) {
  const child = spawn(command, args, { env, cwd, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
}

async function until(check) {
  const deadline = Date.now() + 20000;
  for (;;) { const result = check(); if (result) return result; if (Date.now() >= deadline) throw new Error('MiniMax hook work did not settle'); await new Promise(resolve => setTimeout(resolve, 50)); }
}

async function fixture(t) {
  const proxy = await fakeProxy({ distillAnswer: DRAFT });
  const plugin = mkdtempSync(join(tmpdir(), "evolver MiniMax user's gói ")); pack('minimax', plugin);
  const data = join(proxy.env.HOME, 'native'), project = join(proxy.env.HOME, "workspace user's tiếng Việt"), bin = join(proxy.env.HOME, "runtime user's & bin");
  const state = join(data, 'v2/plugin-data/hooks/evolver-plugin');
  for (const dir of [join(data, 'v2/sqlite'), project, bin]) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(data, 'v2/sqlite/runtime-state.sqlite'));
  db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, extra_data_json TEXT); CREATE TABLE local_runtime_session_agent_definitions (session_id TEXT PRIMARY KEY, definition_json TEXT); CREATE TABLE local_runtime_turn_ingress (session_id TEXT, turn_id TEXT, status TEXT)');
  db.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?)').run('s1', JSON.stringify({ effectiveModel: 'custom_provider:first/model-a' }));
  writeFileSync(join(data, 'config.yaml'), 'defaultModel: custom_provider:second/model-b\n');
  const originalConfig = readFileSync(join(data, 'config.yaml'), 'utf8');
  const log = join(proxy.env.HOME, 'mcode.jsonl');
  writeFileSync(join(bin, 'mcode.cmd'), `@echo off\r\n"%FAKE_MINIMAX_NODE%" "${fakeCli}" %*\r\n`);
  writeFileSync(join(bin, 'mcode'), `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('../../fixtures/minimax/fake-mcode.mjs', import.meta.url).href)});\n`); chmodSync(join(bin, 'mcode'), 0o755);
  const system = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => proxy.env[key]).map(key => [key, proxy.env[key]]));
  const env = { ...system, HOME: proxy.env.HOME, USERPROFILE: proxy.env.HOME, PLUGIN_ROOT: plugin, PLUGIN_DATA: state, MINIMAX_DATA_DIR: data, MAVIS_DATA_DIR: data, FAKE_MINIMAX_NODE: process.execPath, FAKE_MINIMAX_LOG: log, PATH: [bin, dirname(process.execPath)].join(delimiter) };
  delete env.EVOLVER_RECALL; delete env.EVOLVER_AUTO_DISTILL;
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks;
  const base = { session_id: 's1', turn_id: 't1', cwd: project, model: 'model-a' };
  const hook = async (event, extra = {}) => {
    const handler = hooks[event][0].hooks[0];
    const windows = process.platform === 'win32';
    const started = Date.now();
    const result = await run(windows ? handler.commandWindows : '/bin/sh', windows ? [] : ['-c', handler.command], { env, cwd: project, shell: windows, input: JSON.stringify({ ...base, hook_event_name: event, ...extra }) });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - started < handler.timeout * 1000, `${event} exceeded its native hook budget`);
    return JSON.parse(result.stdout);
  };
  const read = (name, fallback) => existsSync(join(state, name)) ? JSON.parse(readFileSync(join(state, name), 'utf8')) : fallback;
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const verified = async () => {
    await hook('UserPromptSubmit', { prompt: PROMPT });
    const file = join(project, 'fixture.txt'); writeFileSync(file, 'before');
    const edit = { tool_name: 'edit', tool_input: { file_path: file, old_string: 'before', new_string: 'after' } };
    await hook('PreToolUse', edit); writeFileSync(file, 'after'); await hook('PostToolUse', { ...edit, tool_response: { details: { diff: '-before\n+after' } } });
    for (const exit of [1, 0]) {
      const actual = await run(process.execPath, ['-e', `process.exit(${exit})`], { env, cwd: project });
      await hook('PostToolUse', { tool_name: 'bash', tool_input: { command: 'node --test' }, tool_response: { details: { execution: { reason: 'exited', exitCode: actual.code }, processOutput: { stdout: exit ? '# fail 1' : '# pass 1\n# fail 0', stderr: '', interrupted: false } } } });
    }
    await hook('Stop', { last_assistant_message: 'The retry check now passes after the repair.' });
  };
  t.after(async () => {
    await until(() => !existsSync(join(state, 'minimax-outbox.lock')));
    db.close(); rmSync(plugin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await closeProxyWhenSettled(proxy);
  });
  return { proxy, plugin, data, state, env, project, db, hook, read, calls, verified, originalConfig };
}

test('packed shell hooks persist settings across processes, expose status in chat and keep manual distill available', async t => {
  const f = await fixture(t);
  assert.equal((await f.hook('UserPromptSubmit', { prompt: 'evolver-status recall off' })).decision, 'block');
  const recalls = f.proxy.requests.filter(x => x.path === '/asset/fetch').length;
  assert.equal((await f.hook('UserPromptSubmit', { prompt: PROMPT })).hookSpecificOutput, undefined);
  assert.equal(f.proxy.requests.filter(x => x.path === '/asset/fetch').length, recalls);
  await f.hook('UserPromptSubmit', { prompt: 'evolver-status auto-distill off' });
  await f.verified(); await f.hook('SessionEnd');
  assert.equal(f.calls().length, 0);
  assert.equal(f.read('minimax-settings.json').autoDistill, false);
  const manual = await run(process.execPath, [join(f.plugin, 'bin/command.mjs'), 'minimax', 'evolver-distill'], { env: { ...f.env, EVOLVER_SESSION_ID: 's1' }, cwd: f.project });
  assert.equal(manual.code, 0, manual.stderr);
  assert.match(manual.stdout, /into a draft/);
  assert.equal(f.read('minimax-distill-drafts.json', []).length, 1);
  assert.equal(readFileSync(join(f.data, 'config.yaml'), 'utf8'), f.originalConfig);
  assert.equal(f.proxy.requests.some(x => x.path === '/asset/submit'), false);
});

test('automatic distill uses the captured session route after another model becomes current and settles only once', async t => {
  const f = await fixture(t); await f.verified();
  assert.deepEqual(f.read('minimax-distill-pending.json').s1.model, { model: 'custom_provider:first/model-a' });
  f.db.prepare('UPDATE local_runtime_sessions SET extra_data_json = ?').run(JSON.stringify({ effectiveModel: 'custom_provider:second/model-b' }));
  await f.hook('SessionEnd');
  await until(() => f.read('minimax-distill-drafts.json', []).length === 1 && !f.read('minimax-distill-pending.json', {}).s1);
  const [call] = f.calls();
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'custom_provider:first/model-a');
  assert.equal(call.marker, '1'); assert.equal(existsSync(call.cwd), false);
  await f.hook('SessionStart');
  assert.equal(f.calls().length, 1);
  assert.equal(f.proxy.requests.filter(x => x.path === '/conversation/distill').length, 1);
  assert.equal(f.proxy.requests.some(x => x.path === '/asset/submit'), false);
});

test('a chat distill runs in a detached worker, reports its result in chat, and leaves publication explicit', async t => {
  const f = await fixture(t); await f.verified();
  const admission = await f.hook('UserPromptSubmit', { prompt: 'evolver-distill retry handling' });
  assert.equal(admission.decision, 'block');
  const id = /Job ([0-9a-f-]+):/.exec(admission.reason)?.[1]; assert.ok(id);
  const job = await until(() => { const value = f.read('minimax-commands/commands.json', []).find(item => item.id === id); return value?.state === 'completed' ? value : null; });
  assert.equal(job.sessionId, 's1'); assert.equal(job.projectDir, f.project);
  const result = await f.hook('UserPromptSubmit', { prompt: `evolver-status job ${id}` });
  assert.equal(result.decision, 'block'); assert.match(result.reason, /into a draft/);
  assert.equal(f.read('minimax-distill-drafts.json', []).length, 1);
  assert.equal(f.calls().length, 1);
  assert.equal(f.proxy.requests.some(item => item.path === '/asset/submit'), false);
});

test('native cancellation closes the matching turn through its durable status, without Stop or another prompt', async t => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO local_runtime_turn_ingress VALUES (?, ?, ?)').run('s1', 't1', 'accepted');
  await f.hook('UserPromptSubmit', { prompt: PROMPT });
  f.db.prepare('UPDATE local_runtime_turn_ingress SET status = ?').run('aborted');
  await until(() => f.proxy.requests.some(item => item.path === '/asset/reuse-result' && item.body.outcome === 'failed' && item.body.evidence.aborted));
  assert.deepEqual(f.read('minimax-distill-pending.json', {}), {});
  assert.equal(f.calls().length, 0);
});
