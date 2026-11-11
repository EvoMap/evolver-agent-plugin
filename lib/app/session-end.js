// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withClosedRange } from '../distill/range.js';
import { endedSession, isEarlierTurn, markedReported, pendingReportsOf, sessionOf, unreportedOf } from '../session/state.js';
import { TASKS } from './ports.js';
import { settledSessionOf, turnEnded, withoutPendingControls } from './turn-end.js';
import { turnReportsOf } from './turn-reports.js';

const NOTHING_DONE = Object.freeze({ checks: [], commands: [], paths: [], edits: [], answer: '' });
const isSameTurn = (session, expected) => session.turn === expected.turn && session.sessionEpoch === expected.sessionEpoch;

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
  await turnEnded(ports, { sessionId, reason: openTurnReason, projectDir, recordOf: () => NOTHING_DONE, expectedTurn: session });
  const ending = sessionOf(await ports.sessions.read(sessionId));
  if (!isSameTurn(ending, session)) return;
  // Native mode only replays cached reports; session start settles explicitly adopted legacy injections.
  // An uncached native entry has no safe legacy provenance, so shutdown cannot classify it.
  const pending = ports.confirmTurnCompletion ? pendingReportsOf(ending, sessionId) : null;
  const due = pending ? pending.map(({ asset }) => asset) : unreportedOf(ending, sessionId, Infinity);
  const queued = pending ? pending.map(({ entry }) => entry) : turnReportsOf(ports.identity, due, { reason: 'aborted', checks: [] });
  const controls = ending.pendingControls;
  await ports.reports.enqueue([...queued, ...controls]);
  // A prompt uses the same fence to open its turn after this session and its range have ended together.
  const ended = await ports.sessions.withSession(sessionId, async () => {
    const saved = await ports.sessions.update(sessionId, (stored) => {
      const current = sessionOf(stored);
      if (!isSameTurn(current, ending)) return undefined;
      const marked = markedReported(current, due, ports.clock.now()) ?? current;
      return endedSession(withoutPendingControls(marked, controls));
    });
    if (!saved) return false;
    await ports.candidates.update((pending) => withClosedRange(pending, sessionId));
    await ports.notes.clear(sessionId, session);
    return true;
  });
  ports.scheduler.schedule(ended ? [TASKS.DRAIN, TASKS.DISTILL] : [TASKS.DRAIN]);
}
