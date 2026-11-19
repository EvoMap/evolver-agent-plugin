import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { enginePortOf } from '../../lib/runtime/engine/job.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';

function enginePort(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = fileStoresOf({ dir, agent: 'testagent' });
  return { stores, engine: enginePortOf(stores, { runningProxy: async () => null, runtime: {}, ...options }) };
}

test('a failed setup waits out its retry delay, unless a person asks: retryNow makes it due at once', async (t) => {
  const { stores, engine } = enginePort(t);
  const failed = { status: 'install_failed', error: 'npm ERR! network', at: Date.now(), failures: 1, retryAt: Date.now() + 600_000 };
  await stores.engineState.update(() => failed);
  assert.equal(await engine.needsSetup(), false);
  await engine.retryNow();
  assert.equal(await engine.needsSetup(), true);
  const { retryAt, ...kept } = failed;
  assert.deepEqual(await engine.outcome(), kept, 'only the delay is dropped');
});

test('retryNow leaves an outcome without a retry delay, or none at all, as it is', async (t) => {
  const { stores, engine } = enginePort(t);
  await engine.retryNow();
  assert.equal(await engine.outcome(), null);
  const ready = { status: 'ready', version: '2.0.46', at: 1, failures: 0 };
  await stores.engineState.update(() => ready);
  await engine.retryNow();
  assert.deepEqual(await engine.outcome(), ready);
});

test('Desktop setup retries belong to the selected installation, and queued workers recheck it', async (t) => {
  let running;
  let corrupt = false;
  let failStart = true;
  let starts = 0;
  const desktopEngine = () => {
    if (corrupt) throw Object.assign(new Error('Repair the Desktop installation'), { source: 'desktop' });
    return { command: 'desktop-evolver', args: [], version: '2.0.50' };
  };
  const runningProxy = async () => running;
  const runtime = {
    now: Date.now, desktopEngine, runningProxy, nodeVersion: '22.13.0',
    runDesktop: async () => {
      starts += 1;
      if (failStart) return { ok: false, error: 'Proxy did not start' };
      running = { version: '2.0.50', desktopProof: 'desktop-proxy' };
      return { ok: true };
    },
    waitForProxy: runningProxy,
  };
  const { stores, engine } = enginePort(t, { desktopEngine, runningProxy, runtime });
  await stores.engineState.update(() => ({
    status: 'start_failed', source: 'managed', failures: 4, retryAt: Date.now() + 600_000,
  }));

  assert.equal(await engine.needsSetup(), true, 'a plugin-managed failure must not delay the first Desktop setup');
  await engine.setUp();
  assert.equal(starts, 1);
  assert.equal((await engine.outcome()).failures, 1);
  assert.equal(await engine.needsSetup(), false, 'the same Desktop selection still backs off');
  await engine.setUp();
  assert.equal(starts, 1, 'a queued retry respects the current selection backoff under lock');

  corrupt = true;
  assert.equal(await engine.needsSetup(), true, 'corruption must be reported even during an earlier retry delay');
  await engine.setUp();
  assert.equal((await engine.outcome()).error, 'Repair the Desktop installation');
  assert.equal(await engine.needsSetup(), false, 'an unchanged corrupt selection still backs off');

  corrupt = false;
  failStart = false;
  assert.equal(await engine.needsSetup(), true, 'a repaired selection is retried immediately');
  await engine.setUp();
  const ready = await engine.outcome();
  assert.equal(ready.status, 'started');
  assert.equal(ready.desktopProof, 'desktop-proxy');
  await engine.setUp();
  assert.deepEqual(await engine.outcome(), ready, 'a queued worker leaves the same verified Proxy alone');
  assert.equal(starts, 2);

  running = null;
  assert.equal(await engine.needsSetup(), true, 'a successful setup does not delay restarting a stopped Proxy');
  await engine.setUp();
  assert.equal(starts, 3);
});

test('setup does not persist a Proxy result across a concurrent Desktop selection change', async (t) => {
  let readyProxy;
  const updated = { command: 'new-desktop-evolver', args: [], version: '2.0.51' };
  let selection = {
    command: 'old-desktop-evolver', args: [], version: '2.0.50',
    verify: async () => {
      selection = updated;
      readyProxy = { version: updated.version, desktopProof: 'new-proxy' };
    },
  };
  const desktopEngine = () => selection;
  const runningProxy = async () => readyProxy;
  const runtime = { now: Date.now, desktopEngine, runningProxy, nodeVersion: '22.13.0' };
  const { engine } = enginePort(t, { desktopEngine, runningProxy, runtime });

  await engine.setUp();
  assert.equal(await engine.outcome(), null);
  assert.equal(await engine.needsSetup(), true);
  await engine.setUp();
  const outcome = await engine.outcome();
  assert.equal(outcome.version, updated.version);
  assert.equal(outcome.desktopProof, 'new-proxy');
});
