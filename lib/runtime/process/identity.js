// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import os from 'node:os';

const PS_TIMEOUT_MS = 1_000;
// ps counts a process's age in whole seconds, and the start is recorded just after the spawn.
const START_TOLERANCE_MS = 10_000;
const ELAPSED = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/;

/** How long `pid` has run, in ms, from `ps -o etime=`; null where ps cannot say (Windows, or no such process). */
export function elapsedMsOf(pid, { platform = process.platform, probe = spawnSync } = {}) {
  if (platform === 'win32') return null;
  const answer = probe('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  const match = ELAPSED.exec(answer.stdout ?? '');
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function isOwnLiveProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is still the process this user started at `startedAt`. A pid outlives its process: after a reboot,
 * or once the number comes round again, it names another one, perhaps another user's.
 */
export function isSameProcess(pid, startedAt, { now = Date.now(), bootedAt = now - os.uptime() * 1000, elapsedOf = elapsedMsOf } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || startedAt < bootedAt || !isOwnLiveProcess(pid)) return false;
  const elapsed = elapsedOf(pid);
  return elapsed === null || Math.abs(now - elapsed - startedAt) < START_TOLERANCE_MS;
}
