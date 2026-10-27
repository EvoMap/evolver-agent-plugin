import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { ASSET, PROMPT } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

// The hooks as Codex runs them: each registered command through a shell, with PLUGIN_ROOT pointing at the folder
// Codex installs, on payloads shaped like those Codex 0.164 sends.

const posix = { skip: process.platform === 'win32' && 'the hooks run through sh here' };
const FIXTURES = fileURLToPath(new URL('../../fixtures/codex/', import.meta.url));
const PAYLOADS = JSON.parse(readFileSync(join(FIXTURES, 'hook-payloads.json'), 'utf8'));
const PATCH = '*** Begin Patch\n*** Update File: lib/redis.js\n@@\n-export const retries = 1;\n+export const retries = null;\n*** End Patch\n';
const PATCH_APPLIED = 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM lib/redis.js\n';
const FAILED_RUN = 'not ok 1 - retries\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n# tests 1\n# pass 0\n# fail 1\n';
const PASSED_RUN = '# tests 1\n# pass 1\n# fail 0\n';

let proxy;
let plugin;
let project;
let env;
let hooks;

before(async () => {
  proxy = await fakeProxy();
  plugin = mkdtempSync(join(tmpdir(), 'evolver-codex-plugin-'));
  pack('codex', plugin);
  hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
  project = join(proxy.env.HOME, 'project');
  mkdirSync(join(project, 'lib'), { recursive: true });
  env = {
    ...proxy.env,
    PATH: [join(FIXTURES, 'fake-codex'), dirname(process.execPath), proxy.env.PATH].join(delimiter),
    FAKE_CODEX_NODE: process.execPath,
    FAKE_CODEX_LOG: join(proxy.env.HOME, 'codex.log'),
    PLUGIN_ROOT: plugin,
  };
});

// A detached worker may still be writing into the scratch home when a test ends.
async function closeWhenSettled(server) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return server.close();
    } catch (error) {
      if (attempt === 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

after(async () => {
  rmSync(plugin, { recursive: true, force: true });
  await closeWhenSettled(proxy);
});

function runHook(event, payload, hookEnv = env) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', hooks[event][0].hooks[0].command], { env: hookEnv });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(payload));
  });
}

function session(id) {
  const base = { session_id: id, cwd: project, transcript_path: null };
  let turn = 0;
  const turnId = () => `${id}-turn-${turn}`;
  const tool = (name, command, extra = {}) => ({ ...base, turn_id: turnId(), model: 'gpt-5.5', permission_mode: 'default', tool_name: name, tool_input: { command }, tool_use_id: `call_${Math.random()}`, ...extra });
  return {
    start: (source = 'startup') => runHook('SessionStart', { ...PAYLOADS['SessionStart.startup'], ...base, source }),
    prompt: (prompt) => {
      turn += 1;
      return runHook('UserPromptSubmit', { ...PAYLOADS.UserPromptSubmit, ...base, turn_id: turnId(), prompt });
    },
    patch: async (patch = PATCH) => {
      await runHook('PreToolUse', { ...PAYLOADS['PreToolUse.apply_patch'], ...tool('apply_patch', patch) });
      writeFileSync(join(project, 'lib', 'redis.js'), 'export const retries = null;\n');
      return runHook('PostToolUse', { ...PAYLOADS['PostToolUse.apply_patch'], ...tool('apply_patch', patch, { tool_response: PATCH_APPLIED }) });
    },
    bash: (command, output) => runHook('PostToolUse', { ...PAYLOADS['PostToolUse.Bash.passed'], ...tool('Bash', command, { tool_response: output }) }),
    stop: (answer) => runHook('Stop', { ...PAYLOADS.Stop, ...base, turn_id: turnId(), last_assistant_message: answer }),
    interrupt: () => runHook('Interrupt', { ...PAYLOADS.Interrupt, ...base, turn_id: turnId() }),
    end: () => runHook('SessionEnd', { ...PAYLOADS.SessionEnd, ...base }),
  };
}

