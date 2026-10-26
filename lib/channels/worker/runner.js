// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';

/** The detached worker a hook process starts for slow work: runs `tasks` for `agent`; true when none threw. */
export async function runWorker(agent, tasks, { env = process.env } = {}) {
  const profile = await profileNamed(agent).catch(() => null);
  if (!profile) return false;
  return environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks }).runTasks(tasks);
}
