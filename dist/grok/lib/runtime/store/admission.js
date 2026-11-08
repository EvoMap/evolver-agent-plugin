// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ownerIsGone, processStartTime, PROCESS_START_TIMEOUT_MS, PROCESS_START_TOLERANCE_MS } from '../process/owner.js';

export const LOCK_WAIT_MS = 2_000;
export const LOCK_RETRY_MS = 20;
export const LOCK_ACCESS_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ADMISSION_IDENTITY_CHECK_MS = 10_000;
const ABANDONED_PREFIX = 'abandoned-';
const abandonedAdmissions = new Map();

export function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reclaimAdmission(admission, deadline, starts) {
  try {
    const info = fs.lstatSync(admission);
    if (!info.isDirectory()) return false;
    const entries = fs.readdirSync(admission);
    if (entries.length > 0) {
      const marker = entries.find((name) => name.startsWith(ABANDONED_PREFIX));
      const ownerName = marker ? marker.slice(ABANDONED_PREFIX.length) : entries[0];
      if (entries.some((name) => name !== ownerName && name !== marker)) return false;
      const owner = /^owner-(\d+)-[a-f0-9]+(?:-([a-f0-9]{24}|[0-9]{13}))?$/.exec(ownerName);
      if (!owner) return false;
      const pid = Number(owner[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      const abandonedHere = abandonedAdmissions.get(admission) === ownerName;
      const markerPath = marker && path.join(admission, marker);
      if (markerPath && !fs.lstatSync(markerPath).isFile()) return false;
      if (!markerPath && !abandonedHere && !ownerIsGone(pid)) {
        const birth = Number(owner[2]);
        const remaining = deadline - Date.now();
        if (owner[2]?.length !== 13 || !Number.isSafeInteger(birth) || Date.now() - info.mtimeMs < ADMISSION_IDENTITY_CHECK_MS || remaining <= 0) return false;
        if (!starts.has(pid)) starts.set(pid, processStartTime(pid, Math.min(remaining, PROCESS_START_TIMEOUT_MS)));
        const actualBirth = starts.get(pid);
        // Only a clearly newer process proves reuse. ps timestamps round to whole seconds.
        if (!actualBirth || actualBirth <= birth + PROCESS_START_TOLERANCE_MS) return false;
      }
      if (entries.includes(ownerName)) fs.unlinkSync(path.join(admission, ownerName));
      if (markerPath) fs.unlinkSync(markerPath);
      if (abandonedHere) abandonedAdmissions.delete(admission);
    }
    // Only the inspected unique owner is unlinked. A fresh guard is already nonempty, so rmdir cannot
    // remove it even if another reclaimer replaced the directory after our read.
    fs.rmdirSync(admission);
    return true;
  } catch {
    return false;
  }
}

function enterAdmission(lockDir, deadline, starts) {
  const admission = `${lockDir}.admission`;
  const owner = `owner-${process.pid}-${crypto.randomBytes(12).toString('hex')}-${processStartTime(process.pid)}`;
  const staging = `${admission}.${owner}.claim`;
  fs.mkdirSync(path.dirname(admission), { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { mode: 0o700 });
  let published = false;
  try {
    fs.writeFileSync(path.join(staging, owner), '', { mode: 0o600, flag: 'wx' });
    // Publishing a prepopulated directory never exposes an empty fresh guard to a stale reclaimer.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.renameSync(staging, admission);
        published = true;
        abandonedAdmissions.delete(admission);
        return { admission, owner };
      } catch {
        if (attempt > 0 || !reclaimAdmission(admission, deadline, starts)) return null;
      }
    }
    return null;
  } finally {
    if (!published) fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function retryLockAccess(access) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return access();
    } catch (error) {
      if (attempt === 2 || !LOCK_ACCESS_ERRORS.has(error?.code)) throw error;
      pause(LOCK_RETRY_MS);
    }
  }
}

function releaseAdmission({ admission, owner }) {
  try {
    retryLockAccess(() => fs.unlinkSync(path.join(admission, owner)));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') {
      throw Object.assign(new Error(`Could not release admission ${admission}`, { cause }), { code: 'ELOCKED' });
    }
  }
  // The guard is released when its unique owner is gone. An empty directory can be reclaimed.
  try { retryLockAccess(() => fs.rmdirSync(admission)); } catch {}
}

function abandonAdmission({ admission, owner }) {
  // A separate marker can be written even when Windows denies access to the owner file.
  try {
    retryLockAccess(() => fs.writeFileSync(path.join(admission, ABANDONED_PREFIX + owner), '', { mode: 0o600, flag: 'wx' }));
  } catch {
    abandonedAdmissions.set(admission, owner);
  }
}

// Every directory mutation uses this short, nonblocking admission. No work or await belongs inside it.
export function admitted(lockDir, mutate, rollback, deadline = Date.now() + LOCK_WAIT_MS, starts = new Map()) {
  const admission = enterAdmission(lockDir, deadline, starts);
  if (!admission) return null;
  let result;
  try {
    result = mutate();
  } catch (error) {
    try { releaseAdmission(admission); } catch { abandonAdmission(admission); }
    throw error;
  }
  try {
    releaseAdmission(admission);
  } catch (error) {
    // Publish only after rollback, so another process cannot enter while it runs.
    try { rollback?.(); } catch (rollbackError) { error.rollbackError = rollbackError; }
    abandonAdmission(admission);
    if (rollback) throw error;
  }
  return result;
}
