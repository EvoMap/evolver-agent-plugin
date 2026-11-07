// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { OUTBOX_TTL_MS, withQueued } from '../../report-outbox.js';
import { ABSENT } from '../../retention.js';
import { appendStateLine, readState, readStateLines, removeState, takeStateLines, updateState, withLock, writeState } from './file-lock.js';
import { adoptLegacyIn } from './legacy.js';

// Every store port over files in one directory. Each file carries the agent's name, `<agent>-<kind>`, so no other
// agent's process ever claims, orphans or drains its entries even when two agents share the directory; this is
// the only place those names are written down.

const MAX_DRAIN_ROUNDS = 5;
// A session file holds the turn counter, which a resumed session needs for as long as it may still be resumed.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CORRECTION_LOCK_WAIT_MS = 2_000;
const CORRECTION_LOCK_RETRY_MS = 20;
const digestOf = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

// A range's turn numbers name it apart from one created again in the same millisecond after its turns were distilled.
export function rangeReferenceOf(sessionId, { at, changedAt, turns }) {
  return `v2-${crypto.createHash('sha256').update(JSON.stringify([sessionId, at, changedAt, turns.map(({ turn }) => turn)])).digest('base64url')}`;
}

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
    read: async () => readStateLines(target),
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

// Ranges live apart from the one-turn candidates an earlier version keeps in its pending file: a session still running
// that version claims every due entry there and, unable to read a range, would count failures until it drops it. What
// that version left behind moves over here once.
function rangeStore(target, legacy) {
  // Under the pending file's own lock, which that version also takes, so none of its writes lands between the read and
  // the clear. A range already here is newer than any candidate it left.
  const adoptLeftovers = () => {
    if (Object.keys(readState(legacy, {})).length === 0) return;
    updateState(legacy, {}, (leftovers) => {
      if (Object.keys(leftovers).length === 0) return undefined;
      updateState(target, {}, (ranges) => ({ ...leftovers, ...ranges }));
      return {};
    });
  };
  return {
    read: async () => {
      adoptLeftovers();
      return readState(target, {});
    },
    update: async (mutate) => {
      adoptLeftovers();
      return updateState(target, {}, mutate);
    },
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

  // Drafts outlive session files. Record correction independently of both session pruning and draft cleanup.
  const corrections = path.join(dir, `${agent}-distill-corrections`);
  const correctionName = (sessionId, turn, sessionEpoch) => digestOf(JSON.stringify([sessionId, turn, sessionEpoch]));
  const correctionFile = (...source) => path.join(corrections, correctionName(...source));
  const draftCorrections = {
    withSession: async (sessionId, work, signal) => {
      const lock = path.join(corrections, `${digestOf(sessionId)}.lock`);
      const deadline = Date.now() + CORRECTION_LOCK_WAIT_MS;
      let result;
      for (;;) {
        signal?.throwIfAborted();
        if (await withLock(lock, async () => { result = await work(); })) return result;
        if (Date.now() >= deadline) throw Object.assign(new Error('Timed out waiting for the draft correction lock. Please retry.'), { code: 'ELOCKED' });
        await delay(CORRECTION_LOCK_RETRY_MS, undefined, { signal });
      }
    },
    mark: async (sessionId, turn, sessionEpoch) => {
      fs.mkdirSync(corrections, { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(correctionFile(sessionId, turn, sessionEpoch), 'a', 0o600));
    },
    has: async (sessionId, turn, sessionEpoch) => Boolean(fs.statSync(correctionFile(sessionId, turn, sessionEpoch), { throwIfNoEntry: false })),
  };

  // One unreadable or busy session must not stop the others; the first failure is still raised afterwards.
  const eachSession = (visit) => {
    let failure;
    for (const target of filesOf(sessionPattern('session', 'json'))) {
      try {
        visit(target);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  const sessions = {
    read: async (sessionId) => readState(sessionFile('session', sessionId), {}),
    readEach: async (visit) => eachSession((target) => {
      const stored = readState(target, {});
      if (stored.sessionId) visit(stored, stored.sessionId);
    }),
    update: async (sessionId, mutate) => updateState(sessionFile('session', sessionId), {}, (stored) => stamped(sessionId, mutate(stored))),
    updateEach: async (mutate) => eachSession((target) => {
      updateState(target, {}, (stored) => (stored.sessionId ? stamped(stored.sessionId, mutate(stored, stored.sessionId)) : undefined));
    }),
  };

  const notes = {
    append: (sessionId, note) => linesStore(sessionFile('turn', sessionId, 'jsonl')).append(note),
    read: (sessionId) => linesStore(sessionFile('turn', sessionId, 'jsonl')).read(),
    take: async (sessionId) => {
      const { lines, commit } = await linesStore(sessionFile('turn', sessionId, 'jsonl')).take();
      return { notes: lines, commit };
    },
    clear: (sessionId) => linesStore(sessionFile('turn', sessionId, 'jsonl')).clear(),
  };

  const baseline = {
    remember: (sessionId, target, turnId = null) => linesStore(sessionFile('edits', sessionId, 'jsonl')).append({ path: target, before: contentHashOf(target), turnId }),
    take: async (sessionId, turnId = null) => {
      const { lines, commit } = await linesStore(sessionFile('edits', sessionId, 'jsonl')).take();
      const before = new Map();
      const ofTurn = (line) => !line.turnId || !turnId || line.turnId === turnId;
      for (const { path: target, before: hash } of lines.filter(ofTurn)) if (typeof target === 'string' && !before.has(target)) before.set(target, hash);
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

  // A marker outlives its session file for as long as a saved draft of that turn may still be published.
  const pruneCorrections = (now) => {
    let saved, names;
    try {
      saved = readState(file('distill-drafts'), []);
      names = fs.readdirSync(corrections);
    } catch {
      return;
    }
    const kept = new Set(saved.filter((draft) => draft?.sourceCandidate).map(({ sessionId, sourceCandidate: { turn, sessionEpoch } }) => correctionName(sessionId, turn, sessionEpoch)));
    for (const name of names.filter((entry) => /^[0-9a-f]{16}$/.test(entry) && !kept.has(entry))) {
      const target = path.join(corrections, name);
      try {
        if (now - fs.statSync(target).mtimeMs > SESSION_TTL_MS) fs.rmSync(target, { force: true });
      } catch {
      }
    }
  };

  const prune = (now = Date.now()) => {
    const lifetimes = [[sessionPattern('session', 'json'), SESSION_TTL_MS], [sessionPattern('turn', 'jsonl'), OUTBOX_TTL_MS], [sessionPattern('edits', 'jsonl'), OUTBOX_TTL_MS]];
    for (const [pattern, ttlMs] of lifetimes) {
      for (const target of filesOf(pattern)) {
        try {
          if (now - fs.statSync(target).mtimeMs > ttlMs) fs.rmSync(target, { force: true });
        } catch {
        }
      }
    }
    pruneCorrections(now);
  };

  const adoptLegacy = (declarations) => adoptLegacyIn({
    dir,
    agent,
    marker: file('legacy-adopted'),
    retentionFile: retentionPath,
    updateSession: (sessionId, mutate) => updateState(sessionFile('session', sessionId), {}, (stored) => stamped(sessionId, mutate(stored))),
  }, declarations);

  return {
    adoptLegacy,
    sessions,
    notes,
    baseline,
    candidates: { ...rangeStore(file('distill-ranges'), file('distill-pending')), referenceOf: rangeReferenceOf },
    drafts: tableStore(file('distill-drafts'), []),
    outcomes: tableStore(file('distill-outcomes'), []),
    corpus: tableStore(file('distill-corpus'), []),
    draftCorrections,
    reports,
    outbox,
    retention,
    engineState: tableStore(file('engine'), null),
    engineAnnounced: tableStore(file('engine-announced'), {}),
    engineLock: file('engine', 'lock'),
    distillWaiter: file('distill-waiter'),
    folder: (kind) => path.join(dir, `${agent}-${kind}`),
    prune,
  };
}
