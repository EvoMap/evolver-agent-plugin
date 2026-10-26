// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OUTBOX_TTL_MS, withQueued } from '../../report-outbox.js';
import { ABSENT } from '../../retention.js';
import { appendStateLine, readState, removeState, takeStateLines, updateState, withLock, writeState } from './file-lock.js';

// Every store port over files in one directory. Each file carries the agent's name, `<agent>-<kind>`, so no other
// agent's process ever claims, orphans or drains its entries even when two agents share the directory; this is
// the only place those names are written down.

const MAX_DRAIN_ROUNDS = 5;
const digestOf = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

export function contentHashOf(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return ABSENT;
  }
}

function linesStore(target) {
  return {
    append: async (value) => appendStateLine(target, value),
    take: async () => {
      const { lines, commit } = takeStateLines(target);
      return { lines, commit: async () => commit() };
    },
    clear: async () => removeState(target),
  };
}

function tableStore(target, empty) {
  return {
    read: async () => readState(target, empty),
    update: async (mutate) => updateState(target, empty, mutate),
  };
}

export function fileStoresOf({ dir, agent }) {
  const file = (kind, extension = 'json') => path.join(dir, `${agent}-${kind}.${extension}`);
  const sessionFile = (kind, sessionId, extension = 'json') => path.join(dir, `${agent}-${kind}-${digestOf(sessionId)}.${extension}`);
  const sessionPattern = (kind, extension) => new RegExp(`^${agent}-${kind}-[0-9a-f]{16}\\.${extension}$`);
  const filesOf = (pattern) => {
    try {
      return fs.readdirSync(dir).filter((name) => pattern.test(name)).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };
  const stamped = (sessionId, next) => (next === undefined ? undefined : { ...next, sessionId, touchedAt: Date.now() });

  const sessions = {
    read: async (sessionId) => readState(sessionFile('session', sessionId), {}),
    update: async (sessionId, mutate) => updateState(sessionFile('session', sessionId), {}, (stored) => stamped(sessionId, mutate(stored))),
    updateEach: async (mutate) => {
      for (const target of filesOf(sessionPattern('session', 'json'))) {
        updateState(target, {}, (stored) => (stored.sessionId ? stamped(stored.sessionId, mutate(stored, stored.sessionId)) : undefined));
      }
    },
  };

  const notes = {
    append: (sessionId, note) => linesStore(sessionFile('turn', sessionId, 'jsonl')).append(note),
    take: async (sessionId) => {
      const { lines, commit } = await linesStore(sessionFile('turn', sessionId, 'jsonl')).take();
      return { notes: lines, commit };
    },
    clear: (sessionId) => linesStore(sessionFile('turn', sessionId, 'jsonl')).clear(),
  };

  const baseline = {
    remember: (sessionId, target) => linesStore(sessionFile('edits', sessionId, 'jsonl')).append({ path: target, before: contentHashOf(target) }),
    take: async (sessionId) => {
      const { lines, commit } = await linesStore(sessionFile('edits', sessionId, 'jsonl')).take();
      const before = new Map();
      for (const { path: target, before: hash } of lines) if (typeof target === 'string' && !before.has(target)) before.set(target, hash);
      return { before, commit };
    },
  };

  const queuePath = file('reports-queue', 'jsonl');
  const outboxPath = file('reports-outbox');
  const reports = { enqueue: async (entries) => entries.forEach((entry) => appendStateLine(queuePath, entry)) };

  // Hooks only append to the queue; the one process holding the lock owns the outbox. The lock is refreshed after
  // every attempt and only the attempted entries are merged back, so a slow drain never rolls the file back.
  const outbox = {
    drain: (deliver) => withLock(file('outbox', 'lock'), async (lock) => {
      const attempted = new Set();
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
        const { lines: queued, commit } = takeStateLines(queuePath);
        const merged = withQueued(readState(outboxPath, {}), queued, Date.now());
        writeState(outboxPath, merged);
        commit();
        const due = Object.fromEntries(Object.entries(merged).filter(([key]) => !attempted.has(key)));
        for (const key of Object.keys(due)) attempted.add(key);
        const delivered = await deliver(due, lock.refresh);
        const changed = Object.fromEntries(Object.entries(delivered).filter(([key, entry]) => due[key] !== entry));
        writeState(outboxPath, { ...readState(outboxPath, {}), ...changed });
        if (queued.length === 0) return;
      }
    }),
  };

  const retentionPath = file('retention-pending', 'jsonl');
  const retention = {
    remember: async ({ sessionId, projectDir, reuses, editedBefore }) => {
      if (reuses.length === 0 || editedBefore.size === 0) return;
      const files = [...editedBefore].map(([target, before]) => ({ path: target, before, after: contentHashOf(target) }));
      appendStateLine(retentionPath, { sessionId, projectDir, reuses, files, atMs: Date.now() });
    },
    takeDue: async ({ sessionId, projectDir }) => {
      const now = Date.now();
      const { lines, commit } = takeStateLines(retentionPath, now);
      const live = lines.filter((entry) => now - entry.atMs <= OUTBOX_TTL_MS);
      const isDue = (entry) => entry.projectDir === projectDir && entry.sessionId !== sessionId;
      for (const entry of live.filter((candidate) => !isDue(candidate))) appendStateLine(retentionPath, entry);
      const due = live.filter(isDue).map((entry) => ({ ...entry, files: entry.files.map((file) => ({ ...file, now: contentHashOf(file.path) })) }));
      return { due, commit: async () => commit() };
    },
  };

  const prune = (now = Date.now()) => {
    const patterns = [sessionPattern('session', 'json'), sessionPattern('turn', 'jsonl'), sessionPattern('edits', 'jsonl')];
    for (const target of patterns.flatMap(filesOf)) {
      try {
        if (now - fs.statSync(target).mtimeMs > OUTBOX_TTL_MS) fs.rmSync(target, { force: true });
      } catch {
      }
    }
  };

  return {
    sessions,
    notes,
    baseline,
    candidates: tableStore(file('distill-pending'), {}),
    drafts: tableStore(file('distill-drafts'), []),
    reports,
    outbox,
    retention,
    engineState: tableStore(file('engine'), null),
    engineAnnounced: tableStore(file('engine-announced'), {}),
    engineLock: file('engine', 'lock'),
    folder: (kind) => path.join(dir, `${agent}-${kind}`),
    prune,
  };
}
