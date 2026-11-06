// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { candidateOf, skipReason, withCandidate, withRejudgedCandidate, withSessionActivity, withoutTurnCandidate } from '../distill/candidate.js';
import { reportedReuseOf } from '../reuse.js';
import { closedTurn, isCorrected, isSettling, markedReported, sessionOf, settledSession, unreportedOf } from '../session/state.js';
import { turnRecordOf } from '../turn/record.js';
import { scheduleDueDistillation } from './distill-session.js';
import { TASKS } from './ports.js';
import { OBSERVED, turnReportsOf } from './turn-reports.js';

const SETTLE_POLL_MS = 100;
// How long, from the moment the last turn began closing, a prompt waits for that turn's end to finish writing, so a
// correction drops a candidate that exists.
const SETTLING_WAIT_MS = 2_000;

const matchesTurn = (session, expected) => !expected || (session.turn === expected.turn && session.pid === expected.pid && session.sessionEpoch === expected.sessionEpoch);

function dropCandidate(ports, sessionId, opened, expected) {
  return ports.candidates.update(pending => {
    if (expected && pending[sessionId]?.sessionEpoch !== opened.sessionEpoch) return undefined;
    return withoutTurnCandidate(pending, sessionId, opened.turn);
  });
}

async function closeTurn({ sessions, clock }, sessionId, turnId, expected) {
  let opened = null;
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    if (!matchesTurn(session, expected)) return undefined;
    const now = clock.now();
    const result = closedTurn(session, turnId, now);
    opened = expected && result.opened ? { ...result.opened, settling: now } : result.opened;
    return result.next;
  });
  return opened;
}

// Reports are queued before their injections are marked reported, so a hook killed in between leaves an injection
// reported twice, which the outbox keys away, rather than never.
async function reportTurn({ identity, sessions, reports, clock }, sessionId, opened, { reason, checks, source, expected }) {
  const current = sessionOf(await sessions.read(sessionId));
  if (expected && current.sessionEpoch !== opened.sessionEpoch) return { queued: [], strategies: [] };
  const unreported = unreportedOf(current, sessionId, opened.turn);
  const due = expected ? unreported.filter(asset => asset.turn === opened.turn) : unreported;
  const queued = turnReportsOf(identity, due, { reason, checks, source });
  await reports.enqueue(queued);
  await sessions.update(sessionId, (stored) => {
    const previous = sessionOf(stored);
    if (expected && previous.sessionEpoch !== opened.sessionEpoch) return undefined;
    const session = markedReported(previous, due, clock.now()) ?? previous;
    const labelable = opened.isCommand || (expected && (!matchesTurn(session, expected) || isCorrected(session, opened.turn)))
      ? session.labelable : queued.map(({ report }) => reportedReuseOf(report));
    return { ...session, labelable };
  });
  return { queued, strategies: due.map((asset) => asset.strategyText) };
}

async function snapshotIfReadable(project, projectDir) {
  try {
    return await project.snapshot(projectDir);
  } catch {
    return null;
  }
}

async function rememberCandidate({ candidates, sessions, owner, clock, project }, sessionId, opened, { reason, record, model, projectDir, source, written = withCandidate, expected, allowNewCandidate = true, finalizationPending = false }) {
  if (opened.isCommand || skipReason(reason, record)) return false;
  const snapshot = projectDir ? await snapshotIfReadable(project, projectDir) : null;
  if (expected) {
    const session = sessionOf(await sessions.read(sessionId));
    if (session.sessionEpoch !== opened.sessionEpoch || isCorrected(session, opened.turn)) return false;
  }
  const candidate = candidateOf({ prompt: opened.prompt, record, model, turn: opened.turn, sessionEpoch: opened.sessionEpoch, pid: expected ? expected.pid : owner.current(), now: clock.now(), source, project: snapshot, finalizationPending });
  const saved = await candidates.update((pending) => {
    const current = pending[sessionId];
    const sameTurn = current?.turn === opened.turn && current.sessionEpoch === opened.sessionEpoch;
    const newer = current && ((current.sessionEpoch ?? 0) > (opened.sessionEpoch ?? 0)
      || (current.sessionEpoch === opened.sessionEpoch && current.turn > opened.turn));
    if (expected && (newer || (!allowNewCandidate && !sameTurn))) return undefined;
    return written(pending, sessionId, candidate);
  });
  return expected ? Boolean(saved) : true;
}

const settleTurn = (ports, sessionId, opened, expected) => ports.sessions.update(sessionId, stored => {
  const current = sessionOf(stored);
  return matchesTurn(current, expected) && (!expected || current.settling === opened.settling) ? settledSession(current) : undefined;
});

