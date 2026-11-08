// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { hasUnknownChecks } from '../checks.js';
import { gateOf } from '../distill/gate.js';
import { baseFor, rangeOf, withSessionActivity, withWorkTurn, withoutWorkTurn } from '../distill/range.js';
import { isWorkTurn, workTurnOf } from '../distill/work-turn.js';
import { reportedReuseOf } from '../reuse.js';
import { awaitsNativeTerminal, closedTurn, isCorrected, isSettling, markedReported, observedNativeTurn, sessionOf, settledSession, unreportedOf } from '../session/state.js';
import { trialControlEntriesOf } from '../trial-control.js';
import { turnRecordOf } from '../turn/record.js';
import { scheduleDueDistillation } from './distill-session.js';
import { TASKS } from './ports.js';
import { OBSERVED, taskSessionId, turnReportsOf } from './turn-reports.js';

const SETTLE_POLL_MS = 100;
// How long, from the moment the last turn began closing, a prompt waits for that turn's end to finish writing, so a
// correction lands on a work turn that exists.
const SETTLING_WAIT_MS = 2_000;

const matchesTurn = (session, expected) => !expected || (session.turn === expected.turn && session.pid === expected.pid && session.sessionEpoch === expected.sessionEpoch);

const hasDeferredTurn = (session, opened) => {
  const stored = observedNativeTurn(session, opened.turn);
  return session.turn > opened.turn && stored && matchesTurn(stored, opened) && stored.native.turnId === opened.turnId;
};

const canKeepTurn = (session, opened) => session.sessionEpoch === opened.sessionEpoch
  && (session.turn > opened.turn || matchesTurn(session, opened)) && !isCorrected(session, opened.turn);

function dropWorkTurn(ports, sessionId, opened, expected) {
  return ports.candidates.update((pending) => {
    if (expected && !rangeOf(pending, sessionId)?.turns.some((turn) => turn.turn === opened.turn && turn.sessionEpoch === opened.sessionEpoch)) return undefined;
    return withoutWorkTurn(pending, sessionId, opened.turn, { sessionEpoch: opened.sessionEpoch, now: ports.clock.now() });
  });
}

async function closeTurn({ sessions, clock }, sessionId, turnId, expected) {
  let opened = null;
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    if (!matchesTurn(session, expected)) return undefined;
    const now = clock.now();
    const result = closedTurn(session, turnId, now);
    opened = result.opened && { ...result.opened, settling: now };
    return result.next;
  });
  return opened;
}

// Reports are queued before their injections are marked reported, so a hook killed in between leaves an injection
// reported twice, which the outbox keys away, rather than never.
// A retry finds no open turn. Controls that could not be queued wait in the session for the next turn or session end.
async function reportTurn({ identity, sessions, reports, clock }, sessionId, opened, { reason, checks, source, expected, deferred }) {
  const current = sessionOf(await sessions.read(sessionId));
  if ((expected && current.sessionEpoch !== opened.sessionEpoch) || (deferred && !hasDeferredTurn(current, opened))) {
    return { queued: [], controls: 0, strategies: [] };
  }
  const unreported = unreportedOf(current, sessionId, opened.turn, { includeDeferred: Boolean(expected) });
  const due = expected ? unreported.filter((asset) => asset.turn === opened.turn) : unreported;
  const queued = turnReportsOf(identity, due, { reason, checks, source });
  const controls = [...current.pendingControls, ...trialControlsOf(identity, current, sessionId, opened, checks)];
  try {
    await reports.enqueue([...queued, ...controls]);
  } catch (error) {
    await sessions.update(sessionId, (stored) => {
      const session = sessionOf(stored);
      if (expected && session.sessionEpoch !== opened.sessionEpoch) return undefined;
      return withPendingControls(session, controls);
    });
    throw error;
  }
  await sessions.update(sessionId, (stored) => {
    const previous = sessionOf(stored);
    if (expected && previous.sessionEpoch !== opened.sessionEpoch) return undefined;
    const session = markedReported(previous, due, clock.now()) ?? previous;
    const labelable = opened.isCommand || (expected && (!matchesTurn(session, expected) || isCorrected(session, opened.turn)))
      ? session.labelable : queued.map(({ report }) => reportedReuseOf(report));
    return { ...withoutPendingControls(session, controls), labelable };
  });
  return { queued, controls: controls.length, strategies: due.map((asset) => asset.strategyText) };
}

// Keyed by withholding, so overlapping turn ends keep each other's pending controls.
const controlKeyOf = ({ report }) => report.withheld_id;

function withPendingControls(session, controls) {
  const known = new Set(session.pendingControls.map(controlKeyOf));
  return { ...session, pendingControls: [...session.pendingControls, ...controls.filter((control) => !known.has(controlKeyOf(control)))] };
}

export function withoutPendingControls(session, queuedControls) {
  const queued = new Set(queuedControls.map(controlKeyOf));
  return { ...session, pendingControls: session.pendingControls.filter((control) => !queued.has(controlKeyOf(control))) };
}

