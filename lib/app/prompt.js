// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftSourcesOf, withoutDraftsForTurn } from '../distill.js';
import { rangeOf, withCorrection, withSessionActivity } from '../distill/range.js';
import { correctionTextOf } from '../distill/work-turn.js';
import { promptTextOf, recallStrategy, taskTextOf } from '../recall.js';
import { correctionReportsOf, followUpLabelOf } from '../session/follow-ups.js';
import { boundTurn, joinedWaiting, listedIdsOf, openedTurn, sessionOf, withInjection, withShown, withTurnHead, withWaiting, withWithheld } from '../session/state.js';
import { scheduleDueDistillation } from './distill-session.js';
import { recallRequestOf } from './recall-request.js';
import { TASKS } from './ports.js';

export const CLOSING = 'Apply them where they fit.';
// A Recipe still pending this close to the hook's deadline gives way to the single strategy, which needs the rest to be booked.
const RECIPE_MARGIN_MS = 300;
const LATE_RECIPE_WAIT_MS = 6_000;

// An older plugin version ending the session drops its epoch; the range holding the corrected turn, or its newest
// draft, keeps it.
async function sourceEpochOf({ candidates, drafts }, sessionId, turn) {
  const saved = await drafts.read();
  const ofSession = (Array.isArray(saved) ? saved : []).filter((draft) => draft?.sessionId === sessionId);
  const range = rangeOf(await candidates.read(), sessionId);
  const work = range?.turns.find((read) => read.turn === turn);
  const ofRange = work ? [{ at: range.at, turn, sessionEpoch: work.sessionEpoch ?? range.sessionEpoch }] : [];
  const sources = [...ofRange, ...ofSession.flatMap(draftSourcesOf)];
  return sources.filter((source) => source?.turn === turn && source.sessionEpoch !== undefined).sort((left, right) => right.at - left.at)[0]?.sessionEpoch;
}

async function markedCorrection(ports, sessionId, { turn, sessionEpoch }) {
  if (turn === 0) return { turn };
  const epoch = sessionEpoch ?? await sourceEpochOf(ports, sessionId, turn);
  await ports.draftCorrections.mark(sessionId, turn, epoch);
  return { turn, sessionEpoch: epoch };
}

// The lock only orders the mark against a publication's last check. One held past its wait must not cost the person
// their turn and its recall, so the correction is then recorded without it and the hook reports the skipped lock.
async function recordedCorrection(ports, sessionId, session) {
  const mark = () => markedCorrection(ports, sessionId, session);
  try {
    return await ports.draftCorrections.withSession(sessionId, mark);
  } catch (error) {
    if (error?.code !== 'ELOCKED') throw error;
    return { ...(await mark()), skipped: error };
  }
}

/**
 * The next prompt is the only verdict on a turn available without asking anyone: a correction stays with the last
 * turn in the session's range, for distillation to read, takes back the drafts distilled from that turn before it,
 * and the last turn's reuses are reported again under `:correction`. The turn is marked corrected first, so a draft's
 * confirmation or publication sees the mark, and the range changes before drafts are removed, so a draft written
 * after the removal still sees the turn it read changed. Every prompt is the session's activity, which a range waits
 * out before it is distilled. Answers the error of a correction lock it had to go without, if any.
 */
async function labelFollowUp(ports, sessionId, prompt) {
  const { sessions, candidates, drafts, reports, clock } = ports;
  const label = followUpLabelOf(prompt);
  const session = sessionOf(await sessions.read(sessionId));
  let skipped;
  if (label === 'correction') {
    const correction = await recordedCorrection(ports, sessionId, session);
    skipped = correction.skipped;
    await candidates.update((pending) => withCorrection(pending, sessionId, session.turn, correctionTextOf(promptTextOf(prompt)), clock.now()));
    if (correction.turn > 0) await drafts.update((list) => withoutDraftsForTurn(list, sessionId, correction.turn, correction.sessionEpoch));
  }
  await candidates.update((pending) => withSessionActivity(pending, sessionId, clock.now()));
  // Read again: a turn end that overlapped the waits above may have left newer reuses to label.
  const { labelable } = sessionOf(await sessions.read(sessionId));
  const queued = correctionReportsOf(labelable, label, sessionId);
  if (queued.length > 0) await reports.enqueue(queued);
  await scheduleDueDistillation(ports, queued.length > 0 ? [TASKS.DRAIN] : []);
  return skipped;
}

