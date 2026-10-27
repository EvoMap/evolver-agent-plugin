import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { enginePortOf } from '../../lib/runtime/engine/job.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';

function enginePort(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = fileStoresOf({ dir, agent: 'testagent' });
  return { stores, engine: enginePortOf(stores, { runningProxy: async () => null, runtime: {} }) };
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
