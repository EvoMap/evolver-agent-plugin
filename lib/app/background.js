// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { deliverReports } from './deliver-reports.js';
import { armDistillWakeUp, distillDue, distillsInBackground, dropExpiredLeftovers } from './distill-session.js';
import { TASKS } from './ports.js';

const WORK = {
  [TASKS.ENGINE]: (ports) => ports.engine.setUp(),
  [TASKS.DRAIN]: deliverReports,
  // Without a model outside the conversation a leftover cannot be distilled here; trying would only use up its tries
  // before the agent's own model, asked in its session, gets to write the Gene. A person who turned background
  // distillation off still distills on demand.
  [TASKS.DISTILL]: async (ports) => {
    if (!distillsInBackground(ports)) return dropExpiredLeftovers(ports);
    await distillDue(ports);
    await armDistillWakeUp(ports);
  },
};

/** Runs the scheduled background tasks in order; true when none threw. One failing never stops the next. */
export async function runBackgroundTasks(ports, tasks) {
  let isClean = true;
  for (const task of tasks) {
    try {
      await WORK[task]?.(ports);
    } catch {
      isClean = false;
    }
  }
  return isClean;
}
