import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SIGN_IN, needsNewRun, signInOf } from '../../lib/hub-login.js';
import { profileNamed } from '../../lib/agent/registry.js';
import { environmentFor } from '../../lib/runtime/environment.js';
import { hubSignInOf, signInFilesOf } from '../../lib/runtime/hub-login.js';
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
