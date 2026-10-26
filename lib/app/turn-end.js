// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { candidateOf, skipReason, withCandidate, withoutTurnCandidate } from '../distill/candidate.js';
import { reportedReuseOf } from '../reuse.js';
import { closedTurn, isSettling, markedReported, sessionOf, settledSession, unreportedOf } from '../session/state.js';
import { turnRecordOf } from '../turn/record.js';
import { TASKS } from './ports.js';
import { OBSERVED, turnReportsOf } from './turn-reports.js';

const SETTLE_POLL_MS = 100;
// How long, from the moment the last turn began closing, a prompt waits for that turn's end to finish writing, so a
// correction drops a candidate that exists.
const SETTLING_WAIT_MS = 2_000;

async function closeTurn({ sessions, clock }, sessionId, turnId) {
  let opened = null;
  await sessions.update(sessionId, (stored) => {
    const result = closedTurn(sessionOf(stored), turnId, clock.now());
    opened = result.opened;
    return result.next;
  });
  return opened;
}

// Reports are queued before their injections are marked reported, so a hook killed in between leaves an injection
// reported twice, which the outbox keys away, rather than never.
async function reportTurn({ identity, sessions, reports, clock }, sessionId, opened, { reason, checks, source }) {
  const due = unreportedOf(sessionOf(await sessions.read(sessionId)), sessionId, opened.turn);
  const queued = turnReportsOf(identity, due, { reason, checks, source });
  await reports.enqueue(queued);
  await sessions.update(sessionId, (stored) => {
    const session = markedReported(sessionOf(stored), due, clock.now()) ?? sessionOf(stored);
    const labelable = opened.isCommand ? session.labelable : queued.map(({ report }) => reportedReuseOf(report));
    return { ...session, labelable };
  });
  return queued;
}

async function rememberCandidate({ candidates, owner, clock }, sessionId, opened, { reason, record, model }) {
  if (opened.isCommand || skipReason(reason, record)) return false;
  const candidate = candidateOf({ prompt: opened.prompt, record, model, turn: opened.turn, pid: owner.current(), now: clock.now() });
  await candidates.update((pending) => withCandidate(pending, sessionId, candidate));
  return true;
}

// A turn can run again after its end without a new prompt (a background command finished); its reports went out and
// stay, but its candidate is judged again on the whole turn: written when it still ended verified, else dropped.
// The re-judge marks the session settling while it writes, like a first turn end, so a correction that arrives
// meanwhile waits for it and then drops what it wrote.
async function rejudgeCandidate(ports, sessionId, turnId, { reason, answer, model, recordOf }) {
  let session = null;
  await ports.sessions.update(sessionId, (stored) => {
    const current = sessionOf(stored);
    if (current.open || current.isCommand || current.turnId !== turnId) return undefined;
    session = current;
    return { ...current, settling: ports.clock.now() };
  });
  if (!session) return;
  try {
    const record = await recordOf(session);
    const finished = { ...record, answer: String(answer || record.answer || '').trim() };
    if (skipReason(reason, finished)) await ports.candidates.update((pending) => withoutTurnCandidate(pending, sessionId, session.turn));
    else await rememberCandidate(ports, sessionId, session, { reason, record: finished, model });
  } finally {
    await ports.sessions.update(sessionId, (stored) => settledSession(sessionOf(stored)));
  }
}

/**
 * Closes the open turn (only `turnId`, when given) with how it ended — 'answer', 'aborted', 'refusal' or 'error' —
 * and what it did: `recordOf(openedTurn)` when the host keeps its own record (a transcript), else the tool notes. Every injection of
 * the turn is reported with that evidence, its reuses wait for the next prompt's label, its edits for the next
 * session's retention check, and a verified turn becomes the session's distillation candidate (`isCandidate`). Null
 * when no such turn was open.
 */
export async function turnEnded(ports, { sessionId, turnId, reason, answer = '', model = null, projectDir, recordOf = null, source = OBSERVED }) {
  const opened = await closeTurn(ports, sessionId, turnId);
  if (!opened) {
    if (turnId && recordOf) await rejudgeCandidate(ports, sessionId, turnId, { reason, answer, model, recordOf });
    return null;
  }
  const notes = await ports.notes.take(sessionId);
  const record = (await recordOf?.(opened)) ?? turnRecordOf(notes.notes);
  const finished = { ...record, answer: String(answer || record.answer || '').trim() };
  const edits = await ports.baseline.take(sessionId);
  const queued = await reportTurn(ports, sessionId, opened, { reason, checks: finished.checks, source });
  const reuses = queued.map(({ report }) => reportedReuseOf(report));
  await ports.retention.remember({ sessionId, projectDir, reuses, editedBefore: edits.before });
  await notes.commit();
  await edits.commit();
  const isCandidate = await rememberCandidate(ports, sessionId, opened, { reason, record: finished, model });
  await ports.sessions.update(sessionId, (stored) => settledSession(sessionOf(stored)));
  if (queued.length > 0) ports.scheduler.schedule([TASKS.DRAIN]);
  return { turn: opened.turn, record: finished, reports: queued.map(({ report }) => report), isCandidate };
}

function isWorthWaiting(session, now, openUntil) {
  if (session.open) return now < openUntil;
  return isSettling(session, now) && now < session.settling + SETTLING_WAIT_MS;
}

/**
 * Before a new prompt: waits while the last turn's end is still writing (a bounded while), and up to `settleMs` for
 * a host that sends the next prompt before the last turn's end, then closes a turn still open as `as`: it never got
 * an end event. `recordOf` judges it on the host's own record, as its end would have.
 */
export async function closeUnfinishedTurn(ports, { sessionId, settleMs = 0, as = 'error', projectDir, recordOf = null }) {
  if ((await settledSessionOf(ports, sessionId, settleMs)).open) await turnEnded(ports, { sessionId, reason: as, projectDir, recordOf });
}

/** The session once its last turn's end has had its chance to arrive (up to `settleMs`) and finish writing. */
export async function settledSessionOf(ports, sessionId, settleMs = 0) {
  const openUntil = ports.clock.now() + settleMs;
  while (isWorthWaiting(sessionOf(await ports.sessions.read(sessionId)), ports.clock.now(), openUntil)) {
    await ports.clock.sleep(SETTLE_POLL_MS);
  }
  return sessionOf(await ports.sessions.read(sessionId));
}
