// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { exitProcess } from '../../runtime/process/exit.js';

const WAKE_AT = /^--at=(\d+)$/;

const wakeAtOf = (args) => {
  const option = args.find((arg) => WAKE_AT.test(arg));
  return option ? Number(WAKE_AT.exec(option)[1]) : null;
};

/**
 * The detached worker a hook process starts for slow work: runs the tasks in `args` for `agent`, and with
 * `--at=<ms>`, as a wake-up, only once that time has come; true when none threw.
 */
async function runTasksFor(profile, args, env) {
  const { runTasks, waitForWakeUp } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
  const at = wakeAtOf(args);
  if (at !== null) await waitForWakeUp(at);
  return runTasks(args.filter((arg) => !WAKE_AT.test(arg)));
}

export async function runWorker(agent, args, { env = process.env } = {}) {
  const profile = await profileNamed(agent).catch(() => null);
  return profile ? runTasksFor(profile, args, env) : false;
}

export async function runWorkerProcess(agent, args, env = process.env) {
  const profile = await profileNamed(agent).catch(() => null);
  const ok = profile && await runTasksFor(profile, args, env);
  exitProcess(ok ? 0 : 1, { drainWindowsHandles: profile?.drainWindowsHandles });
}