/** A recall's match when it brings a strategy (`{ ids, text, stepTexts? }`, a Recipe's steps or one asset), else null. */
const strategyOf = (match) => (match?.ids?.length && match.text ? match : null);

/** Books a recalled strategy into `turn` and answers its text, '' when it brings none or books nothing new. */
export async function booked({ sessions, clock }, sessionId, { turn, match, onlyWhileOpen = false }) {
  if (!strategyOf(match)) return '';
  let added = false;
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    if (onlyWhileOpen && !(session.open && session.turn === turn)) return undefined;
    const result = withInjection(session, match, turn, clock.now());
    added = result.added;
    return result.next;
  });
  return added ? match.text : '';
}

async function shown({ sessions }, sessionId, { turn, ids }) {
  let isOpen = false;
  await sessions.update(sessionId, (stored) => {
    const next = withShown(sessionOf(stored), ids, turn);
    isOpen = Boolean(next);
    return next;
  });
  return isOpen;
}

async function waitForToolResult({ sessions }, sessionId, { turn, match }) {
  const strategy = strategyOf(match);
  if (strategy) await sessions.update(sessionId, (stored) => withWaiting(sessionOf(stored), strategy, turn));
}

/** Remembers a trial Gene the Proxy withheld from `turn`, which that turn's end reports as a control. */
export const rememberWithheld = ({ sessions }, sessionId, turn) => (withheld) =>
  sessions.update(sessionId, (stored) => withWithheld(sessionOf(stored), withheld, turn));

async function recalled(ports, sessionId, { turn, prompt, projectDir, waitMs, keepLate, holdForToolResult }) {
  const session = sessionOf(await ports.sessions.read(sessionId));
  const listedIds = listedIdsOf(session);
  const context = session.task ? { task: session.task, trigger: 'turn_start' } : null;
  const { request: proxyFetch, signal, cancel } = recallRequestOf(ports.proxy);
  const recipeCutoff = ports.clock.sleep(waitMs > 0 ? Math.max(0, waitMs - RECIPE_MARGIN_MS) : LATE_RECIPE_WAIT_MS, signal);
  const onWithheld = rememberWithheld(ports, sessionId, turn);
  const recall = recallStrategy(proxyFetch, promptTextOf(prompt), { context, projectDir, listedIds, onWithheld, closingOf: () => CLOSING, recipeCutoff });
  const TIMED_OUT = Symbol('timed out');
  const match = waitMs > 0 ? await Promise.race([recall, ports.clock.sleep(waitMs, signal).then(() => TIMED_OUT)]) : TIMED_OUT;
  if (match !== TIMED_OUT || !keepLate) cancel();
  if (match !== TIMED_OUT && holdForToolResult) {
    await waitForToolResult(ports, sessionId, { turn, match });
    return { injection: '' };
  }
  if (match !== TIMED_OUT) return { injection: await booked(ports, sessionId, { turn, match }) };
  if (!keepLate) return { injection: '' };
  const late = recall.then((landed) => (strategyOf(landed) ? {
    text: landed.text,
    show: () => shown(ports, sessionId, { turn, ids: landed.ids }),
    join: async () => (await booked(ports, sessionId, { turn, match: landed, onlyWhileOpen: true })) !== '',
  } : null)).catch(() => null).finally(cancel);
  return { injection: '', late };
}

// The commit a turn begins on is where a range of work turns starting with it takes its diff from, so work it commits
// still shows. Read alongside the recall, it costs the prompt no wait of its own.
async function rememberTurnHead({ project, sessions }, sessionId, { turn, sessionEpoch, projectDir }) {
  let head = null;
  try {
    head = await project?.head?.(projectDir);
  } catch {
    return;
  }
  if (head) await sessions.update(sessionId, (stored) => stored.sessionEpoch === sessionEpoch ? withTurnHead(sessionOf(stored), head, turn) : undefined);
}

