// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { join } from 'node:path';
import { turnEnded } from '../../app/turn-end.js';
import { reconcileNativeTurn } from '../../app/native-turn.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { monitorNativeTurn } from '../../runtime/native-monitor.js';

/** The detached worker a hook process starts for slow work: runs `tasks` for `agent`; true when none threw. */
export async function runWorker(agent, tasks, { env = process.env } = {}) {
  const profile = await profileNamed(agent).catch(() => null);
  if (!profile) return false;
  const { ports, runTasks } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
  let clean = true;
  for (const task of tasks) {
    if (task.startsWith('native:') && ports.native) {
      let at;
      try { at = JSON.parse(task.slice(7)); } catch { return false; }
      await monitorNativeTurn(ports, at, input => reconcileNativeTurn(ports, input), closed => turnEnded(ports, closed), { dir: join(profile.stateDir(env), 'native-monitors') });
    } else clean = await runTasks([task]) && clean;
  }
  return clean;
}
