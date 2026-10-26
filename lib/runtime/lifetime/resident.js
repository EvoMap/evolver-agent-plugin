// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/**
 * A resident process (an in-process plugin, an MCP server) runs slow work itself, one batch after another, without
 * the host's event waiting for it. `idle()` resolves once the queue is empty, for a host that disposes the plugin.
 */
export function inProcessScheduler(run) {
  let queue = Promise.resolve();
  return {
    schedule: (tasks) => {
      if (tasks.length === 0) return;
      queue = queue.then(() => run(tasks)).catch(() => false);
    },
    idle: () => queue,
  };
}
