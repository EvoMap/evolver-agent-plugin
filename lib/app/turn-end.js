// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { verdictOf } from '../checks.js';
import { gateOf } from '../distill/gate.js';
import { baseFor, rangeOf, withSessionActivity, withWorkTurn, withoutWorkTurn } from '../distill/range.js';
import { isWorkTurn, workTurnOf } from '../distill/work-turn.js';
import { reportedReuseOf } from '../reuse.js';
import { closedTurn, isSettling, markedReported, pendingReportsOf, sessionOf, settledSession, unreportedOf, withPendingReports } from '../session/state.js';
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

// A turn end that began later (a re-judge of the same turn) owns `settling` from then on; an earlier one leaves it.
// A native turn whose evidence could not be read reopens, so the host's next turn end or recovery delivers it again.
const settleTurn = (ports, sessionId, opened, reopen = false) => ports.sessions.update(sessionId, (stored) => {
  const current = sessionOf(stored);
  if (!sameTurn(current, opened) || current.settling !== opened.settling) return undefined;
  const settled = settledSession(current);
  return reopen ? { ...settled, open: true, waiting: opened.waiting } : settled;
});

async function closeTurn({ sessions, clock }, sessionId, turnId, expected) {
  let opened = null;
  await sessions.update(sessionId, (stored) => {
    if (expected && !sameTurn(sessionOf(stored), expected)) return undefined;
    const result = closedTurn(sessionOf(stored), turnId, clock.now());
    opened = result.opened && { ...result.opened, settling: result.next.settling };
    return result.next;
  });
  return opened;
}

