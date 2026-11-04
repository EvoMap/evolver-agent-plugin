// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// setTimeout runs a longer delay at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A resident process (an in-process plugin, an MCP server) runs slow work itself, one batch after another, without
 * the host's event waiting for it. `stop()` takes no more work and aborts `signal`: a host shutting down bounds its
 * time tightly, so what it ends then only writes, and work still running (a distillation's model call) stops without
 * counting a try, so the process can exit; the next start delivers and distills what is left. A wake-up is one timer
 * that never keeps the process up, replaced only by an earlier one.
 */
export function inProcessScheduler(run) {
  let queue = Promise.resolve();
  let isStopped = false;
  let wakeUp = null;
  const stopping = new AbortController();
  const schedule = (tasks) => {
    if (tasks.length === 0 || isStopped) return;
    queue = queue.then(() => run(tasks)).catch(() => false);
  };
  return {
    signal: stopping.signal,
    schedule,
    wakeAt: (at, tasks) => {
      if (isStopped || (wakeUp && wakeUp.at <= at)) return;
      clearTimeout(wakeUp?.timer);
      const timer = setTimeout(() => {
        wakeUp = null;
        schedule(tasks);
      }, Math.min(at - Date.now(), MAX_TIMER_MS));
      timer.unref?.();
      wakeUp = { at, timer };
    },
    idle: () => queue,
    stop: () => {
      isStopped = true;
      clearTimeout(wakeUp?.timer);
      wakeUp = null;
      stopping.abort();
    },
  };
}
