// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withClosedRange } from '../distill/range.js';
import { endedSession, isEarlierTurn, markedReported, pendingReportsOf, sessionOf, unreportedOf } from '../session/state.js';
import { TASKS } from './ports.js';
import { settledSessionOf, turnEnded, withoutPendingControls } from './turn-end.js';
import { turnReportsOf } from './turn-reports.js';

const NOTHING_DONE = Object.freeze({ checks: [], commands: [], paths: [], edits: [], answer: '' });

/**
 * Only writes, since hosts bound a session-end hook tightly: once the last turn's end had its chance to arrive
 * (`settleMs`), a turn still open ends as `openTurnReason`, what is left unreported goes out as aborted with any trial
 * control a turn end could not queue, and the session's range of work turns is closed for the background worker to
 * distill. The session keeps its turn counter, so a resumed one never repeats a task id. An end that names an earlier
 * turn of the session (`turnId`) is stale: a new prompt already continued the session, so it changes nothing.
 */
export async function sessionEnded(ports, { sessionId, projectDir, turnId = null, settleMs = 0, openTurnReason = 'aborted' }) {
  const session = await settledSessionOf(ports, sessionId, settleMs);
  if (isEarlierTurn(session, turnId)) return;
  await turnEnded(ports, { sessionId, reason: openTurnReason, projectDir, recordOf: () => NOTHING_DONE });
  const ending = sessionOf(await ports.sessions.read(sessionId));
  const pending = ports.confirmTurnCompletion ? pendingReportsOf(ending, sessionId) : null;
  const due = pending ? pending.map(({ asset }) => asset) : unreportedOf(ending, sessionId, Infinity);
  const queued = pending ? pending.map(({ entry }) => entry) : turnReportsOf(ports.identity, due, { reason: 'aborted', checks: [] });
  const controls = ending.pendingControls;
  await ports.reports.enqueue([...queued, ...controls]);
  await ports.sessions.update(sessionId, (stored) => {
    const marked = markedReported(sessionOf(stored), due, ports.clock.now()) ?? sessionOf(stored);
    return endedSession(withoutPendingControls(marked, controls));
  });
  await ports.candidates.update((pending) => withClosedRange(pending, sessionId));
  await ports.notes.clear(sessionId, session);
  ports.scheduler.schedule([TASKS.DRAIN, TASKS.DISTILL]);
}