// Reports are queued before their injections are marked reported, so a hook killed in between leaves an injection
// reported twice, which the outbox keys away, rather than never.
// Controls that could not be queued wait in the session for the next turn or session end. Hosts that accept inferred
// completion also retry unreported injections at the next turn end.
async function reportTurn({ identity, sessions, reports, clock, confirmTurnCompletion }, sessionId, opened, { reason, checks, source, verified }) {
  const session = sessionOf(await sessions.read(sessionId));
  if (session.sessionEpoch !== opened.sessionEpoch) return { queued: [], controls: 0, strategies: [] };
  // Native evidence covers exactly the turn that produced it.
  const due = verified ? unreportedOf(session, sessionId, opened.turn)
    .filter((asset) => !confirmTurnCompletion || asset.turn === opened.turn) : [];
  const queued = turnReportsOf(identity, due, { reason, checks, source });
  const retries = confirmTurnCompletion ? pendingReportsOf(session, sessionId, opened.turn - 1) : [];
  const controls = [...session.pendingControls, ...(verified ? trialControlsOf(identity, session, sessionId, opened, checks) : [])];
  const result = { queued, controls: controls.length + retries.length, strategies: due.map((asset) => asset.strategyText) };
  try {
    await reports.enqueue([...retries.map(({ entry }) => entry), ...queued, ...controls]);
  } catch (error) {
    await sessions.update(sessionId, (stored) => {
      const current = sessionOf(stored);
      if (current.sessionEpoch !== opened.sessionEpoch) return undefined;
      const pending = confirmTurnCompletion ? withPendingReports(current, due, queued) : current;
      return withPendingControls(pending, controls);
    });
    // A native turn's reports wait in the session with their evidence, so its work is still recorded before the error.
    if (!confirmTurnCompletion) throw error;
    return { ...result, failure: error };
  }
  await sessions.update(sessionId, (stored) => {
    const current = sessionOf(stored);
    if (current.sessionEpoch !== opened.sessionEpoch) return undefined;
    const session = markedReported(current, [...due, ...retries.map(({ asset }) => asset)], clock.now()) ?? current;
    if (!sameTurn(session, opened)) return withoutPendingControls(session, controls);
    const labelable = opened.isCommand ? session.labelable : queued.map(({ report }) => reportedReuseOf(report));
    return { ...withoutPendingControls(session, controls), labelable };
  });
  return result;
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
async function rememberWorkTurn({ candidates, owner, clock, project, sessions, modelForTurn, confirmTurnCompletion }, sessionId, opened, { record, model, projectDir, source }) {
  if (opened.isCommand || !isWorkTurn(record)) return false;
  model ??= modelForTurn?.(sessionId, opened) ?? null;
  const pending = await candidates.read();
  const prior = rangeOf(pending, sessionId);
  const matching = rangeInEpoch(pending, sessionId, opened.sessionEpoch);
  if (modelForTurn && !canJoinRange(matching, model)) return false;
  const workTurn = workTurnOf({ turn: opened.turn, prompt: opened.prompt, record, answer: record.answer, head: opened.turnHead, now: clock.now() });
  const planned = matching ? baseFor(pending, sessionId, workTurn, opened) : workTurn.head ?? null;
  const snapshot = projectDir ? await snapshotIfReadable(project, projectDir, planned) : null;
  const base = planned ?? (snapshot?.head ? { root: snapshot.root, head: snapshot.head } : null);
  // A detached observer's parent is a hook process, while the open turn carries the native owner.
  const pid = (confirmTurnCompletion ? opened.pid : null) ?? owner.current();
  const context = { base, project: snapshot, projectDir: projectDir ?? null, model, sessionEpoch: opened.sessionEpoch, pid, source, now: clock.now() };
  if ((await sessions.read(sessionId)).sessionEpoch !== opened.sessionEpoch) return false;
  return Boolean(await candidates.update((latest) => {
    const current = rangeOf(latest, sessionId);
    const sameEpoch = rangeInEpoch(latest, sessionId, opened.sessionEpoch);
    // Only replace a different epoch if it was already present before the snapshot.
    if (current && !sameEpoch && (!prior || current.sessionEpoch !== prior.sessionEpoch)) return undefined;
    if (modelForTurn && !canJoinRange(sameEpoch, model)) return undefined;
    return withWorkTurn(latest, sessionId, workTurn, context);
  }));
}

// A turn read from the host's own record can run again after its end without a new prompt (a background command
// finished); its reports went out and stay, but its place in the range is judged again on the whole turn: kept, with
// any correction it got, when it still did work, else taken out. An agent's report is its record, so a second one is
// a retry and changes nothing. The re-judge marks the session settling while it writes, like a first turn end, so a
// correction that arrives meanwhile waits for it.
async function rejudgeWorkTurn(ports, sessionId, turnId, { answer, model, projectDir, recordOf }) {
  let session = null;
  await ports.sessions.update(sessionId, (stored) => {
    const current = sessionOf(stored);
    if (current.open || current.isCommand || current.turnId !== turnId) return undefined;
    session = { ...current, settling: ports.clock.now() };
    return session;
  });
  if (!session) return;
  try {
    const record = await recordOf(session);
    const finished = { ...record, answer: String(answer || record.answer || '').trim() };
    const isWork = await rememberWorkTurn(ports, sessionId, session, { record: finished, model, projectDir, source: OBSERVED });
    if (!isWork) await ports.candidates.update((pending) => rangeInEpoch(pending, sessionId, session.sessionEpoch)
      ? withoutWorkTurn(pending, sessionId, session.turn, session) : undefined);
  } finally {
    await settleTurn(ports, sessionId, session);
  }
}

/** The closed turn's evidence, read before anything is written; null once its session epoch has moved on. */
async function readTurnEvidence(ports, sessionId, opened, recordOf) {
  if ((await ports.sessions.read(sessionId)).sessionEpoch !== opened.sessionEpoch) return null;
  const observed = await recordOf?.(opened);
  if ((await ports.sessions.read(sessionId)).sessionEpoch !== opened.sessionEpoch) return null;
  const notes = await ports.notes.take(sessionId, opened);
  try {
    return { observed, notes, edits: await ports.baseline.take(sessionId, opened.turnId, opened) };
  } catch (error) {
    notes.release();
    throw error;
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
async function recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, source }, { observed, notes, edits }) {
  const ofThisTurn = (entry) => !entry.turnId || !opened.turnId || entry.turnId === opened.turnId;
  const record = observed ?? turnRecordOf(notes.notes.filter(ofThisTurn), { pairShellCalls: ports.confirmTurnCompletion });
  const finished = { ...record, answer: String(answer || record.answer || '').trim() };
  const verified = !ports.confirmTurnCompletion || (reason === 'answer' && finished.answer
    && finished.checks.length > 0 && finished.checks.every(check => verdictOf(check) !== 'unknown'));
  const { queued, controls, strategies, failure } = await reportTurn(ports, sessionId, opened, { reason, checks: finished.checks, source, verified });
  if ((await ports.sessions.read(sessionId)).sessionEpoch !== opened.sessionEpoch) return null;
  const reuses = queued.map(({ report }) => reportedReuseOf(report));
  if (verified) await ports.retention.remember({ sessionId, projectDir, reuses, editedBefore: edits.before });
  await notes.commit();
  await edits.commit();
  const isWork = verified && await rememberWorkTurn(ports, sessionId, opened, { record: finished, model, projectDir, source });
  if (!isWork) await ports.candidates.update((pending) => rangeInEpoch(pending, sessionId, opened.sessionEpoch)
    ? withSessionActivity(pending, sessionId, ports.clock.now()) : undefined);
  const isDistillable = isWork && gateOf(rangeInEpoch(await ports.candidates.read(), sessionId, opened.sessionEpoch)?.turns ?? []).passed;
  return { turn: opened.turn, record: finished, reports: queued.map(({ report }) => report), strategies, isDistillable, controls, failure };
}

export async function turnEnded(ports, { sessionId, turnId, reason, answer = '', model = null, projectDir, recordOf = null, source = OBSERVED, expectedTurn }) {
  const opened = await closeTurn(ports, sessionId, turnId, expectedTurn);
  if (!opened) {
    if (ports.confirmTurnCompletion || !(turnId && recordOf && source === OBSERVED)) return null;
    await rejudgeWorkTurn(ports, sessionId, turnId, { answer, model, projectDir, recordOf });
    await scheduleDueDistillation(ports);
    return null;
  }
  let ended, evidenceRead = false;
  try {
    const evidence = await readTurnEvidence(ports, sessionId, opened, recordOf);
    evidenceRead = true;
    if (evidence) ended = await recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, source }, evidence);
  } finally {
    await settleTurn(ports, sessionId, opened, ports.confirmTurnCompletion && !evidenceRead);
  }
  if (!ended) return null;
  const { controls, failure, ...result } = ended;
  await scheduleDueDistillation(ports, result.reports.length > 0 || controls > 0 ? [TASKS.DRAIN] : []);
  if (failure) throw failure;
  return result;
}

