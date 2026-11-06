// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import path from 'node:path';

import { windowsAncestorsOf } from './windows.js';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
export const PROCESS_START_TIMEOUT_MS = 1_000;
// POSIX ps reports start times to the nearest second.
export const PROCESS_START_TOLERANCE_MS = 2_000;
const MAX_ANCESTORS = 16;
const ownStartTime = Math.round(Date.now() - process.uptime() * 1000);

/** A bounded process start-time probe for lock recovery. The hot path needs no subprocess. */
export function processStartTime(pid, timeout = PROCESS_START_TIMEOUT_MS) {
  if (pid === process.pid) return ownStartTime;
  if (!Number.isSafeInteger(pid) || pid <= 0 || timeout <= 0) return null;
  const windows = process.platform === 'win32';
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (windows && !path.isAbsolute(systemRoot)) return null;
  const executable = windows ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/ps';
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset] (Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`]
    : ['-p', String(pid), '-o', 'lstart='];
  const env = windows ? process.env : { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
  const result = spawnSync(executable, args, {
    env, encoding: 'utf8', windowsHide: true, timeout, killSignal: 'SIGKILL',
  });
  const started = result.status === 0 ? result.stdout.trim() : '';
  if (!started) return null;
  const time = windows ? Number(started) : Date.parse(started + ' GMT');
  return Number.isSafeInteger(time) && time > 0 ? time : null;
}

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
  const probe = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: PROCESS_START_TIMEOUT_MS });
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(probe.stdout ?? '');
  if (!match) return null;
  const command = match[2].replace(/^-/, '');
  return { ppid: Number(match[1]), name: path.basename(command), path: executablePathOf(pid, command) };
}

function parentPid(probe) {
  let pid = process.ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth += 1) {
    const parent = probe(pid);
    if (!parent) return null;
    if (!SHELLS.has(parent.name.toLowerCase().replace(/\.exe$/, ''))) return pid;
    pid = parent.ppid;
  }
  return null;
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
 * need a process table; where none can be read they are null and such entries never read as
 * orphaned.
 */
export function ownerProbeOf(declaration, { probe, platform = process.platform, windowsAncestry = false } = {}) {
  let windows;
  const readProcess = probe ?? (platform === 'win32'
    ? (pid) => (windows ??= windowsAncestorsOf(process.ppid)).get(pid) ?? null
    : processInfo);
  const locate = () => {
    if (declaration === 'self') return process.pid;
    if (declaration === 'spawner') return process.ppid;
    if (platform === 'win32' && !windowsAncestry) return null;
    if (declaration === 'parent') return parentPid(readProcess);
    if (declaration?.ancestor instanceof RegExp) return ancestorPid((info) => declaration.ancestor.test(info.name), readProcess);
    if (declaration?.ancestorPath instanceof RegExp) return ancestorPid((info) => declaration.ancestorPath.test(info.path ?? info.name), readProcess);
    return null;
  };
  let current;
  return {
    current: () => (current === undefined ? (current = locate()) : current),
    self: () => process.pid,
    isGone: ownerIsGone,
  };
}
