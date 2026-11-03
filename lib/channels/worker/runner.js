// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { exitProcess } from '../../runtime/process/exit.js';

export async function runWorkerProcess(agent, tasks, env = process.env) {
  const profile = await profileNamed(agent).catch(() => null);
  let ok = false;
  if (profile) {
    const { runTasks } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
    ok = await runTasks(tasks);
  }
  exitProcess(ok ? 0 : 1, { drainWindowsHandles: profile?.drainWindowsHandles });
}
