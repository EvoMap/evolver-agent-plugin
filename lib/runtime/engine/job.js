// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';

import { isSetupDue, prepareEngine, setupErrorOutcome, withoutRetryDelay } from '../../engine/setup.js';
import { meetsMinimum } from '../../engine/version.js';
import { withLock } from '../store/file-lock.js';
import { engineRuntime } from './install.js';

// Installing can take minutes (npm up to 5, starting the Proxy up to 2), longer than a lock is trusted to be held,
// so the lock is refreshed while the work runs and no second session start installs into the same folder.
const LOCK_REFRESH_MS = 30_000;

function desktopSelectionOf(desktopEngine) {
  try {
    const engine = desktopEngine?.();
    if (engine) return createHash('sha256').update(JSON.stringify([engine.version, engine.command, engine.args])).digest('hex');
  } catch {
    return 'invalid';
  }
}

async function needsSetup(previous, selection, runningProxy, now) {
  const due = isSetupDue(previous, now);
  if (selection === 'invalid' || (!selection && !due)) return due;
  const running = await runningProxy();
  if (selection) return running?.desktopProof ? running.desktopProof !== previous?.desktopProof : due;
  return !(running && meetsMinimum(running.version));
}

async function setUpUnderLock(stores, runtime) {
  const saved = await stores.engineState.read();
  const selection = desktopSelectionOf(runtime.desktopEngine);
  const previous = saved?.desktopSelection === selection ? saved : null;
  const now = runtime.now();
  if (runtime.desktopEngine ? !(await needsSetup(previous, selection, runtime.runningProxy, now)) : !isSetupDue(previous, now)) return;
  let outcome;
  try {
    outcome = await prepareEngine(runtime, previous);
  } catch (error) {
    outcome = setupErrorOutcome(error, previous, runtime.now());
  }
  await stores.engineState.update(() => {
    if (selection !== desktopSelectionOf(runtime.desktopEngine)) return undefined;
    return selection ? { ...outcome, desktopSelection: selection } : outcome;
  });
}

/**
 * The Engine port: whether Evolver needs setting up (no Proxy new enough answers and no retry is pending),
 * setting it up under the agent's own prefix, retrying a failed setup at once, and the outcome's one-off announcement.
 */
export function enginePortOf(stores, {
  runningProxy, clientEnv = () => ({}), desktopEngine, env = process.env,
  runtime = engineRuntime({ prefix: stores.folder('engine'), clientEnv, desktopEngine, env, inspectProxy: desktopEngine ? runningProxy : undefined }),
}) {
  return {
    outcome: () => stores.engineState.read(),
    needsSetup: async () => {
      const saved = await stores.engineState.read();
      const selection = desktopSelectionOf(desktopEngine);
      const previous = saved?.desktopSelection === selection ? saved : null;
      return needsSetup(previous, selection, runningProxy, Date.now());
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
