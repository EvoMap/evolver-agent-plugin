import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { profileNamed } from '../../lib/agent/registry.js';
import { sessionEndWaitOf, waitBudgetOf } from '../../lib/runtime/budget.js';
import { EPHEMERAL, environmentFor } from '../../lib/runtime/environment.js';
import { waitForWakeUp } from '../../lib/runtime/lifetime/ephemeral.js';
import { modelRunnerOf } from '../../lib/runtime/model-executor.js';
import { ownerIsGone, ownerProbeOf } from '../../lib/runtime/process/owner.js';
import { cmdArgument, runProcess } from '../../lib/runtime/process/spawn.js';
import { readState, writeState } from '../../lib/runtime/store/file-lock.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';

const node = process.execPath;

test('a run gets its input on stdin and the headless marker only when asked', async () => {
  const echo = ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s+"|"+(process.env.EVOLVER_HEADLESS??"-")))'];
  assert.equal((await runProcess(node, echo, { input: 'hi' })).stdout, 'hi|-');
  assert.equal((await runProcess(node, echo, { input: 'hi', headless: true })).stdout, 'hi|1');
});

test('a run past its timeout is killed and says so; a missing command reads as ENOENT', async () => {
  const slow = await runProcess(node, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 200 });
  assert.equal(slow.error.code, 'ETIMEDOUT');
  assert.equal((await runProcess('evolver-no-such-command-xyz', [])).error.code, 'ENOENT');
});

test('a cancelled run is ended and reported cancelled', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const result = await runProcess(node, ['-e', 'setTimeout(()=>{},60000)'], { signal: controller.signal });
  assert.equal(result.error.code, 'ABORT_ERR');
});

test('a hook process arms one sleeping waiter, another only for an earlier time or when its pid now names another process; a waiter that wakes gives up its record and runs', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-wake-up-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, EVOLVER_AUTO_DISTILL: 'off' };
  const profile = await profileNamed('codex');
  const { scheduler } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: async () => true }).ports;
  const stores = fileStoresOf({ dir: profile.stateDir(env), agent: profile.name });
  await stores.candidates.update(() => ({ leftover: { closed: true, at: 1 } }));
  const waiter = () => readState(stores.distillWaiter, null);
  const started = [];
  t.after(() => {
    for (const pid of [...started, waiter()?.pid]) if (pid && !ownerIsGone(pid)) process.kill(pid);
    rmSync(home, { recursive: true, force: true });
  });
  const until = async (check, what) => {
    for (const deadline = Date.now() + 10_000; !check(); await new Promise((resolve) => setTimeout(resolve, 20))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    }
  };
  const inAnHour = Date.now() + 60 * 60_000;
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  started.push(stranger.pid);
  writeState(stores.distillWaiter, { pid: stranger.pid, startedAt: Date.now() - 10 * 60_000, at: inAnHour });
  scheduler.wakeAt(inAnHour, ['distill']);
  const sleeping = waiter();
  started.push(sleeping.pid);
  assert.notEqual(sleeping.pid, stranger.pid, 'a dead waiter whose pid another process took arms nothing');
  assert.equal(sleeping.at, inAnHour);
  scheduler.wakeAt(inAnHour + 1, ['distill']);
  assert.deepEqual(waiter(), sleeping, 'a later wake-up is already armed');
  scheduler.wakeAt(Date.now(), ['distill']);
  const waking = waiter();
  started.push(waking.pid);
  assert.notEqual(waking.pid, sleeping.pid, 'an earlier wake-up starts its own waiter');
  await until(() => ownerIsGone(waking.pid), 'the woken waiter to run and exit');
  assert.deepEqual([waiter(), await stores.candidates.read()], [null, {}], 'its record is gone, and its distill task dropped the expired leftover');
  assert.equal(ownerIsGone(sleeping.pid), false, 'the later waiter sleeps on');
});

test('an unreadable waiter record neither stops a woken waiter nor is removed by it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-waiter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const waiterFile = join(dir, 'waiter.json');
  writeFileSync(waiterFile, '{unfinished');
  await waitForWakeUp(0, { waiterFile, clock: { now: () => 1, sleep: async () => {} } });
  assert.equal(readFileSync(waiterFile, 'utf8'), '{unfinished');
});