function trialControlsOf(identity, { injected }, sessionId, opened, checks) {
  const injectedIds = new Set(Object.keys(injected).filter((assetId) => injected[assetId].turn === opened.turn));
  return trialControlEntriesOf({
    platform: identity.agent, taskSessionId: taskSessionId(identity, sessionId), sessionId, turn: opened.turn, withheld: opened.withheld ?? [], injectedIds, checks,
  });
}

async function snapshotIfReadable(project, projectDir, base) {
  try {
    return await project.snapshot(projectDir, { base: base?.head ?? null });
  } catch {
    return null;
  }
}

/**
 * A work turn joins the session's range, with the work tree its checks ran on: its diff against the commit the range
 * began on, taken now, while it is the tree the last check saw.
 */
export const isNativeWorkTurn = (reason, record) => (reason === 'answer' || reason === 'error') && !hasUnknownChecks(record) && isWorkTurn(record);

const keepsWork = ({ native }, { reason, record, expected }) => expected ? isNativeWorkTurn(reason, record) : !native && isWorkTurn(record);

async function rememberWorkTurn(ports, sessionId, opened, { reason, record, model, projectDir, source, expected, allowNewCandidate = true, finalizationPending = false, deferred = false }) {
  const { candidates, sessions, owner, clock, project, native } = ports;
  if (opened.isCommand || !keepsWork(ports, { reason, record, expected })) return false;
  const workTurn = { ...workTurnOf({ turn: opened.turn, prompt: opened.prompt, record, answer: record.answer, head: opened.turnHead, now: clock.now() }),
    ...(opened.sessionEpoch !== undefined && { sessionEpoch: opened.sessionEpoch }), ...(finalizationPending && { finalizationPending: true }) };
  const planned = baseFor(await candidates.read(), sessionId, workTurn);
  const snapshot = projectDir && !deferred ? await snapshotIfReadable(project, projectDir, planned) : null;
  const canKeep = (session) => canKeepTurn(sessionOf(session), opened) && (!deferred || hasDeferredTurn(session, opened));
  if (expected && !canKeep(await sessions.read(sessionId))) return false;
  const base = planned ?? (snapshot?.head ? { root: snapshot.root, head: snapshot.head } : null);
  const context = { base, project: snapshot, projectDir: projectDir ?? null, model, sessionEpoch: opened.sessionEpoch,
    pid: expected ? expected.pid : owner.current(), native: Boolean(native || expected), source, now: clock.now() };
  const saved = await candidates.update((pending) => {
    const range = rangeOf(pending, sessionId);
    const turns = range?.turns ?? [];
    const laterTurn = turns.some((turn) => turn.sessionEpoch === opened.sessionEpoch && turn.turn > opened.turn);
    if (expected) {
      const sameTurn = turns.some((turn) => turn.turn === opened.turn && turn.sessionEpoch === opened.sessionEpoch);
      if ((!allowNewCandidate && !sameTurn) || (!deferred && laterTurn)
        || turns.some((turn) => turn.sessionEpoch > opened.sessionEpoch)) return undefined;
    }
    return withWorkTurn(pending, sessionId, workTurn, { ...context, beforeNewerTurn: deferred && laterTurn });
  });
  if (saved && expected && !canKeep(await sessions.read(sessionId))) {
    await dropWorkTurn(ports, sessionId, opened, expected);
    return false;
  }
  return expected ? Boolean(saved) : true;
}

const settleTurn = (ports, sessionId, opened) => ports.sessions.update(sessionId, (stored) => {
  const current = sessionOf(stored);
  return matchesTurn(current, opened) && current.settling === opened.settling ? settledSession(current) : undefined;
});

// A turn read from the host's own record can run again after its end without a new prompt (a background command
// finished); its reports went out and stay, but its place in the range is judged again on the whole turn: kept, with
// any correction it got, when it still did work, else taken out. An agent's report is its record, so a second one is
// a retry and changes nothing. The re-judge marks the session settling while it writes, like a first turn end, so a
// correction that arrives meanwhile waits for it.
async function rejudgeWorkTurn(ports, sessionId, turnId, { reason, answer, model, projectDir, recordOf, expected, allowNewCandidate, finalizationPending }) {
  let session = null;
  await ports.sessions.update(sessionId, (stored) => {
    const current = sessionOf(stored);
    if (current.open || current.isCommand || current.turnId !== turnId || !matchesTurn(current, expected)
      || (expected && isSettling(current, ports.clock.now()))) return undefined;
    session = { ...current, settling: ports.clock.now() };
    return session;
  });
  if (!session) return;
  try {
    const record = await recordOf(session);
    const finished = { ...record, answer: String(answer || record.answer || '').trim() };
    if (keepsWork(ports, { reason, record: finished, expected })) {
      await rememberWorkTurn(ports, sessionId, session, { reason, record: finished, model, projectDir, source: OBSERVED, expected, allowNewCandidate, finalizationPending });
    } else if (expected || !ports.native) {
      await dropWorkTurn(ports, sessionId, session, expected);
    }
  } finally {
    await settleTurn(ports, sessionId, session);
  }
}

