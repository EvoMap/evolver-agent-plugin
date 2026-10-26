// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { candidateOf, skipReason, withCandidate } from '../distill/candidate.js';
import { reportedReuseOf } from '../reuse.js';
import { closedTurn, isSettled, sessionOf, takenUnreported } from '../session/state.js';
import { turnRecordOf } from '../turn/record.js';
import { TASKS } from './ports.js';
import { OBSERVED, turnReportsOf } from './turn-reports.js';

const SETTLE_POLL_MS = 100;

async function closeTurn({ sessions }, sessionId, turnId) {
  let opened = null;
  await sessions.update(sessionId, (stored) => {
    const result = closedTurn(sessionOf(stored), turnId);
    opened = result.opened;
    return result.next;
  });
  return opened;
}

async function reportTurn({ identity, sessions, reports, clock }, sessionId, opened, { reason, checks, source }) {
  let queued = [];
  await sessions.update(sessionId, (stored) => {
    const { next, due } = takenUnreported(sessionOf(stored), sessionId, opened.turn, clock.now());
    queued = turnReportsOf(identity, due, { reason, checks, source });
    const session = next ?? sessionOf(stored);
    const labelable = opened.isCommand ? session.labelable : queued.map(({ report }) => reportedReuseOf(report));
    return { ...session, labelable };
  });
  await reports.enqueue(queued);
  return queued;
}

async function rememberCandidate({ candidates, owner, clock }, sessionId, opened, { reason, record, model }) {
  if (opened.isCommand || skipReason(reason, record)) return;
  const candidate = candidateOf({ prompt: opened.prompt, record, model, turn: opened.turn, pid: owner.current(), now: clock.now() });
  await candidates.update((pending) => withCandidate(pending, sessionId, candidate));
}

/**
 * Closes the open turn (only `turnId`, when given) with how it ended — 'answer', 'aborted', 'refusal' or 'error' —
 * and what it did: `recordOf(openedTurn)` when the host keeps its own record (a transcript), else the tool notes. Every injection of
 * the turn is reported with that evidence, its reuses wait for the next prompt's label, its edits for the next
 * session's retention check, and a verified turn becomes the session's distillation candidate. Null when no such
 * turn was open.
 */
export async function turnEnded(ports, { sessionId, turnId, reason, answer = '', model = null, projectDir, recordOf = null, source = OBSERVED }) {
  const opened = await closeTurn(ports, sessionId, turnId);
  if (!opened) return null;
  const notes = await ports.notes.take(sessionId);
  const record = (await recordOf?.(opened)) ?? turnRecordOf(notes.notes);
  const finished = { ...record, answer: String(answer ?? '').trim() };
  const edits = await ports.baseline.take(sessionId);
  const queued = await reportTurn(ports, sessionId, opened, { reason, checks: finished.checks, source });
  const reuses = queued.map(({ report }) => reportedReuseOf(report));
  await ports.retention.remember({ sessionId, projectDir, reuses, editedBefore: edits.before });
  await notes.commit();
  await edits.commit();
  await rememberCandidate(ports, sessionId, opened, { reason, record: finished, model });
  await ports.sessions.update(sessionId, (stored) => ({ ...sessionOf(stored), settling: false }));
  if (queued.length > 0) ports.scheduler.schedule([TASKS.DRAIN]);
  return { turn: opened.turn, record: finished, reports: queued.map(({ report }) => report) };
}

/**
 * Before a new prompt: waits up to `settleMs` for the last turn to finish closing, for hosts that send the next
 * prompt before the last turn's end, then closes a turn that is still open as `as` (it never got an end event).
 */
export async function closeUnfinishedTurn(ports, { sessionId, settleMs = 0, as = 'error', projectDir }) {
  const deadline = ports.clock.now() + settleMs;
  while (!isSettled(sessionOf(await ports.sessions.read(sessionId))) && ports.clock.now() < deadline) {
    await ports.clock.sleep(SETTLE_POLL_MS);
  }
  if (sessionOf(await ports.sessions.read(sessionId)).open) await turnEnded(ports, { sessionId, reason: as, projectDir });
}
