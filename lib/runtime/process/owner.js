// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd.exe', 'powershell', 'pwsh']);
const PS_TIMEOUT_MS = 1000;
const MAX_ANCESTORS = 16;

/**
 * Whether the process that wrote a state entry has exited. Signal 0 only probes: ESRCH means no such process;
 * EPERM means it exists under another user. An entry without a pid is never taken for a dead owner's.
 */
export function ownerIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

export function processInfo(pid) {
  const probe = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(probe.stdout ?? '');
  return match ? { ppid: Number(match[1]), name: path.basename(match[2]).replace(/^-/, '') } : null;
}

function parentPid(probe) {
  const parent = probe(process.ppid);
  if (!parent) return null;
  return SHELLS.has(parent.name) ? parent.ppid : process.ppid;
}

function ancestorPid(pattern, probe) {
  let pid = process.ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth += 1) {
    const info = probe(pid);
    if (!info) return null;
    if (pattern.test(info.name)) return pid;
    pid = info.ppid;
  }
  return null;
}

/**
 * The process a session belongs to, as the agent declared it: 'self' (an in-process plugin or a server), 'parent'
 * (the host that ran this hook; a shell in between is skipped) or `{ ancestor: /name/ }` (the nearest ancestor so
 * named). Null where no process table can be read, Windows included: such entries never read as orphaned.
 */
export function ownerProbeOf(declaration, { probe = processInfo, platform = process.platform } = {}) {
  const locate = () => {
    if (declaration === 'self') return process.pid;
    if (platform === 'win32') return null;
    if (declaration === 'parent') return parentPid(probe);
    if (declaration?.ancestor instanceof RegExp) return ancestorPid(declaration.ancestor, probe);
    return null;
  };
  let current;
  return {
    current: () => (current === undefined ? (current = locate()) : current),
    self: () => process.pid,
    isGone: ownerIsGone,
  };
}
