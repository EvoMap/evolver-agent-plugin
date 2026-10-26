// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { COMMANDS } from '../../app/commands/index.js';
import { createDriver } from '../../agent/driver.js';
import { RESIDENT, environmentFor } from '../../runtime/environment.js';
import { transcripts } from '../../runtime/transcripts.js';

/** What an entry may show of the plugin's commands: name, description, input hint, and whether it is a prompt for the agent. */
export const commandCatalog = Object.freeze(COMMANDS.map(({ name, description, hint, forAgent }) => Object.freeze({ name, description, hint, forAgent: Boolean(forAgent) })));

/** The prompt the agent answers for a command that is one, such as `evolver-evolve`, for hosts that register prompts. */
export { EVOLVE_PROMPT } from '../../app/commands/evolve.js';

/**
 * The channel of a host that loads the plugin into its own process. The host's entry calls `handle(hostEvent,
 * payload)` from its callbacks and applies the answer itself; background work runs in this process. `overrides`
 * passes ports only the host can build, such as an SDK-backed `model`. `close()` is for the host's shutdown: it takes
 * no more background work, so the session ends raised after it only write. `idle()` resolves once background work
 * scheduled so far is done.
 */
export function createPluginChannel({ profile, env = process.env, overrides = {} }) {
  const { ports } = environmentFor({ profile, env, lifetime: RESIDENT, runBackground: runBackgroundTasks, overrides });
  const driver = createDriver({ profile, ports, transcripts, lifetime: RESIDENT });
  return {
    handle: driver.handle,
    close: () => ports.scheduler.stop?.(),
    idle: () => ports.scheduler.idle?.() ?? Promise.resolve(),
  };
}
