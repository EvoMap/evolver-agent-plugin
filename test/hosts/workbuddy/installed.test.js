import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { PROMPT } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

const posix = { skip: process.platform === 'win32' && 'the hooks and commands run through sh here' };
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../fixtures/workbuddy/', import.meta.url));
const LRU_TURN = readFileSync(join(FIXTURES, 'lru-turn.jsonl'), 'utf8');
const PAYLOADS = JSON.parse(readFileSync(join(FIXTURES, 'hook-payloads.json'), 'utf8'));
const ANSWER_LINE = `${JSON.stringify(PAYLOADS.assistantMessage)}\n`;
const AGENT_GENE = JSON.stringify({ title: 'LRU cache', summary: 'An LRU cache over a Map.', strategy: ['Keep a Map.', 'Re-insert on read.'] });

// What WorkBuddy's installer leaves in its plugin cache: the packed folder, which it copies whole.
function installedPlugin() {
  const root = mkdtempSync(join(tmpdir(), 'workbuddy-plugin-'));
  pack('workbuddy', root);
  return root;
}

let proxy;
let plugin;
let home;
let data;
let project;
let hookEnv;
let shellEnv;

before(async () => {
  proxy = await fakeProxy();
  plugin = installedPlugin();
  home = proxy.env.HOME;
  data = join(home, '.workbuddy', 'plugins', 'data', 'evolver-evomap-workbuddy');
  project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const { CODEBUDDY_SESSION_ID, CLAUDE_SESSION_ID, CODEBUDDY_PLUGIN_DATA, ...base } = proxy.env;
  shellEnv = {
    ...base,
    PATH: [join(FIXTURES, 'fake-codebuddy'), dirname(process.execPath), base.PATH].join(delimiter),
    FAKE_CODEBUDDY_NODE: process.execPath,
    FAKE_CODEBUDDY_LOG: join(home, 'codebuddy.log'),
  };
  hookEnv = { ...shellEnv, CODEBUDDY_PLUGIN_ROOT: plugin, CODEBUDDY_PLUGIN_DATA: data, CODEBUDDY_PROJECT_DIR: project };
});

after(() => {
  proxy.close();
  rmSync(plugin, { recursive: true, force: true });
});

