import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EDIT_TOOLS } from '../../../hosts/antigravity/evidence.js';
import profile from '../../../hosts/antigravity/profile.js';
import { pack } from '../../../scripts/pack.mjs';
import { ASSET, PROMPT } from '../../app/memory-ports.js';
import { closeProxyWhenSettled, fakeProxy } from '../../helpers/fake-proxy.js';

// The hooks as Antigravity runs them: the registration's own shell commands, through `sh -c`, from a stand-in
// language server, against the plugin installed (as a link) in the folder Antigravity installs to.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE_HOST = fileURLToPath(new URL('../../fixtures/antigravity/fake-host.mjs', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('../../fixtures/antigravity/fake-agy.mjs', import.meta.url));
const NAME = 'evolver-plugin';
const DOCUMENTED_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'];
const PASSED_RUN = 'The command exited with code 0.\nOutput:\nℹ tests 2\nℹ pass 2\nℹ fail 0\n';

const read = (file) => readFileSync(join(root, file), 'utf8');
const hooks = JSON.parse(read('hosts/antigravity/dist/hooks.json'))[NAME];
const handlerOf = (event) => (event === 'PreToolUse' ? hooks[event][0].hooks[0] : hooks[event][0]);
const commandOf = (event) => handlerOf(event).command;
const neutralOf = (event) => JSON.stringify(profile.reply.empty(event));

function scratchHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'evolver-antigravity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

let packedRoot = null;
after(() => packedRoot && rmSync(packedRoot, { recursive: true, force: true }));

function packedPlugin() {
  if (!packedRoot) {
    packedRoot = mkdtempSync(join(tmpdir(), 'evolver-antigravity-packed-'));
    pack('antigravity', packedRoot);
  }
  return packedRoot;
}

function install(home, folder) {
  mkdirSync(join(home, folder), { recursive: true });
  symlinkSync(packedPlugin(), join(home, folder, NAME));
  return join(home, folder, NAME);
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (Array.isArray(value) ? value.length > 0 : value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting');
}

/** A language_server process that runs the registration's commands, the owner every hook it starts finds. */
function antigravity(t, env) {
  const bin = join(env.HOME, 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'language_server'));
  const host = spawn(join(bin, 'language_server'), [FAKE_HOST], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => host.kill('SIGKILL'));
  const waiting = new Map();
  let buffer = '';
  let nextId = 0;
  host.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const reply = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(reply.id)(reply);
    }
  });
  return {
    pid: host.pid,
    run: (event, input) => new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, ({ output }) => resolve(JSON.parse(output)));
      host.stdin.write(`${JSON.stringify({ id, command: commandOf(event), input })}\n`);
    }),
  };
}

function conversation(host, home, id) {
  const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  mkdirSync(dirname(transcript), { recursive: true });
  let step = 0;
  const write = (fields) => {
    step += 1;
    appendFileSync(transcript, `${JSON.stringify({ step_index: step, status: 'DONE', created_at: new Date(Date.now() + step).toISOString(), ...fields })}\n`);
  };
  const base = { conversationId: id, workspacePaths: [join(home, 'project')], transcriptPath: transcript, artifactDirectoryPath: join(home, 'artifacts'), modelName: 'gemini-test' };
  return {
    prompt: (text) => write({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }),
    step: write,
    invoke: () => host.run('PreInvocation', { ...base, invocationNum: 0, initialNumSteps: step }),
    preToolUse: (toolCall) => host.run('PreToolUse', { ...base, toolCall, stepIdx: step }),
    stop: (fields = {}) => host.run('Stop', { ...base, executionNum: 0, terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, ...fields }),
  };
}

const reuseReports = (proxy) => proxy.requests.filter((request) => request.path === '/asset/reuse-result').map((request) => request.body);
const stateFile = (home, name) => join(home, '.evolver', 'state', name);