/**
 * Opens the session's next turn and recalls one strategy for it within `waitMs`: a hook cannot add context once
 * it has answered. With `keepLate`, for a host that can add context to a running turn, a slower recall keeps going:
 * `late` resolves to `{ text, show, join }`. `show()` answers whether the turn is still open and keeps the strategy
 * out of the session's later recalls, for a host that adds it before a model step carries it; `join()` books it,
 * only while the turn is still open, once a model step does. With `holdForToolResult`, for a host whose prompt hook
 * cannot add context, a strategy that lands in time waits for the turn's first tool result instead (see
 * `takeWaitingStrategy`). A plugin command's turn keeps the last real turn's reuses for the next prompt to label, is
 * recalled for nothing and never joins the session's range of work turns. `skipped` is the error of a correction lock
 * the prompt went without.
 */
export async function promptSubmitted(ports, { sessionId, prompt, projectDir = null, turnId = null, turnStart = null, hostTurn = null, isCommand = false, waitMs, keepLate = false, holdForToolResult = false }) {
  const skipped = isCommand ? undefined : await labelFollowUp(ports, sessionId, prompt);
  const opened = await ports.sessions.update(sessionId, (stored) =>
    openedTurn(sessionOf(stored), { turnId, turnStart, hostTurn, prompt: prompt ? promptTextOf(prompt) : null, task: taskTextOf(prompt), pid: ports.owner.current(), isCommand, now: ports.clock.now() }));
  const wantsRecall = !isCommand && ports.settings?.recall !== false;
  const recall = wantsRecall ? recalled(ports, sessionId, { turn: opened.turn, prompt, projectDir, waitMs, keepLate, holdForToolResult }) : { injection: '' };
  const headRead = isCommand || !projectDir ? null : rememberTurnHead(ports, sessionId, { turn: opened.turn, sessionEpoch: opened.sessionEpoch, projectDir });
  const [{ injection, late }] = await Promise.all([recall, headRead]);
  return { turn: opened.turn, sessionEpoch: opened.sessionEpoch, injection, ...(late && { late }), ...(skipped && { skipped }) };
}

/**
 * The strategy waiting for the open turn's first tool result, booked as injected now that the host adds it there; ''
 * when none waits, the turn it waited for has ended, or the result names another turn than the open one. Only one
 * tool result of a turn takes it.
 */
export async function takeWaitingStrategy({ sessions, clock }, { sessionId, turnId = null }) {
  if (!sessionOf(await sessions.read(sessionId)).waiting) return '';
  let text = '';
  await sessions.update(sessionId, (stored) => {
    const joined = joinedWaiting(sessionOf(stored), { turnId, now: clock.now() });
    text = joined.text;
    return joined.next;
  });
  return text;
}

/**
 * The session's last turn, `{ turn, turnId, strategy }`, its strategy only while it is open, or null before the
 * first: a host whose injection lasts one model call replays it, and one more call of a closed turn opens none.
 */
export async function lastTurnOf({ sessions }, sessionId) {
  const session = sessionOf(await sessions.read(sessionId));
  return session.turn > 0 ? { turn: session.turn, turnId: session.turnId, strategy: session.open ? session.strategy : '' } : null;
}

/**
 * Adopts a strategy a command found into the session's ledger: for the turn it was found in, or the next one when
 * a command found it between turns, so that turn's end reports its reuse. Only for a host whose command answers
 * reach the model; a strategy the model never saw is no reuse.
 */
export async function adoptStrategy({ sessions, clock }, { sessionId, strategy }) {
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    const turn = session.open && !session.isCommand ? session.turn : session.turn + 1;
    return withInjection(session, strategy, turn, clock.now()).next;
  });
}

/**
 * Binds the open turn to the id a host announces once it runs (see `boundTurn`); the turn, `{ turn, turnId,
 * sessionEpoch }`, or null when the announcement is not the open turn's.
 */
export async function turnStarted({ sessions }, { sessionId, turnId, prompt }) {
  const bound = await sessions.update(sessionId, (stored) => boundTurn(sessionOf(stored), { turnId, prompt: prompt ? promptTextOf(prompt) : '' }));
  return bound ? { turn: bound.turn, turnId: bound.turnId, sessionEpoch: bound.sessionEpoch } : null;
}
