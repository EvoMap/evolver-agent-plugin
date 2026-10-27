// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
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

// macOS `ps` names a process by its executable's full path; Linux truncates the name, so the path is read from /proc.
function executablePathOf(pid, command) {
  if (path.isAbsolute(command)) return command;
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return command;
  }
}

export function processInfo(pid) {
  const probe = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(probe.stdout ?? '');
  if (!match) return null;
  const command = match[2].replace(/^-/, '');
  return { ppid: Number(match[1]), name: path.basename(command), path: executablePathOf(pid, command) };
}

function parentPid(probe) {
  const parent = probe(process.ppid);
  if (!parent) return null;
  return SHELLS.has(parent.name) ? parent.ppid : process.ppid;
}

function ancestorPid(isOwner, probe) {
  let pid = process.ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth += 1) {
    const info = probe(pid);
    if (!info) return null;
    if (isOwner(info)) return pid;
    pid = info.ppid;
  }
  return null;
}

/**
 * The process a session belongs to, as the agent declared it: 'self' (an in-process plugin or a server), 'spawner'
 * (the process that started this one with no shell between, such as a host's relay), 'parent' (the host that ran this
 * hook; a shell in between is skipped), `{ ancestor: /name/ }` (the nearest ancestor so named) or
 * `{ ancestorPath: /path/ }` (the nearest whose executable's path matches: a host running as `node`). The last three
 * need a process table; where none can be read, Windows included, they are null and such entries never read as
 * orphaned.
 */
export function ownerProbeOf(declaration, { probe = processInfo, platform = process.platform } = {}) {
  const locate = () => {
    if (declaration === 'self') return process.pid;
    if (declaration === 'spawner') return process.ppid;
    if (platform === 'win32') return null;
    if (declaration === 'parent') return parentPid(probe);
    if (declaration?.ancestor instanceof RegExp) return ancestorPid((info) => declaration.ancestor.test(info.name), probe);
    if (declaration?.ancestorPath instanceof RegExp) return ancestorPid((info) => declaration.ancestorPath.test(info.path ?? info.name), probe);
    return null;
  };
  let current;
  return {
    current: () => (current === undefined ? (current = locate()) : current),
    self: () => process.pid,
    isGone: ownerIsGone,
  };
}