const isDistillableIn = (pending, sessionId) => gateOf(rangeOf(pending, sessionId)?.turns ?? []).passed;

/**
 * Closes the open turn (only `turnId`, when given) with how it ended — 'answer', 'aborted', 'refusal' or 'error' —
 * and what it did: `recordOf(openedTurn)` when the host keeps its own record (a transcript), else the tool notes. Every
 * injection of the turn is reported with that evidence, a trial Gene the Proxy withheld from it is reported as a
 * control, its reuses wait for the next prompt's label, its edits for the next session's retention check, and a work
 * turn joins the session's range for distillation; `isDistillable` says the range passes the gate now. `strategies`
 * holds the text of each strategy it reported. Null when no such turn was open.
 */
async function recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, recordOf, source, expected, allowNewCandidate, finalizationPending }) {
  const notes = await ports.notes.take(sessionId);
  const ofThisTurn = (entry) => !entry.turnId || !opened.turnId || entry.turnId === opened.turnId;
  const record = (await recordOf?.(opened)) ?? turnRecordOf(notes.notes.filter(ofThisTurn));
  const finished = { ...record, answer: String(answer || record.answer || '').trim() };
  const edits = await ports.baseline.take(sessionId, opened.turnId);
  const { queued, controls, strategies } = await reportTurn(ports, sessionId, opened, { reason, checks: finished.checks, source, expected });
  const reuses = queued.map(({ report }) => reportedReuseOf(report));
  await ports.retention.remember({ sessionId, projectDir, reuses, editedBefore: edits.before });
  await notes.commit();
  await edits.commit();
  const isWork = await rememberWorkTurn(ports, sessionId, opened, { reason, record: finished, model, projectDir, source, expected, allowNewCandidate, finalizationPending });
  if (!isWork && !expected) await ports.candidates.update((pending) => withSessionActivity(pending, sessionId, ports.clock.now()));
  const isDistillable = isWork && !finalizationPending && isDistillableIn(await ports.candidates.read(), sessionId);
  return { turn: opened.turn, record: finished, reports: queued.map(({ report }) => report), strategies, isDistillable, ...(expected && { isCandidate: isWork }), controls };
}

/** A native record for a retained turn uses only its own evidence and captured route. */
export async function finishDeferredNativeTurn(ports, sessionId, opened, { reason, record, model }) {
  const { queued, controls } = await reportTurn(ports, sessionId, opened, {
    reason, checks: record.checks, source: OBSERVED, expected: opened, deferred: true,
  });
  const isCandidate = await rememberWorkTurn(ports, sessionId, opened, {
    reason, record, model, projectDir: opened.native.payload?.cwd, source: OBSERVED, expected: opened,
    deferred: true, allowNewCandidate: !opened.native.candidateMade, finalizationPending: true,
  });
  if (queued.length || controls) await scheduleDueDistillation(ports, [TASKS.DRAIN]);
  return { turn: opened.turn, reports: queued.map(({ report }) => report), isCandidate };
}

export async function turnEnded(ports, { sessionId, turnId, reason, answer = '', model = null, projectDir, recordOf = null, source = OBSERVED, expected, allowNewCandidate, finalizationPending }) {
  const opened = await closeTurn(ports, sessionId, turnId, expected);
  if (!opened) {
    if (!(turnId && recordOf && source === OBSERVED)) return null;
    await rejudgeWorkTurn(ports, sessionId, turnId, { reason, answer, model, projectDir, recordOf, expected, allowNewCandidate, finalizationPending });
    await scheduleDueDistillation(ports);
    return null;
  }
  let ended;
  try {
    ended = await recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, recordOf, source, expected, allowNewCandidate, finalizationPending });
  } finally {
    await settleTurn(ports, sessionId, opened);
  }
  const { controls, ...result } = ended;
  await scheduleDueDistillation(ports, result.reports.length > 0 || controls > 0 ? [TASKS.DRAIN] : []);
  return result;
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
  const session = await settledSessionOf(ports, sessionId, settleMs);
  if (session.open && !(ports.native && awaitsNativeTerminal(session))) {
    await turnEnded(ports, { sessionId, reason: as, projectDir, recordOf });
  }
}

/** The session once its last turn's end has had its chance to arrive (up to `settleMs`) and finish writing. */
export async function settledSessionOf(ports, sessionId, settleMs = 0) {
  const openUntil = ports.clock.now() + settleMs;
  while (isWorthWaiting(sessionOf(await ports.sessions.read(sessionId)), ports.clock.now(), openUntil)) {
    await ports.clock.sleep(SETTLE_POLL_MS);
  }
  return sessionOf(await ports.sessions.read(sessionId));
}
