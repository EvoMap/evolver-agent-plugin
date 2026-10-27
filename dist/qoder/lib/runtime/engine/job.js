// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isSetupDue, prepareEngine, setupErrorOutcome, withoutRetryDelay } from '../../engine/setup.js';
import { meetsMinimum } from '../../engine/version.js';
import { withLock } from '../store/file-lock.js';
import { engineRuntime } from './install.js';

// Installing can take minutes (npm up to 5, starting the Proxy up to 2), longer than a lock is trusted to be held,
// so the lock is refreshed while the work runs and no second session start installs into the same folder.
const LOCK_REFRESH_MS = 30_000;

async function setUpUnderLock(stores, runtime) {
  const previous = await stores.engineState.read();
  if (!isSetupDue(previous, runtime.now())) return;
  let outcome;
  try {
    outcome = await prepareEngine(runtime, previous);
  } catch (error) {
    outcome = setupErrorOutcome(error, previous, runtime.now());
  }
  await stores.engineState.update(() => outcome);
}

/**
 * The Engine port: whether Evolver needs setting up (no Proxy new enough answers and no retry is pending),
 * setting it up under the agent's own prefix, retrying a failed setup at once, and the outcome's one-off announcement.
 */
export function enginePortOf(stores, { runningProxy, runtime = engineRuntime({ prefix: stores.folder('engine') }) }) {
  return {
    outcome: () => stores.engineState.read(),
    needsSetup: async () => {
      const running = await runningProxy();
      return !(running && meetsMinimum(running.version)) && isSetupDue(await stores.engineState.read(), Date.now());
    },
    setUp: () => withLock(stores.engineLock, async (lock) => {
      const keepAlive = setInterval(lock.refresh, LOCK_REFRESH_MS);
      keepAlive.unref?.();
      try {
        await setUpUnderLock(stores, runtime);
      } finally {
        clearInterval(keepAlive);
      }
    }),
    retryNow: () => stores.engineState.update(withoutRetryDelay),
    takeUnannounced: async () => {
      const outcome = await stores.engineState.read();
      if (!outcome) return null;
      let isNew = false;
      await stores.engineAnnounced.update((announced) => {
        isNew = announced.at !== outcome.at;
        return isNew ? { at: outcome.at } : undefined;
      });
      return isNew ? outcome : null;
    },
  };
}
