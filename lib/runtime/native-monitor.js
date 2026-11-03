// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { withLock } from './store/file-lock.js';

const POLL_MS = 500;
const MISSING_MS = 30_000;
const MAX_WATCH_MS = 24 * 60 * 60 * 1000;

/** Hook completion can precede the native terminal write. One owned monitor reconciles that logical turn. */
export async function monitorNativeTurn(ports, at, reconcile, abort, { dir, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!ports.native || !at || typeof at.sessionId !== 'string' || !at.sessionId || at.sessionId.length > 2048
      || !Number.isSafeInteger(at.turn) || at.turn < 1 || typeof at.projectDir !== 'string') return false;
  const key = createHash('sha256').update(JSON.stringify([at.sessionId, at.turn])).digest('hex');
  return withLock(join(dir, key), async lock => {
    const start = now();
    while (now() - start < MAX_WATCH_MS) {
      const session = await ports.sessions.read(at.sessionId);
      if (session.turn !== at.turn || session.native?.turn !== at.turn) return;
      // Native terminal wins over owner death; orphan recovery must not turn a completed check into an abort.
      const result = await reconcile(at);
      if (result?.facts?.limited || ['unreadable', 'unsupported'].includes(result?.facts?.status)) return;
      // An end before native admission cannot become a running turn; do not retain a detached observer for it.
      if (session.native.sessionEnded && !result?.native?.turnId) return;
      if (ports.owner.isGone(session.pid)) {
        if (!result?.ended) await abort({ ...at, expectedTurn: session.turn, expectedPid: session.pid, reason: 'aborted' });
        return;
      }
      if (result?.ended && !result.waiting) return;
      if (!session.open && !result?.waiting) return;
      if (!result?.native?.turnId && now() - start >= MISSING_MS) return;
      lock.refresh();
      await sleep(POLL_MS);
    }
  });
}
