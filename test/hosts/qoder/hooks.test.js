// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { ASSET, PROMPT } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

// The hooks as Qoder CLI runs them: each registered command in exec form, `${QODER_PLUGIN_ROOT}` in its arguments
// replaced by the folder Qoder installs, on the payloads Qoder CLI 1.1.79 sent.

const posix = { skip: process.platform === 'win32' && 'the fake qodercli is a shell script' };
const FIXTURES = fileURLToPath(new URL('../../fixtures/qoder/', import.meta.url));
const PAYLOADS = JSON.parse(readFileSync(join(FIXTURES, 'hook-payloads.json'), 'utf8'));
const FAILED_RUN = 'Exit code 1\nnot ok 1 - retries\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n# tests 1\n# pass 0\n# fail 1';
const PASSED_RUN = '# tests 1\n# pass 1\n# fail 0';

let proxy;
let plugin;
let project;
let env;
let hooks;

before(async () => {
  proxy = await fakeProxy();
  plugin = mkdtempSync(join(tmpdir(), 'evolver-qoder-plugin-'));
  pack('qoder', plugin);
  hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
  project = join(proxy.env.HOME, 'project');
  mkdirSync(join(project, 'lib'), { recursive: true });
  env = {
    ...proxy.env,
    PATH: [join(FIXTURES, 'fake-qodercli'), dirname(process.execPath), proxy.env.PATH].join(delimiter),
    FAKE_QODER_NODE: process.execPath,
    FAKE_QODER_LOG: join(proxy.env.HOME, 'qodercli.log'),
    QODER_PLUGIN_ROOT: plugin,
    QODER_PLUGIN_DATA: join(proxy.env.HOME, '.qoder', 'plugins', 'data', 'evolver-plugin-evomap'),
    QODER_PROJECT_DIR: project,
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
  const { command, args } = hooks[event][0].hooks[0];
  return new Promise((resolve) => {
    const child = spawn(command === 'node' ? process.execPath : command, args.map((arg) => arg.replaceAll('${QODER_PLUGIN_ROOT}', hookEnv.QODER_PLUGIN_ROOT)), { env: hookEnv });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(payload));
  });
}

function session(id) {
  const base = { session_id: id, cwd: project, transcript_path: join(proxy.env.HOME, '.qoder', 'projects', `${id}.jsonl`) };
  let turn = 0;
  const turnId = () => `${id}-turn-${turn}`;
  const call = (name, input, extra = {}) => ({ ...base, tool_use_id: `toolu_${Math.random()}`, tool_name: name, tool_input: input, ...extra });
  const edited = join(project, 'lib', 'redis.js');
  return {
    start: (source = 'startup') => runHook('SessionStart', { ...PAYLOADS['SessionStart.startup'], ...base, source }),
    prompt: (prompt) => {
      turn += 1;
      return runHook('UserPromptSubmit', { ...PAYLOADS.UserPromptSubmit, ...base, request_set_id: turnId(), prompt });
    },
    edit: async () => {
      const input = { file_path: edited, old_string: 'retries = 3', new_string: 'retries = null' };
      await runHook('PreToolUse', { ...PAYLOADS['PreToolUse.Edit'], ...call('Edit', input) });
      writeFileSync(edited, 'export const retries = null;\n');
      return runHook('PostToolUse', { ...PAYLOADS['PostToolUse.Edit'], ...call('Edit', input) });
    },
    failing: (command) => runHook('PostToolUseFailure', { ...PAYLOADS['PostToolUseFailure.Bash.exit1'], ...call('Bash', { command }, { error: FAILED_RUN }) }),
    passing: (command) => runHook('PostToolUse', {
      ...PAYLOADS['PostToolUse.Bash.passed'],
      ...call('Bash', { command }, { tool_response: { ...PAYLOADS['PostToolUse.Bash.passed'].tool_response, stdout: PASSED_RUN } }),
    }),
    notification: () => runHook('UserPromptSubmit', { ...PAYLOADS['UserPromptSubmit.taskNotification'], ...base, request_set_id: `${id}-notification` }),
    stop: (answer) => runHook('Stop', { ...PAYLOADS.Stop, ...base, parent_request_set_id: turnId(), last_assistant_message: answer }),
    stopFailure: () => runHook('StopFailure', { ...PAYLOADS.StopFailure, ...base }),
    queryEnd: (reason, requestSetId = turnId()) => runHook('QueryEnd', { ...PAYLOADS['QueryEnd.abort'], ...base, request_set_id: requestSetId, business_id: requestSetId, reason }),
    background: (command) => runHook('PostToolUse', { ...PAYLOADS['PostToolUse.Bash.backgrounded'], ...call('Bash', { command, run_in_background: true }) }),
    notificationStop: () => runHook('Stop', { ...PAYLOADS.Stop, ...base, parent_request_set_id: `${id}-notification`, last_assistant_message: 'The background run passed.' }),
    end: () => runHook('SessionEnd', { ...PAYLOADS.SessionEnd, ...base }),
  };
}

const stateFile = (name) => join(proxy.env.HOME, '.evolver', 'state', name);
const pending = () => (existsSync(stateFile('qoder-distill-pending.json')) ? JSON.parse(readFileSync(stateFile('qoder-distill-pending.json'), 'utf8')) : {});
const posted = (path) => proxy.requests.filter((request) => request.path === path).map((request) => request.body);
const reportOf = (taskId) => posted('/asset/reuse-result').find((report) => report.task_id === taskId);
const qoderRuns = () => (existsSync(env.FAKE_QODER_LOG) ? readFileSync(env.FAKE_QODER_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

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
  writeFileSync(join(project, 'lib', 'redis.js'), 'export const retries = 3;\n');
  const injected = await s.prompt(prompt);
  await s.failing('npm test');
  await s.edit();
  await s.passing('npm test 2>&1 | tail -5');
  await s.stop('Retries fixed: maxRetriesPerRequest is null and npm test passes.');
  return injected;
}

test('a whole turn through the packed hooks: the strategy rides the prompt, the report goes out at Stop with its check', posix, async () => {
  const s = session('s-turn');
  assert.deepEqual(await s.start(), {});
  writeFileSync(join(project, 'lib', 'redis.js'), 'export const retries = 3;\n');
  const injected = await s.prompt(PROMPT);
  assert.equal(injected.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(injected.hookSpecificOutput.additionalContext, new RegExp(`^\\[Evolution Memory\\] ${ASSET.short_title}[\\s\\S]*\\nApply them where they fit\\.$`));
  assert.deepEqual(await s.failing('npm test'), {});
  assert.deepEqual(await s.edit(), {});
  assert.deepEqual(await s.passing('npm test 2>&1 | tail -5'), {});
  const summary = await s.stop('Retries fixed: maxRetriesPerRequest is null and npm test passes.');
  assert.match(summary.systemMessage, new RegExp(`^✓ Goal reached \\(last check passed: npm test 2>&1 \\| tail -5\\) · reused EvoMap strategy "${ASSET.short_title}"`));

  assert.deepEqual(await waitFor(() => reportOf('qoder:s-turn:1')), {
    asset_id: ASSET.asset_id,
    outcome: 'success',
    task_id: 'qoder:s-turn:1',
    reason: 'Injected by Evolver into turn 1; applied: used; last test passed after failing earlier.',
    evidence: { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, aborted: false, stage: 'immediate' },
  });
  const candidate = pending()['s-turn'];
  assert.deepEqual(candidate.model, { model: 'default' });
  assert.deepEqual(candidate.paths, [join(project, 'lib', 'redis.js')]);
  assert.deepEqual(candidate.checks.map((check) => check.failed), [true, false]);
  assert.ok(readdirSync(stateFile('')).every((name) => name.startsWith('qoder-')), 'every state file carries the agent name');
});

test('a command is answered and blocked: it opens no turn, recalls nothing and leaves the model out', posix, async () => {
  const s = session('s-command');
  const fetches = posted('/asset/fetch').length;
  const answer = await s.prompt('/evolver-plugin:evolver-status');
  assert.equal(answer.decision, 'block');
  assert.match(answer.systemMessage, /^Evolver Proxy running/);
  assert.equal(answer.reason, answer.systemMessage);
  assert.equal(answer.hookSpecificOutput, undefined, 'nothing reaches the model');
  assert.equal(posted('/asset/fetch').length, fetches);
  await verifiedTurn(s);
  assert.ok(await waitFor(() => reportOf('qoder:s-command:1')), 'the command was no turn');
});

test('/evolver-evolve goes on to the model with its checkpoint as the prompt\'s context', posix, async () => {
  const s = session('s-evolve');
  const answer = await s.prompt('/evolver-evolve the retries');
  assert.equal(answer.decision, undefined);
  assert.match(answer.hookSpecificOutput.additionalContext, /^Take a deliberate evolution step[\s\S]*Focus on: the retries/);
});

const digestOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const sessionState = (id) => JSON.parse(readFileSync(stateFile(`qoder-session-${digestOf(id)}.json`), 'utf8'));

test('a task notification Qoder submits is no turn: it recalls nothing, counts no turn and keeps the candidate', posix, async () => {
  const s = session('s-notify');
  await verifiedTurn(s);
  await waitFor(() => reportOf('qoder:s-notify:1'));
  const fetches = posted('/asset/fetch').length;
  assert.deepEqual(await s.notification(), {});
  assert.equal(posted('/asset/fetch').length, fetches);
  assert.deepEqual(await runHook('Stop', { ...PAYLOADS.Stop, session_id: 's-notify', cwd: project, parent_request_set_id: 's-notify-notification' }), {});
  assert.equal(sessionState('s-notify').turn, 1);
  assert.ok(pending()['s-notify'], 'its Stop judged no turn of the person\'s');
});

test('a turn that failed on a model error is reported failed at StopFailure, and leaves no candidate', posix, async () => {
  const s = session('s-error');
  await s.prompt(PROMPT);
  assert.deepEqual(await s.stopFailure(), {});
  const report = await waitFor(() => reportOf('qoder:s-error:1'));
  assert.equal(report.outcome, 'failed');
  assert.equal(report.evidence.aborted, false);
  assert.equal(pending()['s-error'], undefined);
});

test('an interrupted turn ends at its QueryEnd, so the task notification turn after it lends it no check', posix, async () => {
  const s = session('s-esc');
  await s.prompt(PROMPT);
  await s.background('sleep 4; echo bg done');
  assert.deepEqual(await s.queryEnd('abort'), {});
  assert.deepEqual(await s.notification(), {});
  await s.passing('node --test');
  assert.deepEqual(await s.notificationStop(), {});
  assert.deepEqual(await s.queryEnd('end_turn', 's-esc-notification'), {});
  const report = await waitFor(() => reportOf('qoder:s-esc:1'));
  assert.equal(report.evidence.aborted, true);
  assert.equal(report.evidence.check, undefined, 'the notification turn\'s test is no evidence of the interrupted one');
  assert.equal(report.outcome, 'failed');
  await s.prompt('continue with the README');
  assert.equal(sessionState('s-esc').turn, 2, 'the notification counted no turn');
});

test('an interrupted turn no hook closed is closed as aborted by the next prompt', posix, async () => {
  const s = session('s-cut');
  await s.prompt(PROMPT);
  await s.passing('npm test');
  await s.prompt('continue with the README');
  const report = await waitFor(() => reportOf('qoder:s-cut:1'));
  assert.equal(report.evidence.aborted, true);
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: false });
});

test('the session end distills its candidate through qodercli in print mode, headless', posix, async () => {
  const s = session('s-done');
  await verifiedTurn(s);
  assert.deepEqual(await s.end(), {});
  const body = await waitFor(() => posted('/conversation/distill').find((entry) => entry.session_id === 'qoder:s-done'));
  assert.deepEqual([body.platform, body.trigger, body.user_prompt], ['qoder', 'session_end', PROMPT]);
  assert.deepEqual(body.distill_usage, { inputTokens: 900, outputTokens: 120 });
  const run = qoderRuns().find((entry) => entry.prompt?.includes(`## Task\n${PROMPT}`));
  assert.deepEqual(run.args.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.ok(run.args.includes('--no-session-persistence'));
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
  const child = spawn(process.execPath, [join(plugin, 'bin', 'command.mjs'), 'qoder', 'evolver-status'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(stdout, /^Evolver Proxy running/);
});
