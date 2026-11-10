// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { hasUnknownChecks, verdictOf } from '../checks.js';
import { gateOf } from '../distill/gate.js';
import { baseFor, rangeOf, withSessionActivity, withWorkTurn, withoutWorkTurn } from '../distill/range.js';
import { isWorkTurn, workTurnOf } from '../distill/work-turn.js';
import { reportedReuseOf } from '../reuse.js';
import {
  awaitsNativeTerminal, closedTurn, isCorrected, isSettling, markedReported, observedNativeTurn, pendingReportsOf, sessionOf, settledSession, unreportedOf,
  withPendingReports,
} from '../session/state.js';
import { trialControlEntriesOf } from '../trial-control.js';
import { reasonOfNativeStatus } from '../turn-outcomes.js';
import { turnRecordOf } from '../turn/record.js';
import { scheduleDueDistillation } from './distill-session.js';
import { TASKS } from './ports.js';
import { OBSERVED, taskSessionId, turnReportsOf } from './turn-reports.js';

const SETTLE_POLL_MS = 100;
// How long, from the moment the last turn began closing, a prompt waits for that turn's end to finish writing, so a
// correction lands on a work turn that exists.
const SETTLING_WAIT_MS = 2_000;

const sameTurn = (session, expected) => session.turnId === expected.turnId && session.turn === expected.turn && session.sessionEpoch === expected.sessionEpoch;
// A native observer binds its turn id after the prompt, so it names its turn by number, owner and epoch.
const matchesTurn = (session, expected) => !expected
  || (session.turn === expected.turn && session.pid === expected.pid && session.sessionEpoch === expected.sessionEpoch);

const hasDeferredTurn = (session, opened) => {
  const stored = observedNativeTurn(session, opened.turn);
  return session.turn > opened.turn && stored && matchesTurn(stored, opened) && stored.native.turnId === opened.turnId;
};

const canKeepTurn = (session, opened) => session.sessionEpoch === opened.sessionEpoch
  && (session.turn > opened.turn || matchesTurn(session, opened)) && !isCorrected(session, opened.turn);

function dropWorkTurn(ports, sessionId, opened, expected) {
  return ports.candidates.update((pending) => {
    const range = rangeOf(pending, sessionId);
    const known = range?.turns.some((turn) => turn.turn === opened.turn && turn.sessionEpoch === opened.sessionEpoch);
    if (expected ? !known : range?.sessionEpoch !== opened.sessionEpoch) return undefined;
    return withoutWorkTurn(pending, sessionId, opened.turn, { sessionEpoch: opened.sessionEpoch, now: ports.clock.now() });
  });
}

async function closeTurn({ sessions, clock }, sessionId, turnId, { expectedTurn, expected } = {}) {
  let opened = null;
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    if ((expectedTurn && !sameTurn(session, expectedTurn)) || !matchesTurn(session, expected)) return undefined;
    const now = clock.now();
    const result = closedTurn(session, turnId, now);
    opened = result.opened && { ...result.opened, settling: now };
    return result.next;
  });
  return opened;
}

const settleTurn = (ports, sessionId, opened) => ports.sessions.update(sessionId, (stored) => {
  const current = sessionOf(stored);
  return sameTurn(current, opened) && current.settling === opened.settling ? settledSession(current) : undefined;
});