function shell(command, { env, input = '' }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

async function runHook(hostEvent, payload, env = hookEnv) {
  const { hooks } = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooks[hostEvent][0].hooks[0].command.replaceAll('${CODEBUDDY_PLUGIN_ROOT}', plugin);
  const { stdout } = await shell(command, { env, input: JSON.stringify(payload) });
  return JSON.parse(stdout);
}

// The host fills the plugin's folders in when it loads a command and `$ARGUMENTS` when it renders one (leaving
// it when there is none), then runs the inline script in a shell that has the session but no plugin data folder.
function runCommand(name, sessionId, { args = '', env = {} } = {}) {
  const loaded = readFileSync(join(plugin, 'commands', `${name}.md`), 'utf8')
    .replaceAll('${CODEBUDDY_PLUGIN_ROOT}', plugin)
    .replaceAll('${CODEBUDDY_PLUGIN_DATA}', data);
  const rendered = args ? loaded.replace(/\$ARGUMENTS\b/g, args) : loaded;
  const [, script] = /!`([^`]+)`/.exec(rendered);
  return shell(script.trim(), { env: { ...shellEnv, CODEBUDDY_SESSION_ID: sessionId, ...env } });
}

function session(id) {
  const transcript = join(home, `${id}.jsonl`);
  writeFileSync(transcript, '');
  const base = { session_id: id, transcript_path: transcript, cwd: project };
  return {
    transcript,
    start: () => runHook('SessionStart', { ...PAYLOADS.SessionStart, session_id: id, transcript_path: transcript }),
    prompt: (prompt) => runHook('UserPromptSubmit', { ...PAYLOADS.UserPromptSubmit, ...base, prompt }),
    beforeEdit: (file) => runHook('PreToolUse', { ...PAYLOADS.PreToolUse, ...base, tool_input: { file_path: file, content: 'x' } }),
    stop: (reason = 'completed') => runHook('FinalStop', { ...PAYLOADS.FinalStop, ...base, final_stop_reason: reason }),
    end: () => runHook('SessionEnd', { ...PAYLOADS.SessionEnd, ...base }),
  };
}

async function verifiedTurn(s, prompt = PROMPT) {
  const answer = await s.prompt(prompt);
  appendFileSync(s.transcript, LRU_TURN + ANSWER_LINE);
  await s.stop();
  return answer;
}

const pending = () => {
  try {
    return JSON.parse(readFileSync(join(data, 'workbuddy-distill-pending.json'), 'utf8'));
  } catch {
    return {};
  }
};
const posted = (path) => proxy.requests.filter((request) => request.path === path).map((request) => request.body);
const reportOf = (taskId) => posted('/asset/reuse-result').find((report) => report.task_id === taskId);
const cliRuns = () => (existsSync(shellEnv.FAKE_CODEBUDDY_LOG) ? readFileSync(shellEnv.FAKE_CODEBUDDY_LOG, 'utf8').split('\n').filter(Boolean).map((entry) => JSON.parse(entry)) : []);

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a verified turn through the installed hooks is recalled for, reported with its check and left as the candidate', posix, async () => {
  const s = session('s-verified');
  assert.deepEqual(await s.start(), {});
  const injected = await s.prompt(PROMPT);
  assert.match(injected.hookSpecificOutput.additionalContext, /\nApply them where they fit\.$/);
  assert.equal(injected.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.deepEqual(await s.beforeEdit('lib/redis.js'), {});
  appendFileSync(s.transcript, LRU_TURN + ANSWER_LINE);
  assert.deepEqual(await s.stop(), {});

  const report = await waitFor(() => reportOf('workbuddy:s-verified:1'));
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: true });
  const candidate = pending()['s-verified'];
  assert.deepEqual(candidate.model, { model: 'fast-model' });
  assert.equal(candidate.answer, PAYLOADS.assistantMessage.content[0].text);
  assert.ok(candidate.commands.some((command) => command.includes('node --test')));
  assert.ok(readdirSync(data).every((name) => name.startsWith('workbuddy-')), 'every state file carries the agent name');
});

test('an interrupted turn is reported aborted and leaves no candidate; a command turn is neither recalled for nor a correction', posix, async () => {
  const cut = session('s-interrupted');
  await cut.prompt(PROMPT);
  await cut.stop('interrupted');
  const report = await waitFor(() => reportOf('workbuddy:s-interrupted:1'));
  assert.equal(report.evidence.aborted, true);
  assert.equal(pending()['s-interrupted'], undefined);

  const kept = session('s-kept');
  await verifiedTurn(kept);
  const recalls = posted('/asset/fetch').length;
  assert.deepEqual(await kept.prompt(PAYLOADS.renderedCommand), {});
  await kept.stop();
  assert.equal(posted('/asset/fetch').length, recalls);
  assert.equal(pending()['s-kept'].turn, 1, 'the command turn neither replaced nor dropped the candidate');
});

test('inside the headless distillation run every hook answers {} and writes nothing', posix, async () => {
  const before = proxy.requests.length;
  const s = session('s-headless');
  const env = { ...hookEnv, EVOLVER_HEADLESS: '1', CODEBUDDY_PLUGIN_DATA: join(home, 'headless-data') };
  assert.deepEqual(await runHook('UserPromptSubmit', { ...PAYLOADS.UserPromptSubmit, session_id: 's-headless', transcript_path: s.transcript, prompt: PROMPT }, env), {});
  assert.deepEqual(await runHook('FinalStop', { ...PAYLOADS.FinalStop, session_id: 's-headless', transcript_path: s.transcript }, env), {});
  assert.equal(proxy.requests.length, before);
  assert.equal(existsSync(join(home, 'headless-data')), false);
});

test('the commands answer from the plugin data folder their script line names', posix, async () => {
  const status = await runCommand('evolver-status', 's-kept');
  assert.match(status.stdout, /Evolver Proxy running/);
  assert.match(status.stdout, /This session has a verified turn waiting to be distilled\./);
  assert.equal((await runCommand('evolver-drafts', 's-kept')).stdout, 'No distilled drafts are waiting.');
  assert.match((await runCommand('evolver-drafts', 's-kept', { args: 'publish 3' })).stdout, /^No draft matches "3"/);
  assert.match((await runCommand('evolver-evolve', 's-kept', { args: 'the cache' })).stdout, /Take a deliberate evolution step[\s\S]*Focus on: the cache$/);
});

test('/evolver-distill hands the Gene to the agent when the headless CLI cannot sign in, at no cost to the candidate', posix, async () => {
  await verifiedTurn(session('s-agent'));
  const handed = await runCommand('evolver-distill', 's-agent', { args: 'the eviction order', env: { FAKE_CODEBUDDY_ANSWER: 'auth' } });
  assert.match(handed.stdout, /^EVOLVER: WRITE THE GENE YOURSELF\n.*Authentication required/);
  assert.match(handed.stdout, /Focus on: the eviction order/);
  assert.equal(cliRuns().at(-1).headless, '1');
  assert.equal(pending()['s-agent'].attempts, 0);
  assert.equal(pending()['s-agent'].claimedBy, null);
  const again = await runCommand('evolver-distill', 's-agent', { env: { FAKE_CODEBUDDY_ANSWER: 'auth' } });
  const endOf = (text) => /^EVOLVER_GENE_[0-9a-f]{16}$/m.exec(text)[0];
  assert.notEqual(endOf(again.stdout), endOf(handed.stdout), 'every hand-over ends its heredoc on a new line');
});

const postCommandOf = (text) => /^CODEBUDDY_SESSION_ID=.*\n<the JSON object>\nEVOLVER_GENE_[0-9a-f]{16}$/m.exec(text)[0];

test('the agent\'s post distills the candidate it was written for, once its shell knows the plugin data folder', posix, async () => {
  await verifiedTurn(session('s-post'));
  const handed = await runCommand('evolver-distill', 's-post', { env: { FAKE_CODEBUDDY_ANSWER: 'auth' } });
  const result = await shell(postCommandOf(handed.stdout).replace('<the JSON object>', AGENT_GENE), { env: { ...shellEnv, CODEBUDDY_PLUGIN_DATA: data } });
  assert.match(result.stdout, /^The Proxy kept nothing/);
  const [distilled] = posted('/conversation/distill').filter((body) => body.summary === 'An LRU cache over a Map.');
  assert.equal(distilled.platform, 'workbuddy');
  assert.deepEqual(distilled.strategy, ['Keep a Map.', 'Re-insert on read.']);
  assert.equal(pending()['s-post'], undefined);
});

test('the agent\'s post works from its own shell, which has no plugin data folder', posix, async () => {
  await verifiedTurn(session('s-agent-shell'));
  const handed = await runCommand('evolver-distill', 's-agent-shell', { env: { FAKE_CODEBUDDY_ANSWER: 'auth' } });
  await shell(postCommandOf(handed.stdout).replace('<the JSON object>', AGENT_GENE), { env: shellEnv });
  assert.equal(pending()['s-agent-shell'], undefined);
});

test('a session end reports an open strategy aborted and distills the session\'s candidate with the headless CLI', posix, async () => {
  const cut = session('s-cut');
  await cut.prompt(PROMPT);
  await cut.end();
  const aborted = await waitFor(() => reportOf('workbuddy:s-cut:1'));
  assert.equal(aborted.evidence.aborted, true);

  const done = session('s-done');
  await verifiedTurn(done);
  await done.end();
  const distilled = await waitFor(() => posted('/conversation/distill').find((body) => body.session_id === 'workbuddy:s-done'));
  assert.equal(distilled.platform, 'workbuddy');
  assert.equal(distilled.trigger, 'session_end');
  assert.deepEqual(distilled.distill_usage, { inputTokens: 900, outputTokens: 120 });
  const run = cliRuns().find((entry) => entry.prompt.includes('## Task\nfix the flaky redis') && entry.args.includes('fast-model'));
  assert.deepEqual(run.args, ['-p', '--tools', '', '--no-session-persistence', '--output-format', 'json', '--max-turns', '1', '--model', 'fast-model']);
  assert.equal(run.headless, '1');
  await waitFor(() => !pending()['s-done']);
});

test('a session start tells the model the engine setup outcome once', posix, async () => {
  writeFileSync(join(data, 'workbuddy-engine.json'), JSON.stringify({ status: 'started', version: '2.0.46', at: 1, source: 'managed' }));
  const answer = await session('s-notice').start();
  assert.match(answer.hookSpecificOutput.additionalContext, /^\[Evolver\]/);
});
