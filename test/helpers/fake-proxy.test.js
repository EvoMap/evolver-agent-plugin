import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

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
