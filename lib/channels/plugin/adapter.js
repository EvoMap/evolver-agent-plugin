// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { createDriver } from '../../agent/driver.js';
import { RESIDENT, environmentFor } from '../../runtime/environment.js';
import { transcripts } from '../../runtime/transcripts.js';

/**
 * The channel of a host that loads the plugin into its own process: the host calls `handle(hostEvent, payload)`
 * from its callbacks and applies the answer itself; background work runs in this process. `overrides` replaces
 * ports the host provides itself, such as an SDK-backed model. `idle()` resolves when background work is done.
 */
export function createPluginChannel({ profile, env = process.env, overrides = {} }) {
  const { ports } = environmentFor({ profile, env, lifetime: RESIDENT, runBackground: runBackgroundTasks, overrides });
  const driver = createDriver({ profile, ports, transcripts, lifetime: RESIDENT });
  return { handle: driver.handle, idle: () => ports.scheduler.idle?.() ?? Promise.resolve(), ports };
}