const stateFile = (name) => join(proxy.env.HOME, '.evolver', 'state', name);
const pending = () => (existsSync(stateFile('codex-distill-pending.json')) ? JSON.parse(readFileSync(stateFile('codex-distill-pending.json'), 'utf8')) : {});
const posted = (path) => proxy.requests.filter((request) => request.path === path).map((request) => request.body);
const reportOf = (taskId) => posted('/asset/reuse-result').find((report) => report.task_id === taskId);
const codexRuns = () => (existsSync(env.FAKE_CODEX_LOG) ? readFileSync(env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function verifiedTurn(s, prompt = PROMPT) {
  const injected = await s.prompt(prompt);
  await s.patch();
  await s.bash('npm test', FAILED_RUN);
  await s.bash('npm test 2>&1 | tail -5', PASSED_RUN);
  await s.stop('Retries fixed: maxRetriesPerRequest is null and npm test passes.');
  return injected;
}

test('a whole turn through the packed hooks: the strategy rides the prompt, the report goes out at Stop with its check', posix, async () => {
  const s = session('s-turn');
  assert.deepEqual(await s.start(), {});
  const injected = await s.prompt(PROMPT);
  assert.equal(injected.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(injected.hookSpecificOutput.additionalContext, new RegExp(`^\\[Evolution Memory\\] ${ASSET.short_title}[\\s\\S]*\\nApply them where they fit\\.$`));
  assert.deepEqual(await s.patch(), {});
  assert.deepEqual(await s.bash('npm test', FAILED_RUN), {});
  assert.deepEqual(await s.bash('npm test 2>&1 | tail -5', PASSED_RUN), {});
  assert.deepEqual(await s.stop('Retries fixed: maxRetriesPerRequest is null and npm test passes.'), {});

  assert.deepEqual(await waitFor(() => reportOf('codex:s-turn:1')), {
    asset_id: ASSET.asset_id,
    outcome: 'success',
    task_id: 'codex:s-turn:1',
    reason: 'Injected by Evolver into turn 1; applied: used; last test passed after failing earlier.',
    evidence: { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, aborted: false, stage: 'immediate' },
  });
  const candidate = pending()['s-turn'];
  assert.deepEqual(candidate.model, { model: 'gpt-5.5' });
  assert.deepEqual(candidate.paths, ['lib/redis.js']);
  assert.deepEqual(candidate.checks.map((check) => check.failed), [true, false]);
  assert.ok(readdirSync(stateFile('')).every((name) => name.startsWith('codex-')), 'every state file carries the agent name');
});

test('a command typed into the prompt box is answered and blocked: it opens no turn and recalls nothing', posix, async () => {
  const s = session('s-command');
  const fetches = posted('/asset/fetch').length;
  const answer = await s.prompt('evolver-status');
  assert.equal(answer.decision, 'block');
  assert.match(answer.reason, /^Evolver Proxy running/);
  assert.equal(answer.hookSpecificOutput, undefined, 'nothing reaches the model');
  assert.equal(posted('/asset/fetch').length, fetches);
  await verifiedTurn(s);
  assert.ok(await waitFor(() => reportOf('codex:s-command:1')), 'the command was no turn');
});

test('an interrupted turn is reported aborted with the check it ran, and leaves no candidate', posix, async () => {
  const s = session('s-cut');
  await s.prompt(PROMPT);
  await s.bash('npm test', PASSED_RUN);
  assert.deepEqual(await s.interrupt(), {});
  const report = await waitFor(() => reportOf('codex:s-cut:1'));
  assert.equal(report.evidence.aborted, true);
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: false });
  assert.equal(pending()['s-cut'], undefined);
});

test('a turn that ended on an error runs no hook: the next prompt closes it as failed', posix, async () => {
  const s = session('s-error');
  await s.prompt(PROMPT);
  await s.prompt('continue with the README');
  const report = await waitFor(() => reportOf('codex:s-error:1'));
  assert.equal(report.outcome, 'failed');
  assert.equal(report.evidence.aborted, false);
});

test('the session end distills its candidate through codex exec, headless, on the session model', posix, async () => {
  const s = session('s-done');
  await verifiedTurn(s);
  assert.deepEqual(await s.end(), {});
  const body = await waitFor(() => posted('/conversation/distill').find((entry) => entry.session_id === 'codex:s-done'));
  assert.deepEqual([body.platform, body.trigger, body.user_prompt], ['codex', 'session_end', PROMPT]);
  assert.deepEqual(body.distill_usage, { inputTokens: 900, cachedInputTokens: 0, outputTokens: 120, reasoningOutputTokens: 0 });
  const run = codexRuns().find((entry) => entry.prompt.includes(`## Task\n${PROMPT}`));
  assert.deepEqual(run.args.slice(0, 6), ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--ignore-user-config', '--json']);
  assert.deepEqual(run.args.slice(run.args.indexOf('-m'), run.args.indexOf('-m') + 2), ['-m', 'gpt-5.5']);
  assert.equal(run.headless, '1');
  await waitFor(() => !pending()['s-done']);
});

test('inside the headless run every hook answers {} and writes nothing', posix, async () => {
  const before = proxy.requests.length;
  const headless = { ...env, EVOLVER_HEADLESS: '1', HOME: join(proxy.env.HOME, 'headless-home') };
  const payload = { ...PAYLOADS.UserPromptSubmit, session_id: 's-headless', cwd: project, prompt: PROMPT };
  assert.deepEqual(await runHook('UserPromptSubmit', payload, headless), {});
  assert.deepEqual(await runHook('Stop', { ...PAYLOADS.Stop, session_id: 's-headless' }, headless), {});
  assert.equal(proxy.requests.length, before);
  assert.equal(existsSync(join(proxy.env.HOME, 'headless-home')), false);
});

test('a terminal runs the same commands from the packed folder', posix, async () => {
  const child = spawn(process.execPath, [join(plugin, 'bin', 'command.mjs'), 'codex', 'evolver-status'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(stdout, /^Evolver Proxy running/);
  assert.match(stdout, /verified turn\(s\) waiting to be distilled|No distillation candidate is waiting/, 'a terminal belongs to no session');
});

const digestOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

test('what the standalone plugin left is adopted: its open strategy is reported aborted, its turn counter carries on', posix, async (t) => {
  const old = await fakeProxy();
  t.after(() => closeWhenSettled(old));
  const dir = join(old.env.HOME, '.evolver', 'state');
  mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(join(dir, `codex-injected-${digestOf('s-old')}.json`), JSON.stringify({
    'sha256:orphan': { turn: 4, injectedAt: Date.now(), title: 'Retry uploads', sessionId: 's-old', pid: dead },
  }));
  writeFileSync(join(dir, `codex-session-${digestOf('s-old')}.json`), JSON.stringify({ turn: 4, turnId: 't-4', closed: false, prompt: 'p', labelable: [], stoppedRecord: null }));
  const oldEnv = { ...env, ...old.env, PATH: env.PATH };
  const base = { ...PAYLOADS['SessionStart.startup'], cwd: project, transcript_path: null };
  assert.deepEqual(await runHook('SessionStart', { ...base, session_id: 's-new' }, oldEnv), {});
  const reported = () => old.requests.filter((request) => request.path === '/asset/reuse-result').map((request) => request.body);
  const [orphan] = await waitFor(() => (reported().length > 0 ? reported() : null));
  assert.deepEqual([orphan.task_id, orphan.asset_id, orphan.evidence.aborted], ['codex:s-old:4', 'sha256:orphan', true]);
  assert.equal(existsSync(join(dir, `codex-injected-${digestOf('s-old')}.json`)), false);

  await runHook('UserPromptSubmit', { ...PAYLOADS.UserPromptSubmit, session_id: 's-old', cwd: project, turn_id: 't-5', prompt: PROMPT }, oldEnv);
  await runHook('Stop', { ...PAYLOADS.Stop, session_id: 's-old', cwd: project, turn_id: 't-5' }, oldEnv);
  assert.ok(await waitFor(() => reported().find((report) => report.task_id === 'codex:s-old:5')), 'a resumed thread never repeats a task id');
});
