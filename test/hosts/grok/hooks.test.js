import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { ASSET, PROMPT } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

// The hooks as grok runs them: each registered command through sh, with GROK_PLUGIN_ROOT pointing at the packed
// folder grok installs, on the payloads grok 1.0.70 sent.

const posix = { skip: process.platform === 'win32' && 'the hooks run through sh here' };
const FIXTURES = fileURLToPath(new URL('../../fixtures/grok/', import.meta.url));
const PAYLOADS = JSON.parse(readFileSync(join(FIXTURES, 'hook-payloads.json'), 'utf8'));
const FAILED_RUN = { exit_code: 1, output_for_prompt: 'exit: 1\nnot ok 1 - retries\n# tests 1\n# pass 0\n# fail 1\n' };
const PASSED_RUN = { exit_code: 0, output_for_prompt: 'exit: 0\n# tests 1\n# pass 1\n# fail 0\n' };

let proxy;
let plugin;
let project;
let env;
let hooks;

before(async () => {
  proxy = await fakeProxy();
  plugin = mkdtempSync(join(tmpdir(), 'evolver-grok-plugin-'));
  pack('grok', plugin);
  hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
  project = join(proxy.env.HOME, 'project');
  mkdirSync(join(project, 'lib'), { recursive: true });
  env = {
    ...proxy.env,
    PATH: [join(FIXTURES, 'fake-grok'), dirname(process.execPath), proxy.env.PATH].join(delimiter),
    FAKE_GROK_NODE: process.execPath,
    FAKE_GROK_LOG: join(proxy.env.HOME, 'grok.log'),
    GROK_PLUGIN_ROOT: plugin,
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
    child.on('close', (code) => resolve({ code, answer: JSON.parse(stdout) }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const answerOf = async (event, payload, hookEnv) => (await runHook(event, payload, hookEnv)).answer;

function session(id) {
  const base = { sessionId: id, session_id: id, cwd: project, workspaceRoot: project };
  let turn = 0;
  const promptId = () => `${id}-prompt-${turn}`;
  const shell = (command, result) => ({
    ...PAYLOADS['PostToolUse.run_terminal_command.failed'], ...base,
    toolInput: { command, description: 'Run the tests' }, toolResult: { ...PAYLOADS['PostToolUse.run_terminal_command.failed'].toolResult, command, ...result },
    toolUseId: `call_${Math.random()}`,
  });
  const edit = { ...PAYLOADS['PostToolUse.search_replace'], ...base, toolInput: { file_path: join(project, 'lib', 'redis.js'), old_string: '1', new_string: 'null' } };
  return {
    start: () => answerOf('SessionStart', { ...PAYLOADS.SessionStart, ...base }),
    prompt: (prompt) => {
      turn += 1;
      return answerOf('UserPromptSubmit', { ...PAYLOADS.UserPromptSubmit, ...base, promptId: promptId(), prompt });
    },
    read: () => answerOf('PostToolUse', { ...PAYLOADS['PostToolUse.read_file'], ...base }),
    edit: async () => {
      await answerOf('PreToolUse', { ...PAYLOADS['PreToolUse.search_replace'], ...base, toolInput: edit.toolInput });
      writeFileSync(join(project, 'lib', 'redis.js'), 'export const retries = null;\n');
      return answerOf('PostToolUse', edit);
    },
    bash: (command, result) => runHook('PostToolUse', shell(command, result)),
    stop: (answer) => answerOf('Stop', { ...PAYLOADS.Stop, ...base, promptId: promptId(), lastAssistantMessage: answer, last_assistant_message: answer }),
    cancel: () => answerOf('StopCancelled', { ...PAYLOADS['StopCancelled.max_turns'], ...base, promptId: promptId() }),
    shutdownStop: () => answerOf('Stop', { ...PAYLOADS['Stop.shutdown'], ...base }),
    end: () => answerOf('SessionEnd', { ...PAYLOADS.SessionEnd, ...base }),
  };
}

const stateFile = (name) => join(proxy.env.HOME, '.evolver', 'state', name);
const pending = () => (existsSync(stateFile('grok-distill-pending.json')) ? JSON.parse(readFileSync(stateFile('grok-distill-pending.json'), 'utf8')) : {});
const posted = (path) => proxy.requests.filter((request) => request.path === path).map((request) => request.body);
const reportOf = (taskId) => posted('/asset/reuse-result').find((report) => report.task_id === taskId);
const grokRuns = () => (existsSync(env.FAKE_GROK_LOG) ? readFileSync(env.FAKE_GROK_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

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
  await s.prompt(prompt);
  await s.bash('npm test', FAILED_RUN);
  await s.edit();
  await s.bash('npm test 2>&1 | tail -5', PASSED_RUN);
  return s.stop('Retries fixed: maxRetriesPerRequest is null and npm test passes.');
}

test('a whole turn through the packed hooks: the strategy reaches the first tool result, the report goes out at Stop', posix, async () => {
  const s = session('s-turn');
  assert.deepEqual(await s.start(), {});
  assert.deepEqual(await s.prompt(PROMPT), {}, 'grok would discard a prompt hook\'s context');
  const first = await s.bash('npm test', FAILED_RUN);
  assert.equal(first.code, 0, 'a non-zero exit would drop the context');
  assert.equal(first.answer.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(first.answer.hookSpecificOutput.additionalContext, new RegExp(`^\\[Evolution Memory\\] ${ASSET.short_title}[\\s\\S]*\\nApply them where they fit\\.$`));
  assert.deepEqual(await s.edit(), {}, 'only the first tool result carries it');
  assert.deepEqual((await s.bash('npm test 2>&1 | tail -5', PASSED_RUN)).answer, {});
  assert.deepEqual(await s.stop('Retries fixed: maxRetriesPerRequest is null and npm test passes.'), {
    systemMessage: `✓ Goal reached (last check passed: npm test 2>&1 | tail -5) · reused EvoMap strategy "${ASSET.short_title}"`,
  });
  assert.deepEqual(await waitFor(() => reportOf('grok:s-turn:1')), {
    asset_id: ASSET.asset_id,
    outcome: 'success',
    task_id: 'grok:s-turn:1',
    reason: 'Injected by Evolver into turn 1; applied: used; last test passed after failing earlier.',
    evidence: { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, aborted: false, stage: 'immediate' },
  });
  const candidate = pending()['s-turn'];
  assert.deepEqual(candidate.paths, [join(project, 'lib', 'redis.js')]);
  assert.deepEqual(candidate.checks.map((check) => check.failed), [true, false]);
  assert.deepEqual(await s.shutdownStop(), {}, 'the Stop of a session\'s end ends no turn');
  assert.ok(readdirSync(stateFile('')).every((name) => name.startsWith('grok-')), 'every state file carries the agent name');
});

test('a turn answered without any tool call never sees its strategy, and reports nothing', posix, async () => {
  const s = session('s-talk');
  await s.prompt(PROMPT);
  await s.stop('Here is how the retries work.');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reportOf('grok:s-talk:1'), undefined);
  await s.prompt(PROMPT);
  assert.ok((await s.read()).hookSpecificOutput, 'the next turn may recall it again');
});

test('a cancelled turn is reported aborted with the check it ran, and leaves no candidate', posix, async () => {
  const s = session('s-cut');
  await s.prompt(PROMPT);
  await s.read();
  await s.bash('npm test', PASSED_RUN);
  assert.deepEqual(await s.cancel(), {});
  const report = await waitFor(() => reportOf('grok:s-cut:1'));
  assert.equal(report.evidence.aborted, true);
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: false });
  assert.equal(pending()['s-cut'], undefined);
});

test('a command typed into the prompt box is answered and blocked: it opens no turn and recalls nothing', posix, async () => {
  const s = session('s-command');
  const fetches = posted('/asset/fetch').length;
  const answer = await s.prompt('/evolver-status');
  assert.equal(answer.decision, 'block');
  assert.match(answer.reason, /^Evolver Proxy running/);
  assert.equal((await s.prompt('evolver-status')).decision, 'block', 'without its slash too');
  assert.equal(posted('/asset/fetch').length, fetches);
  assert.deepEqual(await s.prompt('/evolver-evolve the retries'), {}, 'its checkpoint reaches the model from the command file');
  await verifiedTurn(s);
  assert.ok(await waitFor(() => reportOf('grok:s-command:2')), 'the evolve turn counted; the blocked commands did not');
});

test('the session end distills its candidate through grok -p, headless, in an empty folder', posix, async () => {
  const s = session('s-done');
  await verifiedTurn(s);
  assert.deepEqual(await s.end(), {});
  const body = await waitFor(() => posted('/conversation/distill').find((entry) => entry.session_id === 'grok:s-done'));
  assert.deepEqual([body.platform, body.trigger, body.user_prompt], ['grok', 'session_end', PROMPT]);
  assert.deepEqual(body.distill_usage, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 });
  const run = grokRuns().find((entry) => entry.prompt.includes(`## Task\n${PROMPT}`));
  assert.deepEqual(run.args.slice(0, 4), ['-p', '-', '--output-format', 'json']);
  assert.equal(run.args.includes('-m'), false, 'on the default model of the person\'s config');
  assert.equal(run.headless, '1');
  await waitFor(() => !pending()['s-done']);
});

test('inside the headless run every hook answers {} and writes nothing', posix, async () => {
  const before = proxy.requests.length;
  const headless = { ...env, EVOLVER_HEADLESS: '1', HOME: join(proxy.env.HOME, 'headless-home') };
  const base = { sessionId: 's-headless', session_id: 's-headless', cwd: project };
  assert.deepEqual(await answerOf('UserPromptSubmit', { ...PAYLOADS.UserPromptSubmit, ...base, prompt: PROMPT }, headless), {});
  assert.deepEqual(await answerOf('PostToolUse', { ...PAYLOADS['PostToolUse.read_file'], ...base }, headless), {});
  assert.deepEqual(await answerOf('Stop', { ...PAYLOADS.Stop, ...base }, headless), {});
  assert.equal(proxy.requests.length, before);
  assert.equal(existsSync(join(proxy.env.HOME, 'headless-home')), false);
});

test('a terminal runs the same commands from the packed folder', posix, async () => {
  const child = spawn(process.execPath, [join(plugin, 'bin', 'command.mjs'), 'grok', 'evolver-status'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(stdout, /^Evolver Proxy running/);
});