test("a process's age is read from every form ps prints it in, and is unknown where ps cannot say", async () => {
  const { elapsedMsOf } = await import('../../lib/runtime/process/identity.js');
  const ps = (stdout) => ({ probe: () => ({ stdout }), platform: 'darwin' });
  assert.equal(elapsedMsOf(1, ps('   05:03\n')), 303_000);
  assert.equal(elapsedMsOf(1, ps('01:02:03')), 3_723_000);
  assert.equal(elapsedMsOf(1, ps('2-01:02:03')), 176_523_000);
  assert.equal(elapsedMsOf(1, ps('')), null);
  assert.equal(elapsedMsOf(1, { platform: 'win32' }), null);
});

test('cmd.exe metacharacters in an argument are quoted and escaped so none runs', () => {
  assert.equal(cmdArgument('a&b'), '^^^"a^^^&b^^^"');
});

test('the owner is this process, the parent past a shell, or the nearest named ancestor', () => {
  const table = new Map([[process.ppid, { ppid: 50, name: 'zsh' }], [50, { ppid: 40, name: 'Cursor Helper' }], [40, { ppid: 1, name: 'codex' }]]);
  const probe = (pid) => table.get(pid) ?? null;
  assert.equal(ownerProbeOf('self').current(), process.pid);
  assert.equal(ownerProbeOf('parent', { probe, platform: 'darwin' }).current(), 50);
  assert.equal(ownerProbeOf({ ancestor: /^codex/ }, { probe, platform: 'darwin' }).current(), 40);
  assert.equal(ownerProbeOf('parent', { probe, platform: 'win32' }).current(), null);
});

test('a hook waits what is left of its budget, never less than a floor', () => {
  assert.equal(waitBudgetOf({ prompt: 8_000 }, 'prompt', { startedAt: 0, now: 500 }), 6_000);
  assert.equal(waitBudgetOf({ prompt: 7_000 }, 'prompt', { startedAt: 0, now: 500 }), 5_000);
  assert.equal(waitBudgetOf({ prompt: 660_000 }, 'prompt', { startedAt: 0, now: 0 }), 6_000);
  assert.equal(waitBudgetOf({ prompt: 1_000 }, 'prompt', { startedAt: 0, now: 0 }), 500);
  assert.equal(waitBudgetOf({}, 'prompt', { lifetime: 'resident' }), 6_000);
});

test('a session end waits for the last turn\'s end only as long as the host\'s session-end budget leaves', () => {
  assert.equal(sessionEndWaitOf({ prompt: 5_000 }, 2_000, { startedAt: 0, now: 100 }), 2_000, 'no budget, no limit');
  assert.equal(sessionEndWaitOf({ sessionEnd: 1_500 }, 2_000, { startedAt: 0, now: 100 }), 600);
  assert.equal(sessionEndWaitOf({ sessionEnd: 1_500 }, 300, { startedAt: 0, now: 100 }), 300);
  assert.equal(sessionEndWaitOf({ sessionEnd: 1_500 }, 2_000, { startedAt: 0, now: 1_000 }), 0);
});

test('a cli model may take its prompt from a file in its empty folder, and set variables for the run', async () => {
  const runner = modelRunnerOf({
    kind: 'cli',
    command: () => node,
    args: (model, prompt, { promptPath }) => ['-e', 'const fs=require("fs");process.stdout.write(JSON.stringify({text:fs.readFileSync(process.argv[1],"utf8"),cwd:process.cwd(),flag:process.env.HOST_HOOKS_ENABLED}))', promptPath],
    parse: ({ stdout }) => ({ answer: JSON.parse(stdout) }),
    workdir: 'empty',
    promptFile: 'prompt.md',
    env: { HOST_HOOKS_ENABLED: 'false' },
  });
  const { answer } = await runner.complete('m', 'the gene prompt', AbortSignal.timeout(5_000));
  assert.equal(answer.text, 'the gene prompt');
  assert.equal(answer.flag, 'false');
  assert.equal(existsSync(answer.cwd), false, 'the folder and its prompt file are removed after the run');
});

