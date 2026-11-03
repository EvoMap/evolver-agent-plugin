// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ownerIsGone, processStartTime } from '../process/owner.js';

export const LOCK_WAIT_MS = 2_000;
export const LOCK_RETRY_MS = 20;
export const LOCK_ACCESS_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ADMISSION_IDENTITY_CHECK_MS = 10_000;
const START_TIME_TOLERANCE_MS = 2_000;
const abandonedAdmissions = new Map();

export function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reclaimAdmission(admission, deadline, starts) {
  try {
    const info = fs.lstatSync(admission);
    if (!info.isDirectory()) return false;
    const owners = fs.readdirSync(admission);
    if (owners.length > 1) return false;
    if (owners.length === 1) {
      const owner = /^owner-(\d+)-[a-f0-9]+(?:-([a-f0-9]{24}|[0-9]{13}))?$/.exec(owners[0]);
      if (!owner) return false;
      const pid = Number(owner[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      const abandonedHere = abandonedAdmissions.get(admission) === owners[0];
      if (!abandonedHere && !ownerIsGone(pid)) {
        const birth = Number(owner[2]);
        const remaining = deadline - Date.now();
        if (owner[2]?.length !== 13 || !Number.isSafeInteger(birth) || Date.now() - info.mtimeMs < ADMISSION_IDENTITY_CHECK_MS || remaining <= 0) return false;
        if (!starts.has(pid)) starts.set(pid, processStartTime(pid, remaining));
        const actualBirth = starts.get(pid);
        // Only a clearly newer process proves reuse. ps timestamps round to whole seconds.
        if (!actualBirth || actualBirth <= birth + START_TIME_TOLERANCE_MS) return false;
      }
      fs.unlinkSync(path.join(admission, owners[0]));
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
    abandonedAdmissions.set(admission, owner);
    throw Object.assign(new Error(`Could not release admission ${admission}`, { cause }), { code: 'ELOCKED' });
  }
  // The guard is released when its unique owner is gone. An empty directory can be reclaimed.
  try { retryLockAccess(() => fs.rmdirSync(admission)); } catch {}
}

// Every directory mutation uses this short, nonblocking admission. No work or await belongs inside it.
export function admitted(lockDir, mutate, rollback, deadline = Date.now() + LOCK_WAIT_MS, starts = new Map()) {
  const admission = enterAdmission(lockDir, deadline, starts);
  if (!admission) return null;
  let result;
  try {
    result = mutate();
  } catch (error) {
    try { releaseAdmission(admission); } catch {}
    throw error;
  }
  try {
    releaseAdmission(admission);
  } catch (error) {
    // After an irreversible release, report its result. The stranded guard is tracked for recovery.
    if (rollback) {
      try { rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
  }
  return result;
}
