// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runCommand } from './commands/index.js';
import { deliverReports } from './deliver-reports.js';
import { armDistillWakeUp, distillDue, distillsInBackground, dropExpiredLeftovers } from './distill-session.js';
import { turnEnded } from './turn-end.js';
import { TASKS } from './ports.js';

function cancellable(ports, signal) {
  const combined = (other) => other ? AbortSignal.any([other, signal]) : signal;
  return {
    ...ports,
    scheduler: { ...ports.scheduler, signal: combined(ports.scheduler.signal) },
    proxy: { ...ports.proxy, request: (method, path, body, options = {}) => ports.proxy.request(method, path, body, { ...options, signal: combined(options.signal) }) },
    model: ports.model && { complete: (model, prompt, other) => ports.model.complete(model, prompt, combined(other)) },
  };
}

const WORK = {
  [TASKS.ENGINE]: (ports) => ports.engine.setUp(),
  [TASKS.DRAIN]: deliverReports,
  command: (ports, id) => ports.commandJobs?.run(id, (at, signal) => runCommand(cancellable(ports, signal), { ...at, signal })),
  turn: (ports, payload) => ports.turnMonitor?.(JSON.parse(payload), (closed) => turnEnded(ports, closed)),
  // Without a model outside the conversation a leftover cannot be distilled here; trying would only use up its tries
  // before the agent's own model, asked in its session, gets to write the Gene. A person who turned background
  // distillation off still distills on demand.
  [TASKS.DISTILL]: async (ports) => {
    if (!distillsInBackground(ports)) return dropExpiredLeftovers(ports);
    try {
      await distillDue(ports);
    } finally {
      await armDistillWakeUp(ports);
    }
  },
};

/** Runs the scheduled background tasks in order; true when none threw. One failing never stops the next. */
export async function runBackgroundTasks(ports, tasks) {
  let isClean = true;
  for (const task of tasks) {
    try {
      const separator = task.indexOf(':');
      const kind = separator < 0 ? task : task.slice(0, separator);
      const payload = separator < 0 ? undefined : task.slice(separator + 1);
      if (!Object.hasOwn(WORK, kind)) continue;
      const result = await WORK[kind](ports, payload);
      if (kind === 'command' && result === false) isClean = false;
    } catch {
      isClean = false;
    }
  }
  return isClean;
}
