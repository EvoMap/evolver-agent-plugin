// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { headlessEnv } from '../headless.js';

// The one place this plugin starts a process: every platform difference (Windows .cmd shims, argument quoting,
// killing a whole process tree) and every lifecycle rule (timeout, cancellation, the headless marker) lives here.

const KILL_GRACE_MS = 5_000;
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const IS_WINDOWS = process.platform === 'win32';
const WINDOWS_ROOT = process.env.SystemRoot || process.env.WINDIR || '';
const SYSTEM32 = IS_WINDOWS && path.isAbsolute(WINDOWS_ROOT) ? path.join(WINDOWS_ROOT, 'System32') : null;

function windowsSystemDirectory() {
  // A stripped host environment still has the Windows loader mapped from the system directory.
  const loader = process.report.getReport().sharedObjects.find((file) =>
    path.isAbsolute(file) && /[\\/](?:system32|syswow64)[\\/]ntdll\.dll$/i.test(file));
  return loader ? path.dirname(loader) : null;
}

const TASKKILL_DIR = IS_WINDOWS ? SYSTEM32 ?? windowsSystemDirectory() : null;

// npm shims (`evolver`, `npx`, `npm`) only run through cmd.exe, which reads the line once while the shim re-reads its
// arguments, so each argument is quoted for the C runtime and its cmd metacharacters are caret-escaped twice.
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

export function cmdArgument(arg) {
  const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  return quoted.replace(CMD_METACHARACTERS, '^$1').replace(CMD_METACHARACTERS, '^$1');
}

const cmdLine = (command, args) => [String(command).replace(CMD_METACHARACTERS, '^$1'), ...args.map(cmdArgument)].join(' ');

function taskkill(pid) {
  if (!TASKKILL_DIR) return;
  const root = path.dirname(TASKKILL_DIR);
  // taskkill itself needs the system root, even when launched by its absolute path.
  const env = SYSTEM32 ? process.env : { ...process.env, SystemRoot: root, WINDIR: root };
  execFile(path.join(TASKKILL_DIR, 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { env, windowsHide: true }, () => {});
}

function signalGroup(pid, name) {
  try {
    process.kill(-pid, name);
  } catch {
  }
}

/** Ends `pid` and everything it started: its process group on POSIX, its tree through taskkill on Windows. */
export function endTree(pid, { platform = process.platform, killWindowsTree = taskkill, signal = signalGroup } = {}) {
  if (platform === 'win32') return killWindowsTree(pid);
  signal(pid, 'SIGTERM');
  setTimeout(() => signal(pid, 'SIGKILL'), KILL_GRACE_MS).unref?.();
}

/**
 * Runs a command to completion: `input` on stdin, stdout and stderr collected. `shim` marks an npm shim, run
 * through cmd.exe on Windows. `headless` sets the marker that turns this plugin's own hooks off in the child.
 * `encoding: 'buffer'` keeps stdout as the bytes the command wrote. Resolves `{ code, stdout, stderr, error }`; never
 * rejects. `error.code === 'ENOENT'` means no such command.
 */
export function runProcess(command, args = [], { input, closeInputOn, env = process.env, cwd = os.homedir(), timeoutMs, signal, shim = false, headless = false, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    const viaShell = IS_WINDOWS && shim;
    const isBinary = encoding === 'buffer';
    if ((viaShell && !SYSTEM32) || (IS_WINDOWS && !TASKKILL_DIR && (timeoutMs || signal || closeInputOn))) {
      const error = Object.assign(new Error('Windows system directory is unavailable; no command was started'), { code: 'ENOENT' });
      return resolve({ code: null, stdout: isBinary ? Buffer.alloc(0) : '', stderr: '', error });
    }
    const stdoutChunks = [];
    let stdoutSize = 0;
    let stderr = '';
    let incompleteLine = '';
    let settled = false;
    let inputFailure;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ stdout: isBinary ? Buffer.concat(stdoutChunks) : stdoutChunks.join(''), stderr, ...result });
    };
    const child = spawn(viaShell ? cmdLine(command, args) : command, viaShell ? [] : args, {
      cwd, env: headless ? headlessEnv(env) : env, shell: viaShell ? path.join(SYSTEM32, 'cmd.exe') : false, detached: !IS_WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stop = () => child.pid && endTree(child.pid);
    const timer = timeoutMs ? setTimeout(() => { stop(); finish(inputFailure ?? { code: null, error: Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }) }); }, timeoutMs) : null;
    timer?.unref?.();
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    if (!isBinary) child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdoutSize < OUTPUT_MAX_BYTES) {
        stdoutChunks.push(chunk);
        stdoutSize += chunk.length;
      }
      if (settled || inputFailure || !closeInputOn || child.stdin.writableEnded) return;
      const lines = chunk.toString().split('\n');
      // Discard an oversized line through its newline without matching a partial suffix.
      lines[0] = incompleteLine === null ? null : incompleteLine + lines[0];
      incompleteLine = lines.pop();
      if (incompleteLine?.length > OUTPUT_MAX_BYTES) incompleteLine = null;
      try {
        if (lines.some((line) => line !== null && line.length <= OUTPUT_MAX_BYTES && closeInputOn(line))) child.stdin.end();
      } catch (error) {
        inputFailure = { code: null, error };
        stop();
      }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < OUTPUT_MAX_BYTES) stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(inputFailure ?? { code: null, error }));
    child.on('close', (code) => finish(inputFailure ?? (signal?.aborted ? { code, error: Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }) } : { code, error: null })));
    if (closeInputOn) child.stdin.write(input ?? '');
    else child.stdin.end(input ?? '');
  });
}

/** Starts a process that outlives this one, detached and silent; answers its pid, undefined when it did not start. */
export function startDetached(command, args, { env = process.env, cwd = os.homedir() } = {}) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd, env });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

function isOnWindowsPath(name, env = process.env) {
  if (!SYSTEM32) return Promise.resolve(false);
  return new Promise((resolve) => execFile(path.join(SYSTEM32, 'where.exe'), [name], { env, windowsHide: true }, (error) => resolve(!error)));
}

function spawnedOrMissing(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve({ pid: child.pid }));
    child.once('error', (error) => (error?.code === 'ENOENT' ? resolve({ missing: true }) : reject(error)));
  });
}

/**
 * Starts a process that outlives this one: detached into its own process group, no stdin, its stdout and stderr
 * written to `logFile`, which starts empty. `shim` marks an npm shim, run through cmd.exe on Windows. Resolves
 * `{ pid }`, or `{ missing: true }` when there is no such command.
 */
export async function startLogged(command, args, { logFile, env = process.env, cwd = os.homedir(), shim = false }) {
  const viaShell = IS_WINDOWS && shim;
  if (viaShell && !(await isOnWindowsPath(command, env))) return { missing: true };
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logFile, 'w', 0o600);
  try {
    const child = spawn(viaShell ? cmdLine(command, args) : command, viaShell ? [] : args, {
      cwd, env, shell: viaShell ? path.join(SYSTEM32, 'cmd.exe') : false, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    const started = spawnedOrMissing(child);
    child.on('error', () => {});
    child.unref();
    return await started;
  } finally {
    fs.closeSync(log);
  }
}

/** Whether a failed run means the command does not exist; through cmd.exe that is only a localized non-zero exit. */
export async function isMissingCommand(result, name, { platform = process.platform, isOnPath = isOnWindowsPath } = {}) {
  if (result.error?.code === 'ENOENT') return true;
  if (platform !== 'win32' || result.code === 0) return false;
  return !(await isOnPath(name));
}
