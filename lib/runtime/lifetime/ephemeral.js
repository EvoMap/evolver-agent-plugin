// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { fileURLToPath } from 'node:url';

import { startDetached } from '../process/spawn.js';

const WORKER = fileURLToPath(new URL('../../../bin/worker.mjs', import.meta.url));

/**
 * A hook process lives only until it answers, so slow work runs in a detached worker that outlives it. Where the
 * host forbids starting one, the work is not lost: every session start schedules delivery and distillation again.
 */
export function detachedScheduler(agent, env) {
  return {
    schedule: (tasks) => {
      if (tasks.length > 0) startDetached(process.execPath, [WORKER, agent, ...tasks], { env });
    },
  };
}