// Reports are queued before their injections are marked reported, so a hook killed in between leaves an injection
// reported twice, which the outbox keys away, rather than never.
// Controls that could not be queued wait in the session for the next turn or session end. Hosts that accept inferred
// completion also retry unreported injections at the next turn end.
async function reportTurn(ports, sessionId, opened, { reason, checks, source, verified, expected, deferred }) {
  const { identity, sessions, reports, clock, confirmTurnCompletion } = ports;
  const session = sessionOf(await sessions.read(sessionId));
  if (session.sessionEpoch !== opened.sessionEpoch || (deferred && !hasDeferredTurn(session, opened))) {
    return { queued: [], controls: 0, strategies: [] };
  }
  // Native evidence covers exactly the turn that produced it.
  const ownTurnOnly = confirmTurnCompletion || Boolean(expected);
  const due = verified ? unreportedOf(session, sessionId, opened.turn, { includeDeferred: Boolean(expected) })
    .filter((asset) => !ownTurnOnly || asset.turn === opened.turn) : [];
  const queued = turnReportsOf(identity, due, { reason, checks, source });
  const retries = confirmTurnCompletion ? pendingReportsOf(session, sessionId, opened.turn - 1) : [];
  const controls = [...session.pendingControls, ...(verified ? trialControlsOf(identity, session, sessionId, opened, checks) : [])];
  try {
    await reports.enqueue([...retries.map(({ entry }) => entry), ...queued, ...controls]);
  } catch (error) {
    await sessions.update(sessionId, (stored) => {
      const current = sessionOf(stored);
      if (current.sessionEpoch !== opened.sessionEpoch) return undefined;
      const pending = confirmTurnCompletion ? withPendingReports(current, due, queued) : current;
      return withPendingControls(pending, controls);
    });
    throw error;
  }
  await sessions.update(sessionId, (stored) => {
    const current = sessionOf(stored);
    if (current.sessionEpoch !== opened.sessionEpoch) return undefined;
    const session = markedReported(current, [...due, ...retries.map(({ asset }) => asset)], clock.now()) ?? current;
    const isReplaced = !sameTurn(session, opened) || (expected && (!matchesTurn(session, expected) || isCorrected(session, opened.turn)));
    if (isReplaced) return withoutPendingControls(session, controls);
    const labelable = opened.isCommand ? session.labelable : queued.map(({ report }) => reportedReuseOf(report));
    return { ...withoutPendingControls(session, controls), labelable };
  });
  return { queued, controls: controls.length + retries.length, strategies: due.map((asset) => asset.strategyText) };
}

// Keyed by withholding, so turn ends that overlap neither drop each other's pending controls nor queue one twice.
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

// A range captured on one account must never be sent to a later turn's model route.
function canJoinRange(range, model) {
  if (!range) return true;
  return Boolean(model?.configDigest && model.selection && model.configDigest === range.model?.configDigest
    && JSON.stringify(model.selection) === JSON.stringify(range.model.selection));
}

const rangeInEpoch = (pending, sessionId, epoch) => {
  const range = rangeOf(pending, sessionId);
  return range?.sessionEpoch === epoch ? range : undefined;
};

/**
 * A work turn joins the session's range, with the work tree its checks ran on: its diff against the commit the range
 * began on, taken now, while it is the tree the last check saw.
 */
export const isNativeWorkTurn = (reason, record) => (reason === 'answer' || reason === 'error') && !hasUnknownChecks(record) && isWorkTurn(record);

const keepsWork = ({ native }, { reason, record, expected }) => expected ? isNativeWorkTurn(reason, record) : !native && isWorkTurn(record);

function joinedRange(latest, sessionId, workTurn, { opened, prior, expected, deferred, allowNewCandidate, model, modelForTurn, context }) {
  const current = rangeOf(latest, sessionId);
  const sameEpoch = rangeInEpoch(latest, sessionId, opened.sessionEpoch);
  // Only replace a different epoch if it was already present before the snapshot.
  if (current && !sameEpoch && (!prior || current.sessionEpoch !== prior.sessionEpoch) && !expected) return undefined;
  if (modelForTurn && !canJoinRange(sameEpoch, model)) return undefined;
  const turns = current?.turns ?? [];
  const laterTurn = turns.some((turn) => turn.sessionEpoch === opened.sessionEpoch && turn.turn > opened.turn);
  if (expected) {
    const known = turns.some((turn) => turn.turn === opened.turn && turn.sessionEpoch === opened.sessionEpoch);
    if ((!allowNewCandidate && !known) || (!deferred && laterTurn) || turns.some((turn) => turn.sessionEpoch > opened.sessionEpoch)) return undefined;
  }
  return withWorkTurn(latest, sessionId, workTurn, { ...context, beforeNewerTurn: deferred && laterTurn });
}

