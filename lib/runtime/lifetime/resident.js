// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/**
 * A resident process (an in-process plugin, an MCP server) runs slow work itself, one batch after another, without
 * the host's event waiting for it. `stop()` takes no more work and aborts `signal`: a host shutting down bounds its
 * time tightly, so what it ends then only writes, and work still running (a distillation's model call) stops without
 * counting a try, so the process can exit; the next start delivers and distills what is left.
 */
export function inProcessScheduler(run) {
  let queue = Promise.resolve();
  let isStopped = false;
  const stopping = new AbortController();
  return {
    signal: stopping.signal,
    schedule: (tasks) => {
      if (tasks.length === 0 || isStopped) return;
      queue = queue.then(() => run(tasks)).catch(() => false);
    },
    idle: () => queue,
    stop: () => {
      isStopped = true;
      stopping.abort();
    },
  };
}
