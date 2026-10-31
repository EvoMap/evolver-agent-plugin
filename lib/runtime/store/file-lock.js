// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ownerIsGone } from '../process/owner.js';

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const WORK_LOCK_STALE_MS = 2 * 60 * 1000;
const CLAIM_STALE_MS = 60 * 1000;

export function readState(target, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) !== Array.isArray(fallback)) throw new Error(`Invalid state shape in ${target}; repair it before retrying.`);
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${target}; repair it before retrying.`);
    throw error;
  }
}

export function writeState(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
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
    removeState(temporary);
  }
}

export function removeState(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
  }
}

// Atomics.wait is the only sleep that holds a synchronous read-modify-write together.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function contentOf(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const ownerPidOf = (token) => Number(token.split(':')[0]);

// Another process may reclaim the same dead lock and a third take a fresh one before this removal happens, so the
// lock is first moved aside, and only what was inspected as dead is deleted; anything else is put back.
function reclaim(lockPath, deadToken) {
  const aside = `${lockPath}.${crypto.randomBytes(6).toString('hex')}.reclaimed`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return;
  }
  if (contentOf(aside) !== deadToken) {
    try {
      fs.linkSync(aside, lockPath);
    } catch {
    }
  }
  removeState(aside);
}

function acquire(lockPath, deadline) {
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(lockPath, token, { mode: 0o600, flag: 'wx' });
      return token;
    } catch (error) {
      if (['EACCES', 'EPERM', 'EBUSY'].includes(error?.code) && Date.now() < deadline) { pause(LOCK_RETRY_MS); continue; }
      if (error?.code !== 'EEXIST') return null;
      const held = contentOf(lockPath);
      if (held !== null && ownerIsGone(ownerPidOf(held))) reclaim(lockPath, held);
      else if (Date.now() >= deadline) return null;
      else pause(LOCK_RETRY_MS);
    }
  }
}

function release(lockPath, token) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) fs.rmSync(lockPath, { force: true });
      return;
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) return;
      pause(LOCK_RETRY_MS);
    }
  }
}

/**
 * Applies `mutate` to a state file under an exclusive lock, so hook processes sharing it cannot overwrite each
 * other's entries. A dead owner's lock is taken over; failed admission never permits an unlocked write.
 * `mutate` returns undefined to leave the file.
 */
export function updateState(target, fallback, mutate) {
  const lockPath = `${target}.lock`;
  const token = acquire(lockPath, Date.now() + LOCK_WAIT_MS);
  if (!token) throw Object.assign(new Error('State is busy or unavailable; no update was made'), { code: 'ELOCKED' });
  try {
    const next = mutate(readState(target, fallback));
    if (next !== undefined) writeState(target, next);
    return next;
  } finally {
    if (token) release(lockPath, token);
  }
}

export function appendStateLine(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.appendFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
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

function ownsLock(lockDir, token) {
  return contentOf(path.join(lockDir, 'owner')) === token;
}

function tryLock(lockDir, now) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  if (isStale(lockDir, now)) fs.rmSync(lockDir, { recursive: true, force: true });
  try {
    fs.mkdirSync(lockDir);
  } catch {
    return null;
  }
  const token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(lockDir, 'owner'), token);
  return {
    refresh: () => {
      if (ownsLock(lockDir, token)) fs.utimesSync(lockDir, new Date(), new Date());
    },
    release: () => {
      if (ownsLock(lockDir, token)) fs.rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

/** Runs slow `work` while holding a lock directory no other process gets meanwhile; false when it is held. */
export async function withLock(lockDir, work, now = Date.now()) {
  const lock = tryLock(lockDir, now);
  if (!lock) return false;
  try {
    await work(lock);
    return true;
  } finally {
    lock.release();
  }
}
