import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { engineRuntime } from '../../lib/runtime/engine/install.js';
import { desktopProxyMayStart, proxyFetchOf, runningProxy } from '../../lib/runtime/proxy.js';

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  return server.address().port;
}

test('Proxy redirects cannot forward a request body to a different origin', async (t) => {
  let forwarded = 0;
  const destination = await listen(t, (request, response) => {
    forwarded += 1;
    request.resume();
    response.end('{}');
  });
  const port = await listen(t, (request, response) => {
    request.resume();
    response.writeHead(307, { Location: `http://127.0.0.1:${destination}/redirected` }).end();
  });
  const proxyFetch = proxyFetchOf({ EVOMAP_PROXY_PORT: String(port), HOME: import.meta.dirname });
  const result = await proxyFetch('POST', '/conversation/distill', { fixture: 'private draft' });
  assert.equal(forwarded, 0);
  assert.equal(result.ok, false);
});

test('a timeout in fractional milliseconds, as a wait measured from the process start has, still reaches the Proxy', async (t) => {
  const port = await listen(t, (request, response) => {
    request.resume();
    response.end('{"assets":[]}');
  });
  const proxyFetch = proxyFetchOf({ EVOMAP_PROXY_PORT: String(port), HOME: import.meta.dirname });
  const result = await proxyFetch('POST', '/asset/fetch', {}, { timeoutMs: 5_234.567 });
  assert.equal(result.ok, true, result.error);
});

test('only an authenticated Proxy matching the Desktop lifecycle receipt receives the request', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-proxy-version-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'custom state');
  mkdirSync(dir);
  const command = join(home, 'desktop', 'evolver.exe');
  let received = 0, statusPid = process.pid, healthProbes = 0;
  const port = await listen(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer local-test');
    if (request.url === '/proxy/status') {
      healthProbes += 1;
      return response.end(JSON.stringify({ running: true, health: { pid: statusPid } }));
    }
    received += 1;
    request.resume();
    response.end('{}');
  });
  const desktopEngine = () => ({ command, args: [], version: '2.0.50' });
  const env = { HOME: home, EVOLVER_PROXY_SETTINGS_FILE: join(dir, 'settings.json'), EVOLVER_LIFECYCLE_PID_FILE: join(dir, 'override.pid') };
  let proof;
  const request = proxyFetchOf(env, { desktopEngine, desktopProof: () => proof });
  const settings = (version, token = 'local-test') => writeFileSync(env.EVOLVER_PROXY_SETTINGS_FILE, JSON.stringify({ proxy: { url: `http://127.0.0.1:${port}`, token, pid: process.pid, version } }));
  const receipt = (overrides) => writeFileSync(env.EVOLVER_LIFECYCLE_PID_FILE, JSON.stringify({ owner: 'evolver-lifecycle', pid: process.pid, command, args: ['proxy'], ...overrides }));
  assert.equal(desktopProxyMayStart(env), true, 'isolated profile may start its first Proxy');
  settings('2.0.50');
  receipt({ command: join(home, 'global', 'evolver.exe') });
  assert.equal(desktopProxyMayStart(env), false, 'never start on top of a live PID when ownership is unresolved');
  assert.equal((await runningProxy({ env, desktopEngine })).desktopProof, null);
  assert.equal((await request('POST', '/asset/fetch', {})).ok, false);
  assert.equal(received, 0);

  receipt({});
  statusPid += 1;
  assert.equal((await runningProxy({ env, desktopEngine })).desktopProof, null);
  assert.equal((await request('POST', '/asset/fetch', {})).ok, false, 'the status response must own the settings PID');
  statusPid = process.pid;
  settings('2.0.51');
  assert.equal((await request('POST', '/asset/fetch', {})).ok, false, 'the receipt must serve the selected version');
  settings('2.0.50');
  proof = (await runningProxy({ env, desktopEngine })).desktopProof;
  assert.match(proof, /^[a-f0-9]{64}$/);
  const authenticated = healthProbes;
  assert.equal((await request('POST', '/asset/fetch', {})).ok, true);
  assert.equal(received, 1);
  assert.equal(healthProbes, authenticated, 'a locked dispatch does not wait for a second health request');
  settings('2.0.50', 'rotated');
  assert.equal((await request('POST', '/asset/fetch', {})).ok, false, 'a new endpoint token invalidates the old proof');
  assert.equal(received, 1);
});

test('Desktop setup declines an installation replaced before launch', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-desktop-switch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = { command: process.execPath, args: ['-e', 'console.log("first installation")'], version: '2.0.50' };
  const next = { ...first, args: ['-e', 'console.log("next installation")'] };
  let selection = next;
  const runtime = engineRuntime({
    env: { HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot },
    desktopEngine: () => selection,
  });
  const stale = await runtime.runDesktop(first, ['lifecycle', 'start']);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /Desktop installation changed/);

  selection = first;
  const current = await runtime.runDesktop(first, ['lifecycle', 'start']);
  assert.equal(current.ok, true, current.error);
  assert.match(current.stdout, /first installation/);
});