test('the packed folder holds the registration and manifest at its root, and nothing of the Claude Code plugin', () => {
  const packed = packedPlugin();
  const manifest = JSON.parse(readFileSync(join(packed, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, NAME);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(packed, 'hooks.json'), 'utf8'))), [NAME]);
  assert.ok(existsSync(join(packed, manifest.logo)));
  for (const folder of ['skills', 'commands', 'agents', 'hooks', '.claude-plugin']) assert.equal(existsSync(join(packed, folder)), false, folder);
});

test('the registration names documented events the profile maps, edit tools only for PreToolUse, timeouts in seconds', () => {
  for (const event of Object.keys(hooks)) {
    assert.ok(DOCUMENTED_EVENTS.includes(event), event);
    assert.ok(profile.events[event], event);
    assert.ok(commandOf(event).includes(`exec node "$d/bin/hook.mjs" antigravity ${event};`), event);
    assert.ok(commandOf(event).endsWith(`echo '${neutralOf(event)}'`), event);
  }
  const matcher = new RegExp(hooks.PreToolUse[0].matcher);
  assert.ok(EDIT_TOOLS.every((tool) => matcher.test(tool)));
  assert.equal(matcher.test('run_command'), false);
  assert.equal(handlerOf('PreInvocation').timeout * 1000, profile.budgets.prompt);
});

test('a hook command runs only a copy in an install folder, never one in its working directory, else answers neutrally', (t) => {
  const home = scratchHome(t);
  const env = { ...process.env, HOME: home, EVOLVER_HEADLESS: '1' };
  const run = (event, cwd) => spawnSync('/bin/sh', ['-c', commandOf(event)], { cwd, env, input: '{}', encoding: 'utf8' }).stdout.trim();
  const located = (event) => spawnSync('/bin/sh', ['-c', commandOf(event).replace('exec node', 'exec echo')], { cwd: root, env, encoding: 'utf8' }).stdout.trim();
  for (const event of Object.keys(hooks)) assert.equal(run(event, root), neutralOf(event), `${event}: a project holding these files runs nothing`);
  const config = install(home, '.gemini/config/plugins');
  assert.equal(located('Stop'), `${config}/bin/hook.mjs antigravity Stop`);
  const cli = install(home, '.gemini/antigravity-cli/plugins');
  assert.equal(located('PreToolUse'), `${cli}/bin/hook.mjs antigravity PreToolUse`);
  for (const event of Object.keys(hooks)) assert.equal(run(event, home), neutralOf(event), `${event}: inside the plugin's own headless run`);
  assert.equal(existsSync(join(home, '.evolver')), false);
});

test('a whole turn through the installed hooks: the strategy before each call, allow on edits, the report at Stop', async (t) => {
  const proxy = await fakeProxy();
  t.after(() => closeProxyWhenSettled(proxy));
  install(proxy.env.HOME, '.gemini/config/plugins');
  const host = antigravity(t, proxy.env);
  const s = conversation(host, proxy.env.HOME, 's-e2e');
  s.prompt(PROMPT);

  const first = await s.invoke();
  assert.match(first.injectSteps[0].ephemeralMessage, /^\[Evolution Memory\] Fix flaky Redis connection retries[\s\S]*Apply them where they fit\.$/);
  const target = join(proxy.env.HOME, 'project', 'lib', 'redis.js');
  assert.deepEqual(await s.preToolUse({ name: 'write_to_file', args: { TargetFile: target, CodeContent: 'x' } }), { decision: 'allow' });
  s.step({ source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'write_to_file', args: { TargetFile: JSON.stringify(target) } }] });
  s.step({ source: 'MODEL', type: 'CODE_ACTION', content: 'created' });
  assert.deepEqual(await s.invoke(), first);
  s.step({ source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify('npm test') } }] });
  s.step({ source: 'MODEL', type: 'RUN_COMMAND', content: PASSED_RUN });
  s.step({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Retries fixed; npm test passes.' });
  assert.deepEqual(await s.stop(), { decision: 'stop' });

  const [report] = await waitFor(() => reuseReports(proxy));
  assert.deepEqual(report, {
    asset_id: ASSET.asset_id,
    outcome: 'success',
    task_id: 'antigravity:s-e2e:1',
    reason: 'Injected by Evolver into turn 1; applied: used; last test passed.',
    evidence: { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: false }, aborted: false, stage: 'immediate' },
  });
  assert.equal(proxy.requests.filter((request) => request.path === '/asset/fetch').length, 1);
  const candidate = JSON.parse(readFileSync(stateFile(proxy.env.HOME, 'antigravity-distill-pending.json'), 'utf8'))['s-e2e'];
  assert.deepEqual([candidate.prompt, candidate.model, candidate.pid], [PROMPT, { model: 'gemini-test' }, host.pid]);
});