test('a cli model that exits non-zero fails with what its output says, else with its exit code and output', async () => {
  const exiting = (stdout) => ({
    kind: 'cli',
    command: () => node,
    args: () => ['-e', `process.stdout.write(${JSON.stringify(stdout)});process.exit(1)`],
    parse: ({ stdout: printed }) => {
      const result = JSON.parse(printed);
      if (result.is_error) throw new Error(`no answer: ${result.result}`);
      return { answer: result.result };
    },
  });
  await assert.rejects(modelRunnerOf(exiting('{"is_error":true,"result":"Not logged in"}')).complete('m', 'gene', AbortSignal.timeout(5_000)), /^Error: no answer: Not logged in$/);
  await assert.rejects(modelRunnerOf(exiting('{"is_error":false,"result":"half"}')).complete('m', 'gene', AbortSignal.timeout(5_000)), /exited 1: \{"is_error":false,"result":"half"\}$/);
});

test('a cli model declaration runs headless and parses its answer; none or in-session means no runner', async () => {
  const runner = modelRunnerOf({
    kind: 'cli',
    command: () => node,
    args: () => ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({result:s.toUpperCase(),marker:process.env.EVOLVER_HEADLESS})))'],
    parse: ({ stdout }) => ({ answer: JSON.parse(stdout).result + JSON.parse(stdout).marker }),
  });
  assert.equal((await runner.complete('m', 'gene', AbortSignal.timeout(5_000))).answer, 'GENE1');
  assert.equal(modelRunnerOf(null), null);
  assert.equal(modelRunnerOf({ kind: 'in-session' }), null);
  assert.equal(modelRunnerOf({ kind: 'cli', command: () => null }), null);
});

test('the CLI runs the plugin-installed engine in the project directory, before any on PATH', async () => {
  const { evolverCliOf } = await import('../../lib/runtime/cli-executor.js');
  const { mkdtempSync, writeFileSync, realpathSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-cli-')));
  const entry = join(dir, 'evolver.mjs');
  writeFileSync(entry, 'process.stdout.write(process.argv.slice(2).join(" ") + " in " + process.cwd())');
  const cli = evolverCliOf({ enginePrefix: '/managed', managedEngine: (prefix) => (prefix === '/managed' ? { path: entry } : null) });
  assert.deepEqual(await cli.run(['run', '--dry-run'], { cwd: dir }), { ok: true, text: `run --dry-run in ${dir}` });
});

test('a CLI is looked up name by name, on PATH then in the host\'s folders, and a generic name must prove itself', async () => {
  const { executableOf } = await import('../../lib/runtime/process/which.js');
  const present = new Set(['/usr/bin/agent', '/home/me/.local/bin/cursor-agent', '/apps/wb/codebuddy']);
  const options = { env: { PATH: '/usr/bin' }, platform: 'darwin', exists: (file) => present.has(file), realPath: (file) => file };
  const cursor = { names: ['cursor-agent', 'agent'], dirs: ['/home/me/.local/bin'], accepts: (name, real) => name === 'cursor-agent' || real.includes('cursor-agent') };
  assert.deepEqual(executableOf(cursor, options), { file: '/home/me/.local/bin/cursor-agent', viaNode: false });
  present.delete('/home/me/.local/bin/cursor-agent');
  assert.equal(executableOf(cursor, options), null, 'an unrelated agent on PATH is never run');
  const workbuddy = { names: ['codebuddy'], dirs: ['/apps/wb'], nodeScriptOnWindows: true };
  assert.deepEqual(executableOf(workbuddy, options), { file: '/apps/wb/codebuddy', viaNode: false });
  assert.deepEqual(executableOf(workbuddy, { ...options, platform: 'win32', env: { PATH: '/usr/bin' } }), { file: '/apps/wb/codebuddy', viaNode: true });
  present.add('/usr/bin/tool.cmd');
  assert.equal(executableOf({ names: ['tool'] }, { ...options, platform: 'win32' }), null, 'a .cmd shim needs a shell');
});

test('on Windows an npm .cmd shim is found only for a CLI that allows one, after an .exe of the same name', async () => {
  const { executableOf } = await import('../../lib/runtime/process/which.js');
  const present = new Set(['/npm/codex.cmd', '/tools/codex.exe']);
  const options = (PATH) => ({ env: { PATH }, platform: 'win32', exists: (file) => present.has(file), realPath: (file) => file });
  assert.deepEqual(executableOf({ names: ['codex'], windowsShims: true }, options('/npm')), { file: '/npm/codex.cmd', viaNode: false });
  assert.equal(executableOf({ names: ['codex'] }, options('/npm')), null);
  assert.deepEqual(executableOf({ names: ['codex'], windowsShims: true }, options('/tools')), { file: '/tools/codex.exe', viaNode: false });
});
