// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { fileURLToPath } from 'node:url';

import { nodeExecutable } from '../process/node.js';
import { isSameProcess } from '../process/identity.js';
import { startDetached } from '../process/spawn.js';
import { readState, removeState, writeState } from '../store/file-lock.js';

const WORKER = fileURLToPath(new URL('../../../bin/worker.mjs', import.meta.url));
// setTimeout runs a longer delay at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

// A record whose time has passed names a waiter that is waking, or one that died: either way it no longer stands for
// a wake-up to come. A waiter killed early leaves its pid free for another process, so the start time must match too.
const coversWakeUpAt = (record, at, now) => now < record?.at && record.at <= at && isSameProcess(record.pid, record.startedAt, { now });

// The record only saves starting a second waiter, which claims keep from distilling anything twice, so a state folder
// that cannot be written never fails the hook that armed it.
function recordWaiter(waiterFile, record) {
  try {
    writeState(waiterFile, record);
  } catch {
  }
}

/**
 * A hook process lives only until it answers, so slow work runs in a detached worker that outlives it. Where the
 * host forbids starting one, the work is not lost: every session start schedules delivery and distillation again.
 * A wake-up is such a worker that first sleeps until its time (`--at=<ms>`): one per agent and state folder, kept in
 * `waiterFile` as `{ pid, startedAt, at }`, and started again only for an earlier time or once that one is gone.
 */
export function detachedScheduler(agent, env, waiterFile) {
  const start = (args) => startDetached(nodeExecutable(), [WORKER, agent, ...args], { env });
  return {
    schedule: (tasks) => {
      if (tasks.length > 0) start(tasks);
    },
    wakeAt: (at, tasks) => {
      const now = Date.now();
      if (coversWakeUpAt(readState(waiterFile, null), at, now)) return;
      const pid = start([`--at=${at}`, ...tasks]);
      if (pid) recordWaiter(waiterFile, { pid, startedAt: now, at });
    },
  };
}

/** The waiter's side: sleeps until `at`, then gives up its record, so the wake-up its own tasks arm starts the next. */
export async function waitForWakeUp(at, { waiterFile, clock }) {
  while (clock.now() < at) await clock.sleep(Math.min(at - clock.now(), MAX_TIMER_MS));
  if (readState(waiterFile, null)?.pid === process.pid) removeState(waiterFile);
}