test('a killed session\'s open strategy is reported aborted at the first model call of the next session', async (t) => {
  const proxy = await fakeProxy({ assets: [] });
  t.after(() => closeProxyWhenSettled(proxy));
  install(proxy.env.HOME, '.gemini/config/plugins');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const digest = createHash('sha256').update('s-killed').digest('hex').slice(0, 16);
  mkdirSync(stateFile(proxy.env.HOME, ''), { recursive: true });
  writeFileSync(stateFile(proxy.env.HOME, `antigravity-session-${digest}.json`), JSON.stringify({
    sessionId: 's-killed', turn: 4, open: true, pid: dead, injected: { 'sha256:orphan': { turn: 4, injectedAt: Date.now(), strategyText: '1. a.' } },
  }));
  const s = conversation(antigravity(t, proxy.env), proxy.env.HOME, 's-next');
  s.prompt(PROMPT);
  assert.deepEqual(await s.invoke(), {});
  const [report] = await waitFor(() => reuseReports(proxy));
  assert.equal(report.task_id, 'antigravity:s-killed:4');
  assert.deepEqual(report.evidence, { tier: 'none', applied: 'used', aborted: true, stage: 'immediate' });
});

test('the candidate of a session whose Antigravity process is gone is distilled by agy run headless, in an empty folder', async (t) => {
  const proxy = await fakeProxy({ assets: [] });
  t.after(() => closeProxyWhenSettled(proxy));
  const home = proxy.env.HOME;
  install(home, '.gemini/config/plugins');
  mkdirSync(join(home, 'bin'), { recursive: true });
  copyFileSync(FAKE_AGY, join(home, 'bin', 'agy'));
  chmodSync(join(home, 'bin', 'agy'), 0o755);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  mkdirSync(stateFile(home, ''), { recursive: true });
  writeFileSync(stateFile(home, 'antigravity-distill-pending.json'), JSON.stringify({
    's-gone': { prompt: 'add a retry to the uploader', commands: ['npm test'], paths: [], checks: [{ command: 'npm test', failed: false }], answer: 'Retries added; npm test passes.', model: { model: 'gemini-test' }, turn: 1, pid: dead, attempts: 0, at: 1 },
  }));
  const s = conversation(antigravity(t, { ...proxy.env, PATH: `${join(home, 'bin')}:${proxy.env.PATH}` }), home, 's-next');
  s.prompt('what does the uploader do?');
  await s.invoke();

  const [body] = await waitFor(() => proxy.requests.filter((request) => request.path === '/conversation/distill').map((request) => request.body), 5_000);
  assert.deepEqual([body.platform, body.trigger, body.user_prompt, body.persist, body.publish], ['antigravity', 'session_end', 'add a retry to the uploader', true, false]);
  assert.deepEqual(body.strategy, ['Measure.', 'Back off.']);
  assert.equal(body.distill_usage.inputTokens, 900);
  const [call] = readFileSync(join(home, 'fake-agy.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(call.args, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--model', 'gemini-test']);
  assert.equal(call.marker, '1');
  assert.match(call.prompt, /## Task\nadd a retry to the uploader/);
  assert.notEqual(call.cwd, realpathSync(home));
  assert.equal(existsSync(call.cwd), false, 'the empty workspace is removed after the run');
});