async function rememberWorkTurn(ports, sessionId, opened, options) {
  const { record, projectDir, source, expected, allowNewCandidate = true, finalizationPending = false, deferred = false } = options;
  const { candidates, owner, clock, project, sessions, native, modelForTurn, confirmTurnCompletion } = ports;
  if (opened.isCommand || !keepsWork(ports, { reason: options.reason, record, expected })) return false;
  const model = options.model ?? modelForTurn?.(sessionId, opened) ?? null;
  const pending = await candidates.read();
  const prior = rangeOf(pending, sessionId);
  const matching = rangeInEpoch(pending, sessionId, opened.sessionEpoch);
  if (modelForTurn && !canJoinRange(matching, model)) return false;
  const workTurn = { ...workTurnOf({ turn: opened.turn, prompt: opened.prompt, record, answer: record.answer, head: opened.turnHead, now: clock.now() }),
    sessionEpoch: opened.sessionEpoch, ...(finalizationPending && { finalizationPending: true }) };
  const planned = matching ? baseFor(pending, sessionId, workTurn) : workTurn.head ?? null;
  const snapshot = projectDir && !deferred ? await snapshotIfReadable(project, projectDir, planned) : null;
  const base = planned ?? (snapshot?.head ? { root: snapshot.root, head: snapshot.head } : null);
  // A detached observer's parent is a hook process, while the open turn carries the native owner.
  const pid = expected?.pid ?? (confirmTurnCompletion ? opened.pid : null) ?? owner.current();
  const context = { base, project: snapshot, projectDir: projectDir ?? null, model, sessionEpoch: opened.sessionEpoch, pid, native: Boolean(native || expected), source, now: clock.now() };
  // If the turn moved to deferred storage during the snapshot, its recovery uses native evidence alone.
  const canKeep = (stored) => canKeepTurn(sessionOf(stored), opened) && Boolean(hasDeferredTurn(sessionOf(stored), opened)) === deferred;
  const latest = await sessions.read(sessionId);
  if (sessionOf(latest).sessionEpoch !== opened.sessionEpoch || (expected && !canKeep(latest))) return false;
  const saved = await candidates.update((table) => joinedRange(table, sessionId, workTurn, { opened, prior, expected, deferred, allowNewCandidate, model, modelForTurn, context }));
  if (saved && expected && !canKeep(await sessions.read(sessionId))) {
    await dropWorkTurn(ports, sessionId, opened, expected);
    return false;
  }
  return Boolean(saved);
}

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
    const keeps = keepsWork(ports, { reason, record: finished, expected });
    const kept = keeps && await rememberWorkTurn(ports, sessionId, session, {
      reason, record: finished, model, projectDir, source: OBSERVED, expected, allowNewCandidate, finalizationPending,
    });
    if (expected ? !keeps : !kept && !ports.native) await dropWorkTurn(ports, sessionId, session, expected);
  } finally {
    await settleTurn(ports, sessionId, session);
  }
}

/**
 * Closes the open turn (only `turnId`, when given) with how it ended — 'answer', 'aborted', 'refusal' or 'error' —
 * and what it did: `recordOf(openedTurn)` when the host keeps its own record (a transcript), else the tool notes. Every
 * injection of the turn is reported with that evidence, a trial Gene the Proxy withheld from it is reported as a
 * control, its reuses wait for the next prompt's label, its edits for the next session's retention check, and a work
 * turn joins the session's range for distillation; `isDistillable` says the range passes the gate now. `strategies`
 * holds the text of each strategy it reported. Null when no such turn was open.
 */
