// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import path from 'node:path';

import { appendStateLine, readState, removeState, updateState, writeState } from './file-lock.js';

// What a host's standalone plugin left in its state folder, adopted so that a resumed session keeps counting turns (a
// repeated task id is taken for a duplicate and its report lost), undelivered reports go out, and injections no
// report covered are reported as aborted at the next session start, never on a later turn's evidence. A profile
// declares its leftovers as plain data:
//   { rename: RegExp }      files or folders of an old name, moved to `<agent>-<old name>`; a newer one wins
//   { sessions: RegExp }    old session files whose owner and session id sit on their ledger entries
//   { ledgers: RegExp }     per-session injection ledgers whose entries name their session and owner
//   { turns: name }         a table of turn counters, { sessionId: { turn } }
//   { retention: name }     a list of pending retention checks
// Each file is adopted on its own and removed once adopted, so one that fails is tried again by the next process
// and holds up nothing else; the folder is marked done only when nothing is left.

function namesIn(dir, pattern) {
  try {
    return fs.readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
}

/** Runs `adopt` on each name on its own; false when any of them failed, which is then tried again later. */
function eachAdopted(names, adopt) {
  let isComplete = true;
  for (const name of names) {
    try {
      adopt(name);
    } catch {
      isComplete = false;
    }
  }
  return isComplete;
}

// Reported entries are kept, so the session is never handed the same strategy again; unreported ones are marked
// adopted. An entry the session already holds stays as it is.
function adoptedLedger(stored, entries) {
  const injected = { ...stored.injected };
  for (const [assetId, entry] of entries) {
    if (injected[assetId]) continue;
    injected[assetId] = {
      turn: entry.turn,
      injectedAt: entry.injectedAt,
      strategyText: entry.strategyText ?? '',
      ...(entry.reportedAt ? { reportedAt: entry.reportedAt } : { adopted: true }),
    };
  }
  return injected;
}

// The ledger is the only record of the turn its session had reached, reported entries included: a resumed session
// counts on from there, or it repeats a task id.
function adoptLedgerEntries({ updateSession }, sessionId, entries, pid) {
  const lastTurn = Math.max(0, ...entries.map(([, entry]) => Number(entry.turn) || 0));
  updateSession(sessionId, (stored) => ({
    ...stored,
    turn: Math.max(stored.turn ?? 0, lastTurn),
    pid: stored.pid ?? pid ?? null,
    injected: adoptedLedger(stored, entries),
  }));
}

const ADOPT = {
  rename({ dir, agent }, pattern) {
    return eachAdopted(namesIn(dir, pattern), (name) => {
      const target = path.join(dir, `${agent}-${name}`);
      if (!fs.existsSync(target)) fs.renameSync(path.join(dir, name), target);
    });
  },
  sessions({ dir, agent }, pattern) {
    return eachAdopted(namesIn(dir, pattern), (name) => {
      const stored = readState(path.join(dir, name), {});
      const entries = Object.entries(stored.injected ?? {});
      const owner = entries.map(([, entry]) => entry).find((entry) => typeof entry?.sessionId === 'string');
      const target = path.join(dir, `${agent}-${name}`);
      if (!fs.existsSync(target)) {
        writeState(target, {
          ...stored,
          ...(owner && { sessionId: owner.sessionId, pid: stored.pid ?? owner.pid ?? null }),
          injected: adoptedLedger({ injected: {} }, entries),
        });
      }
      removeState(path.join(dir, name));
    });
  },
  ledgers(store, pattern) {
    return eachAdopted(namesIn(store.dir, pattern), (name) => {
      const bySession = new Map();
      for (const [assetId, entry] of Object.entries(readState(path.join(store.dir, name), {}))) {
        if (typeof entry?.sessionId !== 'string') continue;
        bySession.set(entry.sessionId, [...(bySession.get(entry.sessionId) ?? []), [assetId, entry]]);
      }
      for (const [sessionId, entries] of bySession) adoptLedgerEntries(store, sessionId, entries, entries[0][1].pid);
      removeState(path.join(store.dir, name));
    });
  },
  turns({ dir, updateSession }, name) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return;
    for (const [sessionId, counter] of Object.entries(readState(file, {}))) {
      const turn = Number(counter?.turn) || 0;
      updateSession(sessionId, (stored) => (turn > (stored.turn ?? 0) ? { ...stored, turn } : stored));
    }
    removeState(file);
  },
  retention({ dir, retentionFile }, name) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return;
    for (const entry of readState(file, [])) appendStateLine(retentionFile, entry);
    removeState(file);
  },
};

function adoptAll(store, declarations) {
  let isComplete = true;
  for (const declaration of declarations) {
    for (const [kind, value] of Object.entries(declaration)) {
      try {
        if (ADOPT[kind]?.(store, value) === false) isComplete = false;
      } catch {
        isComplete = false;
      }
    }
  }
  return isComplete;
}

/**
 * Adopts the declared leftovers; the marker's lock keeps two processes from adopting them at once, and the marker is
 * written only once all of them are adopted. Never throws: a hook must answer whatever its state folder does.
 */
export function adoptLegacyIn(store, declarations) {
  if (declarations.length === 0 || fs.existsSync(store.marker)) return;
  try {
    updateState(store.marker, null, (adopted) => (adopted || !adoptAll(store, declarations) ? undefined : { at: Date.now() }));
  } catch {
  }
}
