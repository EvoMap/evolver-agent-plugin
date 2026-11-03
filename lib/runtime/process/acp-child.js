// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeState } from '../store/file-lock.js';
import { startWindowsJob } from './windows-job.js';

export const guardianFile = fileURLToPath(import.meta.url);
export const OWNER_FILE = '.evolver-model-owner.json';
export const CHILD_FILE = '.evolver-owned-child.json';

const pause = ms => new Promise(done => setTimeout(done, ms));
const bounded = async (promise, ms) => {
  let timer;
  try { return await Promise.race([promise, new Promise(done => { timer = setTimeout(done, ms); })]); }
  finally { clearTimeout(timer); }
};
const pidGone = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
};
const groupGone = pid => {
  try { process.kill(-pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
};

function ownedHome(home, base, nonce) {
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(home)) !== realpathSync(base) || !basename(home).startsWith('evolver-model-')) throw new Error('Unowned scratch');
  const marker = join(home, OWNER_FILE);
  const mark = lstatSync(marker);
  if (!mark.isFile() || mark.isSymbolicLink() || mark.size > 2048 || JSON.parse(readFileSync(marker, 'utf8')).nonce !== nonce) throw new Error('Unowned scratch marker');
}

async function killNative(child) {
  if (!child?.pid || child.pid === process.pid || child.pid === process.ppid) return false;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await pause(100);
  if (!groupGone(child.pid)) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  return groupGone(child.pid);
}

/** Separate control pipe: losing the model worker ends the native process rather than orphaning it. */
async function guard() {
  let spec;
  try {
    spec = JSON.parse(process.argv[2]);
    ownedHome(spec.home, spec.base, spec.nonce);
    if (typeof spec.command !== 'string' || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string')) throw new Error();
  } catch { process.exitCode = 1; process.disconnect?.(); return; }

  let child, job, receipt, result, parentLost = false, failure, timer, stopping = false, release;
  const released = new Promise(done => { release = done; });
  const notify = value => { if (process.connected) try { process.send(value, () => {}); } catch {} };
  const remember = nativePid => {
    try {
      if (!nativePid) throw new Error();
      receipt = { nonce: spec.nonce, guardianPid: process.pid, nativePid, ...(job && { helperPid: child.pid, jobEmpty: false }) };
      writeFileSync(join(spec.home, CHILD_FILE), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
      notify({ type: 'spawned', pid: nativePid });
    } catch { failure = 'ownership_failed'; void terminate(); }
  };
  const stopped = new Promise(done => {
    if (process.platform === 'win32') { job = startWindowsJob(spec, remember); child = job.child; }
    else child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', () => { failure = 'spawn_failed'; });
    child.on('close', (code, signal) => { result = { code, signal }; done(); });
  });
  child.stdin.on('error', () => {});
  process.stdout.on('error', () => {});
  let bytes = 0, outputBytes = 0;
  const count = chunk => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024 && !failure) { failure = 'output_limit'; void terminate(); }
  };
  child.stdout.on('data', chunk => { count(chunk); if (!failure) { outputBytes += chunk.length; process.stdout.write(chunk); } });
  if (!job) { child.stderr.on('data', count); remember(child.pid); }

  async function terminate() {
    if (stopping) return;
    stopping = true;
    if (job) {
      try { job.stop(); } catch { child.kill('SIGKILL'); }
      await bounded(stopped, 3000);
      // Closing the owned helper handle kills its job, but does not prove the job has drained.
      if (!result) child.kill('SIGKILL');
    } else {
      await killNative(child);
      await bounded(stopped, 3000);
    }
  }
  const endInput = () => {
    if (result) return;
    child.stdin.end();
    timer ??= setTimeout(() => { failure ??= 'shutdown_timeout'; void terminate(); }, parentLost ? 250 : 5000);
  };
  process.stdin.on('data', chunk => { if (!child.stdin.destroyed) child.stdin.write(chunk); });
  process.stdin.on('end', endInput);
  process.on('message', message => {
    if (message?.type === 'stop') { failure ??= 'cancelled'; void terminate(); }
    if (message?.type === 'release') release();
  });
  process.on('disconnect', () => { parentLost = true; release(); clearTimeout(timer); timer = null; endInput(); });
  process.on('SIGTERM', () => { failure ??= 'cancelled'; void terminate(); });
  const ownerWatch = setInterval(() => {
    if (!pidGone(spec.ownerPid)) return;
    parentLost = true; release(); endInput(); void terminate();
  }, 100);

  await stopped;
  clearTimeout(timer);
  if (!job && !groupGone(child.pid)) {
    failure ??= 'leftover_process';
    await killNative(child);
  }
  const proof = job?.proof(result.code, result.signal);
  const treeClosed = job ? Boolean(proof) : groupGone(child.pid);
  if (proof) {
    result = { code: proof.code, signal: null };
    failure ??= proof.failure;
    if (receipt) try { writeState(join(spec.home, CHILD_FILE), { ...receipt, jobEmpty: true }); } catch { /* The live proof still permits cleanup. */ }
  } else if (job) failure ??= 'job_unproven';
  notify({ type: 'closed', ...result, treeClosed, failure, outputBytes });
  // The worker reads closed native facts before release. Losing its IPC pipe releases cleanup too.
  if (parentLost || pidGone(spec.ownerPid)) release();
  await released;
  clearInterval(ownerWatch);
  let cleaned = false;
  if (treeClosed) {
    try {
      ownedHome(spec.home, spec.base, spec.nonce);
      rmSync(spec.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      cleaned = true;
    } catch { /* The ownership receipt remains for a later bounded recovery. */ }
  }
  notify({ type: 'cleanup', cleaned });
  process.exitCode = failure || !cleaned ? 1 : 0;
  if (process.connected) process.disconnect();
}

if (process.argv[1] && resolve(process.argv[1]) === guardianFile) {
  guard().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
}
