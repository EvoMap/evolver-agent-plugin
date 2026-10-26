// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isSetupDue, prepareEngine, setupErrorOutcome } from '../../engine/setup.js';
import { meetsMinimum } from '../../engine/version.js';
import { withLock } from '../store/file-lock.js';
import { engineRuntime } from './install.js';

/**
 * The Engine port: whether Evolver needs setting up (no Proxy new enough answers and no retry is pending),
 * setting it up under the agent's own prefix, and the outcome's one-off announcement.
 */
export function enginePortOf(stores, { runningProxy, runtime = engineRuntime({ prefix: stores.folder('engine') }) }) {
  return {
    outcome: () => stores.engineState.read(),
    needsSetup: async () => {
      const running = await runningProxy();
      return !(running && meetsMinimum(running.version)) && isSetupDue(await stores.engineState.read(), Date.now());
    },
    setUp: () => withLock(stores.engineLock, async () => {
      const previous = await stores.engineState.read();
      if (!isSetupDue(previous, runtime.now())) return;
      let outcome;
      try {
        outcome = await prepareEngine(runtime, previous);
      } catch (error) {
        outcome = setupErrorOutcome(error, previous, runtime.now());
      }
      await stores.engineState.update(() => outcome);
    }),
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