async function recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, recordOf, source, expected, allowNewCandidate, finalizationPending }) {
  if ((await ports.sessions.read(sessionId)).sessionEpoch !== opened.sessionEpoch) return null;
  const [notes, edits] = await Promise.all([
    ports.notes.take(sessionId, opened), ports.baseline.take(sessionId, opened.turnId, opened),
  ]);
  const observed = await recordOf?.(opened);
  if ((await ports.sessions.read(sessionId)).sessionEpoch !== opened.sessionEpoch) return null;
  const ofThisTurn = (entry) => !entry.turnId || !opened.turnId || entry.turnId === opened.turnId;
  const record = observed ?? turnRecordOf(notes.notes.filter(ofThisTurn), { pairShellCalls: ports.confirmTurnCompletion });
  const finished = { ...record, answer: String(answer || record.answer || '').trim() };
  const verified = !ports.confirmTurnCompletion || (reason === 'answer' && finished.answer
    && finished.checks.length > 0 && finished.checks.every(check => verdictOf(check) !== 'unknown'));
  const { queued, controls, strategies } = await reportTurn(ports, sessionId, opened, { reason, checks: finished.checks, source, verified, expected });
  if ((await ports.sessions.read(sessionId)).sessionEpoch !== opened.sessionEpoch) return null;
  const reuses = queued.map(({ report }) => reportedReuseOf(report));
  if (verified) await ports.retention.remember({ sessionId, projectDir, reuses, editedBefore: edits.before });
  await notes.commit();
  await edits.commit();
  const isWork = verified && await rememberWorkTurn(ports, sessionId, opened, {
    reason, record: finished, model, projectDir, source, expected, allowNewCandidate, finalizationPending,
  });
  if (!isWork && !expected) await ports.candidates.update((pending) => rangeInEpoch(pending, sessionId, opened.sessionEpoch)
    ? withSessionActivity(pending, sessionId, ports.clock.now()) : undefined);
  const isDistillable = isWork && !finalizationPending
    && gateOf(rangeInEpoch(await ports.candidates.read(), sessionId, opened.sessionEpoch)?.turns ?? []).passed;
  return {
    turn: opened.turn, record: finished, reports: queued.map(({ report }) => report), strategies, isDistillable,
    ...(expected && { isCandidate: isWork }), controls,
  };
}

/** A native record for a retained turn uses only its own evidence and captured route. */
export async function finishDeferredNativeTurn(ports, sessionId, opened, { reason, record, model }) {
  const { queued, controls } = await reportTurn(ports, sessionId, opened, {
    reason, checks: record.checks, source: OBSERVED, verified: true, expected: opened, deferred: true,
  });
  const isCandidate = await rememberWorkTurn(ports, sessionId, opened, {
    reason, record, model, projectDir: opened.native.payload?.cwd, source: OBSERVED, expected: opened,
    deferred: true, allowNewCandidate: !opened.native.candidateMade, finalizationPending: true,
  });
  if (queued.length || controls) await scheduleDueDistillation(ports, [TASKS.DRAIN]);
  return { turn: opened.turn, reports: queued.map(({ report }) => report), isCandidate };
}

export async function turnEnded(ports, { sessionId, turnId, reason, answer = '', model = null, projectDir, recordOf = null, source = OBSERVED, expectedTurn, ...native }) {
  const { expected, allowNewCandidate, finalizationPending } = native;
  const opened = await closeTurn(ports, sessionId, turnId, { expectedTurn, expected });
  if (!opened) {
    if (ports.confirmTurnCompletion || !(turnId && recordOf && source === OBSERVED)) return null;
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
  if (!ended) return null;
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
  if (!session.open || (ports.native && awaitsNativeTerminal(session))) return;
  if (!ports.confirmTurnCompletion) return turnEnded(ports, { sessionId, reason: as, projectDir, recordOf });
  const row = ports.turnStatus?.(sessionId, session.turnId);
  const reason = reasonOfNativeStatus(row?.status, true);
  const ended = await turnEnded(ports, {
    sessionId, turnId: session.turnId, reason: reason ?? (as === 'answer' ? 'error' : as), projectDir,
    recordOf: reason ? recordOf : null, expectedTurn: session,
  });
  if (!ended) await settledSessionOf(ports, sessionId);
}

/** The session once its last turn's end has had its chance to arrive (up to `settleMs`) and finish writing. */
export async function settledSessionOf(ports, sessionId, settleMs = 0) {
  const openUntil = ports.clock.now() + settleMs;
  while (isWorthWaiting(sessionOf(await ports.sessions.read(sessionId)), ports.clock.now(), openUntil)) {
    await ports.clock.sleep(SETTLE_POLL_MS);
  }
  return sessionOf(await ports.sessions.read(sessionId));
}
