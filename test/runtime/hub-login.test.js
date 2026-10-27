import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SIGN_IN, needsNewRun, signInOf } from '../../lib/hub-login.js';
import { profileNamed } from '../../lib/agent/registry.js';
import { environmentFor } from '../../lib/runtime/environment.js';
import { hubSignInOf, previousLogOf, signInFilesOf } from '../../lib/runtime/hub-login.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';
import { installFakeEvolver } from '../helpers/fake-evolver.js';

const posix = { skip: process.platform === 'win32' && 'process groups are POSIX' };
const RUNTIME = new URL('../../lib/runtime/hub-login.js', import.meta.url).href;
const STORES = new URL('../../lib/runtime/store/file-stores.js', import.meta.url).href;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-login-'));
  const stores = fileStoresOf({ dir: join(dir, 'state'), agent: 'testagent' });
  const prefix = stores.folder('engine');
  const fake = installFakeEvolver(prefix, join(dir, 'fake'));
  const env = { ...process.env, ...fake.env, HOME: dir };
  const files = signInFilesOf(env);
  t.after(() => {
    for (const line of startsOf(dir)) try { process.kill(Number(line.split(' ')[0]), 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, stores, prefix, env, files, signIn: () => hubSignInOf({ files, enginePrefix: prefix, env }) };
}

function startsOf(dir) {
  try {
    return readFileSync(join(dir, 'fake', 'starts'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function until(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const keepsLive = (run) => !needsNewRun(signInOf(run, Date.now()));

// The parent is a process of its own, as a hook process is: it starts the sign-in and exits at once.
function startFromAParentThatExits(world) {
  const script = `
    const { fileStoresOf } = await import(${JSON.stringify(STORES)});
    const { hubSignInOf, signInFilesOf } = await import(${JSON.stringify(RUNTIME)});
    const stores = fileStoresOf({ dir: ${JSON.stringify(join(world.dir, 'state'))}, agent: 'testagent' });
    const run = await hubSignInOf({ files: signInFilesOf(), enginePrefix: stores.folder('engine') }).joinOrStart(() => false);
    process.stdout.write(JSON.stringify({ parent: process.pid, startedAt: run.startedAt }));
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { env: world.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  parent.stdout.on('data', (chunk) => { stdout += chunk; });
  return new Promise((resolve) => parent.on('close', (code) => resolve({ code, ...JSON.parse(stdout || '{}') })));
}

test('the background evolver login outlives the process that started it, in a group of its own, and its log is read back', posix, async (t) => {
  const world = scratch(t);
  const parent = await startFromAParentThatExits(world);
  assert.equal(parent.code, 0);
  const [line] = await until(() => startsOf(world.dir).length > 0 && startsOf(world.dir), 'the fake evolver to start');
  const pid = Number(line.split(' ')[0]);
  assert.equal(line.split(' ').slice(1).join(' '), 'login', 'the managed engine runs `evolver login`');
  assert.throws(() => process.kill(parent.parent, 0), { code: 'ESRCH' }, 'the parent is gone');
  const signIn = world.signIn();
  const waiting = await until(async () => {
    const state = signInOf(await signIn.latest(), Date.now());
    return state.state === SIGN_IN.WAITING && state;
  }, 'the device prompt in the log');
  assert.deepEqual(waiting, { state: SIGN_IN.WAITING, url: 'https://hub.test/device?user_code=FAKE-CODE', code: 'FAKE-CODE' });
  assert.equal((await signIn.latest()).isRunning, true, 'still waiting after its parent exited');
  assert.equal(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim(), String(pid), 'its own process group');

  writeFileSync(join(world.dir, 'fake', 'approved'), '');
  const run = await until(async () => {
    const latest = await signIn.latest();
    return !latest.isRunning && latest;
  }, 'the sign-in to finish');
  assert.deepEqual(signInOf(run, Date.now()), { state: SIGN_IN.SIGNED_IN, hub: 'https://hub.test' });
  assert.equal(run.startedAt, parent.startedAt);
  assert.match(readFileSync(world.files.log, 'utf8'), /Token stored at/);
  await signIn.forget(run);
  assert.equal(await signIn.latest(), null);
});

test('two callers at once share one sign-in: only one evolver login starts', posix, async (t) => {
  const world = scratch(t);
  const [first, second] = await Promise.all([world.signIn().joinOrStart(keepsLive), world.signIn().joinOrStart(keepsLive)]);
  assert.equal(first.startedAt, second.startedAt);
  await until(() => startsOf(world.dir).length > 0, 'the start');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(startsOf(world.dir).length, 1);
  const third = await world.signIn().joinOrStart(keepsLive);
  assert.equal(third.startedAt, first.startedAt, 'a run still waiting is joined, not replaced');
  assert.equal(startsOf(world.dir).length, 1);
});

test('a run that is over is replaced by a fresh evolver login, with a log of its own', posix, async (t) => {
  const world = scratch(t);
  const signIn = world.signIn();
  const first = await signIn.joinOrStart(keepsLive);
  await until(async () => (await signIn.latest()).output.includes('FAKE-CODE'), 'the prompt');
  writeFileSync(join(world.dir, 'fake', 'denied'), '');
  const failed = await until(async () => {
    const latest = await signIn.latest();
    return !latest.isRunning && latest;
  }, 'the denial');
  assert.deepEqual(signInOf(failed, Date.now()), { state: SIGN_IN.FAILED, reason: 'token poll failed (HTTP 400): access_denied' });
  rmSync(join(world.dir, 'fake', 'denied'));
  await signIn.forget(failed);
  const second = await signIn.joinOrStart(keepsLive);
  assert.notEqual(second.startedAt, first.startedAt);
  assert.doesNotMatch(second.output, /access_denied/);
  assert.match(readFileSync(previousLogOf(world.files.log), 'utf8'), /access_denied/, 'the failed run\'s output is kept');
  await until(() => startsOf(world.dir).length === 2, 'the second evolver login');
});

test('two agents with state folders of their own share one sign-in, since they sign in to one identity home', posix, async (t) => {
  const world = scratch(t);
  const pluginData = join(world.dir, 'workbuddy-data');
  const env = { ...world.env, CODEBUDDY_PLUGIN_DATA: pluginData };
  const portsOf = async (agent) => environmentFor({ profile: await profileNamed(agent), env, lifetime: 'ephemeral', runBackground: async () => true }).ports;
  const [codex, workbuddy] = await Promise.all([portsOf('codex'), portsOf('workbuddy')]);
  installFakeEvolver(join(world.dir, '.evolver', 'state', 'codex-engine'), join(world.dir, 'fake'));
  installFakeEvolver(join(pluginData, 'workbuddy-engine'), join(world.dir, 'fake'));
  const [first, second] = await Promise.all([codex.signIn.joinOrStart(keepsLive), workbuddy.signIn.joinOrStart(keepsLive)]);
  assert.equal(first.startedAt, second.startedAt);
  await until(() => startsOf(world.dir).length > 0, 'the start');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(startsOf(world.dir).length, 1, 'one device flow');
  writeFileSync(join(world.dir, 'fake', 'approved'), '');
  const signedIn = await until(async () => {
    const state = signInOf(await workbuddy.signIn.latest(), Date.now());
    return state.state === SIGN_IN.SIGNED_IN && state;
  }, 'the sign-in, seen from the other agent');
  assert.equal(signedIn.hub, 'https://hub.test');
});

test('a start lock left by a killed process gives no run rather than a false one, and starts nothing', async (t) => {
  const world = scratch(t);
  mkdirSync(world.files.lock, { recursive: true });
  writeFileSync(join(world.files.lock, 'owner'), 'a token of a process that is gone');
  const startedAt = Date.now();
  assert.equal(await world.signIn().joinOrStart(keepsLive), null);
  assert.ok(Date.now() - startedAt < 8_000);
  assert.deepEqual(startsOf(world.dir), []);
});

test('a run is running only while its pid is the process that started then: not after a reboot, a reuse or another user', posix, async (t) => {
  const world = scratch(t);
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await new Promise((resolve) => other.once('spawn', resolve));
  const prompt = '\nTo authorize this device:\n  1. open  https://hub.test/device?user_code=OLD-CODE\n  2. enter code:  OLD-CODE\n';
  mkdirSync(join(world.dir, '.evolver', 'login'), { recursive: true });
  writeFileSync(world.files.log, prompt);
  const runOf = async (record) => {
    writeFileSync(world.files.record, JSON.stringify(record));
    return world.signIn().latest();
  };
  assert.equal((await runOf({ pid: other.pid, startedAt: Date.now() })).isRunning, true, 'the process that started then');
  assert.equal((await runOf({ pid: other.pid, startedAt: Date.now() - 5 * 60_000 })).isRunning, false, 'a pid another process took over');
  assert.equal((await runOf({ pid: other.pid, startedAt: Date.now() - uptime() * 1000 - 60_000 })).isRunning, false, 'a run from before the last boot');
  assert.equal((await runOf({ pid: 1, startedAt: Date.now() })).isRunning, false, "another user's process");
  assert.equal(signInOf(await runOf({ pid: other.pid, startedAt: Date.now() - 5 * 60_000 }), Date.now()).state, SIGN_IN.FAILED, 'its old code is not shown');
});

test('without an engine of its own or an evolver on PATH, the sign-in runs npx on the one release the plugin was verified against', posix, async (t) => {
  const world = scratch(t);
  const bin = join(world.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$$ $*" >> "${join(world.dir, 'fake', 'starts')}"\nprintf '  1. open  https://hub.test/device\\n  2. enter code:  NPX-CODE\\n'\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  const signIn = hubSignInOf({ files: world.files, enginePrefix: join(world.dir, 'no-engine'), env: { ...world.env, PATH: bin } });
  await signIn.joinOrStart(keepsLive);
  const [line] = await until(() => startsOf(world.dir).length > 0 && startsOf(world.dir), 'npx');
  assert.equal(line.split(' ').slice(1).join(' '), '-y @evomap/evolver@2.0.46 login');
  assert.equal((statSync(world.files.log).mode & 0o777).toString(8), '600', 'the log is the person\'s alone');
  await until(async () => (await signIn.latest()).output.includes('NPX-CODE'), 'its output');
});

test('a run replaced while it still runs is ended, so no second device flow lives on', posix, async (t) => {
  const world = scratch(t);
  const signIn = world.signIn();
  await signIn.joinOrStart(keepsLive);
  const [first] = await until(() => startsOf(world.dir).length > 0 && startsOf(world.dir), 'the first run');
  const firstPid = Number(first.split(' ')[0]);
  await signIn.joinOrStart(() => false);
  await until(() => startsOf(world.dir).length === 2, 'the second run');
  await until(() => {
    try {
      process.kill(firstPid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'the first run to end');
});