// A turn read from the host's own record can run again after its end without a new prompt (a background command
// finished); its reports went out and stay, but its candidate is judged again on the whole turn: kept when it still
// ended verified, else dropped. An agent's report is its record, so a second one is a retry and changes nothing.
// The re-judge marks the session settling while it writes, like a first turn end, so a correction that arrives
// meanwhile waits for it and then drops what it wrote; one already past that wait has marked the session corrected
// before dropping, so the re-judge, checking the mark after its write, takes the write back.
async function rejudgeCandidate(ports, sessionId, turnId, { reason, answer, model, projectDir, recordOf, expected, allowNewCandidate, finalizationPending }) {
  let session = null;
  await ports.sessions.update(sessionId, (stored) => {
    const current = sessionOf(stored);
    if (current.open || current.isCommand || current.turnId !== turnId || !matchesTurn(current, expected)
        || (expected && isSettling(current, ports.clock.now()))) return undefined;
    const next = { ...current, settling: ports.clock.now() };
    session = expected ? next : current;
    return next;
  });
  if (!session) return;
  try {
    const record = await recordOf(session);
    const finished = { ...record, answer: String(answer || record.answer || '').trim() };
    const drop = () => dropCandidate(ports, sessionId, session, expected);
    if (skipReason(reason, finished)) await drop();
    else await rememberCandidate(ports, sessionId, session, { reason, record: finished, model, projectDir, source: OBSERVED, written: withRejudgedCandidate, expected, allowNewCandidate, finalizationPending });
    const current = sessionOf(await ports.sessions.read(sessionId));
    if (isCorrected(current, session.turn) || (expected && current.sessionEpoch !== session.sessionEpoch)) await drop();
  } finally {
    await settleTurn(ports, sessionId, session, expected);
  }
}

/**
 * Closes the open turn (only `turnId`, when given) with how it ended — 'answer', 'aborted', 'refusal' or 'error' —
 * and what it did: `recordOf(openedTurn)` when the host keeps its own record (a transcript), else the tool notes. Every injection of
 * the turn is reported with that evidence, its reuses wait for the next prompt's label, its edits for the next
 * session's retention check, and a verified turn becomes the session's distillation candidate (`isCandidate`);
 * `strategies` holds the text of each strategy it reported. Null when no such turn was open.
 */
async function recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, recordOf, source, expected, allowNewCandidate, finalizationPending }) {
  const notes = await ports.notes.take(sessionId);
  const ofThisTurn = (entry) => !entry.turnId || !opened.turnId || entry.turnId === opened.turnId;
  const record = (await recordOf?.(opened)) ?? turnRecordOf(notes.notes.filter(ofThisTurn));
  const finished = { ...record, answer: String(answer || record.answer || '').trim() };
  const edits = await ports.baseline.take(sessionId, opened.turnId);
  const { queued, strategies } = await reportTurn(ports, sessionId, opened, { reason, checks: finished.checks, source, expected });
  const reuses = queued.map(({ report }) => reportedReuseOf(report));
  await ports.retention.remember({ sessionId, projectDir, reuses, editedBefore: edits.before });
  await notes.commit();
  await edits.commit();
  let isCandidate = await rememberCandidate(ports, sessionId, opened, { reason, record: finished, model, projectDir, source, expected, allowNewCandidate, finalizationPending });
  if (isCandidate && expected) {
    const session = sessionOf(await ports.sessions.read(sessionId));
    if (session.sessionEpoch !== opened.sessionEpoch || isCorrected(session, opened.turn)) {
      await dropCandidate(ports, sessionId, opened, expected);
      isCandidate = false;
    }
  }
  if (!isCandidate) await ports.candidates.update((pending) => {
    const current = pending[sessionId];
    if (expected && current && (current.sessionEpoch !== opened.sessionEpoch || current.turn > opened.turn)) return undefined;
    return withSessionActivity(pending, sessionId, ports.clock.now());
  });
  return { turn: opened.turn, record: finished, reports: queued.map(({ report }) => report), strategies, isCandidate };
}

export async function turnEnded(ports, { sessionId, turnId, reason, answer = '', model = null, projectDir, recordOf = null, source = OBSERVED, expected, allowNewCandidate, finalizationPending }) {
  const opened = await closeTurn(ports, sessionId, turnId, expected);
  if (!opened) {
    if (!(turnId && recordOf && source === OBSERVED)) return null;
    await rejudgeCandidate(ports, sessionId, turnId, { reason, answer, model, projectDir, recordOf, expected, allowNewCandidate, finalizationPending });
    await scheduleDueDistillation(ports);
    return null;
  }
  let ended;
  try {
    ended = await recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, recordOf, source, expected, allowNewCandidate, finalizationPending });
  } finally {
    await settleTurn(ports, sessionId, opened, expected);
  }
  await scheduleDueDistillation(ports, ended.reports.length > 0 ? [TASKS.DRAIN] : []);
  return ended;
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
