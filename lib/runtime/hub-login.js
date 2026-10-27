// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { evolverCommandsOf } from './cli-executor.js';
import { ownerIsGone } from './process/owner.js';
import { startLogged } from './process/spawn.js';
import { readState, removeState, withLock, writeState } from './store/file-lock.js';

const OUTPUT_MAX_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 100;

function tailOf(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > OUTPUT_MAX_BYTES ? text.slice(-OUTPUT_MAX_BYTES) : text;
  } catch {
    return '';
  }
}

async function startedLogin({ enginePrefix, env, files }) {
  for (const { command, args, shim } of evolverCommandsOf(enginePrefix)) {
    const started = await startLogged(command, [...args, 'login'], { logFile: files.log, env, shim });
    if (started.pid) return started.pid;
  }
  throw new Error('neither the engine this plugin installed, an `evolver` on PATH nor `npx` could be started');
}

/**
 * Where the sign-in is kept: one place for every agent of this user, whatever its own state folder, since they all
 * sign in to one Evolver identity home.
 */
export function signInFilesOf(env = process.env) {
  const dir = path.join(env.HOME || env.USERPROFILE || homedir(), '.evolver', 'login');
  return { record: path.join(dir, 'run.json'), log: path.join(dir, 'run.log'), lock: path.join(dir, 'run.lock') };
}

/**
 * The SignIn port: Evolver's own device sign-in, `evolver login`, run as the EvolverCli port would run it, but in the
 * background, so it outlives the command that started it and waits for the person's approval on its own. Its output
 * goes to `files.log` and its pid to `files.record`; `files.lock` keeps a second one from starting meanwhile.
 */
export function hubSignInOf({ files, enginePrefix, env = process.env }) {
  const latest = async () => {
    const { pid, startedAt } = readState(files.record, {});
    if (!pid) return null;
    return { startedAt, isRunning: !ownerIsGone(pid), output: tailOf(files.log), log: files.log };
  };
  const startUnless = async (isKept) => {
    if (isKept(await latest())) return;
    const pid = await startedLogin({ enginePrefix, env, files });
    writeState(files.record, { pid, startedAt: Date.now() });
  };
  return {
    latest,
    joinOrStart: async (isKept) => {
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (!(await withLock(files.lock, () => startUnless(isKept))) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
      return latest();
    },
    forget: (run) => withLock(files.lock, async () => {
      if (readState(files.record, {}).startedAt === run?.startedAt) removeState(files.record);
    }),
  };
}