function isWorthWaiting(session, now, openUntil) {
  if (session.open) return now < openUntil;
  return isSettling(session, now) && now < session.settling + SETTLING_WAIT_MS;
}

/** The evidence a host status row carries, when its record is the host's own (a session log), else `recordOf`. */
export const recordOfRow = (row, recordOf = null) => (row?.record ? () => row.record : recordOf);

/**
 * Before a new prompt: waits while the last turn's end is still writing (a bounded while), and up to `settleMs` for
 * a host that sends the next prompt before the last turn's end, then closes a turn still open as `as`: it never got
 * an end event. `recordOf` judges it on the host's own record, as its end would have.
 */
export async function closeUnfinishedTurn(ports, { sessionId, settleMs = 0, as = 'error', projectDir, recordOf = null }) {
  const session = await settledSessionOf(ports, sessionId, settleMs);
  if (!session.open) return;
  if (!ports.confirmTurnCompletion) return turnEnded(ports, { sessionId, reason: as, projectDir, recordOf });
  const row = ports.turnStatus?.(sessionId, session.turnId);
  const reason = reasonOfNativeStatus(row?.status, true);
  const ended = await turnEnded(ports, {
    sessionId, turnId: session.turnId, reason: reason ?? (as === 'answer' ? 'error' : as), projectDir,
    answer: (reason && row.answer) || '', recordOf: reason ? recordOfRow(row, recordOf) : null, expectedTurn: session,
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
