// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/**
 * A resident process (an in-process plugin, an MCP server) runs slow work itself, one batch after another, without
 * the host's event waiting for it. `stop()` takes no more work: a host shutting down bounds its time tightly, so
 * what it ends then only writes, and the next start delivers and distills it. Work already running ends with the
 * process; a distillation it claimed is claimed again once its owner is gone.
 */
export function inProcessScheduler(run) {
  let queue = Promise.resolve();
  let isStopped = false;
  return {
    schedule: (tasks) => {
      if (tasks.length === 0 || isStopped) return;
      queue = queue.then(() => run(tasks)).catch(() => false);
    },
    idle: () => queue,
    stop: () => {
      isStopped = true;
    },
  };
}
