// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { reasonOfNativeStatus } from '../turn-outcomes.js';
import { withLock } from './store/file-lock.js';

const POLL_MS = 500;
const MISSING_ROW_MS = 30_000;
const PENDING_ROW_MS = 5 * 60_000;
const DEAD_OWNER_GRACE_MS = 30_000;
const MAX_WATCH_MS = 24 * 60 * 60 * 1000;

/** A terminal record closes the matching turn. Only opt-in profiles also wait for native completion after Stop. */
export async function monitorTurn(ports, at, close, { dir, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!ports.turnStatus || !at || !['sessionId', 'turnId'].every(key => typeof at[key] === 'string' && at[key] && at[key].length <= 256) || typeof at.projectDir !== 'string') return false;
  const key = createHash('sha256').update(JSON.stringify([at.sessionId, at.turnId, at.expectedTurn?.turn, at.expectedTurn?.sessionEpoch])).digest('hex');
  return withLock(join(dir, key), async lock => {
    const started = now();
    let ownerGoneAt, watched = at.expectedTurn;
    while (now() - started < MAX_WATCH_MS) {
      const session = await ports.sessions.read(at.sessionId);
      if (!session.open || session.turnId !== at.turnId) return;
      watched ??= { ...session };
      if (session.turnId !== watched.turnId || session.turn !== watched.turn || session.sessionEpoch !== watched.sessionEpoch) return;
      const ownerGone = ports.owner.isGone(session.pid);
      if (ownerGone && !ports.confirmTurnCompletion) return;
      const row = ports.turnStatus(at.sessionId, at.turnId);
      const reason = reasonOfNativeStatus(row?.status, ports.confirmTurnCompletion);
      if (reason) {
        const { projectDir, expectedTurn, ...turn } = at;
        // Once its owner is gone, the current worktree need not be the one the turn checked.
        await close({ ...turn, ...(!ownerGone && { projectDir }), reason, ...((expectedTurn || ports.confirmTurnCompletion) && { expectedTurn: watched }) });
        return;
      }
      // Some native stores write the first row only at turn completion.
      const waitMs = ports.confirmTurnCompletion && row?.status === 'pending' ? PENDING_ROW_MS : MISSING_ROW_MS;
      const observedAt = now();
      if (ownerGone) {
        ownerGoneAt ??= observedAt;
        if (observedAt - ownerGoneAt >= DEAD_OWNER_GRACE_MS && observedAt - started >= waitMs) return;
      } else if (row?.status === 'completed' || (row?.status !== 'accepted' && observedAt - started >= waitMs)) return;
      lock.refresh();
      await sleep(POLL_MS);
    }
  });
}
