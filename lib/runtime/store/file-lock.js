// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ownerIsGone, processStartTime, PROCESS_START_TIMEOUT_MS, PROCESS_START_TOLERANCE_MS } from '../process/owner.js';
import { admitted, LOCK_ACCESS_ERRORS, LOCK_WAIT_MS, LOCK_RETRY_MS, pause, retryLockAccess } from './admission.js';

const WORK_LOCK_STALE_MS = 2 * 60 * 1000;
const WORK_OWNER_PROBE_MS = process.platform === 'win32' ? 5_000 : PROCESS_START_TIMEOUT_MS;
const WORK_OWNER_WITH_START = /^\d+:[a-f0-9]+:([1-9]\d{12})$/;
const CLAIM_STALE_MS = 60 * 1000;
const abandonedWork = new Map();
const abandonedState = new Map();

export function readState(target, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) !== Array.isArray(fallback)) throw Object.assign(new Error(`Invalid state shape in ${target}; repair it before retrying.`), { code: 'EINVALIDSTATE' });
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw Object.assign(new Error(`Invalid JSON in ${target}; repair it before retrying.`), { code: 'EINVALIDSTATE', cause: error });
    if (error?.code === 'EINVALIDSTATE') throw error;
    throw Object.assign(new Error(`Could not read state in ${target}; check access and retry.`), { code: 'ESTATEIO', cause: error });
  }
}

export function writeState(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value));
    } catch (error) {
      try { fs.closeSync(descriptor); } catch {}
      throw error;
    }
    fs.closeSync(descriptor);
    for (;;) {
      try {
        fs.renameSync(temporary, target);
        return;
      } catch (error) {
        if (!['EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) throw error;
        pause(LOCK_RETRY_MS);
      }
    }
  } finally {
    if (descriptor !== undefined) removeState(temporary);
  }
}

export function removeState(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
  }
}

