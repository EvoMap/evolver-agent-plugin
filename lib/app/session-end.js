// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withClosedCandidate } from '../distill/candidate.js';
import { endedSession, markedReported, sessionOf, unreportedOf } from '../session/state.js';
import { TASKS } from './ports.js';
import { settledSessionOf, turnEnded } from './turn-end.js';
import { turnReportsOf } from './turn-reports.js';

const NOTHING_DONE = Object.freeze({ checks: [], commands: [], paths: [], edits: [], answer: '' });

/**
 * Only writes, since hosts bound a session-end hook tightly: once the last turn's end had its chance to arrive
 * (`settleMs`), a turn still open ends as `openTurnReason`, what is left unreported goes out as aborted, and the
 * candidate is closed for the background worker to distill. The session keeps its turn counter, so a resumed one
 * never repeats a task id. An end that names a turn (`turnId`) while another one is open is stale: a new prompt
 * already continued the session, so it changes nothing.
 */
export async function sessionEnded(ports, { sessionId, projectDir, turnId = null, settleMs = 0, openTurnReason = 'aborted' }) {
  const session = await settledSessionOf(ports, sessionId, settleMs);
  if (turnId && session.open && session.turnId && session.turnId !== turnId) return;
  await turnEnded(ports, { sessionId, reason: openTurnReason, projectDir, recordOf: () => NOTHING_DONE });
  const due = unreportedOf(sessionOf(await ports.sessions.read(sessionId)), sessionId, Infinity);
  await ports.reports.enqueue(turnReportsOf(ports.identity, due, { reason: 'aborted', checks: [] }));
  await ports.sessions.update(sessionId, (stored) => endedSession(markedReported(sessionOf(stored), due, ports.clock.now()) ?? sessionOf(stored)));
  await ports.candidates.update((pending) => withClosedCandidate(pending, sessionId));
  await ports.notes.clear(sessionId);
  ports.scheduler.schedule([TASKS.DRAIN, TASKS.DISTILL]);
}
