// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { withLock } from './store/file-lock.js';

const POLL_MS = 500;
const MISSING_ROW_MS = 30_000;
const MAX_WATCH_MS = 24 * 60 * 60 * 1000;

/** Only an authoritative failed/aborted record closes a turn; an absent record never becomes a verdict. */
export async function monitorTurn(ports, at, close, { dir, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!ports.turnStatus || !at || !['sessionId', 'turnId'].every(key => typeof at[key] === 'string' && at[key] && at[key].length <= 256) || typeof at.projectDir !== 'string') return false;
  const key = createHash('sha256').update(JSON.stringify([at.sessionId, at.turnId])).digest('hex');
  return withLock(join(dir, key), async lock => {
    const started = now();
    while (now() - started < MAX_WATCH_MS) {
      const session = await ports.sessions.read(at.sessionId);
      if (!session.open || session.turnId !== at.turnId || ports.owner.isGone(session.pid)) return;
      const row = ports.turnStatus(at.sessionId, at.turnId);
      if (row?.status === 'failed' || row?.status === 'aborted') {
        await close({ ...at, reason: row.status === 'failed' ? 'error' : 'aborted' });
        return;
      }
      // Successful turns are still judged by Stop and actual tool evidence, never by a database status alone.
      if (row?.status === 'completed' || (row?.status !== 'accepted' && now() - started >= MISSING_ROW_MS)) return;
      lock.refresh();
      await sleep(POLL_MS);
    }
  });
}
