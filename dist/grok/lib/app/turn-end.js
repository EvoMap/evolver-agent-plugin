// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { gateOf } from '../distill/gate.js';
import { baseFor, rangeOf, withSessionActivity, withWorkTurn, withoutWorkTurn } from '../distill/range.js';
import { isWorkTurn, workTurnOf } from '../distill/work-turn.js';
import { reportedReuseOf } from '../reuse.js';
import { closedTurn, isSettling, markedReported, sessionOf, settledSession, unreportedOf } from '../session/state.js';
import { trialControlEntriesOf } from '../trial-control.js';
import { turnRecordOf } from '../turn/record.js';
import { scheduleDueDistillation } from './distill-session.js';
import { TASKS } from './ports.js';
import { OBSERVED, taskSessionId, turnReportsOf } from './turn-reports.js';

const SETTLE_POLL_MS = 100;
// How long, from the moment the last turn began closing, a prompt waits for that turn's end to finish writing, so a
// correction lands on a work turn that exists.
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
// The turn is already closed, so a retry of its end finds no open turn: trial controls that could not be queued wait in
// the session, as unreported injections do, and ride with the next turn end's reports or go out at the session's end.
async function reportTurn({ identity, sessions, reports, clock }, sessionId, opened, { reason, checks, source }) {
  const session = sessionOf(await sessions.read(sessionId));
  const due = unreportedOf(session, sessionId, opened.turn);
  const queued = turnReportsOf(identity, due, { reason, checks, source });
  const controls = [...session.pendingControls, ...trialControlsOf(identity, session, sessionId, opened, checks)];
  try {
    await reports.enqueue([...queued, ...controls]);
  } catch (error) {
    await sessions.update(sessionId, (stored) => withPendingControls(sessionOf(stored), controls));
    throw error;
  }
  await sessions.update(sessionId, (stored) => {
    const session = markedReported(sessionOf(stored), due, clock.now()) ?? sessionOf(stored);
    const labelable = opened.isCommand ? session.labelable : queued.map(({ report }) => reportedReuseOf(report));
    return { ...withoutPendingControls(session, controls), labelable };
  });
  return { queued, controls: controls.length, strategies: due.map((asset) => asset.strategyText) };
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

/**
 * A work turn joins the session's range, with the work tree its checks ran on: its diff against the commit the range
 * began on, taken now, while it is the tree the last check saw.
 */
async function rememberWorkTurn({ candidates, owner, clock, project }, sessionId, opened, { record, model, projectDir, source }) {
  if (opened.isCommand || !isWorkTurn(record)) return false;
  const workTurn = workTurnOf({ turn: opened.turn, prompt: opened.prompt, record, answer: record.answer, head: opened.turnHead, now: clock.now() });
  const planned = baseFor(await candidates.read(), sessionId, workTurn);
  const snapshot = projectDir ? await snapshotIfReadable(project, projectDir, planned) : null;
  const base = planned ?? (snapshot?.head ? { root: snapshot.root, head: snapshot.head } : null);
  const context = { base, project: snapshot, projectDir: projectDir ?? null, model, sessionEpoch: opened.sessionEpoch, pid: owner.current(), source, now: clock.now() };
  await candidates.update((pending) => withWorkTurn(pending, sessionId, workTurn, context));
  return true;
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
    session = current;
    return { ...current, settling: ports.clock.now() };
  });
  if (!session) return;
  try {
    const record = await recordOf(session);
    const finished = { ...record, answer: String(answer || record.answer || '').trim() };
    const isWork = await rememberWorkTurn(ports, sessionId, session, { record: finished, model, projectDir, source: OBSERVED });
    if (!isWork) await ports.candidates.update((pending) => withoutWorkTurn(pending, sessionId, session.turn));
  } finally {
    await ports.sessions.update(sessionId, (stored) => settledSession(sessionOf(stored)));
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
async function recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, recordOf, source }) {
  const notes = await ports.notes.take(sessionId);
  const ofThisTurn = (entry) => !entry.turnId || !opened.turnId || entry.turnId === opened.turnId;
  const record = (await recordOf?.(opened)) ?? turnRecordOf(notes.notes.filter(ofThisTurn));
  const finished = { ...record, answer: String(answer || record.answer || '').trim() };
  const edits = await ports.baseline.take(sessionId, opened.turnId);
  const { queued, controls, strategies } = await reportTurn(ports, sessionId, opened, { reason, checks: finished.checks, source });
  const reuses = queued.map(({ report }) => reportedReuseOf(report));
  await ports.retention.remember({ sessionId, projectDir, reuses, editedBefore: edits.before });
  await notes.commit();
  await edits.commit();
  const isWork = await rememberWorkTurn(ports, sessionId, opened, { record: finished, model, projectDir, source });
  if (!isWork) await ports.candidates.update((pending) => withSessionActivity(pending, sessionId, ports.clock.now()));
  const isDistillable = isWork && isDistillableIn(await ports.candidates.read(), sessionId);
  return { turn: opened.turn, record: finished, reports: queued.map(({ report }) => report), strategies, isDistillable, controls };
}

export async function turnEnded(ports, { sessionId, turnId, reason, answer = '', model = null, projectDir, recordOf = null, source = OBSERVED }) {
  const opened = await closeTurn(ports, sessionId, turnId);
  if (!opened) {
    if (!(turnId && recordOf && source === OBSERVED)) return null;
    await rejudgeWorkTurn(ports, sessionId, turnId, { answer, model, projectDir, recordOf });
    await scheduleDueDistillation(ports);
    return null;
  }
  let ended;
  try {
    ended = await recordTurn(ports, sessionId, opened, { reason, answer, model, projectDir, recordOf, source });
  } finally {
    await ports.sessions.update(sessionId, (stored) => settledSession(sessionOf(stored)));
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
