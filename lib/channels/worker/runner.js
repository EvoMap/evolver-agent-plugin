// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { join } from 'node:path';

import { runBackgroundTasks } from '../../app/background.js';
import { runCommand } from '../../app/commands/index.js';
import { turnEnded } from '../../app/turn-end.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { exitProcess } from '../../runtime/process/exit.js';
import { monitorTurn } from '../../runtime/turn-monitor.js';

function cancellable(ports, signal) {
  const combined = other => other ? AbortSignal.any([other, signal]) : signal;
  return { ...ports,
    scheduler: { ...ports.scheduler, signal: combined(ports.scheduler.signal) },
    proxy: { ...ports.proxy, request: (method, path, body, options = {}) => ports.proxy.request(method, path, body, { ...options, signal: combined(options.signal) }) },
    model: ports.model && { complete: (model, prompt, other) => ports.model.complete(model, prompt, combined(other)) },
  };
}

/** The detached worker a hook process starts for slow work: runs `tasks` for `agent`; true when none threw. */
async function runWorker(profile, tasks, env) {
  const { ports, runTasks } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
  let clean = true;
  for (const task of tasks) {
    if (task.startsWith('command:') && ports.commandJobs) {
      clean = await ports.commandJobs.run(task.slice(8), (at, signal) => runCommand(cancellable(ports, signal), { ...at, signal })) && clean;
    } else if (task.startsWith('turn:') && ports.turnStatus) {
      let at;
      try { at = JSON.parse(task.slice(5)); } catch { clean = false; continue; }
      await monitorTurn(ports, at, closed => turnEnded(ports, closed), { dir: join(profile.stateDir(env), 'turn-monitors') });
    } else clean = await runTasks([task]) && clean;
  }
  return clean;
}

export async function runWorkerProcess(agent, tasks, env = process.env) {
  const profile = await profileNamed(agent).catch(() => null);
  const ok = profile && await runWorker(profile, tasks, env);
  exitProcess(ok ? 0 : 1, { drainWindowsHandles: profile?.drainWindowsHandles });
}
