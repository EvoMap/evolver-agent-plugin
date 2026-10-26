// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import path from 'node:path';

import { appendStateLine, readState, removeState, updateState } from './file-lock.js';

// What an agent's earlier standalone plugin left in its state folder, adopted once, so that a resumed session keeps
// counting turns (a repeated task id is taken for a duplicate and its report lost), undelivered reports go out, and
// injections no report covered get one. An agent's profile declares its leftovers as plain data:
//   { rename: RegExp }      files or folders of an old name, moved to `<agent>-<old name>` unless that exists
//   { ledgers: RegExp }     per-session injection ledgers whose entries name their session and owner
//   { turns: name }         a table of turn counters, { sessionId: { turn } }
//   { retention: name }     a list of pending retention checks

function namesIn(dir, pattern) {
  try {
    return fs.readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
}

const ADOPT = {
  rename({ dir, agent }, pattern) {
    for (const name of namesIn(dir, pattern)) {
      const target = path.join(dir, `${agent}-${name}`);
      if (!fs.existsSync(target)) fs.renameSync(path.join(dir, name), target);
    }
  },
  ledgers({ dir, updateSession }, pattern) {
    for (const name of namesIn(dir, pattern)) {
      for (const [assetId, entry] of Object.entries(readState(path.join(dir, name), {}))) {
        if (entry?.reportedAt || typeof entry?.sessionId !== 'string') continue;
        updateSession(entry.sessionId, (stored) => ({
          ...stored,
          pid: stored.pid ?? entry.pid ?? null,
          injected: { ...stored.injected, [assetId]: { turn: entry.turn, injectedAt: entry.injectedAt, strategyText: entry.strategyText ?? '' } },
        }));
      }
      removeState(path.join(dir, name));
    }
  },
  turns({ dir, updateSession }, name) {
    for (const [sessionId, counter] of Object.entries(readState(path.join(dir, name), {}))) {
      const turn = Number(counter?.turn) || 0;
      updateSession(sessionId, (stored) => (turn > (stored.turn ?? 0) ? { ...stored, turn } : stored));
    }
    removeState(path.join(dir, name));
  },
  retention({ dir, retentionFile }, name) {
    for (const entry of readState(path.join(dir, name), [])) appendStateLine(retentionFile, entry);
    removeState(path.join(dir, name));
  },
};

/** Adopts the declared leftovers once per folder; the marker's lock keeps two processes from adopting them twice. */
export function adoptLegacyIn(store, declarations) {
  if (declarations.length === 0 || fs.existsSync(store.marker)) return;
  updateState(store.marker, null, (adopted) => {
    if (adopted) return undefined;
    for (const declaration of declarations) {
      for (const [kind, value] of Object.entries(declaration)) {
        try {
          ADOPT[kind]?.(store, value);
        } catch {
        }
      }
    }
    return { at: Date.now() };
  });
}