function stateOwnerOf(file) {
  try {
    return retryLockAccess(() => fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const ownerPidOf = (token) => Number(token.split(':')[0]);

function acquire(lockPath, deadline) {
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  const starts = new Map();
  while (Date.now() < deadline) {
    let acquired = false;
    try {
      const result = admitted(lockPath, () => {
        try {
          fs.writeFileSync(lockPath, token, { mode: 0o600, flag: 'wx' });
          acquired = true;
          return token;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          // Admission serializes inspection and removal with every other acquisition.
          const held = stateOwnerOf(lockPath);
          if (held !== null && (abandonedState.get(lockPath) === held || ownerIsGone(ownerPidOf(held)))) {
            fs.unlinkSync(lockPath);
            abandonedState.delete(lockPath);
          }
          return null;
        }
      }, () => {
        if (!acquired) return;
        abandonedState.set(lockPath, token);
        if (stateOwnerOf(lockPath) === token) retryLockAccess(() => fs.unlinkSync(lockPath));
        abandonedState.delete(lockPath);
      }, deadline, starts);
      if (result) {
        abandonedState.delete(lockPath);
        return result;
      }
    } catch (error) {
      if (!LOCK_ACCESS_ERRORS.has(error?.code)) throw error;
    }
    if (Date.now() < deadline) pause(LOCK_RETRY_MS);
  }
  return null;
}

function release(lockPath, token) {
  try {
    if (stateOwnerOf(lockPath) === token) retryLockAccess(() => fs.unlinkSync(lockPath));
  } catch {
    // The state write is already settled. Keep the exact token for the next admitted acquire.
    abandonedState.set(lockPath, token);
  }
}

/**
 * Applies `mutate` to a state file under an exclusive lock, so hook processes sharing it cannot overwrite each
 * other's entries. A dead owner's lock is taken over; failed admission never permits an unlocked write.
 * `mutate` returns undefined to leave the file.
 */
export function updateState(target, fallback, mutate) {
  const lockPath = `${target}.lock`;
  let token, cause;
  try { token = acquire(lockPath, Date.now() + LOCK_WAIT_MS); } catch (error) { cause = error; }
  if (!token) throw Object.assign(new Error('State is busy or unavailable; no update was made', { cause }), { code: 'ELOCKED' });
  try {
    const next = mutate(readState(target, fallback));
    if (next !== undefined) writeState(target, next);
    return next;
  } finally {
    release(lockPath, token);
  }
}

export function appendStateLine(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // A separator before each record keeps a prior interrupted append from consuming this complete record.
  fs.appendFileSync(target, `\n${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function linesOf(file) {
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

function staleClaimsOf(target, now) {
  const prefix = `${path.basename(target)}.`;
  try {
    return fs.readdirSync(path.dirname(target))
      .filter((name) => name.startsWith(prefix) && name.endsWith('.taking'))
      .map((name) => path.join(path.dirname(target), name))
      .filter((file) => now - fs.statSync(file).mtimeMs > CLAIM_STALE_MS);
  } catch {
    return [];
  }
}

function claimed(source, target) {
  const claim = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.taking`;
  try {
    fs.renameSync(source, claim);
    fs.utimesSync(claim, new Date(), new Date());
    return claim;
  } catch {
    return null;
  }
}

// Lines move into a claim file that is deleted only on commit, so a process that dies between taking and
// persisting them leaves the claim behind for the next taker to pick up once it is stale.
/** The lines appended so far, read in place: nothing is claimed, so a later take still finds them all. */
export function readStateLines(target) {
  try {
    return linesOf(target);
  } catch {
    return [];
  }
}

export function takeStateLines(target, now = Date.now()) {
  const claims = [...staleClaimsOf(target, now), target].map((source) => claimed(source, target)).filter(Boolean);
  return {
    lines: claims.flatMap(linesOf),
    commit: () => {
      for (const claim of claims) fs.rmSync(claim, { force: true });
    },
  };
}

function isStale(lockDir, now) {
  try {
    return now - fs.statSync(lockDir).mtimeMs > WORK_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function workOwnerOf(lockDir) {
  try {
    return retryLockAccess(() => fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'));
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw Object.assign(new Error(`Could not read lock owner ${lockDir}`, { cause }), { code: 'ELOCKED' });
  }
}

function ownsLock(lockDir, token) {
  return workOwnerOf(lockDir) === token;
}

async function releaseWorkLock(lockDir, token) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const starts = new Map();
  for (;;) {
    if (admitted(lockDir, () => {
      if (ownsLock(lockDir, token)) fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }, null, deadline, starts)) return;
    if (Date.now() >= deadline) throw Object.assign(new Error(`Could not release lock ${lockDir}`), { code: 'ELOCKED' });
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

function tryLock(lockDir, now) {
  let token, suspect, reusedToken;
  const take = () => admitted(lockDir, () => {
    const stale = isStale(lockDir, now);
    if (abandonedWork.has(lockDir) || stale) {
      let held;
      try { held = workOwnerOf(lockDir); } catch { return null; }
      if (held !== abandonedWork.get(lockDir)) {
        if (!stale) return null;
        if (held !== reusedToken && /^\d+:/.test(held ?? '')) {
          const pid = ownerPidOf(held);
          if (!ownerIsGone(pid)) {
            const birth = WORK_OWNER_WITH_START.exec(held)?.[1];
            if (birth) suspect = { token: held, pid, birth: Number(birth) };
            return null;
          }
        }
      }
      fs.rmSync(lockDir, { recursive: true, force: true });
      abandonedWork.delete(lockDir);
    }
    try {
      fs.mkdirSync(lockDir);
    } catch {
      return null;
    }
    token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}:${processStartTime(process.pid)}`;
    fs.writeFileSync(path.join(lockDir, 'owner'), token);
    return {
      refresh: () => {
        try {
          return admitted(lockDir, () => {
            if (ownsLock(lockDir, token)) fs.utimesSync(lockDir, new Date(), new Date());
          });
        } catch {
          // Timer-driven refresh is best effort; a live pid stays protected and final release still surfaces errors.
          return null;
        }
      },
      release: async () => {
        try { await releaseWorkLock(lockDir, token); }
        catch (error) { abandonedWork.set(lockDir, token); throw error; }
      },
    };
  }, () => {
    if (!token) return;
    abandonedWork.set(lockDir, token);
    if (ownsLock(lockDir, token)) fs.rmSync(lockDir, { recursive: true, force: true });
    abandonedWork.delete(lockDir);
  });
  const lock = take();
  if (lock || !suspect) return lock;
  // A foreign lookup can be slow. Release admission, then recheck staleness and the exact token.
  const actualBirth = processStartTime(suspect.pid, WORK_OWNER_PROBE_MS);
  if (!actualBirth || actualBirth <= suspect.birth + PROCESS_START_TOLERANCE_MS) return null;
  reusedToken = suspect.token;
  return take();
}

/** Runs slow `work` under one owner's lock; dead or legacy directories recover after their lease expires. */
export async function withLock(lockDir, work, now = Date.now()) {
  const lock = tryLock(lockDir, now);
  if (!lock) return false;
  let workFailed = false;
  try {
    await work(lock);
    return true;
  } catch (error) {
    workFailed = true;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (error) {
      if (!workFailed) throw error;
    }
  }
}
