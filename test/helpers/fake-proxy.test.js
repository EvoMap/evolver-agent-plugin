import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { profileNamed } from '../../lib/agent/registry.js';
import { environmentFor, EPHEMERAL } from '../../lib/runtime/environment.js';
import { ownerIsGone, processStartTime, PROCESS_START_TOLERANCE_MS } from '../../lib/runtime/process/owner.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';
import { fakeProxy } from './fake-proxy.js';

test('the fake Proxy stays healthy while the test process does synchronous work', async t => {
  const proxy = await fakeProxy();
  t.after(() => proxy.close());
  const runtime = new URL('../../lib/runtime/proxy.js', import.meta.url).href;
  const script = `
    import { runningProxy } from ${JSON.stringify(runtime)};
    console.log('READY');
    await new Promise(resolve => process.stdin.once('data', resolve));
    console.log(JSON.stringify(await runningProxy()));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: proxy.env, windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const exited = once(child, 'close');
  let stdout = '', stderr = '', blocked = false;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (blocked || !stdout.includes('READY')) return;
    blocked = true;
    child.stdin.end('GO\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  });
  assert.deepEqual(await exited, [0, null], stderr);
  assert.equal(blocked, true);
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result?.version, '2.0.50');
  proxy.close();
  assert.equal(proxy.requests.filter(request => request.path === '/proxy/status').length, 1);
});

test('fake Proxy teardown still stops a waiter when a monitor directory disappears', async t => {
  const proxy = await fakeProxy();
  const home = proxy.env.HOME;
  t.after(() => { if (fs.existsSync(home)) proxy.close(); });
  const monitors = join(home, 'turn-monitors');
  const admission = join(monitors, 'turn.admission');
  const waiterDir = join(home, 'waiters');
  fs.mkdirSync(admission, { recursive: true });
  fs.mkdirSync(waiterDir);
  const startedAt = Date.now();
  const waiter = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(42), 5000)'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(waiter, 'exit');
  t.after(() => { if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill(); });
  await once(waiter, 'spawn');
  fs.writeFileSync(join(waiterDir, 'fixture-distill-waiter.json'), JSON.stringify({ pid: waiter.pid, startedAt }));

  const { readdirSync } = fs;
  let removed = false;
  const race = t.mock.method(fs, 'readdirSync', (dir, options) => {
    const entries = readdirSync(dir, options);
    if (!removed && dir === (options?.recursive ? home : monitors)) {
      fs.rmdirSync(admission);
      removed = true;
      // The recursive native traversal also fails when it reaches the child it already listed.
      if (options?.recursive) readdirSync(admission);
    }
    return entries;
  });
  syncBuiltinESMExports();
  try {
    proxy.close();
  } finally {
    race.mock.restore();
    syncBuiltinESMExports();
  }

  assert.deepEqual(await exited, process.platform === 'win32' ? [1, null] : [null, 'SIGTERM']);
  assert.equal(fs.existsSync(home), false);
});

test('closing the fake Proxy stops a later waiter after an earlier wake-up removed the shared record', async t => {
  const proxy = await fakeProxy();
  const env = { ...proxy.env, CODEX_HOME: join(proxy.env.HOME, '.codex'), PLUGIN_DATA: '', EVOLVER_AUTO_DISTILL: 'off' };
  const profile = await profileNamed('codex');
  const { scheduler } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: async () => true }).ports;
  const { distillWaiter } = fileStoresOf({ dir: profile.stateDir(env), agent: profile.name });
  const readWaiter = () => JSON.parse(fs.readFileSync(distillWaiter, 'utf8'));
  const waiters = [];
  t.after(async () => {
    for (const { pid, startedAt } of waiters) {
      if (ownerIsGone(pid)) continue;
      const birth = processStartTime(pid, 2_500);
      if (birth !== null && Math.abs(birth - startedAt) <= PROCESS_START_TOLERANCE_MS) process.kill(pid);
    }
    await proxy.closeAsync();
  });
  const until = async (condition, what) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await delay(25);
    }
  };

  scheduler.wakeAt(Date.now() + 60_000, ['distill']);
  const later = readWaiter();
  waiters.push(later);
  scheduler.wakeAt(Date.now() + 2_000, ['distill']);
  const earlier = readWaiter();
  waiters.push(earlier);
  assert.notEqual(later.pid, earlier.pid);
  await until(() => ownerIsGone(earlier.pid) && !fs.existsSync(distillWaiter), 'the earlier waiter to finish');
  assert.equal(ownerIsGone(later.pid), false, 'the superseded waiter was still sleeping at teardown');

  proxy.close();
  await until(() => waiters.every(({ pid }) => ownerIsGone(pid)), 'both waiters to exit after close');
});

test('a waiter that starts after fake Proxy teardown exits without recreating the profile', async t => {
  const proxy = await fakeProxy();
  const home = proxy.env.HOME;
  const env = { ...proxy.env, CODEX_HOME: join(home, '.codex'), PLUGIN_DATA: '', EVOLVER_AUTO_DISTILL: 'off' };
  t.after(() => proxy.closeAsync());
  await proxy.closeAsync();

  const worker = fileURLToPath(new URL('../../bin/worker.mjs', import.meta.url));
  await promisify(execFile)(process.execPath, [worker, 'codex', `--at=${Date.now() + 60_000}`, 'distill'],
    { env, windowsHide: true, timeout: 5_000 });
  assert.equal(fs.existsSync(home), false);
});
